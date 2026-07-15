/**
 * Auth for carry, single-tenant-with-tokens but shaped for multi-tenant.
 *
 * A namespace owns two secrets: a READ token (what your Claude mobile connector
 * presents) and a WRITE token (what Claude Code / CI presents to push). Two
 * tokens, not one, so a leaked mobile connector can only read your pack, never
 * overwrite it.
 *
 * v1 loads namespaces from an env var. Multi-tenant later swaps `loadNamespaces`
 * for a DB lookup — the `resolveToken` logic below does not change.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type Scope = "read" | "write";

/**
 * Constant-time token comparison.
 *
 * `crypto.timingSafeEqual` throws if the two buffers differ in length, which would
 * itself leak the secret's length through the throw/no-throw branch. To sidestep
 * that, hash both inputs to a fixed 32-byte SHA-256 digest first, then compare the
 * digests: the comparison inputs are always the same length, so the compare is a
 * true constant-time operation over equal-length buffers regardless of the raw
 * token lengths. (SHA-256 is not for secrecy here — the tokens are compared, not
 * stored — it is purely to normalize length before the timing-safe compare.)
 */
function tokensEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

export interface Namespace {
  namespace: string;
  readToken: string;
  writeToken: string;
}

export interface AuthContext {
  namespace: string;
  /** The highest scope this token grants. A write token also grants read. */
  scope: Scope;
}

/**
 * Parse CARRY_NAMESPACES: a JSON array of
 *   { "namespace": "eric", "readToken": "...", "writeToken": "..." }
 * Throws on malformed config so a misconfigured deploy fails loudly at boot
 * rather than silently accepting no one (or, worse, everyone).
 */
export function loadNamespaces(raw: string | undefined): Namespace[] {
  if (!raw || raw.trim() === "") {
    throw new Error(
      "CARRY_NAMESPACES is not set. Provide a JSON array of " +
        '{ namespace, readToken, writeToken }. See .env.example.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`CARRY_NAMESPACES is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CARRY_NAMESPACES must be a non-empty JSON array.");
  }
  return parsed.map((entry, i) => {
    const e = entry as Partial<Namespace>;
    if (!e.namespace || !e.readToken || !e.writeToken) {
      throw new Error(
        `CARRY_NAMESPACES[${i}] must have non-empty namespace, readToken, and writeToken.`,
      );
    }
    if (e.readToken === e.writeToken) {
      throw new Error(
        `CARRY_NAMESPACES[${i}] readToken and writeToken must differ (that is the point).`,
      );
    }
    return { namespace: e.namespace, readToken: e.readToken, writeToken: e.writeToken };
  });
}

/**
 * Extract the bearer token from an Authorization header.
 * Returns null when the header is missing or not a Bearer token.
 */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Resolve a presented token to an AuthContext, or null if it matches nothing.
 * Compares against every configured token with a constant-time compare (see
 * `tokensEqual`) so an attacker cannot learn a token byte-by-byte from response
 * timing. Write is checked before read; a token can only ever match one entry
 * because loadNamespaces rejects identical read/write tokens.
 */
export function resolveToken(token: string | null, namespaces: Namespace[]): AuthContext | null {
  if (!token) return null;
  for (const ns of namespaces) {
    if (tokensEqual(token, ns.writeToken)) return { namespace: ns.namespace, scope: "write" };
    if (tokensEqual(token, ns.readToken)) return { namespace: ns.namespace, scope: "read" };
  }
  return null;
}

/** True when the auth context's scope satisfies the required scope. */
export function hasScope(ctx: AuthContext, required: Scope): boolean {
  if (required === "read") return ctx.scope === "read" || ctx.scope === "write";
  return ctx.scope === "write";
}
