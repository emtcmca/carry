/**
 * One-command local demo: `npm run demo`.
 *
 * Boots a throwaway carry server (in-memory store, demo tokens), pushes a sample
 * context pack with the WRITE token, reads it back with the READ token, and prints
 * the round-trip — so you can feel what carry does without deploying anything.
 * Everything stays on localhost; the server is killed on exit and nothing is written
 * to disk (no CARRY_DB_URL -> in-memory store).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const READ = "carry_demo_read_token";
const WRITE = "carry_demo_write_token";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "..", "examples", "sample-pack.md"), "utf8");

// Boot a throwaway server as a child process: in-memory store, one demo namespace.
// stdout is dropped so the demo output stays clean; stderr passes through for errors.
const server = spawn(process.execPath, [join(here, "..", "dist", "index.js")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    CARRY_NAMESPACES: JSON.stringify([{ namespace: "demo", readToken: READ, writeToken: WRITE }]),
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForHealth(timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* server not up yet */
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error("server did not become healthy in time");
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "carry-demo", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("");
}

try {
  await waitForHealth();
  console.log(`\n  carry demo — throwaway server on :${PORT} (in-memory, nothing written to disk)\n`);

  // The "desk" pushes a pack with the WRITE token.
  console.log("  [desk]   pushing a sample pack with the WRITE token...");
  const writer = await connect(WRITE);
  const pushed = await writer.callTool({
    name: "push_context",
    arguments: { content: sample, meta: { source: "demo" } },
  });
  console.log(`  [desk]   ${textOf(pushed as never).trim()}`);
  await writer.close();

  // A "surface" (phone/web) reads it back with the READ token.
  console.log("\n  [phone]  reading it back with the READ token via get_context:\n");
  const reader = await connect(READ);
  const got = await reader.callTool({ name: "get_context", arguments: {} });
  await reader.close();

  const body = textOf(got as never);
  console.log(
    body
      .split("\n")
      .map((l) => `  │ ${l}`)
      .join("\n"),
  );
  console.log("\n  That's carry: one pack, pushed from the desk, read from anywhere.\n");
} catch (err) {
  console.error(`\n  demo failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  server.kill();
}
