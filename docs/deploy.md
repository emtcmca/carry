# Deploying carry

carry is a tiny remote MCP server: push a context pack from Claude Code at your
desk, read it from Claude mobile on the go. This guide takes you from a fork to a
live instance your phone can attach to, using the one-click Render Blueprint
([`render.yaml`](../render.yaml)) in this repo.

Everything here is self-host: your instance, your tokens, your data.

---

## What you get

One Render **web service** running the [`Dockerfile`](../Dockerfile) in this repo,
with a **1 GB persistent disk** mounted at `/data` holding the libSQL/SQLite file
(`file:/data/carry.db`). Your pack survives restarts and redeploys.

> **Paid-tier note (read this first):** persistent disks require a **paid** Render
> instance type. The Blueprint sets `plan: starter` for exactly this reason. On the
> **free** tier there is **no persistent disk** — the app falls back to writing in
> the container's ephemeral filesystem, so your pack is **lost on every restart or
> redeploy**. Free is fine to kick the tires; use `starter` or higher for anything
> you rely on.
>
> **Cold-start note:** free and low instance types **spin down when idle** and take
> a few seconds to wake on the next request. The first `get_context` after an idle
> period may be slow while the container cold-starts; subsequent calls are fast.

---

## Step 1 — Fork and clone

1. Fork this repo to your own Git host (GitHub/GitLab), then clone your fork:

   ```powershell
   git clone https://github.com/<you>/carry.git
   cd carry
   ```

**Verify:** `ls` shows `Dockerfile`, `render.yaml`, and `package.json` at the repo root.

---

## Step 2 — Generate strong read + write tokens

Each namespace needs **two distinct** secrets:

- a **read token** — what your Claude mobile connector presents (read-only), and
- a **write token** — what Claude Code / CI presents to push a new pack.

They **must differ**, so a leaked read connector can never overwrite your pack.

Generate two strong random tokens. In **PowerShell** (the one-liner from
[`.env.example`](../.env.example), run it twice):

```powershell
[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }))
```

Run it once for the read token, once for the write token. Keep both somewhere safe
(a password manager) — you paste them into Render next and can't recover them from
Render later.

**Verify:** you have two different ~44-character base64 strings.

---

## Step 3 — Build your `CARRY_NAMESPACES` value

`CARRY_NAMESPACES` is a JSON array of namespaces. For a single user (just you), it
is one object. Paste your two tokens from Step 2 in place of the placeholders:

```json
[{"namespace":"me","readToken":"PASTE_READ_TOKEN","writeToken":"PASTE_WRITE_TOKEN"}]
```

Keep it on **one line** — you'll paste it as a single environment-variable value.

**Verify:** it starts with `[{` and ends with `}]`, and `readToken` ≠ `writeToken`.

---

## Step 4 — Deploy via the Render Blueprint

1. In the Render dashboard, click **New +** → **Blueprint**.
2. Connect your Git account and pick your **carry** fork.
3. Render reads [`render.yaml`](../render.yaml) and shows one web service, `carry`,
   on the `starter` plan with a `carry-data` disk. Confirm the plan is one that
   supports a disk (see the paid-tier note above).
4. Render prompts for the `sync: false` env vars (they aren't stored in the
   Blueprint). Set:
   - **`CARRY_NAMESPACES`** → the one-line JSON from Step 3. **(required)**
   - **`CARRY_DB_AUTH_TOKEN`** → leave **blank** unless you're using hosted Turso
     instead of the on-disk file (see "Turso path" below). **(optional)**
   - `CARRY_DB_URL` and `PORT` are handled for you: `CARRY_DB_URL` is preset to
     `file:/data/carry.db` in the Blueprint, and Render injects `PORT` automatically.
5. Click **Apply** / **Create**. Render builds the Docker image and deploys.

**Verify:** the service reaches **Live** in the dashboard, and the deploy logs show
`carry listening on :<port> (1 namespace(s))`.

---

## Step 5 — Confirm `/healthz`

Once live, Render shows your service URL, e.g. `https://carry-xxxx.onrender.com`.
Health-check it (Render also polls `/healthz` itself, per the Blueprint):

```powershell
curl https://carry-xxxx.onrender.com/healthz
```

**Verify:** you get JSON like `{"ok":true,"service":"carry","namespaces":1}`.
(On free/idle instances, allow a few seconds for cold-start on the first hit.)

---

## Step 6 — Add the connector on claude.ai (web), then use it on mobile

You attach the remote MCP connector **once on the web**; it then syncs to your phone.

1. Go to **claude.ai** in a browser → **Settings** → **Connectors** (a.k.a. custom
   connectors / MCP servers) → **Add custom connector**.
2. Enter:
   - **URL:** `https://carry-xxxx.onrender.com/mcp`  ← note the **`/mcp`** path.
   - **Authentication:** Bearer token → paste your **READ token** from Step 2.
3. Save. Claude discovers the `get_context` tool (and the `carry://context` resource).

**Verify (web):** in a new chat, ask Claude to call `get_context` — it returns your
current pack (or an empty pack if you haven't pushed one yet). Open the **Claude
mobile app** with the same account; the connector appears there too, and mobile can
read the live pack.

To **push** a pack from your desk, point Claude Code / the `carry` CLI at the same
`/mcp` URL with the **WRITE token**. Update from the desk, and mobile reads the new
pack on its next call.

---

## Turso path (optional, no disk)

Prefer a hosted libSQL DB over the Render disk? Instead of the `file:` URL:

1. Create a Turso database and an auth token.
2. In Render, override the env vars:
   - `CARRY_DB_URL` → `libsql://your-db.turso.io`
   - `CARRY_DB_AUTH_TOKEN` → your Turso token (the `sync: false` slot from Step 4).
3. You can then drop the disk from `render.yaml` and run on a cheaper/free instance
   (state lives in Turso, not on local disk). Cold-start still applies on free tiers.

---

## Troubleshooting

- **Boot fails immediately, logs mention auth/namespaces:** `CARRY_NAMESPACES` is
  missing or not valid JSON. The server fails loudly on bad auth config by design —
  recheck Step 3 (one line, distinct tokens, valid array).
- **`/healthz` ok but pack empties after a redeploy:** you're on a tier without a
  persistent disk (free), or `CARRY_DB_URL` isn't pointing at the mount. Confirm a
  paid plan with the `carry-data` disk and `CARRY_DB_URL=file:/data/carry.db`.
- **401 from the connector:** you pasted the wrong token. Mobile/read uses the
  **read** token; pushing uses the **write** token.

See [`../ops/runbook.md`](../ops/runbook.md) for token rotation, backups, and
day-to-day operations.
