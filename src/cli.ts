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
 *   carry push --url <mcpUrl> --from <f1> [f2 ...] [--title <t>] [--token <writeToken>]
 *   carry get  --url <mcpUrl> [--token <readOrWriteToken>]
 *   carry --help
 *
 * Token resolution:
 *   push: --token, else CARRY_WRITE_TOKEN.
 *   get:  --token, else CARRY_READ_TOKEN, else CARRY_WRITE_TOKEN.
 */

import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { compilePack } from "./compiler.js";

export const USAGE = `carry — compile a context pack from Markdown and sync it to a carry instance.

Usage:
  carry push --url <mcpUrl> --from <file> [file ...] [--title <title>] [--token <writeToken>]
  carry get  --url <mcpUrl> [--token <readOrWriteToken>]
  carry --help

push  Read each --from file, compile a pack (stamping source/gitHash/builtAt/title),
      and push it via the MCP push_context tool. Token: --token or CARRY_WRITE_TOKEN.
get   Read and print the current pack via get_context.
      Token: --token, else CARRY_READ_TOKEN, else CARRY_WRITE_TOKEN.`;

export type Command = "push" | "get" | "help";

/** The result of parsing argv. `error` set means "print it and exit non-zero". */
export interface ParsedArgs {
  command: Command;
  url?: string;
  from: string[];
  title?: string;
  token?: string;
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
  if (command !== "push" && command !== "get") {
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
