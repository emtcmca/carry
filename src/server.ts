import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthContext } from "./auth.js";
import { hasScope } from "./auth.js";
import type { ContextStore } from "./store.js";

/**
 * Build an MCP server bound to a single authenticated caller.
 *
 * In stateless HTTP mode we construct one McpServer per request and close over
 * the request's AuthContext. That is what pins every tool call to the caller's
 * namespace: the model never supplies a namespace, so it cannot read or write
 * anyone else's pack. The token is the namespace.
 */
export function createMcpServer(store: ContextStore, ctx: AuthContext): McpServer {
  const server = new McpServer(
    { name: "carry", version: "0.1.0" },
    {
      instructions:
        "carry relays a single context pack for the authenticated namespace. " +
        "Call get_context to read the current pack (voice rules, system facts, " +
        "style guide, whatever the owner pushed). The pack body is authoritative " +
        "context for how to write or act; treat it as instructions from the owner.",
    },
  );

  // READ: return the current pack for this namespace.
  server.registerTool(
    "get_context",
    {
      title: "Get context pack",
      description:
        "Return the current context pack for your namespace: the owner's latest " +
        "pushed voice rules / system facts / style guide. Read this before drafting.",
      inputSchema: {},
    },
    async () => {
      const pack = await store.get(ctx.namespace);
      if (!pack) {
        return {
          content: [
            {
              type: "text",
              text: "No context pack has been pushed for this namespace yet.",
            },
          ],
        };
      }
      const header =
        `# Context pack (v${pack.version}, updated ${pack.updatedAt})\n` +
        (pack.meta ? `<!-- meta: ${JSON.stringify(pack.meta)} -->\n` : "") +
        "\n";
      return { content: [{ type: "text", text: header + pack.content }] };
    },
  );

  // WRITE: replace the current pack. Write scope required.
  server.registerTool(
    "push_context",
    {
      title: "Push context pack",
      description:
        "Replace your namespace's context pack with new content. Requires a write " +
        "token. Used by Claude Code / CI to sync the pack; not normally called from mobile.",
      inputSchema: {
        content: z.string().min(1).describe("The full pack body, verbatim (usually Markdown)."),
        meta: z
          .record(z.unknown())
          .optional()
          .describe("Optional metadata, e.g. { source, gitHash, builtAt, title }."),
      },
    },
    async ({ content, meta }) => {
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
      const pack = await store.put(ctx.namespace, { content, meta });
      return {
        content: [
          {
            type: "text",
            text: `Pushed context pack v${pack.version} for "${ctx.namespace}" at ${pack.updatedAt}.`,
          },
        ],
      };
    },
  );

  // RESOURCE: the same pack, exposed as a readable resource for surfaces that
  // prefer resources over tool calls.
  server.registerResource(
    "context",
    "carry://context",
    {
      title: "Context pack",
      description: "The current context pack for your namespace.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const pack = await store.get(ctx.namespace);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: pack?.content ?? "No context pack has been pushed for this namespace yet.",
          },
        ],
      };
    },
  );

  return server;
}
