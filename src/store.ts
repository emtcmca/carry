import {
  assertValidPackName,
  DEFAULT_PACK_NAME,
  PACK_SCHEMA_VERSION,
  type ContextPack,
  type IncomingPack,
} from "./pack.js";

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
   */
  put(namespace: string, packName: string, incoming: IncomingPack): Promise<ContextPack>;
  /**
   * List the pack names present in `namespace` (empty array if none). Lets callers
   * and future tooling discover what a namespace holds.
   */
  list(namespace: string): Promise<string[]>;
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

  async put(namespace: string, packName: string, incoming: IncomingPack): Promise<ContextPack> {
    assertValidPackName(packName);
    let packs = this.namespaces.get(namespace);
    if (!packs) {
      packs = new Map<string, ContextPack>();
      this.namespaces.set(namespace, packs);
    }
    const previous = packs.get(packName);
    const pack: ContextPack = {
      content: incoming.content,
      meta: incoming.meta,
      updatedAt: new Date().toISOString(),
      version: (previous?.version ?? 0) + 1,
      packSchema: PACK_SCHEMA_VERSION,
    };
    packs.set(packName, pack);
    return pack;
  }

  async list(namespace: string): Promise<string[]> {
    const packs = this.namespaces.get(namespace);
    return packs ? [...packs.keys()].sort() : [];
  }
}
