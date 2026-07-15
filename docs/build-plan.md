# carry — build plan

Working slices. Each slice leaves the repo in a running, verifiable state.

## Slice 1 — runnable MCP server (DONE, 2026-07-15)
- [x] TypeScript strict project, Node >=20, ESM.
- [x] `ContextStore` interface + `InMemoryStore`.
- [x] Two-token auth (read/write) per namespace, loaded from `CARRY_NAMESPACES`,
      fails loudly on misconfig.
- [x] MCP server: `get_context`, `push_context` (write-gated), `carry://context` resource.
- [x] Express entry, stateless Streamable HTTP on `POST /mcp`, `GET /healthz`.
- [x] Verified: `npm run smoke` (cores), `scripts/http-smoke.ts` (real MCP client
      end to end — push, read, read-only rejection, namespace isolation).

## Slice 2 — durable storage (DONE, 2026-07-15)
- [x] `LibSqlStore implements ContextStore`, backed by a Render persistent disk (or
      Turso). Same interface; selected in `index.ts` via env (`CARRY_DB_URL`) through
      a `createStore` factory (falls back to in-memory with a loud warning).
- [x] Migration/bootstrap on boot (`init()` creates the table, idempotent).
- [x] `close()` added to the store contract; graceful SIGTERM/SIGINT shutdown in the
      entry so Render restarts flush and unlock the DB.
- [x] Vitest: shared contract suite over both impls (14) + durability suite (2) proving
      a pack survives a fresh instance on the same file.
- [x] Fixed a real bug the durability test surfaced: libSQL opens the file eagerly and
      does not create parent dirs, so `file:./data/carry.db` crashed with SQLite error
      14 (CANTOPEN); `LibSqlStore` now creates the parent dir up front.

## Slice 3 — the compiler + CLI
- [ ] `carry` CLI: `carry push --from <files...>` compiles a pack from source
      Markdown (e.g. `voice.md` + `voice-calibration.md`), stamps `{ gitHash, builtAt,
      title }` into `meta`, and POSTs to a carry instance with the write token.
- [ ] `carry get` for quick inspection from the terminal.
- [ ] For the linkedin repo: a thin wrapper so `/li` can push voice canon on change.

## Slice 4 — deploy + connect
- [ ] `Dockerfile` + `render.yaml` Blueprint (one-click self-host).
- [ ] Deploy Eric's instance; set real tokens.
- [ ] Add the connector on claude.ai web; confirm it syncs to mobile and reads the pack.

## Slice 5 — launch content
- [ ] LinkedIn post(s) grounded in the deployed, working thing (run through the `/li`
      critic loop). Not before slice 4 — claims must match reality.

## Later — multi-tenant
- [ ] Namespace provisioning + per-namespace tokens in a DB (Postgres driver behind
      `ContextStore`), minimal signup, rate limits, isolation tests.
