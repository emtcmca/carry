/**
 * Structured request logging for the /mcp endpoint — one JSON line per request.
 *
 * Deliberately dependency-free: `console.log(JSON.stringify(...))`, no logging
 * library. The line is intentionally narrow. It NEVER contains tokens, the
 * Authorization header, or pack content — only the request id, the JSON-RPC
 * method name, the resolved namespace, the HTTP status, elapsed ms, and whether
 * the request was rate limited. That is enough to trace and rate-account traffic
 * without leaking anything secret.
 */

export interface RequestLogEntry {
  /** Per-request UUID; also returned to the client as X-Request-Id. */
  reqId: string;
  /** JSON-RPC method from the request body, or "-" when absent/unparseable. */
  method: string;
  /** Resolved auth namespace, or null when unauthenticated/rate-limited pre-auth. */
  namespace: string | null;
  /** Final HTTP status code. */
  status: number;
  /** Wall-clock handling time in milliseconds (rounded to 0.1ms). */
  ms: number;
  /** True when this request was rejected by the rate limiter (HTTP 429). */
  rateLimited: boolean;
}

/** Emit one structured request-log line. Safe fields only — see module note. */
export function logRequest(entry: RequestLogEntry): void {
  console.log(JSON.stringify(entry));
}

/**
 * Extract the JSON-RPC method name from a parsed request body, or "-" when the
 * body is missing, is a batch/array, or carries no string `method`. Reads only
 * the method field — no params, no content — so nothing sensitive can leak here.
 */
export function jsonRpcMethod(body: unknown): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const method = (body as { method?: unknown }).method;
    if (typeof method === "string" && method.length > 0) return method;
  }
  return "-";
}
