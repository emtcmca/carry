import { describe, it, expect, beforeAll } from "vitest";
import { rmSync } from "node:fs";
import { LibSqlStore } from "../src/libsql-store.js";

/**
 * Durability proof: a pack written by one LibSqlStore instance must be readable
 * by a completely separate instance opened on the same file, as would happen
 * across a server restart. Uses a real file under a nested path that does NOT
 * exist yet, which also exercises the parent-directory auto-create (the SQLite
 * error-14 bug fixed in this slice).
 */
const DIR = "./data-test";
const DB_URL = `file:${DIR}/nested/persist.db`;

describe("LibSqlStore durability across instances", () => {
  // Clean at the START of a fresh test process, where no libSQL file handle is
  // held. We deliberately do NOT delete in afterAll: on Windows the native libSQL
  // handle is released only on process exit, so a same-process delete throws EPERM.
  // The next run's beforeAll clears the leftover. DIR is gitignored.
  // The two tests below build on each other's state (v1 then v2).
  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
  });

  it("auto-creates a missing parent directory and persists across a reopen", async () => {
    // First "process": open on a path whose parent does not exist, write a pack.
    const writer = new LibSqlStore(DB_URL);
    await writer.init();
    const put = await writer.put("eric", {
      content: "# Voice\nNo em-dashes.",
      meta: { source: "persistence-test", gitHash: "deadbeef" },
    });
    expect(put.version).toBe(1);
    await writer.close(); // release the file, as a real process exit would.

    // Second "process": a fresh instance on the same file. Simulates a restart.
    const reader = new LibSqlStore(DB_URL);
    await reader.init();
    const got = await reader.get("eric");
    expect(got).not.toBeNull();
    expect(got?.content).toContain("No em-dashes.");
    expect(got?.version).toBe(1);
    expect(got?.meta).toEqual({ source: "persistence-test", gitHash: "deadbeef" });
    await reader.close();
  });

  it("keeps the incremented version across a reopen", async () => {
    const a = new LibSqlStore(DB_URL);
    await a.init();
    await a.put("eric", { content: "second write" });
    await a.close();

    const b = new LibSqlStore(DB_URL);
    await b.init();
    const got = await b.get("eric");
    expect(got?.version).toBe(2);
    expect(got?.content).toBe("second write");
    await b.close();
  });
});
