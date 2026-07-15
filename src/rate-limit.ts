/**
 * Dependency-free fixed-window rate limiter for the public /mcp surface.
 *
 * No external packages: a plain in-memory Map of key -> current-window counter,
 * and `node:crypto` only to hash bearer tokens before they become map keys (so a
 * raw token never sits in memory as a key, matching the "never store/log tokens"
 * rule from the logging module).
 *
 * Fixed window, not sliding: each key gets a counter that resets when its window
 * ends. Simpler and cheaper than a sliding log, and correct enough to blunt both a
 * single token hammering the endpoint and an unauthenticated source brute-forcing
 * tokens from one IP. The clock is injectable so tests never touch the real time.
 */

import { createHash } from "node:crypto";

/** The verdict for one key (or one request, from `rateLimitRequest`). */
export interface RateDecision {
  allowed: boolean;
  /** Seconds until the blocking window resets. 0 when allowed. */
  retryAfterSec: number;
}

export interface FixedWindowLimiterOptions {
  /** Max requests allowed per key per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock returning epoch-ms. Defaults to Date.now (real clock). */
  now?: () => number;
}

interface WindowState {
  count: number;
  /** Epoch-ms at which the current window ends (exclusive). */
  windowEnd: number;
}

/**
 * A fixed-window counter keyed by an opaque string. `check(key)` records one hit
 * and reports whether it was allowed. Keys are independent. Expired windows are
 * dropped lazily on access to that key and can be swept en masse via `prune()`.
 */
export class FixedWindowLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, WindowState>();

  constructor(opts: FixedWindowLimiterOptions) {
    if (opts.max < 1) throw new Error("FixedWindowLimiter: max must be >= 1");
    if (opts.windowMs < 1) throw new Error("FixedWindowLimiter: windowMs must be >= 1");
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Record one request against `key` and decide if it is allowed. Starting or
   * rolling a window happens here, so a key whose window has expired is reset the
   * moment it is next touched — no request is ever charged against a stale window.
   */
  check(key: string): RateDecision {
    const t = this.now();
    let state = this.windows.get(key);
    if (!state || t >= state.windowEnd) {
      // First hit for this key, or its previous window has fully elapsed: start
      // a fresh window anchored at now.
      state = { count: 0, windowEnd: t + this.windowMs };
      this.windows.set(key, state);
    }
    if (state.count >= this.max) {
      // Over the cap: reject and tell the caller when the window frees up. Ceil so
      // "less than a second left" still reports at least 1s (a 0 Retry-After lies).
      const retryAfterSec = Math.max(1, Math.ceil((state.windowEnd - t) / 1000));
      return { allowed: false, retryAfterSec };
    }
    state.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Drop every key whose window has fully expired so the Map cannot grow without
   * bound as new IPs/tokens appear. Safe to call on any cadence; the server wires
   * it to an unref()'d interval so it never keeps the process alive.
   */
  prune(): void {
    const t = this.now();
    for (const [key, state] of this.windows) {
      if (t >= state.windowEnd) this.windows.delete(key);
    }
  }

  /** Number of keys currently tracked. Exposed for tests/observability. */
  get size(): number {
    return this.windows.size;
  }
}

/**
 * Hash a bearer token into a stable, non-reversible map key. Keeps raw tokens out
 * of the limiter's memory; truncated because a full digest is overkill for a key.
 */
function tokenKey(token: string): string {
  return "tok:" + createHash("sha256").update(token, "utf8").digest("hex").slice(0, 32);
}

/**
 * Apply the /mcp rate-limit policy to one request and return a single decision.
 *
 * The endpoint is limited on BOTH axes: always by client IP (guards the pre-auth
 * surface — one source cannot brute-force tokens), and additionally by the bearer
 * token when one is present (one token cannot hammer even from many IPs). IP is
 * checked first; the first key to trip blocks the request, so a request already
 * refused on its IP does not also consume its token's budget.
 */
export function rateLimitRequest(
  limiter: FixedWindowLimiter,
  ip: string | undefined,
  token: string | null,
): RateDecision {
  const ipDecision = limiter.check("ip:" + (ip ?? "unknown"));
  if (!ipDecision.allowed) return ipDecision;
  if (token) {
    const tokenDecision = limiter.check(tokenKey(token));
    if (!tokenDecision.allowed) return tokenDecision;
  }
  return { allowed: true, retryAfterSec: 0 };
}
