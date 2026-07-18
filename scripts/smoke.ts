/**
 * Boot-free smoke test of the storage + auth cores (no HTTP, no network).
 * Verifies the pieces slice 1 rests on before we trust the server. Run: npm run smoke.
 */
import { loadNamespaces, resolveToken, bearerFromHeader, hasScope } from "../src/auth.js";
import { InMemoryStore } from "../src/store.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

// --- auth ---
const ns = loadNamespaces('[{"namespace":"me","readToken":"r_tok","writeToken":"w_tok"}]');
assert(ns.length === 1, "loadNamespaces parses one namespace");

assert(bearerFromHeader("Bearer w_tok") === "w_tok", "bearerFromHeader extracts token");
assert(bearerFromHeader(undefined) === null, "bearerFromHeader handles missing header");

const writeCtx = resolveToken("w_tok", ns);
assert(writeCtx?.scope === "write", "write token resolves to write scope");
assert(resolveToken("r_tok", ns)?.scope === "read", "read token resolves to read scope");
assert(resolveToken("nope", ns) === null, "unknown token resolves to null");

assert(hasScope({ namespace: "me", scope: "write" }, "read"), "write scope satisfies read");
assert(!hasScope({ namespace: "me", scope: "read" }, "write"), "read scope does not satisfy write");

let threw = false;
try {
  loadNamespaces('[{"namespace":"x","readToken":"same","writeToken":"same"}]');
} catch {
  threw = true;
}
assert(threw, "identical read/write tokens rejected");

// --- store ---
const store = new InMemoryStore();
const emptyStart = await store.get("me");
assert(emptyStart === null, "store returns null before first push");

const v1 = await store.put("me", "default", { content: "hello", meta: { source: "test" } });
assert(v1.version === 1 && v1.content === "hello", "first put is version 1");
assert(v1.packSchema === 1, "pack is stamped with packSchema 1");

const v2 = await store.put("me", "default", { content: "world" });
assert(v2.version === 2, "second put increments version");

const got = await store.get("me");
assert(got?.content === "world" && got.version === 2, "get returns latest pack (default packName)");

// Named packs are independent within a namespace.
await store.put("me", "voice", { content: "voice pack" });
const packs = await store.list("me");
assert(packs.length === 2 && packs.includes("default") && packs.includes("voice"), "list returns named packs");
assert((await store.get("me", "voice"))?.content === "voice pack", "named pack round-trips");

const other = await store.get("someone-else");
assert(other === null, "namespaces are isolated");

console.log("\nAll smoke checks passed.");
