import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerFromHeader, loadNamespaces, resolveToken, type Namespace } from "./auth.js";
import { createMcpServer } from "./server.js";
import { createStore } from "./store-factory.js";
import type { ContextStore } from "./store.js";
import { FixedWindowLimiter, rateLimitRequest } from "./rate-limit.js";
import { jsonRpcMethod, logRequest } from "./logging.js";

/**
 * carry HTTP entry point.
 *
 * One endpoint carries the MCP traffic: POST /mcp. We run the SDK's Streamable
 * HTTP transport in STATELESS mode (a fresh server + transport per request),
 * which suits a small read-mostly relay and avoids session bookkeeping/leaks.
 * A plain GET /healthz is provided for Render health checks.
 */

const PORT = Number(process.env.PORT ?? 8080);

// Fixed-window rate limiter for POST /mcp. Default 120 req/min per key; override
// with CARRY_RATE_LIMIT_PER_MIN. Keyed by IP (pre-auth guard) and by token when
// present (see rate-limit.ts). An unref()'d sweep drops expired windows so the
// backing Map cannot grow unbounded, without keeping the process alive.
const RATE_LIMIT_PER_MIN = Number(process.env.CARRY_RATE_LIMIT_PER_MIN ?? 120);
const RATE_WINDOW_MS = 60_000;
const limiter = new FixedWindowLimiter({ max: RATE_LIMIT_PER_MIN, windowMs: RATE_WINDOW_MS });
setInterval(() => limiter.prune(), RATE_WINDOW_MS).unref();

// Fail loudly at boot if auth is misconfigured (see auth.ts).
const namespaces: Namespace[] = loadNamespaces(process.env.CARRY_NAMESPACES);

const store: ContextStore = createStore();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "carry", namespaces: namespaces.length });
});

app.post("/mcp", async (req: Request, res: Response) => {
  // Per-request id: stamped on the response (X-Request-Id) and every log line so a
  // client-visible id ties back to exactly one structured log entry.
  const reqId = randomUUID();
  res.setHeader("X-Request-Id", reqId);

  const startedAt = performance.now();
  const method = jsonRpcMethod(req.body);

  // Log exactly once per request, at response completion, capturing the final
  // status and whatever namespace/rateLimited state the handler resolved. The
  // closure reads the mutable locals below at emit time, so early returns and the
  // MCP path all funnel through this single line. NEVER logs tokens or content.
  let namespace: string | null = null;
  let rateLimited = false;
  let logged = false;
  const emitLog = (): void => {
    if (logged) return;
    logged = true;
    logRequest({
      reqId,
      method,
      namespace,
      status: res.statusCode,
      ms: Math.round((performance.now() - startedAt) * 10) / 10,
      rateLimited,
    });
  };
  res.on("finish", emitLog);
  res.on("close", emitLog);

  // Authenticate before touching MCP. The token pins the namespace + scope.
  const token = bearerFromHeader(req.headers.authorization);

  // Rate limit before any MCP work (body is already parsed). Keyed by IP always,
  // and by token when present, so neither a single source nor a single token can
  // hammer the endpoint. Over the cap -> 429 with a JSON-RPC-shaped error.
  const decision = rateLimitRequest(limiter, req.ip, token);
  if (!decision.allowed) {
    rateLimited = true;
    res.setHeader("Retry-After", String(decision.retryAfterSec));
    res.status(429).json({
      jsonrpc: "2.0",
      error: {
        code: -32029,
        message: `rate limit exceeded, retry after ${decision.retryAfterSec}s`,
      },
      id: null,
    });
    return;
  }

  const ctx = resolveToken(token, namespaces);
  if (!ctx) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
      id: null,
    });
    return;
  }
  namespace = ctx.namespace;

  // Stateless: new transport + server per request, closed over this caller's ctx.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(store, ctx);

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
        id: null,
      });
    }
  }
});

// Method-not-allowed guards so GET/DELETE /mcp return clean JSON-RPC errors
// instead of Express defaults. carry has no server-to-client stream in stateless mode.
for (const method of ["get", "delete"] as const) {
  app[method]("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
      id: null,
    });
  });
}

// Prepare durable storage before accepting traffic, then listen.
store
  .init()
  .then(() => {
    const httpServer = app.listen(PORT, () => {
      console.log(`carry listening on :${PORT} (${namespaces.length} namespace(s))`);
    });

    // Graceful shutdown: stop accepting connections, then release the DB handle.
    // Render sends SIGTERM on deploy/restart; closing the store flushes and unlocks.
    const shutdown = (signal: string) => {
      console.log(`[carry] ${signal} received, shutting down`);
      httpServer.close(() => {
        void store.close().finally(() => process.exit(0));
      });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err: unknown) => {
    console.error(`[carry] store init failed: ${(err as Error).message}`);
    process.exit(1);
  });
