import { describe, it, expect } from "vitest";
import { parseArgs, resolvePushToken, resolveGetToken } from "../src/cli.js";

/**
 * Unit tests for the argv parser and token-resolution helpers only. No network:
 * the CLI's push/get paths open a real MCP client, which is exercised by the
 * live end-to-end check, not here.
 */
describe("parseArgs — routing", () => {
  it("routes to help with no args", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("routes --help / -h / help to help", () => {
    expect(parseArgs(["--help"]).command).toBe("help");
    expect(parseArgs(["-h"]).command).toBe("help");
    expect(parseArgs(["help"]).command).toBe("help");
  });

  it("flags an unknown command as an error (still routed to help)", () => {
    const parsed = parseArgs(["frobnicate"]);
    expect(parsed.command).toBe("help");
    expect(parsed.error).toMatch(/Unknown command: frobnicate/);
  });

  it("flags an unknown flag as an error", () => {
    const parsed = parseArgs(["push", "--nope", "x"]);
    expect(parsed.error).toMatch(/Unknown flag: --nope/);
  });
});

describe("parseArgs — push", () => {
  it("collects url, multiple --from files, title, and token", () => {
    const parsed = parseArgs([
      "push",
      "--url",
      "http://127.0.0.1:8090/mcp",
      "--from",
      "voice.md",
      "facts.md",
      "--title",
      "Voice pack",
      "--token",
      "w_tok",
    ]);
    expect(parsed.command).toBe("push");
    expect(parsed.url).toBe("http://127.0.0.1:8090/mcp");
    expect(parsed.from).toEqual(["voice.md", "facts.md"]);
    expect(parsed.title).toBe("Voice pack");
    expect(parsed.token).toBe("w_tok");
    expect(parsed.error).toBeUndefined();
  });

  it("stops --from collection at the next flag regardless of order", () => {
    const parsed = parseArgs(["push", "--from", "a.md", "b.md", "--url", "http://x/mcp"]);
    expect(parsed.from).toEqual(["a.md", "b.md"]);
    expect(parsed.url).toBe("http://x/mcp");
  });
});

describe("parseArgs — get", () => {
  it("collects url and token", () => {
    const parsed = parseArgs(["get", "--url", "http://x/mcp", "--token", "r_tok"]);
    expect(parsed.command).toBe("get");
    expect(parsed.url).toBe("http://x/mcp");
    expect(parsed.token).toBe("r_tok");
    expect(parsed.from).toEqual([]);
  });
});

describe("token resolution", () => {
  it("push: flag wins over env", () => {
    expect(resolvePushToken("flag_tok", { CARRY_WRITE_TOKEN: "env_tok" })).toBe("flag_tok");
  });

  it("push: falls back to CARRY_WRITE_TOKEN", () => {
    expect(resolvePushToken(undefined, { CARRY_WRITE_TOKEN: "env_tok" })).toBe("env_tok");
  });

  it("push: undefined when neither is set", () => {
    expect(resolvePushToken(undefined, {})).toBeUndefined();
  });

  it("get: flag wins over both env vars", () => {
    expect(
      resolveGetToken("flag_tok", { CARRY_READ_TOKEN: "r", CARRY_WRITE_TOKEN: "w" }),
    ).toBe("flag_tok");
  });

  it("get: falls back to CARRY_READ_TOKEN before CARRY_WRITE_TOKEN", () => {
    expect(resolveGetToken(undefined, { CARRY_READ_TOKEN: "r", CARRY_WRITE_TOKEN: "w" })).toBe("r");
  });

  it("get: falls back to CARRY_WRITE_TOKEN when no read token", () => {
    expect(resolveGetToken(undefined, { CARRY_WRITE_TOKEN: "w" })).toBe("w");
  });

  it("get: undefined when nothing is set", () => {
    expect(resolveGetToken(undefined, {})).toBeUndefined();
  });
});
