import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerFromHeader, loadNamespaces, resolveToken, type Namespace } from "./auth.js";
import { createMcpServer } from "./server.js";
import { InMemoryStore, type ContextStore } from "./store.js";

/**
 * carry HTTP entry point.
 *
 * One endpoint carries the MCP traffic: POST /mcp. We run the SDK's Streamable
 * HTTP transport in STATELESS mode (a fresh server + transport per request),
 * which suits a small read-mostly relay and avoids session bookkeeping/leaks.
 * A plain GET /healthz is provided for Render health checks.
 */

const PORT = Number(process.env.PORT ?? 8080);

// Fail loudly at boot if auth is misconfigured (see auth.ts).
const namespaces: Namespace[] = loadNamespaces(process.env.CARRY_NAMESPACES);

const store: ContextStore = new InMemoryStore();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "carry", namespaces: namespaces.length });
});

app.post("/mcp", async (req: Request, res: Response) => {
  // Authenticate before touching MCP. The token pins the namespace + scope.
  const token = bearerFromHeader(req.headers.authorization);
  const ctx = resolveToken(token, namespaces);
  if (!ctx) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid bearer token." },
      id: null,
    });
    return;
  }

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

app.listen(PORT, () => {
  console.log(`carry listening on :${PORT} (${namespaces.length} namespace(s))`);
});
