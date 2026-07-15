---
status: draft
gated_on: "slice 4 live before publishing"
voice: eric
---

## Post

There is no public API to write the knowledge in a Claude Project. So the voice rules and system facts I edit from Claude Code at my desk never reach the Claude mobile app. Re-upload by hand, or let mobile run stale. Both copies drift the moment I touch the source.

What unlocked it: Claude mobile can use remote MCP connectors. Add the URL once on claude.ai and it syncs to your phone. So one small server both surfaces attach to becomes an always-live source of truth.

That is carry. A remote MCP server, two tools: get_context reads the current pack, push_context replaces it. Two separate tokens per namespace: the mobile connector carries a read token, my desk a write token. They must differ, so a leaked read connector can never overwrite the pack. Durable libSQL storage, TypeScript strict, on the official MCP SDK.

The honest part: a durability test caught my own bug before anything shipped. libSQL opens the database file eagerly and will not create a missing parent directory, so a first boot on a clean disk crashed with SQLite error 14. One-line fix, found only because a test tried to prove a pack survives a restart.

Still building. The question I keep circling: is one pack per namespace the right unit, or should context compose from several at read time?

## Facts grounded against

- No public write API for Project knowledge; connector-once-then-syncs-to-phone framing: `README.md` lines 7-25.
- Remote MCP server, two tools `get_context` / `push_context`, official MCP SDK, name/version "carry" 0.1.0: `src/server.ts` lines 1, 15-17, 28-95.
- Two-token auth (read vs write must differ; read token cannot overwrite the pack): `src/auth.ts` lines 1-25, 56-60, 83-93; `README.md` lines 40-44.
- Durable libSQL storage + the SQLite error 14 (CANTOPEN) parent-dir bug and one-line fix, caught by the durability test: `src/libsql-store.ts` lines 7-19, 32-38; `docs/build-plan.md` lines 15-26 (Slice 2, durability suite of 2).
- Not deployed yet (slice 4 not live, so "still building," no launch claim): `docs/build-plan.md` lines 35-42.
