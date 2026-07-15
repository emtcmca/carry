import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryStore, type ContextStore } from "../src/store.js";
import { LibSqlStore } from "../src/libsql-store.js";

/**
 * One contract, run against every ContextStore implementation. If a new backend
 * is added (Postgres for multi-tenant), it joins this table and must pass the
 * same suite. Behavior is defined here, once, not per implementation.
 */
const implementations: Array<[string, () => ContextStore]> = [
  ["InMemoryStore", () => new InMemoryStore()],
  // libSQL in-memory DB: durable code path, no file, fresh per test.
  ["LibSqlStore(:memory:)", () => new LibSqlStore(":memory:")],
];

describe.each(implementations)("ContextStore contract: %s", (_name, make) => {
  let store: ContextStore;

  beforeEach(async () => {
    store = make();
    await store.init();
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns null before the first push", async () => {
    expect(await store.get("eric")).toBeNull();
  });

  it("stores the first pack as version 1", async () => {
    const pack = await store.put("eric", { content: "hello", meta: { source: "test" } });
    expect(pack.version).toBe(1);
    expect(pack.content).toBe("hello");
    expect(pack.meta).toEqual({ source: "test" });
    expect(pack.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("increments version on each push and returns the latest on get", async () => {
    await store.put("eric", { content: "one" });
    const second = await store.put("eric", { content: "two" });
    expect(second.version).toBe(2);
    const got = await store.get("eric");
    expect(got?.content).toBe("two");
    expect(got?.version).toBe(2);
  });

  it("round-trips a pack with no meta", async () => {
    await store.put("eric", { content: "no meta here" });
    const got = await store.get("eric");
    expect(got?.content).toBe("no meta here");
    expect(got?.meta).toBeUndefined();
  });

  it("round-trips nested meta faithfully", async () => {
    const meta = { source: "cli", gitHash: "abc123", nested: { a: 1, b: ["x", "y"] } };
    await store.put("eric", { content: "c", meta });
    const got = await store.get("eric");
    expect(got?.meta).toEqual(meta);
  });

  it("isolates namespaces", async () => {
    await store.put("eric", { content: "erics pack" });
    expect(await store.get("someone-else")).toBeNull();
    await store.put("someone-else", { content: "other pack" });
    expect((await store.get("eric"))?.content).toBe("erics pack");
    expect((await store.get("someone-else"))?.content).toBe("other pack");
  });

  it("is idempotent on init", async () => {
    await store.init();
    await store.put("eric", { content: "survives second init call" });
    expect((await store.get("eric"))?.content).toBe("survives second init call");
  });
});
