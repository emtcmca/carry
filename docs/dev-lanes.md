# carry — distributed dev lanes (merge-train)

How build work on carry is split across coordinated lanes, each in its own git
worktree on its own branch, reporting to a master coordinator. Mirrors the
BoardPath `hoa-wt-*` merge-train (ADR-0009) pattern.

The point of lanes is **non-overlapping file ownership**: two lanes never edit the
same file, so parallel work does not collide at merge time. A lane that needs a
change outside its ownership does not make it — it requests it from the owning lane
through the coordinator.

## The coordinator (master)

The **main Claude Code session** is the coordinator. It is the only actor that:
- owns `main` and performs every merge (`--no-ff`, after gates pass);
- decides merge order and resolves cross-lane contract changes;
- runs the merge-train gates before any lane lands;
- holds every human-approval, publish, and push gate.

The coordinator does not write lane code itself; it dispatches lanes, verifies
their diffs against ownership, runs the gates, and integrates.

## Lanes

| Lane | Worktree | Branch | Owns (may edit) | Must NOT touch |
|------|----------|--------|-----------------|----------------|
| **core** | `../carry-wt-core` | `feat/core` | `src/server.ts`, `src/index.ts`, `src/auth.ts`, `src/store.ts`, `src/store-factory.ts`, `src/libsql-store.ts`, `src/pack.ts`, `tests/store.test.ts`, `tests/persistence.test.ts`, server/auth deps in `package.json` | `src/cli.ts`, `src/compiler.ts`, `Dockerfile`, `render.yaml`, docs |
| **cli** | `../carry-wt-cli` | `feat/cli` | `src/cli.ts`, `src/compiler.ts`, `scripts/` (cli-related), `tests/cli.test.ts`, `tests/compiler.test.ts`, `bin` field usage | `src/server.ts`, `src/index.ts`, `src/store*.ts`, `src/auth.ts`, `Dockerfile`, `render.yaml` |
| **deploy** | `../carry-wt-deploy` | `feat/deploy` | `Dockerfile`, `.dockerignore`, `render.yaml`, `docs/deploy.md`, `ops/` | `src/**`, `tests/**` |
| **docs** | `../carry-wt-docs` | `feat/docs` | `README.md`, `docs/*.md` (except `deploy.md`), `docs/launch/`, `examples/` | `src/**`, `tests/**`, `Dockerfile`, `render.yaml`, `package.json` |

**core is the contract authority.** Only core may change the public shape of the
server, auth, or store (tool signatures, the env contract, the `ContextStore`
interface). cli and deploy consume those as black boxes:
- cli talks to a running server over `POST /mcp` (`push_context`), and reads the
  env contract (`CARRY_NAMESPACES`, write token). If cli needs an API change, it
  files the request with the coordinator; core makes it; cli rebases.
- deploy starts the server via `npm start` and wires env (`PORT`, `CARRY_NAMESPACES`,
  `CARRY_DB_URL`). It changes no code.

## Merge-train gates

A lane branch merges to `main` only when the coordinator confirms all of:

1. `npm run typecheck` — clean.
2. `npm test` — all green.
3. `npm run smoke` — green (and `scripts/http-smoke.ts` when the change is server-facing).
4. **Diff stays inside the lane's ownership.** Any file outside the table above is a
   stop: the coordinator reassigns the change to the owning lane.
5. Eric approves anything user-facing, and any `git push`. carry is NOT BoardPath, so
   the ADR-0009 push pre-authorization does **not** apply here — every push needs Eric.

## Merge order

When a contract changed this round: **core merges first**, then cli / deploy / docs
rebase onto the new `main` and merge in any order. When no contract changed, order is
free. Each merge is `--no-ff` so the lane stays one revertable unit.

## Lifecycle

- Create a lane worktree: `git worktree add -b feat/<lane> ../carry-wt-<lane> main`.
- Work happens in that worktree only; the builder there runs `git branch --show-current`
  before any write (parallel sessions switch branches under you).
- After merge, retire the worktree: `git worktree remove ../carry-wt-<lane>` and delete
  the branch — **branch deletion requires Eric's confirmation.**

## Current lane assignments (slices from build-plan.md)

- **cli** → Slice 3 (the `carry` CLI + pack compiler).
- **deploy** → Slice 4 (Dockerfile + render.yaml Blueprint; deploy Eric's instance).
- **docs** → Slice 5 prep (launch content draft; not published until slice 4 is live).
- **core** → standing; hardening, multi-tenant groundwork, any contract change a lane needs.
