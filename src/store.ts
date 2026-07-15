import type { ContextPack, IncomingPack } from "./pack.js";

/**
 * Storage boundary for carry. Everything above this interface (the MCP server,
 * auth, HTTP) is storage-agnostic. Swapping the in-memory store for libSQL
 * (slice 2) or Postgres (multi-tenant, later) is a matter of writing a new
 * implementation of this interface — no change to the server code.
 *
 * The store is keyed by `namespace`: one current pack per namespace. carry keeps
 * only the latest pack, not history (history, if ever wanted, is a later concern
 * and belongs in a different implementation, not this interface).
 */
export interface ContextStore {
  /** Return the current pack for a namespace, or null if none has been pushed. */
  get(namespace: string): Promise<ContextPack | null>;
  /**
   * Replace the current pack for a namespace. carry owns `updatedAt` and
   * `version`; the caller only supplies `content` and optional `meta`.
   * Returns the stored pack with server-owned fields filled in.
   */
  put(namespace: string, incoming: IncomingPack): Promise<ContextPack>;
}

/**
 * Process-memory store. Loses everything on restart — fine for local dev and
 * tests, NOT for a deployed instance (Render restarts drop the pack). Slice 2
 * replaces this with a durable libSQL-backed store behind the same interface.
 */
export class InMemoryStore implements ContextStore {
  private readonly packs = new Map<string, ContextPack>();

  async get(namespace: string): Promise<ContextPack | null> {
    return this.packs.get(namespace) ?? null;
  }

  async put(namespace: string, incoming: IncomingPack): Promise<ContextPack> {
    const previous = this.packs.get(namespace);
    const pack: ContextPack = {
      content: incoming.content,
      meta: incoming.meta,
      updatedAt: new Date().toISOString(),
      version: (previous?.version ?? 0) + 1,
    };
    this.packs.set(namespace, pack);
    return pack;
  }
}
