import { describe, it, expect } from "vitest";
import { FixedWindowLimiter, rateLimitRequest, type RateDecision } from "../src/rate-limit.js";

/**
 * Rate-limiter unit tests. The clock is injected everywhere so nothing depends on
 * the real time — no sleeps, no flake. Two layers are covered:
 *  1. FixedWindowLimiter: the raw counter (allow up to max, block, reset, isolate).
 *  2. rateLimitRequest: the /mcp policy that keys on IP + token, exactly as the
 *     server middleware calls it — a non-flaky stand-in for the "burst -> 429" check.
 */

/** A controllable clock: starts at 1000ms, advance() moves it forward. */
function fakeClock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("FixedWindowLimiter", () => {
  it("allows up to max requests in a window, then blocks the next", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 3, windowMs: 1000, now: clock.now });

    expect(limiter.check("k").allowed).toBe(true); // 1
    expect(limiter.check("k").allowed).toBe(true); // 2
    expect(limiter.check("k").allowed).toBe(true); // 3
    const blocked = limiter.check("k"); // 4 -> over cap
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("resets after the window fully elapses", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 2, windowMs: 1000, now: clock.now });

    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false); // capped within window

    clock.advance(1000); // window boundary reached (windowEnd is exclusive)
    expect(limiter.check("k").allowed).toBe(true); // fresh window
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false); // capped again
  });

  it("does not reset partway through a window", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 1, windowMs: 1000, now: clock.now });

    expect(limiter.check("k").allowed).toBe(true);
    clock.advance(999); // still inside the window
    expect(limiter.check("k").allowed).toBe(false);
  });

  it("tracks different keys independently", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 1, windowMs: 1000, now: clock.now });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false); // 'a' is capped
    expect(limiter.check("b").allowed).toBe(true); // 'b' untouched by 'a'
  });

  it("reports a sane retryAfterSec (>=1, <= window seconds)", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    limiter.check("k"); // consume the single slot
    const blocked = limiter.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);

    // With almost the whole window elapsed, retry-after rounds up to 1s (never 0).
    clock.advance(59_500);
    const nearEnd = limiter.check("k");
    expect(nearEnd.allowed).toBe(false);
    expect(nearEnd.retryAfterSec).toBe(1);
  });

  it("prune() drops only fully-expired windows", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 5, windowMs: 1000, now: clock.now });

    limiter.check("old");
    clock.advance(500);
    limiter.check("new"); // 'new' window ends at 1500; 'old' ends at 1000
    expect(limiter.size).toBe(2);

    clock.advance(600); // now = 1100: 'old' expired, 'new' still live
    limiter.prune();
    expect(limiter.size).toBe(1);
    // The surviving key keeps its count (not silently reset by prune).
    for (let i = 0; i < 4; i++) limiter.check("new");
    expect(limiter.check("new").allowed).toBe(false);
  });

  it("rejects a nonsensical config", () => {
    expect(() => new FixedWindowLimiter({ max: 0, windowMs: 1000 })).toThrow();
    expect(() => new FixedWindowLimiter({ max: 1, windowMs: 0 })).toThrow();
  });
});

describe("rateLimitRequest (the /mcp policy: IP + token)", () => {
  it("a burst from one IP over the limit gets blocked (429 path)", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 5, windowMs: 60_000, now: clock.now });

    const results: RateDecision[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(rateLimitRequest(limiter, "1.2.3.4", null));
    }
    // First 5 allowed, the 6th blocked with a retry hint — the server turns this
    // last decision into an HTTP 429 + Retry-After.
    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results[5].allowed).toBe(false);
    expect(results[5].retryAfterSec).toBeGreaterThan(0);
  });

  it("limits per-IP even when unauthenticated (pre-auth brute-force guard)", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 2, windowMs: 60_000, now: clock.now });

    expect(rateLimitRequest(limiter, "9.9.9.9", null).allowed).toBe(true);
    expect(rateLimitRequest(limiter, "9.9.9.9", null).allowed).toBe(true);
    expect(rateLimitRequest(limiter, "9.9.9.9", null).allowed).toBe(false);
  });

  it("keeps different IPs independent", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    expect(rateLimitRequest(limiter, "1.1.1.1", null).allowed).toBe(true);
    expect(rateLimitRequest(limiter, "1.1.1.1", null).allowed).toBe(false);
    expect(rateLimitRequest(limiter, "2.2.2.2", null).allowed).toBe(true); // other IP unaffected
  });

  it("also limits a single token independent of its IP", () => {
    const clock = fakeClock();
    // High per-IP headroom so the TOKEN axis is what trips here.
    const limiter = new FixedWindowLimiter({ max: 100, windowMs: 60_000, now: clock.now });

    // Same token from many distinct IPs still shares the token bucket. Give each
    // request a unique IP so the IP axis never trips; the token axis must.
    let last: RateDecision = { allowed: true, retryAfterSec: 0 };
    for (let i = 0; i < 101; i++) {
      last = rateLimitRequest(limiter, `10.0.0.${i}`, "shared-token");
    }
    expect(last.allowed).toBe(false); // the 101st token hit is over the cap
  });

  it("treats a missing IP as its own 'unknown' bucket without throwing", () => {
    const clock = fakeClock();
    const limiter = new FixedWindowLimiter({ max: 1, windowMs: 60_000, now: clock.now });

    expect(rateLimitRequest(limiter, undefined, null).allowed).toBe(true);
    expect(rateLimitRequest(limiter, undefined, null).allowed).toBe(false);
  });
});
