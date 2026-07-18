# Security

carry is a small server whose whole job is auth-gated access to a context pack.
The security model is deliberately simple; this document states it plainly and tells
you how to report a problem.

## Reporting a vulnerability

Please **do not** open a public issue with exploit detail. Instead, email the
maintainer (see the GitHub profile for [emtcmca](https://github.com/emtcmca)) with a
short description and reproduction steps. I'll acknowledge, work a fix, and credit you
if you'd like once a fix is out.

For anything touching auth bypass, token handling, or isolation between namespaces,
keep specifics minimal in any public channel until a fix ships.

## What the model guarantees

- **The token is the namespace.** Each namespace has a **read** token and a **write**
  token, which must differ. The model never supplies a token; it can only act within
  the namespace the presented token resolves to. A leaked read token cannot overwrite
  a pack — only the write token can push.
- **Fail-closed auth.** Misconfigured `CARRY_NAMESPACES` (missing, invalid JSON, or
  identical read/write tokens) makes the server fail loudly at boot rather than accept
  anyone. An unrecognized or malformed bearer token is a `401`.
- **OAuth is opt-in and read-only.** OAuth mode (`CARRY_OAUTH_ISSUER`) is off unless
  configured. When on, carry validates JWT `iss`, `aud`, signature, and expiry against
  your authorization server's JWKS, and grants **read** scope only. Any verification
  failure returns `null` → `401`; the verifier never throws and never logs token
  contents.
- **No secrets in logs.** Structured per-request logging records method, namespace,
  status, and timing — never tokens or pack content.
- **Rate limiting.** `POST /mcp` is rate-limited (fixed window, keyed by IP and token)
  to blunt brute-force and abuse.

## What you are responsible for (self-host)

- **Keep tokens secret.** Generate strong, distinct read/write tokens and store them in
  a secrets manager. Never commit a real `.env`.
- **Lock OAuth to yourself.** By default OAuth mode accepts any user who can
  authenticate to your configured tenant. If your tenant has more than one user, set
  `CARRY_OAUTH_ALLOWED_SUBS` and/or `CARRY_OAUTH_ALLOWED_EMAILS` so only you can read
  the pack.
- **Serve over TLS.** Terminate HTTPS at your host (Render and similar do this for
  you). Bearer tokens must never travel over plaintext HTTP.

## Known limitations

- Without an allowlist, OAuth mode trusts any authenticated user in the configured
  tenant (see above).
- carry stores one current pack per namespace; it is not a general-purpose datastore
  and makes no durability promise beyond what your configured storage backend provides.
