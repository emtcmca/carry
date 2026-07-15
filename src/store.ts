import {
  assertValidPackName,
  DEFAULT_PACK_NAME,
  PACK_SCHEMA_VERSION,
  type ContextPack,
  type IncomingPack,
} from "./pack.js";

/**
 * Thrown by `put` when an optimistic-concurrency check fails: the caller passed
 * `expectedVersion` but the pack's current stored version is something else (a
 * concurrent writer moved it, or the pack does not exist / does exist unexpectedly).
 * Carries both numbers so the caller can report exactly what to re-read.
 *
 * "No pack yet" is modeled as current version 0, so a first-write assertion is
 * `expectedVersion: 0`.
 */
export class VersionConflictError extends Error {
  readonly expected: number;
  readonly current: number;
  constructor(expected: number, current: number) {
    super(`version conflict: expected ${expected}, current ${current}`);
    this.name = "VersionConflictError";
    this.expected = expected;
    this.current = current;
  }
}

/** Options for a `put`. `expectedVersion` opts into optimistic concurrency. */
export interface PutOptions {
  /**
   * When set, the write only succeeds if the pack's current version equals this
   * number (0 meaning "no pack exists yet"). On mismatch the store throws
   * `VersionConflictError` and writes nothing.
   */
  expectedVersion?: number;
}

/**
 * Storage boundary for carry. Everything above this interface (the MCP server,
 * auth, HTTP) is storage-agnostic. Swapping the in-memory store for libSQL or
 * Postgres (multi-tenant, later) is a matter of writing a new implementation of
 * this interface — no change to the server code.
 *
 * The store is keyed by `(namespace, packName)`: a namespace holds several named
 * packs, and each pack keeps only its latest version (history, if ever wanted, is
 * a later concern and belongs in a different slice, not this interface). A caller
 * that omits `packName` reads/writes the `"default"` pack, preserving the original
 * single-pack behavior.
 */
export interface ContextStore {
  /**
   * Prepare the store for use (create tables, run migrations, open connections).
   * Idempotent: safe to call on every boot. In-memory stores make this a no-op.
   */
  init(): Promise<void>;
  /**
   * Return the current pack named `packName` in `namespace`, or null if none has
   * been pushed. `packName` defaults to `"default"`.
   */
  get(namespace: string, packName?: string): Promise<ContextPack | null>;
  /**
   * Replace the named pack in `namespace`. carry owns `updatedAt`, `version`, and
   * `packSchema`; the caller supplies only `content` and optional `meta`. Returns
   * the stored pack with server-owned fields filled in.
   *
   * If `opts.expectedVersion` is supplied and does not equal the pack's current
   * version (0 = no pack yet), the write is rejected atomically — nothing is
   * stored and `VersionConflictError` is thrown. Omitting it keeps the original
   * last-writer-wins behavior. Every successful put also appends the new version
   * to the pack's history (see `listVersions` / `getVersion`).
   */
  put(
    namespace: string,
    packName: string,
    incoming: IncomingPack,
    opts?: PutOptions,
  ): Promise<ContextPack>;
  /**
   * List the pack names present in `namespace` (empty array if none). Lets callers
   * and future tooling discover what a namespace holds.
   */
  list(namespace: string): Promise<string[]>;
  /**
   * Return the version numbers recorded in `namespace`/`packName`'s append-only
   * history, ascending (empty array if the pack has never been written). Defaults
   * `packName` to `"default"`.
   */
  listVersions(namespace: string, packName?: string): Promise<number[]>;
  /**
   * Return a specific historical version of a pack, or null if that version was
   * never recorded. The returned pack's `version` is the historical one.
   */
  getVersion(namespace: string, packName: string, version: number): Promise<ContextPack | null>;
  /**
   * Release resources (close DB handles). Called on graceful shutdown and by tests
   * before deleting DB files. Idempotent; in-memory stores no-op.
   */
  close(): Promise<void>;
}

/**
 * Process-memory store. Loses everything on restart — fine for local dev and
 * tests, NOT for a deployed instance (Render restarts drop the packs). The
 * durable libSQL-backed store implements the same interface.
 *
 * Keyed as namespace -> (packName -> pack) so `list` is a direct key enumeration.
 */
export class InMemoryStore implements ContextStore {
  private readonly namespaces = new Map<string, Map<string, ContextPack>>();
  /** Append-only per-(namespace, packName) history, ascending by version. */
  private readonly histories = new Map<string, Map<string, ContextPack[]>>();

  async init(): Promise<void> {
    // Nothing to prepare for process memory.
  }

  async close(): Promise<void> {
    // Nothing to release for process memory.
  }

  async get(namespace: string, packName: string = DEFAULT_PACK_NAME): Promise<ContextPack | null> {
    assertValidPackName(packName);
    return this.namespaces.get(namespace)?.get(packName) ?? null;
  }

  async put(
    namespace: string,
    packName: string,
    incoming: IncomingPack,
    opts?: PutOptions,
  ): Promise<ContextPack> {
    assertValidPackName(packName);
    let packs = this.namespaces.get(namespace);
    if (!packs) {
      packs = new Map<string, ContextPack>();
      this.namespaces.set(namespace, packs);
    }
    const current = packs.get(packName)?.version ?? 0;
    // Optimistic concurrency: reject before mutating anything if the caller's
    // expectation is stale. Synchronous here, so the check-and-write cannot race.
    if (opts?.expectedVersion !== undefined && opts.expectedVersion !== current) {
      throw new VersionConflictError(opts.expectedVersion, current);
    }
    const pack: ContextPack = {
      content: incoming.content,
      meta: incoming.meta,
      updatedAt: new Date().toISOString(),
      version: current + 1,
      packSchema: PACK_SCHEMA_VERSION,
    };
    packs.set(packName, pack);
    this.appendHistory(namespace, packName, pack);
    return pack;
  }

  async list(namespace: string): Promise<string[]> {
    const packs = this.namespaces.get(namespace);
    return packs ? [...packs.keys()].sort() : [];
  }

  async listVersions(
    namespace: string,
    packName: string = DEFAULT_PACK_NAME,
  ): Promise<number[]> {
    assertValidPackName(packName);
    // History is appended in version order, so this is already ascending.
    return (this.histories.get(namespace)?.get(packName) ?? []).map((p) => p.version);
  }

  async getVersion(
    namespace: string,
    packName: string = DEFAULT_PACK_NAME,
    version?: number,
  ): Promise<ContextPack | null> {
    assertValidPackName(packName);
    const hist = this.histories.get(namespace)?.get(packName);
    return hist?.find((p) => p.version === version) ?? null;
  }

  /** Record a snapshot of a written pack into its append-only history. */
  private appendHistory(namespace: string, packName: string, pack: ContextPack): void {
    let nsHist = this.histories.get(namespace);
    if (!nsHist) {
      nsHist = new Map<string, ContextPack[]>();
      this.histories.set(namespace, nsHist);
    }
    let hist = nsHist.get(packName);
    if (!hist) {
      hist = [];
      nsHist.set(packName, hist);
    }
    // Store a shallow copy so later reads cannot be affected by anything mutating
    // the returned "current" pack object (packs are treated as immutable anyway).
    hist.push({ ...pack });
  }
}
