# Contributing to carry

Thanks for your interest. carry is a small, deliberately simple MCP server; the
bar for changes is that they keep it small and keep it working.

## Ground rules

- **Keep it deployable.** `main` stays green. Every commit should leave the repo in
  a runnable, tested state.
- **Tests come with behavior.** New behavior needs a test that exercises it through
  the public interface (the MCP surface, the `ContextStore` interface, the CLI —
  not private internals). The suite runs offline; keep it that way (the OAuth tests
  inject a local JWKS rather than hitting the network).
- **Auth and the store contract are load-bearing.** Changes to `src/auth.ts`,
  `src/oauth.ts`, or the `ContextStore` interface change carry's security or
  storage contract — call that out explicitly in the PR description.
- **Never log tokens or pack content.** Structured logging exists; keep secrets and
  user content out of it.
- **No secrets in the repo.** Only `.env.example` is tracked. Never commit a real
  `.env`, a token, or an instance-specific URL as a canonical example (use
  `example.com` placeholders).

## Local setup

```bash
npm install
cp .env.example .env      # set CARRY_NAMESPACES with your own dev tokens
npm run dev               # tsx watch on :8080
```

## Before you open a PR

Run all three and make sure they pass:

```bash
npm run typecheck
npm test
npm run smoke
```

Keep commits small and focused, with a message that explains the *why*. If a change
touches the deploy path, update [`docs/deploy.md`](docs/deploy.md) in the same PR.

## Reporting bugs / requesting features

Use the issue templates. For anything security-sensitive (auth bypass, token
handling, isolation between namespaces), please **do not** open a public issue with
exploit detail — note that it's security-related and keep specifics minimal until a
fix is out.
