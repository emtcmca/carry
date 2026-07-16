/**
 * OAuth 2.1 protected-resource support for carry (WorkOS AuthKit read path).
 *
 * WHY THIS EXISTS
 * claude.ai's web custom-connector dialog (personal accounts) is OAuth-only: it
 * runs OAuth Dynamic Client Registration and rejects servers that only accept a
 * pasted bearer token. So mobile/desktop cannot attach with carry's static token.
 * The fix is to make carry an OAuth 2.1 **protected resource** (RFC 9728): a hosted
 * authorization server (WorkOS AuthKit) does login/consent/DCR and issues JWTs;
 * carry only implements the resource-server side — advertise metadata, answer a 401
 * challenge, and validate incoming JWTs. Claude Code's existing static-bearer WRITE
 * path is untouched; this module is purely additive.
 *
 * SCOPE OF THIS SLICE (read path)
 * OAuth callers get READ scope only. Pushes stay on the Claude Code static WRITE
 * token. A JWT that validates maps to exactly one configured namespace and yields
 * `{ namespace, scope: "read" }`. server.ts already gates writes on scope, so an
 * OAuth caller hitting push_context gets the existing read-only rejection for free.
 *
 * BACKWARD COMPATIBILITY
 * OAuth is OFF unless `CARRY_OAUTH_ISSUER` is set. When it is unset, loadOAuthConfig
 * returns null, index.ts wires no verifier, the well-known route 404s, and the /mcp
 * 401 is byte-for-byte what it was before this module existed.
 *
 * SECURITY POSTURE
 * We never hand-roll JWT/JWKS verification — that is a classic footgun. All crypto
 * goes through `jose`. Verification NEVER throws to the request handler: any failure
 * (bad signature, wrong iss/aud, expired, malformed) resolves to null → 401. Token
 * or JWT contents are never logged.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthContext, Namespace } from "./auth.js";

/**
 * Resolved, validated OAuth configuration. Produced once at boot by
 * `loadOAuthConfig` and passed to the pure metadata helpers and the verifier.
 *
 * - `issuer`   — the WorkOS AuthKit domain (JWT `iss`, and the PRM authorization
 *                server), e.g. `https://youthful-ginger-43.authkit.app`.
 * - `audience` — carry's canonical MCP URL, registered as the WorkOS Resource
 *                Indicator, e.g. `https://carry-abxf.onrender.com/mcp`. Used BOTH
 *                as the JWT `aud` to validate AND as the PRM `resource` value.
 * - `namespace`— which configured namespace an OAuth caller maps to (read scope).
 * - `jwksUrl`  — where to fetch the AuthKit signing keys.
 */
export interface OAuthConfig {
  issuer: string;
  audience: string;
  namespace: string;
  jwksUrl: string;
}

/**
 * The minimal shape jose's `jwtVerify` accepts as its key resolver — the function
 * returned by `createRemoteJWKSet` (production) or `createLocalJWKSet` (tests). We
 * alias jose's own exported type so the DI seam in `createJwtVerifier` stays exact
 * and does not drift from what jose actually expects.
 */
export type JWKSLike = JWTVerifyGetKey;

/**
 * Load OAuth config from the environment, or return null when OAuth is disabled.
 *
 * OAuth is enabled iff `CARRY_OAUTH_ISSUER` is a non-empty string. When disabled
 * this returns null and the caller wires nothing OAuth-related. When enabled we
 * validate loudly at boot (mirroring loadNamespaces' throw-on-misconfig style) so a
 * half-configured deploy fails fast rather than silently rejecting every OAuth
 * caller at runtime. Pure: no network, no JWKS fetch here.
 *
 * Env contract (all optional; presence of the issuer is the on-switch):
 * - CARRY_OAUTH_ISSUER    — AuthKit domain. Enables OAuth mode.
 * - CARRY_OAUTH_AUDIENCE  — carry's MCP URL / WorkOS Resource Indicator. REQUIRED
 *                           when issuer is set.
 * - CARRY_OAUTH_NAMESPACE — which configured namespace OAuth callers map to. If
 *                           exactly one namespace exists, defaults to it. If more
 *                           than one exists, REQUIRED. Must name an existing
 *                           namespace whenever it is set.
 * - CARRY_OAUTH_JWKS_URL  — optional override. Defaults to `${issuer}/oauth2/jwks`
 *                           (trailing slash on the issuer stripped first). The path
 *                           is [unverified] against a live WorkOS tenant, hence the
 *                           override hook.
 */
export function loadOAuthConfig(
  env: NodeJS.ProcessEnv,
  namespaces: Namespace[],
): OAuthConfig | null {
  const issuerRaw = env.CARRY_OAUTH_ISSUER;
  // The on-switch: no issuer -> OAuth disabled, return null and change nothing.
  if (!issuerRaw || issuerRaw.trim() === "") return null;
  const issuer = issuerRaw.trim();

  const audience = env.CARRY_OAUTH_AUDIENCE?.trim();
  if (!audience) {
    throw new Error(
      "CARRY_OAUTH_ISSUER is set but CARRY_OAUTH_AUDIENCE is not. Set the audience to " +
        "carry's canonical MCP URL (the WorkOS Resource Indicator), e.g. " +
        "https://carry-abxf.onrender.com/mcp.",
    );
  }

  // Namespace resolution: sole namespace is the default; ambiguity requires the var;
  // a named-but-unknown namespace is always a misconfig.
  const requested = env.CARRY_OAUTH_NAMESPACE?.trim();
  let namespace: string;
  if (requested) {
    const match = namespaces.find((ns) => ns.namespace === requested);
    if (!match) {
      throw new Error(
        `CARRY_OAUTH_NAMESPACE "${requested}" does not name any namespace in ` +
          "CARRY_NAMESPACES. It must match one configured namespace.",
      );
    }
    namespace = match.namespace;
  } else if (namespaces.length === 1) {
    namespace = namespaces[0].namespace;
  } else {
    throw new Error(
      "CARRY_OAUTH_NAMESPACE is required when more than one namespace is configured " +
        `(found ${namespaces.length}). Set it to the namespace OAuth callers should read.`,
    );
  }

  // Default JWKS URL derives from the issuer; strip a single trailing slash so we
  // never emit a double slash before the path.
  const jwksOverride = env.CARRY_OAUTH_JWKS_URL?.trim();
  const jwksUrl = jwksOverride && jwksOverride !== ""
    ? jwksOverride
    : `${issuer.replace(/\/+$/, "")}/oauth2/jwks`;

  return { issuer, audience, namespace, jwksUrl };
}

/**
 * RFC 9728 protected-resource metadata document. Served at
 * `/.well-known/oauth-protected-resource`. Tells an OAuth client which
 * authorization server(s) can mint tokens for this resource and how to present
 * them. `resource` MUST equal the audience the JWT is validated against.
 */
export function protectedResourceMetadata(config: OAuthConfig): object {
  return {
    resource: config.audience,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The `WWW-Authenticate` challenge value sent on a 401 when OAuth is enabled.
 * Points the client at the PRM document so it can discover the authorization
 * server and begin the OAuth flow. The PRM URL is derived from the AUDIENCE's
 * origin (audience is `https://host/mcp`; PRM lives at
 * `https://host/.well-known/oauth-protected-resource`). Pure.
 */
export function wwwAuthenticateChallenge(config: OAuthConfig): string {
  const prmUrl = `${new URL(config.audience).origin}/.well-known/oauth-protected-resource`;
  return `Bearer error="unauthorized", error_description="Authorization needed", resource_metadata="${prmUrl}"`;
}

/**
 * A JWT verifier: token in, AuthContext out, or null on any failure. Async because
 * JWKS resolution and signature verification are async.
 */
export type JwtVerifier = (token: string) => Promise<AuthContext | null>;

/**
 * Build a JWT verifier bound to this OAuth config.
 *
 * The `jwks` parameter is a DEPENDENCY-INJECTION SEAM for tests: production passes
 * nothing and we construct a remote JWKS set that fetches (and caches) the AuthKit
 * signing keys; tests pass a local key set built from an in-test keypair via
 * `createLocalJWKSet`, so the suite is hermetic — no network, no real WorkOS.
 *
 * On success we return `{ namespace, scope: "read" }` — OAuth callers are read-only
 * by design in this slice. On ANY error we catch and return null; the caller turns
 * that into a 401. We deliberately never rethrow: no stack traces to clients, no
 * token/JWT contents in logs.
 */
export function createJwtVerifier(config: OAuthConfig, jwks?: JWKSLike): JwtVerifier {
  const keyResolver: JWKSLike = jwks ?? createRemoteJWKSet(new URL(config.jwksUrl));
  return async (token: string): Promise<AuthContext | null> => {
    try {
      // jose enforces signature, `iss`, `aud`, and expiry (`exp`) here. A mismatch
      // on any of them throws, which we swallow below into a null → 401.
      await jwtVerify(token, keyResolver, {
        issuer: config.issuer,
        audience: config.audience,
      });
      return { namespace: config.namespace, scope: "read" };
    } catch {
      return null;
    }
  };
}
