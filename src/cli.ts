#!/usr/bin/env node
/**
 * carry CLI.
 *
 * Compiles a context pack from source Markdown files and pushes it to a running
 * carry instance, or reads the current pack back. Zero new dependencies: argv is
 * parsed by hand (matching carry's zero-dep bias) and the network path uses the
 * official MCP client already in deps.
 *
 * Commands:
 *   carry init   [--namespace <name>] [--url <mcpUrl>] [--force]
 *   carry status --url <mcpUrl> [--token <readOrWriteToken>]
 *   carry push --url <mcpUrl> --from <f1> [f2 ...] [--title <t>] [--token <writeToken>]
 *   carry get  --url <mcpUrl> [--token <readOrWriteToken>]
 *   carry --help
 *
 * Token resolution:
 *   push:          --token, else CARRY_WRITE_TOKEN.
 *   get / status:  --token, else CARRY_READ_TOKEN, else CARRY_WRITE_TOKEN.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { compilePack } from "./compiler.js";

export const USAGE = `carry — compile a context pack from Markdown and sync it to a carry instance.

Usage:
  carry init   [--namespace <name>] [--url <mcpUrl>] [--force]
  carry status --url <mcpUrl> [--token <readOrWriteToken>]
  carry push   --url <mcpUrl> --from <file> [file ...] [--title <title>] [--token <writeToken>]
  carry get    --url <mcpUrl> [--token <readOrWriteToken>]
  carry --help

init    Generate a read + write token pair and write a ready-to-use .env in the
        current directory (namespace defaults to "me"). Prints the connector setup.
        Refuses to overwrite an existing .env unless --force.
status  Connect to a carry instance and call list_packs to confirm it is reachable
        and show what packs exist. Token: --token, else CARRY_READ_TOKEN, else CARRY_WRITE_TOKEN.
push    Read each --from file, compile a pack (stamping source/gitHash/builtAt/title),
        and push it via the MCP push_context tool. Token: --token or CARRY_WRITE_TOKEN.
get     Read and print the current pack via get_context.
        Token: --token, else CARRY_READ_TOKEN, else CARRY_WRITE_TOKEN.`;

/** Placeholder URL printed by `carry init` when the user hasn't deployed yet. */
export const DEFAULT_MCP_URL = "https://YOUR-INSTANCE.onrender.com/mcp";

export type Command = "push" | "get" | "init" | "status" | "help";

/** The result of parsing argv. `error` set means "print it and exit non-zero". */
export interface ParsedArgs {
  command: Command;
  url?: string;
  from: string[];
  title?: string;
  token?: string;
  /** `init` only: namespace name to stamp into .env (defaults to "me"). */
  namespace?: string;
  /** `init` only: allow overwriting an existing .env. */
  force?: boolean;
  error?: string;
}

/**
 * Parse argv (already sliced past `node script`, i.e. `process.argv.slice(2)`).
 *
 * Hand-rolled, no arg library. Unknown commands/flags do not throw — they set
 * `error` so the caller can print usage and choose the exit code. Exported so it
 * is unit-testable without spawning a process or touching the network.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", from: [] };
  }
  if (command !== "push" && command !== "get" && command !== "init" && command !== "status") {
    return { command: "help", from: [], error: `Unknown command: ${command}` };
  }

  const parsed: ParsedArgs = { command, from: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--url":
        parsed.url = rest[++i];
        break;
      case "--token":
        parsed.token = rest[++i];
        break;
      case "--title":
        parsed.title = rest[++i];
        break;
      case "--namespace":
        parsed.namespace = rest[++i];
        break;
      case "--force":
        // Boolean flag — takes no value, so do not advance i.
        parsed.force = true;
        break;
      case "--from":
        // Greedily consume following args until the next flag. This is what lets
        // `--from a.md b.md` collect multiple files without repeating the flag.
        while (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
          parsed.from.push(rest[++i]);
        }
        break;
      default:
        return { ...parsed, error: `Unknown flag: ${arg}` };
    }
  }
  return parsed;
}

/** Write-token resolution: explicit flag wins, else the env var. */
export function resolvePushToken(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return flag ?? env.CARRY_WRITE_TOKEN;
}

/** Read-token resolution: flag, else CARRY_READ_TOKEN, else fall back to the write token. */
export function resolveGetToken(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return flag ?? env.CARRY_READ_TOKEN ?? env.CARRY_WRITE_TOKEN;
}

/** A generated read/write token pair for a fresh carry namespace. */
export interface TokenPair {
  readToken: string;
  writeToken: string;
}

/** Token scope. Mirrors the server's read/write split (kept local — no core import). */
type Scope = "read" | "write";

/**
 * Generate one strong token. 32 random bytes (256 bits) rendered base64url, with
 * a human-legible scope prefix (`carry_r_` / `carry_w_`) so a token is
 * recognizable at a glance and the read/write pair can never be confused. The
 * prefix is cosmetic; all the entropy is in the 32 random bytes.
 */
export function generateToken(scope: Scope): string {
  const prefix = scope === "read" ? "carry_r_" : "carry_w_";
  return prefix + randomBytes(32).toString("base64url");
}

/**
 * Generate a distinct read + write token pair. They are independently random, so
 * they always differ — which is exactly the invariant the server's auth enforces
 * (a leaked read token must never be able to overwrite the pack).
 */
export function generateTokenPair(): TokenPair {
  return { readToken: generateToken("read"), writeToken: generateToken("write") };
}

/** Inputs to render a .env file body for a single-namespace carry setup. */
export interface RenderEnvInput {
  namespace: string;
  readToken: string;
  writeToken: string;
}

/**
 * Render a ready-to-use `.env` body for a fresh carry namespace. `CARRY_NAMESPACES`
 * is produced with `JSON.stringify` so it is always valid, correctly-escaped JSON
 * on a single line. Pure — takes no clock/FS, returns a string the caller writes.
 */
export function renderEnv(input: RenderEnvInput): string {
  const nsJson = JSON.stringify([
    { namespace: input.namespace, readToken: input.readToken, writeToken: input.writeToken },
  ]);
  return [
    "# carry local config — generated by `carry init`.",
    "# SECRETS: do not commit this file. The tokens below were shown once at init.",
    "",
    "# Auth: one namespace with a READ token (mobile/desktop connector, read-only)",
    "# and a WRITE token (Claude Code / CI, pushes new packs). They must differ.",
    `CARRY_NAMESPACES=${nsJson}`,
    "",
    "# Durable storage. A file: URL writes a local SQLite DB; unset = in-memory (dev only).",
    "CARRY_DB_URL=file:./data/carry.db",
    "",
    "# Optional: cap the max pack size the server accepts, in bytes. Unset = 262144 (256 KiB).",
    "# CARRY_MAX_PACK_BYTES=262144",
    "",
  ].join("\n");
}

/** Everything the init summary needs to print. */
export interface InitSummaryInput {
  namespace: string;
  url: string;
  readToken: string;
  writeToken: string;
  envPath: string;
}

/**
 * Render the copy-pasteable post-init summary printed to stdout. Pure so it can be
 * asserted in tests without spawning a process. This is the ONLY place the freshly
 * generated tokens are surfaced — they are never written to any log.
 */
export function renderInitSummary(input: InitSummaryInput): string {
  return `carry init — wrote ${input.envPath} (namespace "${input.namespace}").

Two tokens were generated. THIS IS THE ONLY TIME THEY ARE SHOWN — save them in a
password manager now. They also live in the .env just written (keep it out of git).

  READ  token:  ${input.readToken}
  WRITE token:  ${input.writeToken}

1) Add the connector on claude.ai (web) — it syncs to your mobile + desktop apps:
     Settings -> Connectors -> Add custom connector
       URL:            ${input.url}
       Authentication: Bearer token
       Token:          <the READ token above>   (read-only — safe on your phone)

2) Push from Claude Code / CLI with the WRITE token:
     set CARRY_WRITE_TOKEN in your environment, or pass  --token <write>  to carry push
       e.g.  carry push --url ${input.url} --from voice.md --token <the WRITE token>

3) Next step — deploy your own instance (fork -> Render Blueprint): see docs/deploy.md
`;
}

/**
 * Parse the text `list_packs` returns into pack names. The server prints either a
 * "no packs yet" sentence or a `- name` bullet per pack; we pull the bullets. Pure,
 * so `carry status`'s formatting is testable without a live server.
 */
export function parsePackNames(listPacksText: string): string[] {
  return listPacksText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((name) => name.length > 0);
}

/** Best-effort short git hash for provenance. Never throws — falls back to "unknown". */
function resolveGitHash(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Flatten an MCP tool result's content array into plain text. */
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

/** Open an authenticated MCP client against a carry instance over Streamable HTTP. */
async function connect(url: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "carry-cli", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** `carry push` — read files, compile, push_context. */
async function runPush(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
  if (!args.url) throw new Error("push requires --url <mcpUrl>.");
  if (args.from.length === 0) throw new Error("push requires --from <file> [file ...].");

  const token = resolvePushToken(args.token, env);
  if (!token) {
    throw new Error("No write token. Pass --token <writeToken> or set CARRY_WRITE_TOKEN.");
  }

  const files = args.from.map((path) => ({ path, content: readFileSync(path, "utf8") }));
  const gitHash = resolveGitHash();
  const builtAt = new Date().toISOString();
  const { content, meta } = compilePack({ files, title: args.title, gitHash, builtAt });

  const client = await connect(args.url, token);
  try {
    const result = await client.callTool({
      name: "push_context",
      arguments: { content, meta },
    });
    if ((result as { isError?: boolean }).isError) {
      throw new Error(textOf(result) || "push_context returned an error.");
    }
    process.stdout.write(textOf(result) + "\n");
  } finally {
    await client.close();
  }
}

/** `carry get` — read and print the current pack. */
async function runGet(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
  if (!args.url) throw new Error("get requires --url <mcpUrl>.");

  const token = resolveGetToken(args.token, env);
  if (!token) {
    throw new Error(
      "No token. Pass --token <readOrWriteToken> or set CARRY_READ_TOKEN (or CARRY_WRITE_TOKEN).",
    );
  }

  const client = await connect(args.url, token);
  try {
    const result = await client.callTool({ name: "get_context", arguments: {} });
    if ((result as { isError?: boolean }).isError) {
      throw new Error(textOf(result) || "get_context returned an error.");
    }
    process.stdout.write(textOf(result) + "\n");
  } finally {
    await client.close();
  }
}

/** Injectable side-effect seams for `runInit`, so tests never touch the real cwd or stdout. */
export interface InitDeps {
  /** Directory the .env is written into. Defaults to process.cwd(). */
  cwd?: string;
  /** Where the summary is printed. Defaults to process.stdout. */
  out?: (text: string) => void;
}

/**
 * `carry init` — generate a token pair, write a .env in the cwd, print setup.
 *
 * Synchronous and network-free. Refuses to clobber an existing .env unless
 * `--force`, so secrets are never silently overwritten. Returns the generated
 * result (handy for tests); secrets go to stdout only, never to a log file.
 */
export function runInit(args: ParsedArgs, deps: InitDeps = {}): InitSummaryInput {
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const envPath = join(cwd, ".env");

  if (existsSync(envPath) && !args.force) {
    throw new Error(
      `.env already exists at ${envPath}. Refusing to overwrite it (it may hold live ` +
        `secrets). Re-run with --force to replace it.`,
    );
  }

  const namespace = args.namespace ?? "me";
  const url = args.url ?? DEFAULT_MCP_URL;
  const { readToken, writeToken } = generateTokenPair();

  writeFileSync(envPath, renderEnv({ namespace, readToken, writeToken }), "utf8");

  const summary: InitSummaryInput = { namespace, url, readToken, writeToken, envPath };
  out(renderInitSummary(summary));
  return summary;
}

/** `carry status` — confirm an instance is reachable and list its packs via list_packs. */
async function runStatus(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
  if (!args.url) throw new Error("status requires --url <mcpUrl>.");

  const token = resolveGetToken(args.token, env);
  if (!token) {
    throw new Error(
      "No token. Pass --token <readOrWriteToken> or set CARRY_READ_TOKEN (or CARRY_WRITE_TOKEN).",
    );
  }

  const client = await connect(args.url, token);
  try {
    const result = await client.callTool({ name: "list_packs", arguments: {} });
    if ((result as { isError?: boolean }).isError) {
      throw new Error(textOf(result) || "list_packs returned an error.");
    }
    const packs = parsePackNames(textOf(result));
    process.stdout.write("carry: connected OK\n");
    process.stdout.write(`  server: ${args.url}\n`);
    process.stdout.write(
      packs.length > 0 ? `  packs:  ${packs.join(", ")}\n` : "  packs:  (no packs yet)\n",
    );
  } finally {
    await client.close();
  }
}

/** Route parsed args to a command. */
async function run(args: ParsedArgs): Promise<void> {
  if (args.error) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.command === "init") {
    runInit(args);
    return;
  }
  if (args.command === "status") return runStatus(args, process.env);
  if (args.command === "push") return runPush(args, process.env);
  return runGet(args, process.env);
}

/**
 * True only when this file is the process entry point (run as the `carry` bin or
 * via `tsx src/cli.ts`) — false when merely imported (e.g. by Vitest). That guard
 * is what keeps the test suite from firing the CLI's network path on import.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = pathToFileURL(realpathSync(entry)).href;
    const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return entryUrl === selfUrl;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`carry: ${msg}\n`);
    process.exit(1);
  });
}
