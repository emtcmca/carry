# carry — session handoff

Snapshot for starting a fresh Claude Code session in `C:\Dev\carry`. Written 2026-07-15, updated 2026-07-16.
Read this, then `docs/remaining-build-plan.md` (the work) and `docs/dev-lanes.md` (how work is split).

---

## 0. Read-me-first: current status

**`main` is green: typecheck clean, 128 tests, smoke passing.** Instance is **LIVE** at
`https://carry-abxf.onrender.com` (Render starter + persistent disk; write+read paths verified
end-to-end via the CLI on 2026-07-16). Landed across sessions:
- **Round A**: pack model v2 `(namespace, packName)`, migrations + `packSchema`, timing-safe token
  compare, optimistic concurrency (`expectedVersion` → conflict), max pack size, append-only version
  history (`list_versions` / `restore_version` / `get_context version`).
- **B-3** (`carry init` + `carry status`), **C-2** (rate limiting + structured `/mcp` logging),
  **CI** (GitHub Actions typecheck+test), **B-2 spike** (`docs/connector-auth-spike.md`).
- **B-1 deploy** — live instance stood up 2026-07-16.
- **B-2 OAuth (WorkOS AuthKit)** — the connector-auth fix. See below.

**⚠️ THE B-2 SPIKE RISK IS CONFIRMED — and fixed.** Verified live on Eric's account: the claude.ai
**web** custom-connector dialog is **OAuth-only** (it exposes only OAuth Client ID/Secret; clicking
Add with them blank fired OAuth Dynamic Client Registration and failed with "Couldn't register with
Carry's sign-in service"). Pasting a bearer read token is **impossible** on a personal account, so
the old mobile/desktop read path (deploy.md Step 6) is dead. GitHub `claude-ai-mcp` #112/#411 were
correct. Claude Code's **write** path (`--header "Authorization: Bearer …"`) is unaffected and works.

**The fix (built, on `main`, OFF by default):** carry is now an OAuth 2.1 **protected resource**.
A hosted authorization server (**WorkOS AuthKit** — free tier; hosts login+consent+DCR; no
self-hosted frontend, which is why it beat Stytch) issues JWTs; carry serves PRM
(`GET /.well-known/oauth-protected-resource`), a `WWW-Authenticate` 401 challenge, and validates the
JWT with `jose`. OAuth callers get **READ scope only** (pushes stay on the Claude Code static WRITE
token). Enabled only when `CARRY_OAUTH_ISSUER` is set, so `main` stays deployable and every existing
behavior/test is unchanged. Code: `src/oauth.ts` (new), `authenticate()` in `src/auth.ts`, wiring in
`src/index.ts`, `tests/oauth.test.ts` (+22 tests). Two `[unverified]`-until-live items: the JWKS
path `${issuer}/oauth2/jwks` (override via `CARRY_OAUTH_JWKS_URL`) and whether Claude's DCR client
accepts the exact challenge/PRM shape — both resolve at first live connect.

**What remains is HUMAN-GATED (needs Eric):**
1. **B-2 live connect** — WorkOS dashboard (create app; note the `*.authkit.app` domain = issuer;
   register `https://carry-abxf.onrender.com/mcp` as a Resource Indicator = audience; enable DCR +
   CIMD) → set `CARRY_OAUTH_ISSUER` + `CARRY_OAUTH_AUDIENCE` on Render → redeploy → re-add the
   connector on claude.ai web (now OAuth discovery succeeds → WorkOS consent → token → carry reads).
2. **B-4** all-surfaces verification (mobile + desktop actually read the pack once OAuth is live).
3. **C-1** `/li` wiring in `C:\dev\linkedin` (compiles voice.md + voice-calibration.md, `carry push`
   to the live instance with the WRITE token). Scouted: targets `knowledge/voice.md` +
   `knowledge/voice-calibration.md`; repo uses `.claude/commands/li-*.md`. Buildable now.
4. **C-3** publish the launch post (`docs/launch/linkedin-carry-draft.md`) after B-2 live + B-4.

**origin push:** the OAuth slice is committed to `main` locally and NOT yet pushed — needs Eric's ok.

---

## 1. What carry is

A tiny **remote MCP server** that carries a context pack (voice rules, system facts, style
guide) between every Claude surface a user has: push from Claude Code at the desk, read from
Claude mobile / desktop. It exists because there is no public API to write Claude Project
knowledge, so this is the drift-free way to keep all surfaces in sync. Mobile and desktop can
*use* remote MCP connectors (configured once on claude.ai web, synced to devices).

- **Repo (public):** https://github.com/emtcmca/carry — Apache-2.0.
- **Local:** `C:\Dev\carry` (main worktree).
- **Goal (refined):** one server connecting mobile + Claude Code + desktop on any device, as
  frictionless as possible. Scope decision made: **personal + OSS self-host now**; hosted
  multi-tenant (Round D) deferred.

## 2. State snapshot (2026-07-15)

- Branch `main` at `dde9a00`. **`origin/main` is 1 commit behind** (the remaining-build-plan
  commit is local-only) — push needs Eric's ok.
- **Built + verified:** Slice 1 (MCP server), Slice 2 (durable libSQL + graceful shutdown),
  Slice 3 (CLI + compiler), Slice 4 (Dockerfile + render.yaml + deploy docs). **36 tests pass,
  typecheck clean.** NOT deployed anywhere yet.
- Lane worktrees exist (see §5). cli/deploy/docs branches are merged into `main`; their
  worktrees sit on their (now-merged) branches and will need a `git merge main --ff-only`
  before their next slice.

## 3. Architecture + file map

```
src/
  index.ts          Express entry. POST /mcp (stateless Streamable HTTP), GET /healthz,
                    graceful SIGTERM/SIGINT shutdown, store selected via createStore().
  server.ts         createMcpServer(store, authCtx): registers tools get_context,
                    push_context (write-gated), resource carry://context. One server per
                    request, closed over the caller's AuthContext (the token pins namespace).
  auth.ts           Two-token model: read token (mobile connector) + write token (desk), per
                    namespace, loaded from CARRY_NAMESPACES. bearerFromHeader/resolveToken/hasScope.
  store.ts          ContextStore interface + InMemoryStore. init/get/put/close.
  libsql-store.ts   LibSqlStore (SQLite on disk / Turso). Auto-creates parent dir (error-14 fix).
  store-factory.ts  createStore(): CARRY_DB_URL set -> libSQL, else in-memory (loud warning).
  pack.ts           ContextPack / IncomingPack types. carry never parses pack content.
  cli.ts            `carry` CLI (push/get/--help). Zero-dep argv parser. Uses official MCP client.
  compiler.ts       compilePack(): concat source files + stamp meta (gitHash/builtAt injected).
tests/              store.test.ts (contract over both stores), persistence.test.ts (durability),
                    cli.test.ts, compiler.test.ts.  (A-i is adding multi-pack cases.)
scripts/            smoke.ts (auth+store cores), http-smoke.ts (real MCP client e2e).
Dockerfile, .dockerignore, render.yaml   deploy artifacts (glibc/bookworm for libsql).
docs/               build-plan.md (slice status), remaining-build-plan.md (rounds A-D),
                    dev-lanes.md (lane system), deploy.md, this handoff.
ops/runbook.md      token rotation, health, backup, in-memory-fallback warning.
LICENSE             Apache-2.0.
```

### MCP surface (the contract)
- `get_context()` -> current pack text for the caller's namespace.
- `push_context({ content, meta? })` -> replace pack; requires write token.
- resource `carry://context` -> same pack.
- (A-i in flight adds optional `packName`, a `list_packs` tool, resource `carry://context/{pack}`,
  and a `packSchema` version — confirm final shape from the A-i report / the code.)

### Env contract
- `PORT` (Render-managed; default 8080 locally)
- `CARRY_NAMESPACES` — JSON array `[{namespace, readToken, writeToken}]`; read != write (enforced).
- `CARRY_DB_URL` — `file:/data/carry.db` on Render disk, or `libsql://...` for Turso; unset = in-memory.
- `CARRY_DB_AUTH_TOKEN` — only for Turso.

### CLI contract
```
carry push --url <mcpUrl> --from <file1> [file2 ...] [--title <t>] [--token <writeToken>]
carry get  --url <mcpUrl> [--token <readOrWriteToken>]
carry --help
```
Token order — push: `--token` -> `CARRY_WRITE_TOKEN`. get: `--token` -> `CARRY_READ_TOKEN` -> `CARRY_WRITE_TOKEN`.

## 4. Key commands

```bash
npm install
npm run dev            # tsx watch, :8080
npm run typecheck      # tsc --noEmit
npm test               # vitest (36 tests as of this handoff)
npm run smoke          # auth + store cores, no network
npm run build && npm start   # production path
# e2e over HTTP (server must be running with test env): tsx scripts/http-smoke.ts
```
Local server env for manual testing:
`export CARRY_NAMESPACES='[{"namespace":"eric","readToken":"r_tok","writeToken":"w_tok"}]'`

## 5. Lane system (how work is split) — see docs/dev-lanes.md

Coordinator = the main session. It owns all merges, gates, and every push/deploy/publish gate.
Lanes work in their own worktrees with NON-OVERLAPPING file ownership:

| Lane | Worktree | Owns |
|------|----------|------|
| core | `../carry-wt-core` | server/auth/store/pack + their tests — the CONTRACT AUTHORITY |
| cli | `../carry-wt-cli` | `cli.ts`, `compiler.ts`, their tests |
| deploy | `../carry-wt-deploy` | Dockerfile, render.yaml, docs/deploy.md, ops/ |
| docs | `../carry-wt-docs` | README, docs/*.md (not deploy.md/dev-lanes.md), docs/launch/ |

Scoped lane agents live in `.claude/agents/lane-*.md`. Merge-train gates before any lane
merges: typecheck + test + smoke + ownership-diff-check + Eric approval on user-facing/push.

## 6. Gap analysis (promptsmith lenses) — top 3, drives Round A/B

1. **Data model:** one-pack-per-namespace is too coarse -> key by `(namespace, packName)` +
   versioned pack schema + migration path. (A-i is doing this.)
2. **Seamless setup:** per-surface bearer-token paste fights the goal -> OAuth connector spike
   + `carry init` that provisions tokens and prints exact per-surface config. (Round B.)
3. **Write safety:** constant-time token compare (currently plain `===`), optimistic concurrency
   (`expectedVersion` -> 409), version history, rate limiting. (A-ii + Round C.)

Full findings and the round-by-round plan are in `docs/remaining-build-plan.md`.

## 7. Conventions (carry-specific)

- TypeScript strict, ESM, Node >=20. Bias to zero/near-zero runtime deps.
- kebab-case files; YYYY-MM-DD in any dated filename.
- **Git:** branch per feature off `main`; small working commits; merge `--no-ff`.
  **Every `git push` needs Eric's explicit ok** — carry is NOT BoardPath, so no ADR-0009
  push pre-authorization applies here. Branch deletion needs Eric's ok too.
- **Pre-commit gate:** before each commit create the sentinel
  `New-Item -Force "C:\Users\tetzl\.claude\.pre-commit-ready" -ItemType File`, and update any
  task/plan docs in the same commit.
- Commit messages via `git commit -F <file>` (Windows quoting); Co-Authored-By trailer.

## 8. Gotchas found this session (don't re-learn these)

- **libSQL needs glibc, not musl** — Docker base is `node:22-bookworm`, never alpine, or the
  native binding fails to load.
- **libSQL opens the DB file eagerly and won't create parent dirs** — `LibSqlStore` mkdirs the
  parent before `createClient`, else SQLite error 14 (CANTOPEN) on a clean disk.
- **Windows locks the SQLite file until process exit** — tests clean the DB dir in `beforeAll`
  (fresh process, no lock), never `afterAll`. Test DB dirs are gitignored.
- **`npx tsx src/index.ts &` orphans a child node process** that keeps holding the port after
  you kill the parent PID. When smoke-testing over HTTP, kill by port
  (`Get-NetTCPConnection -LocalPort <p>`), not just the npx PID, or you get EADDRINUSE + a
  false-pass from the ghost server.
- Stateless Streamable HTTP + the official MCP `Client` works end to end (initialize + tool
  calls) — no session bookkeeping needed for this read-mostly relay.

## 9. Open items

- **Deploy (B1):** not done — Eric-in-the-loop Render step. Blocks all-surfaces verification
  and publishing the launch post (`docs/launch/linkedin-carry-draft.md`, gated).
- **`/li` wiring (C1):** cross-repo — a step in `C:\dev\linkedin` that compiles voice.md +
  voice-calibration.md and `carry push`es to Eric's live instance. Needs B1 first.
- **origin push:** `main` is 1 ahead of `origin/main`; push when Eric approves.
- **CI:** none yet (Round C) — add GitHub Actions typecheck+test.

## 10. First moves in the new session

1. `git -C C:/Dev/carry status -sb` and `git -C C:/Dev/carry-wt-core status --short` — reconcile
   with §0 (is A-i done/committed/merged?).
2. `npm install && npm test` in `C:\Dev\carry` — confirm green baseline.
3. Read `docs/remaining-build-plan.md`; continue Round A (finish A-i integration, then A-ii),
   or jump to B1 deploy if Eric wants his instance live first.
