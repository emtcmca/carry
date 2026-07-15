# Connector-auth spike (Round B, B2)

**Question:** Can OAuth (or another mechanism) make carry's connector setup
*meaningfully* more seamless than the pasted bearer token it uses today —
"configure once, every surface has it, no per-device token paste"? If yes,
implement it; if not, document the tightest bearer flow.

**Status:** research + design spike. No code. Sources cited inline (URLs).
Date of research: 2026-07-15. Facts are from Anthropic's own connector docs and
the MCP authorization spec; anything I could not confirm from a primary source is
marked **unverified — confirm by hand**.

---

## TL;DR recommendation

**For the personal + OSS self-host scope (Rounds A–C): do NOT build OAuth.
Ship the bearer token made painless by `carry init` (B3). Revisit OAuth only at
Round D (hosted multi-tenant), where it stops being marginal and becomes the point.**

Reasons, in order of weight:

1. **OAuth does not buy the "configure once, all surfaces" win.** That win is
   already delivered by Anthropic's connector infrastructure, not by the auth
   type. Remote connectors are *account-brokered*: add one on claude.ai web and
   it appears on Claude mobile, Claude Desktop, and Cowork on the same account
   with no re-setup — and that is true whether the credential is a bearer token
   or an OAuth token. OAuth changes *how you authenticate the one time you add
   it* (a consent click vs. a token paste); it does not change *how many surfaces
   you configure*. ([Anthropic — Use connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities), [Anthropic — Desktop vs web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors))

2. **OAuth's genuine wins are marginal for a single-user server you own.**
   Consent-screen UX (no secret handled), token expiry + refresh, and revocation
   via a consent list are real — but for a server where you are the only user,
   you control the box, and you can rotate the bearer token yourself, they don't
   justify the build.

3. **The build cost is large and structurally wrong for a self-host tool.** To be
   OAuth-authorized, carry must either become an OAuth 2.1 authorization server or
   bolt one on (see Finding 2). That is standing up an IdP inside a ~100-line
   stateless Express relay. It also drags in a third-party identity vendor or a
   lot of security-critical surface — the opposite of "your instance, your tokens,
   your data" (`docs/deploy.md`).

**One hard dependency to verify before trusting the bearer path (this is the
real risk, not OAuth):** confirm by hand that a *personal* (Pro/Max, non-org-admin)
claude.ai account can actually enter carry's bearer token in the **web**
custom-connector dialog. Anthropic documents a `static_headers` type for exactly
this, but it is **beta** and described as *admin-entered / org-shared*, and
multiple open/closed GitHub issues report the personal add-by-URL dialog exposes
only OAuth fields with no place to paste a bearer token. If that turns out to be
true for personal accounts, carry's current web+mobile flow (`docs/deploy.md`
Step 6) is broken as written — and the fix is still not "build full OAuth" first
(see Finding 3 fallbacks). This is the single most important thing to ground-truth
by hand.

---

## Findings

### Q1 — Do Claude custom/remote MCP connectors support OAuth, and on which surfaces?

**Yes, OAuth is the first-class path, across all hosted surfaces.** Anthropic's
connector-auth doc lists the supported types, and states: *"The same
infrastructure backs Claude.ai, Claude Desktop, Claude mobile, Claude Code, and
Cowork."* The OAuth types are `oauth_dcr` (Dynamic Client Registration, RFC 7591)
and `oauth_cimd` (Client ID Metadata Document), both **"supported out of the box"**,
plus `oauth_anthropic_creds` (Anthropic-held client credentials, by request). The
spec mandated is **OAuth 2.1 with PKCE (S256)**, not plain OAuth 2.0.
([Anthropic — Authentication for connectors](https://claude.com/docs/connectors/building/authentication);
[MCP authorization spec, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization))

Surfaces: custom connectors are available on Claude.ai web, Claude Desktop,
Claude mobile (mobile install is noted as **beta**), Cowork, and Claude Code.
([Anthropic — Get started with custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp))

**Bearer is also officially supported — but with caveats that matter to carry.**
The same doc lists a `static_headers` type: *"Fixed credential (API key or bearer
token) entered by an organization administrator as a request header when adding
the connector"* — **Availability: Beta**, and *"The credential is shared by the
organization rather than pasted per user."* So a bearer/`Authorization` header is
a documented, supported connector auth type. The open question (Q3 / assumptions)
is whether that field is exposed to a **personal, non-admin** account in the web
add-by-URL dialog:

- Issue #112 ("Cannot configure Authorization: Bearer for custom remote MCP —
  only OAuth client id/secret in advanced settings") was filed 2026-03-22 and
  **closed as *not planned*** — reporter states the web dialog shows only OAuth
  client id/secret, "we cannot complete auth for our MCP from this UI."
  ([Issue #112](https://github.com/anthropics/claude-ai-mcp/issues/112))
- Issue #411 reports the same for a Bearer-token MCP (Crisp). ([Issue #411](https://github.com/anthropics/claude-ai-mcp/issues/411))

These issues predate / sit alongside the `static_headers` beta, so they may be
partly superseded — but they are enough that carry must **not** assume the
personal web UI accepts a bearer paste without confirming it live.

**Claude Code is a separate story and is fine either way.** Claude Code is a
native client configured on the machine, not brokered from the web account. It
accepts a bearer header directly:
`claude mcp add --transport http carry https://carry-xxxx.onrender.com/mcp --header "Authorization: Bearer <WRITE_TOKEN>"`
(stored in `~/.claude.json` / `.mcp.json` as a `headers.Authorization` entry).
So carry's **write path** (push from the desk via Claude Code) works with the
current bearer design regardless of what the web UI does. There is a known bug
class where Claude Code intermittently fails to attach the configured header on
some versions — worth being aware of, not a blocker.
([Claude Code — MCP docs](https://code.claude.com/docs/en/mcp);
[Issue #29562](https://github.com/anthropics/claude-code/issues/29562))

### Q2 — What must a server implement to be an OAuth-authorized MCP connector? Rough effort.

Per the MCP authorization spec and Anthropic's connector-auth doc, an
OAuth-authorized remote MCP server must:

1. **Return `401` with `WWW-Authenticate`** on unauthenticated requests, carrying
   `resource_metadata="…/.well-known/oauth-protected-resource"`. Claude does *not*
   honor `WWW-Authenticate` on a `200`; the `401` is required.
2. **Serve Protected Resource Metadata (RFC 9728)** at
   `/.well-known/oauth-protected-resource` — a JSON doc whose `resource` field
   matches the MCP URL *exactly as the user enters it* and whose
   `authorization_servers` lists the AS issuer URL (first entry wins).
3. **Have an OAuth 2.1 authorization server** that serves its own discovery
   metadata (RFC 8414 / OIDC Discovery) at `/.well-known/oauth-authorization-server`,
   exposing `authorization_endpoint`, `token_endpoint`, and either a
   `registration_endpoint` (DCR, RFC 7591) or CIMD support.
4. **Support PKCE S256** (mandatory) and advertise
   `"code_challenge_methods_supported": ["S256"]`.
5. **Support Resource Indicators (RFC 8707)** — validate the `resource` parameter
   binds the token to carry's canonical URL.
6. **Register redirect URIs:** `https://claude.ai/api/mcp/auth_callback` for the
   hosted surfaces; port-agnostic `http://localhost/callback` + `http://127.0.0.1/callback`
   for Claude Code's loopback flow.
7. **Handle token refresh** — Claude refreshes reactively on `401` (and proactively
   ~5 min before expiry); rotate refresh tokens for public clients; return
   RFC-6749 error codes (`invalid_grant`); `/token` must accept
   `application/x-www-form-urlencoded`; discovery/registration/token endpoints must
   respond within ~10 s.
8. **Scopes** via the `WWW-Authenticate` `scope` param or `scopes_supported`.

([Anthropic — Authentication for connectors](https://claude.com/docs/connectors/building/authentication);
[MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization);
RFC [9728](https://www.rfc-editor.org/rfc/rfc9728) / [8414](https://www.rfc-editor.org/rfc/rfc8414) / [7591](https://www.rfc-editor.org/rfc/rfc7591) / [8707](https://www.rfc-editor.org/rfc/rfc8707) / [7636 PKCE](https://datatracker.ietf.org/doc/html/rfc7636))

**Rough effort.** carry today is a stateless Express relay that does a
constant-time bearer compare (`src/auth.ts`, `src/index.ts`). Two ways to get to
OAuth, both large relative to that baseline:

- **Build the AS in carry** (DCR + token issuance + refresh rotation + PKCE +
  PRM/AS metadata + consent): several days to weeks of security-critical code, and
  carry now stores client registrations and tokens — it stops being stateless and
  gains a real attack surface. **Not advisable for a solo self-host tool.**
- **Point PRM at a third-party AS** (Auth0 / Clerk / WorkOS / Stytch / Supabase /
  Cloudflare Access). carry then only serves PRM, returns the `401` handshake, and
  validates the JWT the IdP issued. Much lighter code (~1–2 days), but it forces a
  vendor + real user accounts into a tool whose whole pitch is "your instance,
  your tokens, your data." Reasonable *only* once carry is multi-tenant (Round D).

Anthropic itself steers high-traffic servers toward **CIMD or `oauth_anthropic_creds`
over DCR** (DCR registers a fresh client on every connection). For carry's tiny
scope that nuance is moot — the point is that *any* OAuth path requires an
authorization server carry does not have today.

### Q3 — Does OAuth actually reduce "configure once, all surfaces" vs. bearer?

**No — not for the cross-surface part, which is the stated goal.** The
"configure once, every surface has it" property comes from connector brokering,
not from the auth scheme:

- Anthropic: remote connectors "work across all Claude surfaces. Once connected,
  they're available everywhere without extra setup," and *"remote connectors are
  configured and brokered through your Claude account."* Account-level state
  (connectors, memory, preferences) syncs across web/desktop/mobile on the same
  login. ([Anthropic — Use connectors](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities);
  [Desktop vs web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors))
- carry's own `docs/deploy.md` Step 6 already relies on this: "You attach the
  remote MCP connector **once on the web**; it then syncs to your phone."

So a bearer configured once on web *already* reaches mobile and desktop. OAuth
would ride the exact same brokering. **What OAuth removes is one thing, once:**
the token *paste* at the single web add-step becomes a consent *click*. That's a
nicer 10-second interaction, not a reduction in the number of surfaces you touch.

**Quantifying what OAuth actually buys carry (single-user):**

| Benefit | Bearer + `carry init` | OAuth | Worth it for single-user self-host? |
|---|---|---|---|
| Reaches mobile+desktop from one web setup | Yes (account brokering) | Yes (same brokering) | **Tie — no gain** |
| No secret handled by the human | You paste/store 1 token | Consent click, no secret | Minor UX polish |
| Token expiry + refresh | Manual rotation | Automatic | Marginal (you own the box) |
| Revocation | Rotate the token, redeploy env | Revoke in consent list | Marginal at n=1 |
| Per-user identity / multi-tenant | No (shared secret) | Yes | **The real win — but Round D only** |
| Claude Code (write path) | `--header` bearer works now | Own loopback OAuth flow | Bearer is simpler here |

The only row where OAuth is decisively better — *per-user identity* — is
explicitly out of scope until Round D per `docs/remaining-build-plan.md`.

### Q4 — Alternatives worth weighing

- **Bearer + `carry init` (already planned, B3) — recommended.** `carry init`
  generates the read/write tokens, writes `.env`, and prints the exact connector
  config (URL + auth) and the per-surface setup steps. That collapses the friction
  the promptsmith review flagged (hand-crafting tokens, guessing the `/mcp` path,
  not knowing which token goes where) without any protocol work. Pair it with
  `carry status` (whoami) so each surface can confirm it's reading the live pack.
  This is the tightest bearer flow and it's cheap.
- **A single "connect" link.** Not a real option under the current UI — Anthropic
  disallows credentials in the connector URL (`?token=`), and the MCP spec
  prohibits access tokens in the query string. Don't do this.
  ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication))
- **Authless (`none`) server.** Supported, but it exposes your pack to anyone who
  knows the URL — unacceptable for personal context. Reject.
- **Per-user OAuth — defer to Round D.** When/if carry goes hosted multi-tenant,
  OAuth (pointed at a third-party AS, per Finding 2) becomes the correct choice:
  per-user consent, revocation, and isolation are then the product, not polish.

---

## Effort vs. benefit

| | Bearer + `carry init` (B3) | Full OAuth (self-built AS) | OAuth via 3rd-party AS |
|---|---|---|---|
| New code | Small CLI + docs; **no** server auth change | OAuth 2.1 AS: DCR, token, refresh-rotation, PKCE, PRM/AS metadata, consent | PRM + 401 handshake + JWT validation; AS outsourced |
| Rough effort | ~0.5 day | days–weeks, security-critical | ~1–2 days + vendor setup |
| carry stays stateless | Yes | No (stores clients/tokens) | Mostly (validates tokens) |
| Reaches all hosted surfaces from one setup | Yes | Yes | Yes |
| Removes the one-time secret paste on web | No (still a paste — **if UI allows it**) | Yes (consent click) | Yes (consent click) |
| Adds a third-party dependency | No | No | **Yes (IdP vendor + user accounts)** |
| Fits "your instance, your tokens, your data" | Yes | Strained | No |
| Enables multi-tenant | No | Yes | Yes |
| **Verdict for Rounds A–C** | **Ship this** | Overkill | Overkill |
| **Verdict for Round D** | Insufficient | Possible | **Preferred** |

**Verdict:** For a single-user self-host tool, OAuth is not worth it. It does not
improve cross-surface reach (brokering already does that), its remaining benefits
are marginal at n=1, and its cost is a security-critical auth server carry
shouldn't own. Bearer made painless by `carry init` is the right Round-A–C path.

---

## Recommendation

**Rounds A–C (personal + OSS self-host): keep bearer; make it painless with
`carry init` (B3). Do not implement OAuth.** Concretely:

1. Ship `carry init` / `carry status` as planned (B3) — this is the whole
   seamlessness win for the current scope.
2. **Before trusting the documented web+mobile flow, hand-verify the bearer path
   on the actual surfaces** (this is B4's "assumed-but-unverified" gap — treat it
   as gating, see assumptions below).
3. Keep the read/write two-token split (`src/auth.ts`) — it already gives you
   scope separation and cheap revocation-by-rotation, which covers most of what
   OAuth's revocation would.

**Round D (if/when hosted multi-tenant):** revisit OAuth as the auth model.
Prefer **PRM pointed at a third-party OAuth 2.1 authorization server** (CIMD or
`oauth_anthropic_creds` over raw DCR) rather than building an AS inside carry.
At that point per-user consent, isolation, and revocation are the product
requirement, and the effort is justified. This lines up with the build plan's
D1 (multi-tenant, per-user tokens in a DB).

---

## Assumptions that still need hand-verification

1. **[HIGH — gating] Can a personal (Pro/Max, non-org-admin) claude.ai account
   paste carry's bearer token in the web custom-connector dialog?** Docs say
   `static_headers` exists but is **beta** and *admin/org-scoped*; GitHub issues
   #112 (closed *not planned*) and #411 say the personal add-by-URL dialog shows
   only OAuth fields. **Unverified — confirm by hand** on Eric's live instance
   (B1/B4). If it fails: the fallback is (a) request `static_headers` beta access,
   or (b) reassess OAuth-via-third-party-AS — *not* an immediate full-OAuth build.
   This assumption, not OAuth, is the real risk to carry's setup story.
2. **[MED] Does a connector added on web actually appear on Claude mobile and
   Claude Desktop with no extra setup?** Anthropic's brokering model says yes and
   account state syncs on the same login, but the docs don't spell out per-surface
   connector sync explicitly, and mobile connector install is itself flagged beta.
   **Confirm by hand** (this is exactly B4's all-surfaces verification). Note:
   *desktop* connector support for a custom URL connector is the specific
   assumed-but-unverified item the build plan calls out.
3. **[LOW] Claude Code header attachment reliability.** `--header "Authorization:
   Bearer …"` is the documented path and works, but there are version-specific bug
   reports (e.g. #29562, #50464) where the header isn't attached on session
   establishment. Verify carry's write push actually authenticates from the
   Claude Code version Eric runs.

### Sources

- [Anthropic — Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- [Anthropic — Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Anthropic — Use connectors to extend Claude](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities)
- [Anthropic — When to use desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)
- [Claude Code — Connect to tools via MCP](https://code.claude.com/docs/en/mcp)
- [MCP authorization specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [GitHub — anthropics/claude-ai-mcp #112 (bearer not configurable, closed not planned)](https://github.com/anthropics/claude-ai-mcp/issues/112)
- [GitHub — anthropics/claude-ai-mcp #411 (bearer-token MCP incompatible)](https://github.com/anthropics/claude-ai-mcp/issues/411)
- [GitHub — anthropics/claude-code #29562 (HTTP header not sent on session establish)](https://github.com/anthropics/claude-code/issues/29562)
- RFCs: [9728 PRM](https://www.rfc-editor.org/rfc/rfc9728), [8414 AS metadata](https://www.rfc-editor.org/rfc/rfc8414), [7591 DCR](https://www.rfc-editor.org/rfc/rfc7591), [8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707), [7636 PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
