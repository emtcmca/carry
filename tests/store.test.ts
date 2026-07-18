import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryStore, VersionConflictError, type ContextStore } from "../src/store.js";
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
    expect(await store.get("me", "default")).toBeNull();
  });

  it("stores the first pack as version 1 and stamps packSchema", async () => {
    const pack = await store.put("me", "default", { content: "hello", meta: { source: "test" } });
    expect(pack.version).toBe(1);
    expect(pack.content).toBe("hello");
    expect(pack.meta).toEqual({ source: "test" });
    expect(pack.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(pack.packSchema).toBe(1);
  });

  it("returns packSchema on get as well as put", async () => {
    await store.put("me", "default", { content: "hi" });
    const got = await store.get("me", "default");
    expect(got?.packSchema).toBe(1);
  });

  it("increments version on each push and returns the latest on get", async () => {
    await store.put("me", "default", { content: "one" });
    const second = await store.put("me", "default", { content: "two" });
    expect(second.version).toBe(2);
    const got = await store.get("me", "default");
    expect(got?.content).toBe("two");
    expect(got?.version).toBe(2);
  });

  it("round-trips a pack with no meta", async () => {
    await store.put("me", "default", { content: "no meta here" });
    const got = await store.get("me", "default");
    expect(got?.content).toBe("no meta here");
    expect(got?.meta).toBeUndefined();
  });

  it("round-trips nested meta faithfully", async () => {
    const meta = { source: "cli", gitHash: "abc123", nested: { a: 1, b: ["x", "y"] } };
    await store.put("me", "default", { content: "c", meta });
    const got = await store.get("me", "default");
    expect(got?.meta).toEqual(meta);
  });

  it("isolates namespaces", async () => {
    await store.put("me", "default", { content: "erics pack" });
    expect(await store.get("someone-else", "default")).toBeNull();
    await store.put("someone-else", "default", { content: "other pack" });
    expect((await store.get("me", "default"))?.content).toBe("erics pack");
    expect((await store.get("someone-else", "default"))?.content).toBe("other pack");
  });

  it("is idempotent on init", async () => {
    await store.init();
    await store.put("me", "default", { content: "survives second init call" });
    expect((await store.get("me", "default"))?.content).toBe("survives second init call");
  });

  // --- named packs (pack model v2) ---

  it("keeps multiple named packs in one namespace isolated and independently versioned", async () => {
    await store.put("me", "voice", { content: "voice v1" });
    await store.put("me", "systems", { content: "systems v1" });
    // Bump only 'voice' twice more.
    await store.put("me", "voice", { content: "voice v2" });
    const voiceThird = await store.put("me", "voice", { content: "voice v3" });

    expect(voiceThird.version).toBe(3);
    expect((await store.get("me", "voice"))?.content).toBe("voice v3");
    expect((await store.get("me", "voice"))?.version).toBe(3);

    // 'systems' is untouched by writes to 'voice'.
    const systems = await store.get("me", "systems");
    expect(systems?.content).toBe("systems v1");
    expect(systems?.version).toBe(1);
  });

  it("list() returns the pack names in a namespace, empty before any push", async () => {
    expect(await store.list("me")).toEqual([]);
    await store.put("me", "voice", { content: "v" });
    await store.put("me", "systems", { content: "s" });
    await store.put("me", "default", { content: "d" });
    expect((await store.list("me")).sort()).toEqual(["default", "systems", "voice"]);
    // list is scoped to the namespace.
    expect(await store.list("someone-else")).toEqual([]);
  });

  it("defaults packName to \"default\" when omitted, round-tripping the same pack", async () => {
    // Write with explicit "default", read back with no packName arg.
    await store.put("me", "default", { content: "default-pack body" });
    const viaOmitted = await store.get("me");
    const viaExplicit = await store.get("me", "default");
    expect(viaOmitted?.content).toBe("default-pack body");
    expect(viaOmitted).toEqual(viaExplicit);
    expect(await store.list("me")).toEqual(["default"]);
  });

  it("rejects invalid pack names on both get and put", async () => {
    for (const bad of ["", "UPPER", "has space", "path/sep", "a".repeat(65)]) {
      await expect(store.put("me", bad, { content: "x" })).rejects.toThrow(/packName/i);
      await expect(store.get("me", bad)).rejects.toThrow(/packName/i);
    }
    // A well-formed name using every allowed class is accepted.
    const ok = await store.put("me", "voice.systems_1-2", { content: "ok" });
    expect(ok.version).toBe(1);
  });

  // --- optimistic concurrency (expectedVersion) ---

  it("first write with expectedVersion:0 succeeds and creates version 1", async () => {
    const pack = await store.put("me", "default", { content: "first" }, { expectedVersion: 0 });
    expect(pack.version).toBe(1);
    expect((await store.get("me", "default"))?.content).toBe("first");
  });

  it("a correct expectedVersion writes and increments", async () => {
    await store.put("me", "default", { content: "v1" }); // no expectation -> v1
    const v2 = await store.put("me", "default", { content: "v2" }, { expectedVersion: 1 });
    expect(v2.version).toBe(2);
    const v3 = await store.put("me", "default", { content: "v3" }, { expectedVersion: 2 });
    expect(v3.version).toBe(3);
    expect((await store.get("me", "default"))?.content).toBe("v3");
  });

  it("a stale expectedVersion is rejected and does NOT mutate the pack", async () => {
    await store.put("me", "default", { content: "v1" });
    await store.put("me", "default", { content: "v2" }); // now at version 2
    await expect(
      store.put("me", "default", { content: "stale write" }, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    // Unchanged: still v2 with the old content, no phantom version 3.
    const got = await store.get("me", "default");
    expect(got?.version).toBe(2);
    expect(got?.content).toBe("v2");
    expect(await store.listVersions("me", "default")).toEqual([1, 2]);
  });

  it("VersionConflictError carries expected and current", async () => {
    await store.put("me", "default", { content: "v1" });
    try {
      await store.put("me", "default", { content: "x" }, { expectedVersion: 5 });
      throw new Error("expected a conflict");
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      expect((err as VersionConflictError).expected).toBe(5);
      expect((err as VersionConflictError).current).toBe(1);
    }
  });

  it("expectedVersion:0 against an existing pack is rejected", async () => {
    await store.put("me", "default", { content: "already here" });
    await expect(
      store.put("me", "default", { content: "clobber" }, { expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await store.get("me", "default"))?.content).toBe("already here");
  });

  // --- version history ---

  it("appends every put to history and reads each version back", async () => {
    await store.put("me", "default", { content: "one", meta: { n: 1 } });
    await store.put("me", "default", { content: "two" });
    await store.put("me", "default", { content: "three" });

    expect(await store.listVersions("me", "default")).toEqual([1, 2, 3]);
    expect((await store.getVersion("me", "default", 1))?.content).toBe("one");
    expect((await store.getVersion("me", "default", 1))?.meta).toEqual({ n: 1 });
    expect((await store.getVersion("me", "default", 2))?.content).toBe("two");
    expect((await store.getVersion("me", "default", 3))?.content).toBe("three");
    expect((await store.getVersion("me", "default", 3))?.version).toBe(3);
  });

  it("getVersion returns null for a version that does not exist", async () => {
    await store.put("me", "default", { content: "one" });
    expect(await store.getVersion("me", "default", 99)).toBeNull();
    // No history at all for an unknown pack.
    expect(await store.listVersions("me", "unknown")).toEqual([]);
    expect(await store.getVersion("me", "unknown", 1)).toBeNull();
  });

  it("history is per-(namespace, packName) and defaults packName to default", async () => {
    await store.put("me", "default", { content: "d1" });
    await store.put("me", "voice", { content: "vo1" });
    await store.put("me", "voice", { content: "vo2" });
    expect(await store.listVersions("me")).toEqual([1]); // default pack
    expect(await store.listVersions("me", "voice")).toEqual([1, 2]);
    // Another namespace shares nothing.
    expect(await store.listVersions("someone-else", "voice")).toEqual([]);
  });

  it("restoring old content via put appends a new version without losing history", async () => {
    await store.put("me", "default", { content: "v1-body" });
    await store.put("me", "default", { content: "v2-body" });
    // Simulate restore_version: read old content, put it back as a new version.
    const old = await store.getVersion("me", "default", 1);
    const restored = await store.put("me", "default", { content: old!.content });
    expect(restored.version).toBe(3);
    expect((await store.get("me", "default"))?.content).toBe("v1-body");
    // Newer history is preserved; the restore is appended as version 3.
    expect(await store.listVersions("me", "default")).toEqual([1, 2, 3]);
    expect((await store.getVersion("me", "default", 2))?.content).toBe("v2-body");
  });
});
