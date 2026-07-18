# carry

**Carry a context pack between your Claude surfaces.** Push your voice rules,
system facts, or style guide from Claude Code at your desk; read them from Claude
mobile on the go. One small remote MCP server, always live, no manual re-sync.

carry exists because there is no public API to write Claude Project knowledge, so
keeping your mobile Claude in sync with the instructions you maintain in a repo
means either re-uploading files by hand (which drifts the moment you do) or this:
a server both surfaces attach to, holding one current pack per namespace.

```
  Claude Code (your repo)                         Claude mobile / web / desktop
  compiles + pushes the pack                      connector attached once via web
            │                                              │
            │  push_context (write token)                  │  get_context (read: token or OAuth)
            ▼                                              ▼
        ┌─────────────────────────────────────────────────────┐
        │   carry  —  the current pack for your namespace       │
        └─────────────────────────────────────────────────────┘
```

Because Claude's remote MCP connectors are account-brokered (you add the URL once
on claude.ai web and it appears on your phone, desktop, and web on the same
account), every surface reads the live pack. Update the pack from your desk, and
the next `get_context` anywhere has it.

## Self-hosted — you run it, nobody hosts it for you

carry is **deploy-your-own**. There is no shared "carry cloud" and no maintainer
footing a bill for your usage. You stand up your own instance (a one-click Render
Blueprint is included), set your own tokens, and own your data. The optional OAuth
mode uses **your** authorization server (e.g. your own free-tier WorkOS AuthKit
tenant) — again, your account, not the maintainer's. Running it costs you only
what your host charges (often $0 to kick the tires; a few dollars a month for a
persistent disk). See [`docs/deploy.md`](docs/deploy.md).

## What it exposes (MCP)

Stateless Streamable HTTP on `POST /mcp` (a fresh MCP server per request; no
session state to leak). Plus `GET /healthz`.

- **`get_context`** — return the current pack for your namespace. Read this before drafting.
- **`push_context`** — replace the pack. Requires a **write** token.
- **`carry://context`** — the same pack as an MCP resource.

## Auth model

carry supports two authentication paths. **Static tokens are the default; OAuth is
opt-in and off unless you configure it.**

**1. Static bearer tokens (default — the write path, and a simple read path).**
A namespace owns two secrets: a **read token** and a **write token**. They must
differ, so a leaked read connector can never overwrite your pack. The token *is*
the namespace — the model never supplies one, so it can't touch anyone else's
pack. This is all you need for Claude Code (push with the write token) and for any
MCP client that lets you paste an `Authorization: Bearer` header. No external
service required.

**2. OAuth 2.1 protected-resource mode (optional — for the claude.ai connector).**
The claude.ai **web** connector dialog is OAuth-only on personal accounts (there's
no field to paste a bearer read token). To attach carry as a mobile/web/desktop
connector, enable OAuth: carry becomes an [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)
protected resource that validates JWTs (issuer + audience + expiry) against your
authorization server's JWKS. OAuth callers are granted **read scope only** —
pushing always requires the static write token. OAuth is enabled solely by setting
`CARRY_OAUTH_ISSUER`; leave it unset and nothing about the static-token behavior
changes. See [`docs/connector-auth-spike.md`](docs/connector-auth-spike.md) for
why this path exists.

> **Known limitation (read before you share a connector).** In OAuth mode, carry
> currently trusts **any** user who can authenticate to your configured
> authorization server / tenant. That's fine for a single-user self-host (your
> tenant is just you). Lock-to-user (allowlisting a specific `sub`/email) is on the
> roadmap and **not** yet built — don't point carry at a multi-user OAuth tenant
> and treat the pack as private until it is.

## Run locally

```bash
npm install
cp .env.example .env        # then set CARRY_NAMESPACES with your own tokens
npm run dev                 # starts on :8080 (tsx watch)
```

Verify:

```bash
npm run smoke               # storage + auth cores, no network
npm run typecheck
npm test                    # full vitest suite
```

## The CLI (compile + push a pack)

carry ships a small CLI (`bin: carry`, or `node dist/cli.js` after `npm run build`)
that compiles one or more Markdown files into a single pack, stamps its metadata
(`source`, `title`, `gitHash`, `builtAt`), and pushes it:

```bash
# Build the CLI once
npm run build

# Push a pack (write token from $CARRY_WRITE_TOKEN or --token)
node dist/cli.js push --url https://your-instance.example.com/mcp \
  --from ./context/identity.md ./context/voice.md --title "My Claude context"

# Read the current pack back (read/write token from env or --token)
node dist/cli.js get --url https://your-instance.example.com/mcp
```

Tokens are read from `CARRY_WRITE_TOKEN` / `CARRY_READ_TOKEN` in the environment
(never passed on the command line unless you use `--token`).

## Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)):

| Variable | Required | Purpose |
|---|---|---|
| `CARRY_NAMESPACES` | **yes** | JSON array of `{namespace, readToken, writeToken}`. Read ≠ write. The single source of auth. Server fails loudly on bad config. |
| `PORT` | no | HTTP port. Default `8080`; hosts like Render inject it. |
| `CARRY_DB_URL` | no | Durable storage. Unset = in-memory (dev; lost on restart). `file:/data/carry.db` for an on-disk SQLite/libSQL file, or `libsql://…` for hosted Turso. |
| `CARRY_DB_AUTH_TOKEN` | no | Auth token for a hosted Turso `libsql://` URL. |
| `CARRY_RATE_LIMIT_PER_MIN` | no | Fixed-window limit on `POST /mcp`, keyed by IP and token. Default `120`. |
| `CARRY_OAUTH_ISSUER` | no | **On-switch for OAuth mode.** Your authorization server / AuthKit domain (JWT `iss`). Unset = OAuth disabled. |
| `CARRY_OAUTH_AUDIENCE` | if issuer set | carry's canonical MCP URL, registered as the OAuth resource indicator (JWT `aud`). |
| `CARRY_OAUTH_NAMESPACE` | if >1 namespace | Which namespace OAuth callers map to (read scope). Defaults to the sole namespace when there's only one. |
| `CARRY_OAUTH_JWKS_URL` | no | Override for the JWKS endpoint. Defaults to `${issuer}/oauth2/jwks`. |

## Deploy your own

The included [`render.yaml`](render.yaml) Blueprint stands up a Docker web service
with a persistent disk for the libSQL file. Step-by-step (fork → tokens → deploy →
attach the connector) is in [`docs/deploy.md`](docs/deploy.md); day-two operations
(token rotation, backups) are in [`ops/runbook.md`](ops/runbook.md).

## Roadmap

- **Lock-to-user** — allowlist a specific `sub`/email in OAuth mode (closes the
  known limitation above).
- **Multi-tenant** — namespace provisioning + per-namespace tokens in a DB behind
  the `ContextStore` interface, minimal signup, isolation tests.
- An accumulating memory layer as an alternative to a single deterministic pack.

## How it's built

TypeScript (strict, ESM, Node ≥20). Express entry, the official MCP SDK's Streamable
HTTP transport in stateless mode, a `ContextStore` interface with in-memory and
libSQL implementations selected by env, structured per-request logging (never logs
tokens or content), and a fixed-window rate limiter. Auth is a small, separately
tested module (static tokens + optional `jose`-backed JWT verification). The test
suite runs offline (injected local JWKS for the OAuth path).

## Contributing

Issues and PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0. See [`LICENSE`](LICENSE).
