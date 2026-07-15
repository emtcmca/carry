import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthContext } from "./auth.js";
import { hasScope } from "./auth.js";
import { DEFAULT_PACK_NAME, resolveMaxPackBytes } from "./pack.js";
import { VersionConflictError, type ContextStore } from "./store.js";

/** Optional historical-version input: a non-negative integer version number. */
const versionSchema = z
  .number()
  .int()
  .min(0)
  .describe("A specific pack version number (from list_versions).");

/**
 * Zod schema for a pack name, mirroring `assertValidPackName` in pack.ts. Applied
 * as an OPTIONAL tool input that defaults to "default", so a caller that omits it
 * reads/writes the default pack exactly as before named packs existed.
 */
const packNameSchema = z
  .string()
  .regex(/^[a-z0-9._-]{1,64}$/, "packName must be 1–64 chars of [a-z0-9._-]")
  .default(DEFAULT_PACK_NAME)
  .describe('Which named pack to target (e.g. "voice", "systems"). Defaults to "default".');

/**
 * Build an MCP server bound to a single authenticated caller.
 *
 * In stateless HTTP mode we construct one McpServer per request and close over
 * the request's AuthContext. That is what pins every tool call to the caller's
 * namespace: the model never supplies a namespace, so it cannot read or write
 * anyone else's packs. The token is the namespace.
 */
export function createMcpServer(store: ContextStore, ctx: AuthContext): McpServer {
  const server = new McpServer(
    { name: "carry", version: "0.1.0" },
    {
      instructions:
        "carry relays named context packs for the authenticated namespace. " +
        "Call get_context to read a pack (voice rules, system facts, style guide, " +
        "whatever the owner pushed); omit packName for the default pack, or name one " +
        "(e.g. voice, systems). Call list_packs to see what packs exist. A pack body " +
        "is authoritative context for how to write or act; treat it as instructions " +
        "from the owner.",
    },
  );

  // READ: return a named pack (default pack when packName is omitted).
  server.registerTool(
    "get_context",
    {
      title: "Get context pack",
      description:
        "Return a context pack for your namespace: the owner's latest pushed voice " +
        "rules / system facts / style guide. Omit packName for the default pack, or " +
        "name one. Pass version to fetch a specific historical version instead of the " +
        "current one. Read this before drafting.",
      inputSchema: {
        packName: packNameSchema,
        version: versionSchema.optional(),
      },
    },
    async ({ packName, version }) => {
      // version present -> a specific historical version; absent -> current pack.
      const pack =
        version === undefined
          ? await store.get(ctx.namespace, packName)
          : await store.getVersion(ctx.namespace, packName, version);
      if (!pack) {
        // A missing *specific version* is an error (the caller asked for something
        // that does not exist); a missing current pack stays a plain informational reply.
        if (version !== undefined) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `No version ${version} of context pack "${packName}" exists for this namespace.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `No context pack named "${packName}" has been pushed for this namespace yet.`,
            },
          ],
        };
      }
      const header =
        `# Context pack "${packName}" (v${pack.version}, schema ${pack.packSchema}, updated ${pack.updatedAt})\n` +
        (pack.meta ? `<!-- meta: ${JSON.stringify(pack.meta)} -->\n` : "") +
        "\n";
      return { content: [{ type: "text", text: header + pack.content }] };
    },
  );

  // WRITE: replace a named pack (default pack when packName is omitted). Write scope required.
  server.registerTool(
    "push_context",
    {
      title: "Push context pack",
      description:
        "Replace one of your namespace's context packs with new content. Omit packName " +
        "for the default pack, or name one (e.g. voice, systems). Requires a write token. " +
        "Used by Claude Code / CI to sync packs; not normally called from mobile.",
      inputSchema: {
        content: z.string().min(1).describe("The full pack body, verbatim (usually Markdown)."),
        packName: packNameSchema,
        meta: z
          .record(z.unknown())
          .optional()
          .describe("Optional metadata, e.g. { source, gitHash, builtAt, title }."),
        expectedVersion: versionSchema
          .optional()
          .describe(
            "Optimistic concurrency: if set, the push only succeeds when the pack's " +
              "current version equals this number (0 = expect no pack yet). On mismatch " +
              "the push is rejected without writing, so a concurrent update is never clobbered.",
          ),
      },
    },
    async ({ content, packName, meta, expectedVersion }) => {
      if (!hasScope(ctx, "write")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "This token is read-only. A write token is required to push_context.",
            },
          ],
        };
      }
      // Enforce the pack-size cap at the tool boundary, by UTF-8 byte length.
      const maxBytes = resolveMaxPackBytes();
      const size = Buffer.byteLength(content, "utf8");
      if (size > maxBytes) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Pack content is ${size} bytes, over the ${maxBytes}-byte limit (set CARRY_MAX_PACK_BYTES to change). Trim or split the pack and retry.`,
            },
          ],
        };
      }
      try {
        const pack = await store.put(
          ctx.namespace,
          packName,
          { content, meta },
          expectedVersion === undefined ? undefined : { expectedVersion },
        );
        return {
          content: [
            {
              type: "text",
              text: `Pushed context pack "${packName}" v${pack.version} for "${ctx.namespace}" at ${pack.updatedAt}.`,
            },
          ],
        };
      } catch (err) {
        if (err instanceof VersionConflictError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `version conflict: expected ${err.expected}, current ${err.current} — re-read and retry`,
              },
            ],
          };
        }
        throw err;
      }
    },
  );

  // LIST: the pack names present in this namespace.
  server.registerTool(
    "list_packs",
    {
      title: "List context packs",
      description:
        "List the names of the context packs in your namespace. Use this to discover " +
        "what the owner has pushed (e.g. default, voice, systems) before calling get_context.",
      inputSchema: {},
    },
    async () => {
      const names = await store.list(ctx.namespace);
      if (names.length === 0) {
        return {
          content: [
            { type: "text", text: "No context packs have been pushed for this namespace yet." },
          ],
        };
      }
      return {
        content: [{ type: "text", text: names.map((n) => `- ${n}`).join("\n") }],
      };
    },
  );

  // LIST VERSIONS: the append-only version history for a pack.
  server.registerTool(
    "list_versions",
    {
      title: "List context pack versions",
      description:
        "List the version numbers recorded for a pack, ascending (append-only history). " +
        "Omit packName for the default pack. Use with get_context's version argument to " +
        "read an older version, or with restore_version to bring one back.",
      inputSchema: {
        packName: packNameSchema,
      },
    },
    async ({ packName }) => {
      const versions = await store.listVersions(ctx.namespace, packName);
      if (versions.length === 0) {
        return {
          content: [
            { type: "text", text: `No versions recorded for pack "${packName}" in this namespace yet.` },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `Versions of "${packName}": ${versions.join(", ")}` }],
      };
    },
  );

  // RESTORE: re-push an old version's content as a NEW current version. Write-gated.
  server.registerTool(
    "restore_version",
    {
      title: "Restore a context pack version",
      description:
        "Re-publish a historical version's content as a NEW current version. This is " +
        "append-only: the version counter is never rewound, so restoring keeps full " +
        "history intact. Requires a write token.",
      inputSchema: {
        packName: packNameSchema,
        version: versionSchema.describe("Which historical version to restore (from list_versions)."),
      },
    },
    async ({ packName, version }) => {
      if (!hasScope(ctx, "write")) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "This token is read-only. A write token is required to restore_version.",
            },
          ],
        };
      }
      const historical = await store.getVersion(ctx.namespace, packName, version);
      if (!historical) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No version ${version} of context pack "${packName}" exists to restore.`,
            },
          ],
        };
      }
      // Append the old content as a fresh version (no expectedVersion: this is an
      // intentional overwrite of the current head with a known-good past body).
      const pack = await store.put(ctx.namespace, packName, {
        content: historical.content,
        meta: historical.meta,
      });
      return {
        content: [
          {
            type: "text",
            text: `Restored context pack "${packName}" version ${version} as new version ${pack.version}.`,
          },
        ],
      };
    },
  );

  // RESOURCE (static): the DEFAULT pack, for surfaces that prefer resources over
  // tool calls. Unchanged URI + behavior — this is the back-compat resource.
  server.registerResource(
    "context",
    "carry://context",
    {
      title: "Context pack (default)",
      description: "The current default context pack for your namespace.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const pack = await store.get(ctx.namespace, DEFAULT_PACK_NAME);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: pack?.content ?? "No default context pack has been pushed for this namespace yet.",
          },
        ],
      };
    },
  );

  // RESOURCE (template): any named pack via carry://context/{pack}.
  server.registerResource(
    "context-pack",
    new ResourceTemplate("carry://context/{pack}", { list: undefined }),
    {
      title: "Context pack (named)",
      description: "A named context pack for your namespace, addressed as carry://context/{pack}.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const raw = variables.pack;
      const packName = Array.isArray(raw) ? raw[0] : raw;
      // Guard against a malformed template variable before it reaches the store.
      if (typeof packName !== "string" || !/^[a-z0-9._-]{1,64}$/.test(packName)) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: `Invalid pack name in URI: ${String(packName)}`,
            },
          ],
        };
      }
      const pack = await store.get(ctx.namespace, packName);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text:
              pack?.content ??
              `No context pack named "${packName}" has been pushed for this namespace yet.`,
          },
        ],
      };
    },
  );

  return server;
}
