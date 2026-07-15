/**
 * A "context pack" is the payload carry relays between Claude surfaces.
 *
 * It is deliberately format-agnostic: the `content` is just a string (Markdown,
 * in practice), and carry never parses or interprets it. carry's only job is to
 * store the latest pack for a namespace and hand it back verbatim. What the pack
 * *means* (voice rules, system facts, a style guide) is entirely up to the caller.
 */
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
   * Server-set. Monotonic per namespace.
   */
  version: number;
}

/** A pack as accepted from a writer, before carry stamps server-owned fields. */
export interface IncomingPack {
  content: string;
  meta?: Record<string, unknown>;
}
