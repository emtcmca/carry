# carry

**Carry a context pack between your Claude surfaces.** Push your voice rules,
system facts, or style guide from Claude Code at your desk; read them from Claude
mobile on the go. One small remote MCP server, always live, no manual re-sync.

carry exists because there is no public API to write Claude Project knowledge, so
keeping your mobile Claude in sync with the instructions you maintain in a repo
means either re-uploading files by hand (which drifts the moment you do) or this:
a server both surfaces attach to, holding one current pack per namespace.

```
  Claude Code (your repo)                         Claude mobile app
  compiles + pushes the pack                      connector attached once via web
            │                                              │
            │  push_context (write token)                  │  get_context (read token)
            ▼                                              ▼
        ┌─────────────────────────────────────────────────────┐
        │   carry  —  the current pack for your namespace       │
        └─────────────────────────────────────────────────────┘
```

Because Claude mobile can *use* remote MCP connectors (you add the URL once on
claude.ai web; it syncs to your phone), your phone reads the live pack every time
you draft. Update the pack from your desk, and mobile has it on the next call.

## Status

Early. Slice 1 (a runnable, auth-gated MCP server with an in-memory store) is done
and verified end to end. See [`docs/build-plan.md`](docs/build-plan.md) for what is
built and what is next.

## What it exposes (MCP)

- **`get_context`** — return the current pack for your namespace. Read this before drafting.
- **`push_context`** — replace the pack. Requires a write token.
- **`carry://context`** — the same pack as an MCP resource.

## Auth model

A namespace owns two secrets: a **read token** (what your mobile connector presents)
and a **write token** (what Claude Code / CI presents to push). They must differ, so
a leaked read connector can never overwrite your pack. The token is the namespace:
the model never supplies one, so it cannot touch anyone else's pack.

## Run locally

```bash
npm install
cp .env.example .env        # then set CARRY_NAMESPACES with your own tokens
npm run dev                 # starts on :8080
```

Verify:

```bash
npm run smoke               # storage + auth cores, no network
npm run typecheck
# end-to-end (server must be running): CARRY_URL, then tsx scripts/http-smoke.ts
```

## Roadmap

Durable libSQL storage, a `carry` CLI + pack compiler (repo files → stamped pack),
a Render one-click Blueprint, and optional multi-tenant signup. Tracked in
[`docs/build-plan.md`](docs/build-plan.md).

## License

Apache-2.0.
