import { describe, it, expect } from "vitest";
import { compilePack } from "../src/compiler.js";

/**
 * The compiler is pure and deterministic: gitHash/builtAt are injected, so every
 * assertion here is exact. No git, no clock, no filesystem.
 */
describe("compilePack", () => {
  const FIXED = { gitHash: "abc1234", builtAt: "2026-07-15T00:00:00.000Z", title: "Voice pack" };

  it("wraps each file under a source marker and preserves body verbatim", () => {
    const { content } = compilePack({
      files: [{ path: "knowledge/voice.md", content: "# Voice\nNo em-dashes." }],
      ...FIXED,
    });
    expect(content).toBe("<!-- source: voice.md -->\n# Voice\nNo em-dashes.");
  });

  it("keeps files in the given order, separated by a blank line", () => {
    const { content } = compilePack({
      files: [
        { path: "a.md", content: "AAA" },
        { path: "b.md", content: "BBB" },
      ],
      ...FIXED,
    });
    expect(content).toBe("<!-- source: a.md -->\nAAA\n\n<!-- source: b.md -->\nBBB");
    // Ordering is load-bearing: a.md's marker must precede b.md's.
    expect(content.indexOf("source: a.md")).toBeLessThan(content.indexOf("source: b.md"));
  });

  it("reduces paths to basenames from both / and \\ separators", () => {
    const { meta } = compilePack({
      files: [
        { path: "knowledge/voice.md", content: "x" },
        { path: "C:\\Dev\\carry\\knowledge\\facts.md", content: "y" },
      ],
      ...FIXED,
    });
    expect(meta.source).toEqual(["voice.md", "facts.md"]);
  });

  it("stamps injected provenance into meta unchanged", () => {
    const { meta } = compilePack({ files: [{ path: "a.md", content: "x" }], ...FIXED });
    expect(meta).toEqual({
      source: ["a.md"],
      title: "Voice pack",
      gitHash: "abc1234",
      builtAt: "2026-07-15T00:00:00.000Z",
    });
  });

  it("does not require a title", () => {
    const { meta } = compilePack({
      files: [{ path: "a.md", content: "x" }],
      gitHash: "abc1234",
      builtAt: "2026-07-15T00:00:00.000Z",
    });
    expect(meta.title).toBeUndefined();
    expect(meta.source).toEqual(["a.md"]);
  });

  it("handles the empty-files edge case", () => {
    const { content, meta } = compilePack({ files: [], ...FIXED });
    expect(content).toBe("");
    expect(meta.source).toEqual([]);
    expect(meta.gitHash).toBe("abc1234");
    expect(meta.builtAt).toBe("2026-07-15T00:00:00.000Z");
  });
});
