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
    expect(await store.get("eric", "default")).toBeNull();
  });

  it("stores the first pack as version 1 and stamps packSchema", async () => {
    const pack = await store.put("eric", "default", { content: "hello", meta: { source: "test" } });
    expect(pack.version).toBe(1);
    expect(pack.content).toBe("hello");
    expect(pack.meta).toEqual({ source: "test" });
    expect(pack.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pack.packSchema).toBe(1);
  });

  it("returns packSchema on get as well as put", async () => {
    await store.put("eric", "default", { content: "hi" });
    const got = await store.get("eric", "default");
    expect(got?.packSchema).toBe(1);
  });

  it("increments version on each push and returns the latest on get", async () => {
    await store.put("eric", "default", { content: "one" });
    const second = await store.put("eric", "default", { content: "two" });
    expect(second.version).toBe(2);
    const got = await store.get("eric", "default");
    expect(got?.content).toBe("two");
    expect(got?.version).toBe(2);
  });

  it("round-trips a pack with no meta", async () => {
    await store.put("eric", "default", { content: "no meta here" });
    const got = await store.get("eric", "default");
    expect(got?.content).toBe("no meta here");
    expect(got?.meta).toBeUndefined();
  });

  it("round-trips nested meta faithfully", async () => {
    const meta = { source: "cli", gitHash: "abc123", nested: { a: 1, b: ["x", "y"] } };
    await store.put("eric", "default", { content: "c", meta });
    const got = await store.get("eric", "default");
    expect(got?.meta).toEqual(meta);
  });

  it("isolates namespaces", async () => {
    await store.put("eric", "default", { content: "erics pack" });
    expect(await store.get("someone-else", "default")).toBeNull();
    await store.put("someone-else", "default", { content: "other pack" });
    expect((await store.get("eric", "default"))?.content).toBe("erics pack");
    expect((await store.get("someone-else", "default"))?.content).toBe("other pack");
  });

  it("is idempotent on init", async () => {
    await store.init();
    await store.put("eric", "default", { content: "survives second init call" });
    expect((await store.get("eric", "default"))?.content).toBe("survives second init call");
  });

  // --- named packs (pack model v2) ---

  it("keeps multiple named packs in one namespace isolated and independently versioned", async () => {
    await store.put("eric", "voice", { content: "voice v1" });
    await store.put("eric", "systems", { content: "systems v1" });
    // Bump only 'voice' twice more.
    await store.put("eric", "voice", { content: "voice v2" });
    const voiceThird = await store.put("eric", "voice", { content: "voice v3" });

    expect(voiceThird.version).toBe(3);
    expect((await store.get("eric", "voice"))?.content).toBe("voice v3");
    expect((await store.get("eric", "voice"))?.version).toBe(3);

    // 'systems' is untouched by writes to 'voice'.
    const systems = await store.get("eric", "systems");
    expect(systems?.content).toBe("systems v1");
    expect(systems?.version).toBe(1);
  });

  it("list() returns the pack names in a namespace, empty before any push", async () => {
    expect(await store.list("eric")).toEqual([]);
    await store.put("eric", "voice", { content: "v" });
    await store.put("eric", "systems", { content: "s" });
    await store.put("eric", "default", { content: "d" });
    expect((await store.list("eric")).sort()).toEqual(["default", "systems", "voice"]);
    // list is scoped to the namespace.
    expect(await store.list("someone-else")).toEqual([]);
  });

  it("defaults packName to \"default\" when omitted, round-tripping the same pack", async () => {
    // Write with explicit "default", read back with no packName arg.
    await store.put("eric", "default", { content: "default-pack body" });
    const viaOmitted = await store.get("eric");
    const viaExplicit = await store.get("eric", "default");
    expect(viaOmitted?.content).toBe("default-pack body");
    expect(viaOmitted).toEqual(viaExplicit);
    expect(await store.list("eric")).toEqual(["default"]);
  });

  it("rejects invalid pack names on both get and put", async () => {
    for (const bad of ["", "UPPER", "has space", "path/sep", "a".repeat(65)]) {
      await expect(store.put("eric", bad, { content: "x" })).rejects.toThrow(/packName/i);
      await expect(store.get("eric", bad)).rejects.toThrow(/packName/i);
    }
    // A well-formed name using every allowed class is accepted.
    const ok = await store.put("eric", "voice.systems_1-2", { content: "ok" });
    expect(ok.version).toBe(1);
  });
});
