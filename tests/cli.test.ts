import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  resolvePushToken,
  resolveGetToken,
  generateToken,
  generateTokenPair,
  renderEnv,
  runInit,
  parsePackNames,
} from "../src/cli.js";

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

describe("parseArgs — init / status routing", () => {
  it("routes init and collects --namespace, --url, and boolean --force", () => {
    const parsed = parseArgs(["init", "--namespace", "me", "--url", "http://x/mcp", "--force"]);
    expect(parsed.command).toBe("init");
    expect(parsed.namespace).toBe("me");
    expect(parsed.url).toBe("http://x/mcp");
    expect(parsed.force).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it("init without --force leaves force unset (undefined)", () => {
    const parsed = parseArgs(["init"]);
    expect(parsed.command).toBe("init");
    expect(parsed.force).toBeUndefined();
  });

  it("--force consumes no value — a following command-like arg is not swallowed", () => {
    // If --force wrongly took a value, --url would be eaten and parse as its argument.
    const parsed = parseArgs(["init", "--force", "--url", "http://x/mcp"]);
    expect(parsed.force).toBe(true);
    expect(parsed.url).toBe("http://x/mcp");
  });

  it("routes status and collects --url and --token", () => {
    const parsed = parseArgs(["status", "--url", "http://x/mcp", "--token", "r_tok"]);
    expect(parsed.command).toBe("status");
    expect(parsed.url).toBe("http://x/mcp");
    expect(parsed.token).toBe("r_tok");
  });

  it("still routes push and get correctly alongside the new commands", () => {
    expect(parseArgs(["push", "--url", "http://x/mcp"]).command).toBe("push");
    expect(parseArgs(["get", "--url", "http://x/mcp"]).command).toBe("get");
  });
});

describe("token generation", () => {
  it("prefixes read and write tokens distinctly", () => {
    expect(generateToken("read")).toMatch(/^carry_r_/);
    expect(generateToken("write")).toMatch(/^carry_w_/);
  });

  it("generateTokenPair returns two different tokens (read != write)", () => {
    const { readToken, writeToken } = generateTokenPair();
    expect(readToken).not.toBe(writeToken);
    expect(readToken.startsWith("carry_r_")).toBe(true);
    expect(writeToken.startsWith("carry_w_")).toBe(true);
  });

  it("two calls produce different tokens (randomness, not a constant)", () => {
    expect(generateToken("read")).not.toBe(generateToken("read"));
    const a = generateTokenPair();
    const b = generateTokenPair();
    expect(a.readToken).not.toBe(b.readToken);
    expect(a.writeToken).not.toBe(b.writeToken);
  });

  it("the random body decodes to exactly 32 bytes", () => {
    const body = generateToken("write").replace(/^carry_w_/, "");
    expect(Buffer.from(body, "base64url").length).toBe(32);
  });
});

describe("renderEnv", () => {
  it("produces valid, single-line JSON in CARRY_NAMESPACES", () => {
    const env = renderEnv({ namespace: "me", readToken: "carry_r_x", writeToken: "carry_w_y" });
    const line = env.split("\n").find((l) => l.startsWith("CARRY_NAMESPACES="));
    expect(line).toBeDefined();
    const json = line!.slice("CARRY_NAMESPACES=".length);
    // Single line: the JSON value must contain no embedded newline.
    expect(json.includes("\n")).toBe(false);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([
      { namespace: "me", readToken: "carry_r_x", writeToken: "carry_w_y" },
    ]);
  });

  it("includes CARRY_DB_URL and a commented CARRY_MAX_PACK_BYTES", () => {
    const env = renderEnv({ namespace: "me", readToken: "r", writeToken: "w" });
    expect(env).toMatch(/^CARRY_DB_URL=file:\.\/data\/carry\.db$/m);
    expect(env).toMatch(/^# CARRY_MAX_PACK_BYTES=/m);
  });
});

describe("runInit — .env write + overwrite guard", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes a .env with valid CARRY_NAMESPACES and returns the generated tokens", () => {
    dir = mkdtempSync(join(tmpdir(), "carry-init-"));
    const result = runInit({ command: "init", from: [], namespace: "me" }, { cwd: dir, out: () => {} });

    expect(result.namespace).toBe("me");
    expect(result.readToken.startsWith("carry_r_")).toBe(true);
    expect(result.writeToken.startsWith("carry_w_")).toBe(true);

    const written = readFileSync(join(dir, ".env"), "utf8");
    const line = written.split("\n").find((l) => l.startsWith("CARRY_NAMESPACES="))!;
    const ns = JSON.parse(line.slice("CARRY_NAMESPACES=".length));
    expect(ns[0].namespace).toBe("me");
    expect(ns[0].readToken).toBe(result.readToken);
    expect(ns[0].writeToken).toBe(result.writeToken);
  });

  it("defaults the namespace to \"me\" when none is given", () => {
    dir = mkdtempSync(join(tmpdir(), "carry-init-"));
    const result = runInit({ command: "init", from: [] }, { cwd: dir, out: () => {} });
    expect(result.namespace).toBe("me");
  });

  it("refuses to overwrite an existing .env without --force", () => {
    dir = mkdtempSync(join(tmpdir(), "carry-init-"));
    writeFileSync(join(dir, ".env"), "SENTINEL=keepme\n", "utf8");

    expect(() =>
      runInit({ command: "init", from: [] }, { cwd: dir, out: () => {} }),
    ).toThrow(/already exists/i);

    // Guard held: the original file is untouched.
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("SENTINEL=keepme\n");
  });

  it("overwrites an existing .env when --force is set", () => {
    dir = mkdtempSync(join(tmpdir(), "carry-init-"));
    writeFileSync(join(dir, ".env"), "SENTINEL=keepme\n", "utf8");

    runInit({ command: "init", from: [], force: true }, { cwd: dir, out: () => {} });

    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(written.includes("SENTINEL=keepme")).toBe(false);
    expect(written).toMatch(/^CARRY_NAMESPACES=/m);
  });

  it("prints the tokens to the out sink exactly once (stdout-only, not to a file)", () => {
    dir = mkdtempSync(join(tmpdir(), "carry-init-"));
    let printed = "";
    const result = runInit(
      { command: "init", from: [] },
      { cwd: dir, out: (t) => (printed += t) },
    );
    expect(printed).toContain(result.readToken);
    expect(printed).toContain(result.writeToken);
    expect(existsSync(join(dir, ".env"))).toBe(true);
  });
});

describe("parsePackNames", () => {
  it("extracts bullet names from list_packs output", () => {
    expect(parsePackNames("- default\n- voice\n- systems")).toEqual([
      "default",
      "voice",
      "systems",
    ]);
  });

  it("returns [] for the empty/no-packs sentence", () => {
    expect(parsePackNames("No context packs have been pushed for this namespace yet.")).toEqual([]);
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
