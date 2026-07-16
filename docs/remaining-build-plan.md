# carry — remaining build plan (gap-informed)

> **STATUS 2026-07-16:** Round A (all), B-3, C-2, CI, the B-2 spike, **B-1 deploy (live)**, and
> **B-2 OAuth implementation (WorkOS AuthKit, off-by-default)** are DONE and on `main` (128 tests).
> Scope fork resolved = **personal + OSS now** (Round D deferred).
>
> **B-2 spike #1 risk CONFIRMED, then fixed:** the claude.ai web custom-connector dialog is
> **OAuth-only** on personal accounts — pasting carry's bearer read token is impossible (verified
> live: the dialog ran OAuth DCR and rejected the non-OAuth server). Fix built: carry is now an
> OAuth 2.1 **protected resource**; **WorkOS AuthKit** (free tier; hosts login+consent+DCR; no
> self-hosted frontend) is the authorization server. carry serves PRM + a 401 challenge + JWT
> validation (`jose`); OAuth callers are READ-only; Claude Code's static WRITE bearer is unchanged.
> OFF unless `CARRY_OAUTH_ISSUER` is set, so `main` stays deployable and existing behavior is intact.
>
> Everything left is **human-gated**: B-2 live connect (WorkOS dashboard + 2 Render env vars +
> re-add connector), B-4 all-surfaces verify, C-1 `/li` wiring, C-3 publish. See `docs/handoff.md`
> §0 for the exact state.

Derived from the promptsmith lens review (skeptic / api-design / security / data-integrity /
product / ux). Organized into rounds; each round is a set of lane slices. Sequenced so the
foundational data-model and write-safety changes land BEFORE feature and deploy work builds
on them. `core` is the contract authority; when it changes the pack schema or store
interface, cli/deploy/docs rebase onto the new `main` before their slices.

## Decision fork (confirm before Round A)
- **Personal tool** (self-host, ship now, OSS) vs **seamless product** (hosted multi-tenant).
- **Recommendation:** ship the personal + OSS self-host path now (Rounds A–C). Treat hosted
  multi-tenant (Round D) as a separate, later, opt-in decision after the personal tool proves
  the value. Reason: hosted SaaS is a large build competing with your job search and BoardPath;
  the personal tool delivers the whole "seamless across my devices" value without it.

## Round A — foundations (core lane) — blocks everything downstream
- **A1** Pack model v2: store keyed by `(namespace, packName)`, not just namespace. Add a
  `packName` arg to `get_context` / `push_context` and a parametrized resource
  `carry://context/{pack}`; default name `"default"` for back-compat. Lets context compose
  from several named packs (voice + systems + project). [fixes skeptic ❌, api ⚠️]
- **A2** DB migration path: a `schema_version` table + forward migrations, so the pack schema
  can evolve without hand-editing prod. Stamp a `packSchema` version in the pack. [data-integrity ⚠️, api ❌]
- **A3** Write safety: `crypto.timingSafeEqual` token compare (and delete the overclaiming
  "constant-time-ish" comment); `push_context` accepts optional `expectedVersion` → **409** on
  mismatch (optimistic concurrency for multi-writer); explicit max-pack-size validation with a
  clear error. [security ❌, api ❌]
- **A4** Version history: append-only `packs_history`; `get_context` accepts an optional
  `version`; add `list_versions` + `restore_version`. Kills silent last-writer-wins data loss. [data-integrity ❌]
- Gate: typecheck + test + smoke; the new contract is documented for cli/deploy to consume.

## Round B — seamless setup (deploy + core + cli) — the goal
- **B1** deploy: Deploy Eric's instance live on Render (human-approval gate). Real tokens;
  verify `/healthz` + a real push/get end to end.
- **B2** core: Connector-auth seamlessness. SPIKE done (`docs/connector-auth-spike.md`) → the web
  connector dialog is OAuth-only on personal accounts (confirmed live), so bearer-paste is
  impossible. **IMPLEMENTATION DONE:** carry is an OAuth 2.1 protected resource backed by WorkOS
  AuthKit (off-by-default via `CARRY_OAUTH_ISSUER`); new file `src/oauth.ts` (PRM + 401 challenge +
  `jose` JWT verify), `authenticate()` orchestrator in `src/auth.ts` (static-first, JWT fallback),
  `GET /.well-known/oauth-protected-resource` in `src/index.ts`. OAuth callers are READ-only. New
  env: `CARRY_OAUTH_ISSUER` / `CARRY_OAUTH_AUDIENCE` / `CARRY_OAUTH_NAMESPACE` (opt) /
  `CARRY_OAUTH_JWKS_URL` (opt). **Remaining = live connect (human gate):** WorkOS dashboard (issuer,
  resource indicator = audience, enable DCR+CIMD) + set the 2 Render env vars + re-add the connector.
  [skeptic ❌, ux ❌]
- **B3** cli: `carry init` — generate read/write tokens, write `.env`, and print the exact
  connector config (URL + auth) and claude.ai setup steps per surface. Add `carry status`
  (whoami) so a surface can confirm it is reading the live pack. [ux ❌/⚠️]
- **B4** deploy + coordinator: All-surfaces verification — add the connector on claude.ai web;
  confirm **mobile AND desktop** read the pack; explicitly verify desktop connector support
  (the assumed-but-unverified gap). Human-in-the-loop.
- Gate + Eric approval on anything user-facing / push / deploy.

## Round C — real use + integration (cli + core + docs)
- **C1** cli (cross-repo): `/li` wiring — a thin step in the linkedin repo that compiles
  `voice.md` + `voice-calibration.md` and `carry push`es to Eric's instance on change. Closes
  the original loop this whole thing started from.
- **C2** core + coordinator: rate limiting on `/mcp`; structured request logging (request id,
  no secrets); **CI** (GitHub Actions: typecheck + test on push/PR). [security ❌, cross-cutting]
- **C3** docs: run the launch draft through the `/li` critic loop (instance now live) and
  publish; add a success-metrics note (time-to-first-synced-pack < 5 min; 0 manual re-syncs). [product ⚠️]
- Gate.

## Round D — hosted product (DEFERRED, decision-gated)
- **D1** core: multi-tenant — namespace provisioning, per-user tokens in a DB (Postgres driver
  behind `ContextStore`), isolation tests, rate limits, abuse controls.
- **D2** deploy: hosted deployment (not self-host) + signup.
- **D3** docs: product landing.
- Build only if the personal tool proves the value and Eric chooses to productize.

## Lane load
| Lane | Slices |
|------|--------|
| **core** | A1, A2, A3, A4, B2, C2(part), D1 — heaviest; owns contract + safety + data model |
| **cli** | B3, C1 |
| **deploy** | B1, B4, D2 |
| **docs** | C3, D3 |
| **coordinator (main session)** | all merges, gates, CI setup, and every deploy/push/publish human gate; sequences cross-lane contract changes |

## Merge-train discipline (unchanged)
Round A (core, a contract change) merges first; cli/deploy/docs rebase onto the new `main`
before starting their rounds. Every slice: its own worktree, ownership-diff check,
typecheck + test + smoke, and Eric's approval on anything user-facing, pushed, deployed, or published.
