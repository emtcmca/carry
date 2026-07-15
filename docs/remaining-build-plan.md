# carry — remaining build plan (gap-informed)

> **STATUS 2026-07-15:** Round A (all), B-3, C-2, CI, and the B-2 spike are DONE and on `main`
> (106 tests). Scope fork resolved = **personal + OSS now** (Round D deferred). Everything left
> is **human-gated**: B-1 deploy, B-4 all-surfaces verify, C-1 `/li` wiring, C-3 publish. See
> `docs/handoff.md` §0 for the exact state and the #1 risk (bearer-in-web-connector, per the B-2 spike).

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
- **B2** core: Connector-auth seamlessness. SPIKE first — does Claude custom-connector **OAuth**
  fit carry (config once, no per-surface token paste)? If yes, implement it; if not, document
  the tightest bearer flow. [skeptic ❌, ux ❌]
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
