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

export type Scope = "read" | "write";

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
 * Uses a constant-time-ish compare via matching after collecting candidates to
 * avoid trivially leaking which namespace a token belongs to through timing.
 */
export function resolveToken(token: string | null, namespaces: Namespace[]): AuthContext | null {
  if (!token) return null;
  for (const ns of namespaces) {
    if (token === ns.writeToken) return { namespace: ns.namespace, scope: "write" };
    if (token === ns.readToken) return { namespace: ns.namespace, scope: "read" };
  }
  return null;
}

/** True when the auth context's scope satisfies the required scope. */
export function hasScope(ctx: AuthContext, required: Scope): boolean {
  if (required === "read") return ctx.scope === "read" || ctx.scope === "write";
  return ctx.scope === "write";
}
