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

## Slice 3 — the compiler + CLI (DONE, 2026-07-15, cli lane)
- [x] `carry push --url <u> --from <files...> [--title] [--token]` compiles a pack from
      source Markdown, stamps `{ source, title, gitHash, builtAt }` into `meta`, and
      pushes via the official MCP client (`push_context`). `gitHash`/`builtAt` injected
      so the compiler is pure and unit-tested.
- [x] `carry get --url <u> [--token]` for terminal inspection. `--help`. Zero new deps.
- [x] 20 new tests (compiler 6 + cli 14); real end-to-end push+get verified.
- [ ] For the linkedin repo: a thin wrapper so `/li` can push voice canon on change.
      (Deferred — needs slice 4 live + a real instance URL/token first.)

## Slice 4 — deploy + connect (ARTIFACTS DONE, 2026-07-15, deploy lane)
- [x] `Dockerfile` (multi-stage, glibc for libsql) + `render.yaml` Blueprint (docker
      runtime, /data persistent disk, sync:false secrets) + `docs/deploy.md` + `ops/runbook.md`.
      Build/boot path verified; Docker not installed locally so no `docker build` run.
- [ ] Deploy Eric's instance; set real tokens. (Human-approval gate — pending.)
- [ ] Add the connector on claude.ai web; confirm it syncs to mobile and reads the pack.

## Slice 5 — launch content (DRAFT DONE, 2026-07-15, docs lane; gated)
- [x] LinkedIn draft written and grounded (`docs/launch/linkedin-carry-draft.md`),
      frontmatter-gated on slice 4 going live.
- [ ] Run through the `/li` critic loop and publish — only after slice 4 is deployed.

## Later — multi-tenant
- [ ] Namespace provisioning + per-namespace tokens in a DB (Postgres driver behind
      `ContextStore`), minimal signup, rate limits, isolation tests.
