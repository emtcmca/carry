import { LibSqlStore } from "./libsql-store.js";
import { InMemoryStore, type ContextStore } from "./store.js";

/**
 * Pick a store implementation from the environment.
 *
 * - CARRY_DB_URL set  -> durable LibSqlStore (file:... on disk, or libsql://... Turso).
 * - CARRY_DB_URL unset -> InMemoryStore, with a loud warning that packs will not
 *   survive a restart. Fine for local dev; not what you want on a deployed instance.
 *
 * The caller is responsible for awaiting store.init() before serving traffic.
 */
export function createStore(env: NodeJS.ProcessEnv = process.env): ContextStore {
  const url = env.CARRY_DB_URL?.trim();
  if (url) {
    return new LibSqlStore(url, env.CARRY_DB_AUTH_TOKEN?.trim() || undefined);
  }
  console.warn(
    "[carry] CARRY_DB_URL is not set: using in-memory store. Packs will be LOST on " +
      "restart. Set CARRY_DB_URL (e.g. file:/data/carry.db) for durable storage.",
  );
  return new InMemoryStore();
}
