import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client, type InStatement } from "@libsql/client";
import {
  assertValidPackName,
  DEFAULT_PACK_NAME,
  PACK_SCHEMA_VERSION,
  type ContextPack,
  type IncomingPack,
} from "./pack.js";
import { VersionConflictError, type ContextStore, type PutOptions } from "./store.js";

/**
 * libSQL opens a file-backed DB eagerly (in createClient), and it does NOT create
 * missing parent directories: a `file:./data/carry.db` URL fails with SQLite error
 * 14 (CANTOPEN) if `./data` does not exist. Create the parent up front so a first
 * boot on a clean disk (or Render mount) just works. No-op for :memory: and remote
 * (libsql://) URLs.
 */
function ensureParentDir(url: string): void {
  if (!url.startsWith("file:")) return;
  const path = url.slice("file:".length);
  if (path === "" || path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Ordered forward migrations. Index i (0-based) is migration number i+1. Each entry
 * is the list of SQL statements that migration runs. `init` applies every migration
 * whose number is greater than the DB's recorded `schema_version`, running that
 * migration's statements plus the version bump as ONE atomic batch (BEGIN…COMMIT).
 *
 * Rules for adding a migration (A-ii and beyond):
 *  - APPEND only; never edit or reorder an existing entry (a shipped migration has
 *    already run on real DBs and its effect is now permanent).
 *  - Each migration is a pure forward step. Make it idempotent-friendly where cheap
 *    (IF NOT EXISTS) so a half-applied crash re-runs cleanly.
 *  - Keep it dependency-free: plain SQL statements, no migration library.
 *
 * We use `client.batch(..., "write")` rather than the `transaction()` API on purpose:
 * libSQL's local sqlite3 `transaction()` swaps to a fresh connection afterwards, which
 * for a `:memory:` DB is a *different* empty database — so DDL run in a transaction is
 * invisible to later queries. `batch` runs atomically on the same connection instead.
 */
const MIGRATIONS: ReadonlyArray<ReadonlyArray<InStatement>> = [
  // Migration 1 — create the packs table in the v2 (namespace, pack_name) shape.
  // Fresh project, no legacy single-key rows to carry over: this is the ground truth.
  [
    `CREATE TABLE IF NOT EXISTS packs (
       namespace  TEXT NOT NULL,
       pack_name  TEXT NOT NULL,
       content    TEXT NOT NULL,
       meta       TEXT,
       updated_at TEXT NOT NULL,
       version    INTEGER NOT NULL,
       PRIMARY KEY (namespace, pack_name)
     )`,
  ],
  // Migration 2 — append-only version history. Every successful put records the
  // new (namespace, pack_name, version) snapshot here in the same atomic batch as
  // the main write, so the current pack and its history can never diverge. Keyed by
  // (namespace, pack_name, version): versions are monotonic per pack, so a snapshot
  // is written exactly once and never overwritten.
  [
    `CREATE TABLE IF NOT EXISTS packs_history (
       namespace  TEXT NOT NULL,
       pack_name  TEXT NOT NULL,
       version    INTEGER NOT NULL,
       content    TEXT NOT NULL,
       meta       TEXT,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (namespace, pack_name, version)
     )`,
  ],
];

/**
 * Durable ContextStore backed by libSQL (SQLite on disk, or a remote Turso DB).
 *
 * Same contract as InMemoryStore; the only difference the rest of carry sees is
 * that packs survive a restart. On Render, point CARRY_DB_URL at a file on the
 * persistent disk (e.g. file:/data/carry.db); for a hosted DB use a libsql:// URL
 * plus CARRY_DB_AUTH_TOKEN.
 *
 * Keyed by (namespace, pack_name): a namespace holds several named packs. `meta`
 * is stored as a JSON string and parsed back out; carry never interprets its shape,
 * it only round-trips it faithfully.
 */
export class LibSqlStore implements ContextStore {
  private readonly client: Client;

  constructor(url: string, authToken?: string) {
    ensureParentDir(url);
    this.client = createClient({ url, authToken });
  }

  async close(): Promise<void> {
    this.client.close();
  }

  /**
   * Bring the schema up to the latest migration. Idempotent: on a DB already at the
   * latest version this reads one row and applies nothing. Designed to be additive —
   * appending MIGRATIONS[n] is all a future slice (history table, etc.) needs.
   */
  async init(): Promise<void> {
    // A single-row bookkeeping table holding the highest applied migration number.
    await this.client.execute(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
    );
    const versionResult = await this.client.execute("SELECT version FROM schema_version LIMIT 1");
    let current: number;
    if (versionResult.rows[0]) {
      current = Number(versionResult.rows[0].version);
    } else {
      // Brand-new DB: seed the row at version 0 so migrations run from the start.
      await this.client.execute("INSERT INTO schema_version (version) VALUES (0)");
      current = 0;
    }

    const target = MIGRATIONS.length;
    for (let next = current + 1; next <= target; next++) {
      // Each migration + its version bump run as one atomic batch: a crash
      // mid-migration rolls the whole batch back, leaving schema_version untouched,
      // so init re-runs the migration cleanly on the next boot.
      await this.client.batch(
        [
          ...MIGRATIONS[next - 1],
          { sql: "UPDATE schema_version SET version = ?", args: [next] },
        ],
        "write",
      );
    }
  }

  async get(namespace: string, packName: string = DEFAULT_PACK_NAME): Promise<ContextPack | null> {
    assertValidPackName(packName);
    const result = await this.client.execute({
      sql: "SELECT content, meta, updated_at, version FROM packs WHERE namespace = ? AND pack_name = ?",
      args: [namespace, packName],
    });
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToPack(row.content, row.meta, row.updated_at, row.version);
  }

  async put(
    namespace: string,
    packName: string,
    incoming: IncomingPack,
    opts?: PutOptions,
  ): Promise<ContextPack> {
    assertValidPackName(packName);
    const updatedAt = new Date().toISOString();
    const metaJson = incoming.meta === undefined ? null : JSON.stringify(incoming.meta);

    if (opts?.expectedVersion === undefined) {
      return this.putLastWriterWins(namespace, packName, incoming, updatedAt, metaJson);
    }
    return this.putExpecting(
      namespace,
      packName,
      incoming,
      updatedAt,
      metaJson,
      opts.expectedVersion,
    );
  }

  /**
   * Original last-writer-wins put (no expectedVersion): upsert the current pack and
   * copy the just-written row into history, both in one atomic batch. The history
   * INSERT ... SELECT reads the packs row updated earlier in the same transaction,
   * so the snapshot always matches the new current version exactly.
   */
  private async putLastWriterWins(
    namespace: string,
    packName: string,
    incoming: IncomingPack,
    updatedAt: string,
    metaJson: string | null,
  ): Promise<ContextPack> {
    const results = await this.client.batch(
      [
        {
          sql: `
            INSERT INTO packs (namespace, pack_name, content, meta, updated_at, version)
            VALUES (?, ?, ?, ?, ?, 1)
            ON CONFLICT(namespace, pack_name) DO UPDATE SET
              content    = excluded.content,
              meta       = excluded.meta,
              updated_at = excluded.updated_at,
              version    = packs.version + 1
            RETURNING content, meta, updated_at, version
          `,
          args: [namespace, packName, incoming.content, metaJson, updatedAt],
        },
        {
          sql: `
            INSERT INTO packs_history (namespace, pack_name, version, content, meta, updated_at)
            SELECT namespace, pack_name, version, content, meta, updated_at
            FROM packs WHERE namespace = ? AND pack_name = ?
          `,
          args: [namespace, packName],
        },
      ],
      "write",
    );
    const row = results[0].rows[0];
    return this.rowToPack(row.content, row.meta, row.updated_at, row.version);
  }

  /**
   * Optimistic-concurrency put: only write if the pack's current version equals
   * `expectedVersion` (0 = no pack yet). The guarded write closes the read-to-write
   * race, so a concurrent writer that moved the version cannot be clobbered — on any
   * mismatch we throw VersionConflictError and nothing is stored.
   */
  private async putExpecting(
    namespace: string,
    packName: string,
    incoming: IncomingPack,
    updatedAt: string,
    metaJson: string | null,
    expectedVersion: number,
  ): Promise<ContextPack> {
    const current = await this.currentVersion(namespace, packName);
    if (current !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, current);
    }
    const newVersion = current + 1;

    if (current === 0) {
      // Caller asserts the pack does not exist; create it. A racing create trips the
      // primary key, rolls the whole batch back, and we surface it as a conflict.
      try {
        await this.client.batch(
          [
            {
              sql: `INSERT INTO packs (namespace, pack_name, content, meta, updated_at, version)
                    VALUES (?, ?, ?, ?, ?, 1)`,
              args: [namespace, packName, incoming.content, metaJson, updatedAt],
            },
            {
              sql: `INSERT INTO packs_history (namespace, pack_name, version, content, meta, updated_at)
                    VALUES (?, ?, 1, ?, ?, ?)`,
              args: [namespace, packName, incoming.content, metaJson, updatedAt],
            },
          ],
          "write",
        );
      } catch {
        throw new VersionConflictError(
          expectedVersion,
          await this.currentVersion(namespace, packName),
        );
      }
    } else {
      const results = await this.client.batch(
        [
          {
            sql: `UPDATE packs SET content = ?, meta = ?, updated_at = ?, version = ?
                  WHERE namespace = ? AND pack_name = ? AND version = ?`,
            args: [incoming.content, metaJson, updatedAt, newVersion, namespace, packName, current],
          },
          {
            // Only record history if the guarded UPDATE above actually fired: the
            // guard checks the packs row is now at newVersion. Supplies explicit
            // values (not a copy of some other row) so a lost race records nothing.
            sql: `INSERT INTO packs_history (namespace, pack_name, version, content, meta, updated_at)
                  SELECT ?, ?, ?, ?, ?, ?
                  WHERE (SELECT version FROM packs WHERE namespace = ? AND pack_name = ?) = ?`,
            args: [
              namespace,
              packName,
              newVersion,
              incoming.content,
              metaJson,
              updatedAt,
              namespace,
              packName,
              newVersion,
            ],
          },
        ],
        "write",
      );
      if (Number(results[0].rowsAffected) === 0) {
        throw new VersionConflictError(
          expectedVersion,
          await this.currentVersion(namespace, packName),
        );
      }
    }

    return {
      content: incoming.content,
      meta: incoming.meta,
      updatedAt,
      version: newVersion,
      packSchema: PACK_SCHEMA_VERSION,
    };
  }

  /** Current stored version of a pack, or 0 if it has never been written. */
  private async currentVersion(namespace: string, packName: string): Promise<number> {
    const result = await this.client.execute({
      sql: "SELECT version FROM packs WHERE namespace = ? AND pack_name = ?",
      args: [namespace, packName],
    });
    return result.rows[0] ? Number(result.rows[0].version) : 0;
  }

  async list(namespace: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: "SELECT pack_name FROM packs WHERE namespace = ? ORDER BY pack_name",
      args: [namespace],
    });
    return result.rows.map((row) => String(row.pack_name));
  }

  async listVersions(
    namespace: string,
    packName: string = DEFAULT_PACK_NAME,
  ): Promise<number[]> {
    assertValidPackName(packName);
    const result = await this.client.execute({
      sql: "SELECT version FROM packs_history WHERE namespace = ? AND pack_name = ? ORDER BY version ASC",
      args: [namespace, packName],
    });
    return result.rows.map((row) => Number(row.version));
  }

  async getVersion(
    namespace: string,
    packName: string = DEFAULT_PACK_NAME,
    version?: number,
  ): Promise<ContextPack | null> {
    assertValidPackName(packName);
    const result = await this.client.execute({
      sql: "SELECT content, meta, updated_at, version FROM packs_history WHERE namespace = ? AND pack_name = ? AND version = ?",
      args: [namespace, packName, version ?? -1],
    });
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToPack(row.content, row.meta, row.updated_at, row.version);
  }

  private rowToPack(
    content: unknown,
    meta: unknown,
    updatedAt: unknown,
    version: unknown,
  ): ContextPack {
    return {
      content: String(content),
      meta: meta == null ? undefined : (JSON.parse(String(meta)) as Record<string, unknown>),
      updatedAt: String(updatedAt),
      version: Number(version),
      packSchema: PACK_SCHEMA_VERSION,
    };
  }
}
