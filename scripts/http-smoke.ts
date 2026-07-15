/**
 * End-to-end HTTP smoke: drives a running carry server with a real MCP client
 * over Streamable HTTP. Exercises auth, push_context (write), get_context (read),
 * and read-only rejection. Assumes the server is up on PORT (default 8080) with
 * CARRY_NAMESPACES = eric/r_tok/w_tok. Run via scripts/run-http-smoke.sh.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.CARRY_URL ?? "http://127.0.0.1:8080/mcp";

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`ok: ${msg}`);
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "carry-smoke", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("");
}

// WRITE token: push then read back.
const writer = await connect("w_tok");
const tools = await writer.listTools();
if (!tools.tools.some((t) => t.name === "get_context")) fail("get_context not advertised");
if (!tools.tools.some((t) => t.name === "push_context")) fail("push_context not advertised");
ok("both tools advertised");

const pushed = await writer.callTool({
  name: "push_context",
  arguments: { content: "# Voice\nNo em-dashes.", meta: { source: "http-smoke" } },
});
if (!textOf(pushed as never).includes("v1")) fail(`push did not report v1: ${textOf(pushed as never)}`);
ok("write token pushed pack v1");

const got = await writer.callTool({ name: "get_context", arguments: {} });
if (!textOf(got as never).includes("No em-dashes.")) fail("get did not return pushed content");
ok("get_context returns pushed content");
await writer.close();

// READ token: can read, cannot push.
const reader = await connect("r_tok");
const readGot = await reader.callTool({ name: "get_context", arguments: {} });
if (!textOf(readGot as never).includes("No em-dashes.")) fail("read token could not read pack");
ok("read token can read");

const blocked = await reader.callTool({
  name: "push_context",
  arguments: { content: "malicious overwrite" },
});
if (!(blocked as { isError?: boolean }).isError) fail("read token was allowed to push");
ok("read token blocked from pushing");
await reader.close();

console.log("\nHTTP smoke passed.");
