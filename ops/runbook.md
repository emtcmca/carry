# carry — operations runbook

Day-to-day operations for a deployed carry instance. First-time deploy lives in
[`../docs/deploy.md`](../docs/deploy.md); this file is what you reach for after
it's live.

---

## Health check

- **Endpoint:** `GET /healthz` → `{"ok":true,"service":"carry","namespaces":N}`.
- Render polls it automatically (`healthCheckPath: /healthz` in `render.yaml`); a
  failing check blocks a bad deploy from going live.
- Manual check:

  ```powershell
  curl https://<service>.onrender.com/healthz
  ```

- The container also self-checks via the Dockerfile `HEALTHCHECK` (Node fetch to
  `/healthz` every 30s). `docker ps` shows `healthy`/`unhealthy` when run locally.
- On free/idle instances the **first** hit after idle may be slow (cold-start);
  that's expected, not an outage.

---

## Rotating a token

Tokens live only in the `CARRY_NAMESPACES` env var — there's no separate secret
store. To rotate:

1. Generate a new token (PowerShell):

   ```powershell
   [Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }))
   ```

2. In the Render dashboard → your `carry` service → **Environment**, edit
   `CARRY_NAMESPACES` and replace the `readToken` and/or `writeToken` for the
   affected namespace. Keep read ≠ write.
3. Save. Render restarts the service with the new value (the disk/data is
   untouched — see "What a restart does to data").
4. Update every client that used the old token:
   - **Read token** → update the connector on claude.ai (Settings → Connectors →
     the carry connector → auth). Mobile picks up the change after web is updated.
   - **Write token** → update Claude Code / CI (the pusher).

**Rotate immediately if** a token leaks. Rotating the **read** token does not
affect your ability to push; rotating the **write** token does not lock out
readers. They're independent by design.

---

## What a restart does to data

- **With the persistent disk (paid tier):** nothing is lost. The libSQL file lives
  at `/data/carry.db` on the `carry-data` disk, which is remounted across restarts,
  redeploys, and instance moves. The app closes the DB cleanly on `SIGTERM`
  (Render's restart signal), so writes are flushed.
- **Without a disk (free tier):** the pack is written to the container's ephemeral
  filesystem and is **lost on every restart/redeploy**. This is effectively the
  in-memory fallback with extra steps — do not rely on it (see warning below).

---

## Backing up the SQLite file

The whole state is one file: `/data/carry.db` (plus a transient `-journal` /
`-wal` sidecar). To back it up:

1. Open a shell on the instance (Render dashboard → your service → **Shell**).
2. Copy the file somewhere you can retrieve it, e.g.:

   ```bash
   cp /data/carry.db /data/carry.backup.$(date +%Y-%m-%d).db
   ```

   Then download it via the Render Shell, or push it to object storage you control.
3. **Restore** is the reverse: stop traffic (or accept a brief window), copy a
   backup over `/data/carry.db`, and restart the service.

Because a pack is easy to regenerate from your repo (re-push with the write token),
the DB is convenient-to-restore state, not irreplaceable state — but back it up if
your pack encodes anything you can't trivially rebuild.

> Tip: prefer copying `carry.db` when the service is idle, so no write is mid-flight.
> For a fully consistent snapshot, restart first (clean `SIGTERM` flush) then copy.

---

## In-memory fallback warning

If **`CARRY_DB_URL` is unset**, carry starts in **in-memory mode** and logs, loudly:

```
[carry] CARRY_DB_URL is not set: using in-memory store. Packs will be LOST on
restart. Set CARRY_DB_URL (e.g. file:/data/carry.db) for durable storage.
```

On a deployed instance this is almost always a misconfiguration. The Blueprint sets
`CARRY_DB_URL=file:/data/carry.db` for you — if you see that warning in production
logs, the env var got cleared or the disk isn't mounted. Fix it before pushing a
pack you care about. In-memory mode is intended for local dev only.

---

## Quick reference

| Thing | Value |
|-------|-------|
| Health | `GET /healthz` |
| MCP endpoint | `POST /mcp` (Bearer read token to read, write token to push) |
| Connector URL | `https://<service>.onrender.com/mcp` |
| DB file (durable) | `/data/carry.db` on the `carry-data` disk |
| Restart signal | `SIGTERM` (graceful DB close, then exit) |
| Auth source | `CARRY_NAMESPACES` env var (JSON array) |
