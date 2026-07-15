import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import type { ContextPack, IncomingPack } from "./pack.js";
import type { ContextStore } from "./store.js";

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
 * Durable ContextStore backed by libSQL (SQLite on disk, or a remote Turso DB).
 *
 * Same contract as InMemoryStore; the only difference the rest of carry sees is
 * that a pack survives a restart. On Render, point CARRY_DB_URL at a file on the
 * persistent disk (e.g. file:/data/carry.db); for a hosted DB use a libsql:// URL
 * plus CARRY_DB_AUTH_TOKEN.
 *
 * One row per namespace. `meta` is stored as a JSON string and parsed back out;
 * carry still never interprets its shape, it only round-trips it faithfully.
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

  async init(): Promise<void> {
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS packs (
        namespace  TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        meta       TEXT,
        updated_at TEXT NOT NULL,
        version    INTEGER NOT NULL
      )
    `);
  }

  async get(namespace: string): Promise<ContextPack | null> {
    const result = await this.client.execute({
      sql: "SELECT content, meta, updated_at, version FROM packs WHERE namespace = ?",
      args: [namespace],
    });
    const row = result.rows[0];
    if (!row) return null;
    return this.rowToPack(row.content, row.meta, row.updated_at, row.version);
  }

  async put(namespace: string, incoming: IncomingPack): Promise<ContextPack> {
    const updatedAt = new Date().toISOString();
    const metaJson = incoming.meta === undefined ? null : JSON.stringify(incoming.meta);
    // Upsert with a server-owned monotonic version. RETURNING gives us the row
    // back atomically, so concurrent pushes cannot report a stale version.
    const result = await this.client.execute({
      sql: `
        INSERT INTO packs (namespace, content, meta, updated_at, version)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(namespace) DO UPDATE SET
          content    = excluded.content,
          meta       = excluded.meta,
          updated_at = excluded.updated_at,
          version    = packs.version + 1
        RETURNING content, meta, updated_at, version
      `,
      args: [namespace, incoming.content, metaJson, updatedAt],
    });
    const row = result.rows[0];
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
    };
  }
}
