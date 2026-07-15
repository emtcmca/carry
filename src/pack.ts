/**
 * A "context pack" is the payload carry relays between Claude surfaces.
 *
 * It is deliberately format-agnostic: the `content` is just a string (Markdown,
 * in practice), and carry never parses or interprets it. carry's only job is to
 * store named packs for a namespace and hand them back verbatim. What a pack
 * *means* (voice rules, system facts, a style guide) is entirely up to the caller.
 *
 * A namespace holds MULTIPLE named packs (voice + systems + project, say), each
 * keyed by a `packName`. A caller that omits the name reads/writes `"default"`,
 * so the original single-pack behavior still works unchanged.
 */

/** The pack a caller reads/writes when it does not name one. */
export const DEFAULT_PACK_NAME = "default";

/**
 * Version of the pack *shape* (not its content). Stamped by the server onto every
 * stored pack so a future reader can detect when the pack structure changed and
 * adapt. Bump this only when the ContextPack shape itself changes, never on content.
 */
export const PACK_SCHEMA_VERSION = 1;

/**
 * Default byte cap on a pack's `content`, in bytes (256 KB). A context pack is
 * meant to be voice rules / system facts / a style guide — kilobytes, not
 * megabytes. Capping the body keeps a single push from bloating the store, a
 * connector read, or a request body. Overridable per-deploy via CARRY_MAX_PACK_BYTES.
 */
export const DEFAULT_MAX_PACK_BYTES = 262144;

/**
 * Resolve the effective max pack-content size in bytes from the environment.
 * `CARRY_MAX_PACK_BYTES`, when set, must be a positive integer; anything else is a
 * misconfiguration and throws (fail loud, like the auth config) rather than silently
 * falling back. Unset -> the 256 KB default.
 */
export function resolveMaxPackBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CARRY_MAX_PACK_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_PACK_BYTES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `CARRY_MAX_PACK_BYTES must be a positive integer number of bytes; got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

/**
 * A pack name must be a short, filesystem-and-URL-safe slug: 1–64 chars of
 * lowercase letters, digits, dot, underscore, or hyphen. This keeps names usable
 * inside the `carry://context/{pack}` resource URI and as DB keys, and rejects
 * whitespace, path separators, and casing surprises.
 */
const PACK_NAME_PATTERN = /^[a-z0-9._-]{1,64}$/;

/**
 * Throw a clear error if `packName` is not a valid slug. Used by the store (so the
 * contract holds regardless of caller) and mirrored by the server's zod schema.
 */
export function assertValidPackName(packName: string): void {
  if (typeof packName !== "string" || !PACK_NAME_PATTERN.test(packName)) {
    throw new Error(
      `Invalid packName ${JSON.stringify(packName)}: must match [a-z0-9._-] and be 1–64 characters.`,
    );
  }
}

export interface ContextPack {
  /** The pack body, verbatim. Usually Markdown. carry never parses this. */
  content: string;
  /**
   * Optional caller-supplied metadata. carry stores and returns it untouched.
   * Convention (not enforced): { source, gitHash, builtAt, title }.
   */
  meta?: Record<string, unknown>;
  /** ISO-8601 timestamp of when carry last accepted this pack. Server-set. */
  updatedAt: string;
  /**
   * Opaque version marker, bumped on every successful push. Lets a reader tell
   * "is this the same pack I saw last time?" without diffing the whole body.
   * Server-set. Monotonic per (namespace, packName).
   */
  version: number;
  /**
   * Version of the pack shape (see PACK_SCHEMA_VERSION). Server-set on every pack
   * so readers can detect structural changes independently of content `version`.
   */
  packSchema: number;
}

/** A pack as accepted from a writer, before carry stamps server-owned fields. */
export interface IncomingPack {
  content: string;
  meta?: Record<string, unknown>;
}
