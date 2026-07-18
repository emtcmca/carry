import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadNamespaces, resolveToken, type AuthContext } from "../src/auth.js";
import { createMcpServer } from "../src/server.js";
import { InMemoryStore, type ContextStore } from "../src/store.js";

/**
 * Server-level tests for A-ii. These drive the real MCP server through an in-memory
 * client/server transport pair (no HTTP, no network), so they exercise the tool
 * boundary — scope gating, the size cap, version history tools, and the conflict
 * message — exactly as a connected Claude surface would.
 */

const writeCtx: AuthContext = { namespace: "me", scope: "write" };
const readCtx: AuthContext = { namespace: "me", scope: "read" };

async function clientFor(store: ContextStore, ctx: AuthContext): Promise<Client> {
  const server = createMcpServer(store, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

// --- constant-time auth (timingSafeEqual over SHA-256 digests) ---

describe("resolveToken constant-time auth", () => {
  const ns = loadNamespaces(
    '[{"namespace":"me","readToken":"read-token-123","writeToken":"write-token-456"}]',
  );

  it("resolves valid write and read tokens to the right scope", () => {
    expect(resolveToken("write-token-456", ns)).toEqual({ namespace: "me", scope: "write" });
    expect(resolveToken("read-token-123", ns)).toEqual({ namespace: "me", scope: "read" });
  });

  it("rejects an unknown token of the same length", () => {
    expect(resolveToken("read-token-XXX", ns)).toBeNull();
  });

  it("rejects length-mismatched tokens without throwing", () => {
    // timingSafeEqual throws on raw unequal-length buffers; the SHA-256 normalization
    // makes both compare inputs 32 bytes, so these resolve to null instead of throwing.
    expect(() => resolveToken("x", ns)).not.toThrow();
    expect(resolveToken("x", ns)).toBeNull();
    expect(resolveToken("y".repeat(5000), ns)).toBeNull();
    expect(resolveToken("", ns)).toBeNull();
  });
});

// --- version history + optimistic concurrency at the tool boundary ---

describe("server tools: version history + concurrency", () => {
  it("get_context returns a specific historical version", async () => {
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    await c.callTool({ name: "push_context", arguments: { content: "body-one" } });
    await c.callTool({ name: "push_context", arguments: { content: "body-two" } });

    const v1 = await c.callTool({ name: "get_context", arguments: { version: 1 } });
    expect(textOf(v1)).toContain("body-one");
    const current = await c.callTool({ name: "get_context", arguments: {} });
    expect(textOf(current)).toContain("body-two");
    await c.close();
  });

  it("get_context for a missing version is an error", async () => {
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    await c.callTool({ name: "push_context", arguments: { content: "a" } });
    const res = await c.callTool({ name: "get_context", arguments: { version: 99 } });
    expect(isError(res)).toBe(true);
    await c.close();
  });

  it("list_versions lists ascending version numbers", async () => {
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    await c.callTool({ name: "push_context", arguments: { content: "a" } });
    await c.callTool({ name: "push_context", arguments: { content: "b" } });
    await c.callTool({ name: "push_context", arguments: { content: "c" } });
    const res = await c.callTool({ name: "list_versions", arguments: {} });
    expect(textOf(res)).toContain("1, 2, 3");
    await c.close();
  });

  it("a stale expectedVersion push returns isError and writes nothing", async () => {
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    await c.callTool({ name: "push_context", arguments: { content: "a" } }); // v1
    await c.callTool({ name: "push_context", arguments: { content: "b" } }); // v2

    const stale = await c.callTool({
      name: "push_context",
      arguments: { content: "c", expectedVersion: 1 },
    });
    expect(isError(stale)).toBe(true);
    expect(textOf(stale)).toMatch(/version conflict: expected 1, current 2 — re-read and retry/);
    // Unchanged: still v2/"b".
    expect(await store.get("me", "default")).toMatchObject({ version: 2, content: "b" });
    await c.close();
  });

  it("a correct expectedVersion push succeeds", async () => {
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    await c.callTool({ name: "push_context", arguments: { content: "a" } }); // v1
    const ok = await c.callTool({
      name: "push_context",
      arguments: { content: "b", expectedVersion: 1 },
    });
    expect(isError(ok)).toBe(false);
    expect(textOf(ok)).toContain("v2");
    await c.close();
  });

  it("restore_version appends the old content as a new version (write-gated)", async () => {
    const store = new InMemoryStore();
    const w = await clientFor(store, writeCtx);
    await w.callTool({ name: "push_context", arguments: { content: "old-body" } }); // v1
    await w.callTool({ name: "push_context", arguments: { content: "new-body" } }); // v2

    const restored = await w.callTool({ name: "restore_version", arguments: { version: 1 } });
    expect(textOf(restored)).toContain("as new version 3");
    expect(await store.get("me", "default")).toMatchObject({ version: 3, content: "old-body" });
    // History preserved, nothing lost.
    expect(await store.listVersions("me", "default")).toEqual([1, 2, 3]);
    await w.close();

    // A read token cannot restore.
    const r = await clientFor(store, readCtx);
    const blocked = await r.callTool({ name: "restore_version", arguments: { version: 1 } });
    expect(isError(blocked)).toBe(true);
    expect(textOf(blocked)).toMatch(/read-only/);
    await r.close();
  });
});

// --- max pack size at the tool boundary ---

describe("push_context size cap", () => {
  const original = process.env.CARRY_MAX_PACK_BYTES;
  afterEach(() => {
    if (original === undefined) delete process.env.CARRY_MAX_PACK_BYTES;
    else process.env.CARRY_MAX_PACK_BYTES = original;
  });

  it("rejects content over the default 256 KB cap", async () => {
    delete process.env.CARRY_MAX_PACK_BYTES;
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    const big = "a".repeat(262144 + 1);
    const res = await c.callTool({ name: "push_context", arguments: { content: big } });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toMatch(/262144-byte limit/);
    expect(await store.get("me", "default")).toBeNull();
    await c.close();
  });

  it("respects a CARRY_MAX_PACK_BYTES override in both directions", async () => {
    process.env.CARRY_MAX_PACK_BYTES = "10";
    const store = new InMemoryStore();
    const c = await clientFor(store, writeCtx);
    const over = await c.callTool({
      name: "push_context",
      arguments: { content: "12345678901" }, // 11 bytes
    });
    expect(isError(over)).toBe(true);
    expect(textOf(over)).toMatch(/10-byte limit/);

    const under = await c.callTool({ name: "push_context", arguments: { content: "12345" } }); // 5 bytes
    expect(isError(under)).toBe(false);
    expect(textOf(under)).toContain("v1");
    await c.close();
  });
});
