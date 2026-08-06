/**
 * One-command local demo: `npm run demo`.
 *
 * Boots a throwaway carry server (in-memory store, demo tokens) straight from source
 * via tsx — no build step — then pushes a sample context pack with the WRITE token,
 * reads it back with the READ token, and prints the round-trip. It's the real MCP
 * path (push_context / get_context over Streamable HTTP), just dressed up so it reads
 * well on a screen recording. Everything stays on localhost; the server is killed on
 * exit and nothing is written to disk (no CARRY_DB_URL -> in-memory store).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const READ = "carry_demo_read_token";
const WRITE = "carry_demo_write_token";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "..", "examples", "sample-pack.md"), "utf8");

// ANSI palette — a copper/cream nod to the brand, plus scope colors.
const C = {
  r: "\x1b[0m",
  b: "\x1b[1m",
  d: "\x1b[2m",
  cop: "\x1b[38;5;173m",
  cream: "\x1b[38;5;223m",
  grn: "\x1b[38;5;71m",
  sky: "\x1b[38;5;110m",
};
const line = (s = "") => console.log(s);

// Boot a throwaway server as a child process, from source (tsx loader) so there's no
// build step to clutter a recording. All child output is dropped so the demo's own
// lines are the only thing on screen; a boot failure surfaces via waitForHealth below.
const server = spawn(process.execPath, ["--import", "tsx", join(here, "..", "src", "index.ts")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    CARRY_NAMESPACES: JSON.stringify([{ namespace: "demo", readToken: READ, writeToken: WRITE }]),
  },
  stdio: ["ignore", "ignore", "ignore"],
});

async function waitForHealth(timeoutMs = 12_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* server not up yet */
    }
    await sleep(150);
  }
  throw new Error("server did not become healthy in time");
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "carry-demo", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("");
}

try {
  await waitForHealth();

  line();
  line(`  ${C.b}${C.cream}carry${C.r}  ${C.d}— one context, pushed once, read from anywhere${C.r}`);
  line(`  ${C.d}throwaway server on :${PORT} · in-memory · nothing written to disk${C.r}`);
  line();
  await sleep(700);

  // The "desk" pushes a pack with the WRITE token.
  line(`  ${C.sky}●  [desk]${C.r}   push_context  ${C.d}(write token)${C.r}`);
  await sleep(500);
  const writer = await connect(WRITE);
  const pushed = await writer.callTool({
    name: "push_context",
    arguments: { content: sample, meta: { source: "demo" } },
  });
  await writer.close();
  line(`     ${C.grn}✓ ${textOf(pushed as never).trim()}${C.r}`);
  line();
  await sleep(900);

  // A "surface" (phone/web) reads it back with the READ token.
  line(`  ${C.sky}●  [phone]${C.r}  get_context   ${C.d}(read token)${C.r}`);
  line();
  await sleep(500);
  const reader = await connect(READ);
  const got = await reader.callTool({ name: "get_context", arguments: {} });
  await reader.close();

  // Print the pack body under a copper left-bar, dropping the internal meta comment.
  const body = textOf(got as never)
    .split("\n")
    .filter((l) => !l.startsWith("<!-- meta:"));
  for (const l of body) {
    line(`     ${C.cop}│${C.r} ${C.cream}${l}${C.r}`);
  }
  line();
  await sleep(700);
  line(`  ${C.grn}✓ one pack · every surface · one source of truth${C.r}`);
  line();
} catch (err) {
  console.error(`\n  demo failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  server.kill();
}
