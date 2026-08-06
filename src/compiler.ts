/**
 * Pack compiler — pure, deterministic.
 *
 * Turns a set of source Markdown files into a single "context pack" shaped for
 * the carry server's `push_context` tool (see pack.ts `IncomingPack`). carry
 * never parses the body, so all this does is concatenate the sources verbatim
 * under traceable markers and stamp caller-supplied provenance into `meta`.
 *
 * Deliberately has NO side effects: it never calls git and never reads the
 * clock. `gitHash` and `builtAt` are injected by the caller (the CLI layer),
 * which keeps this unit fully testable with fixed, predictable values.
 */

/** A single source file to fold into the pack. */
export interface SourceFile {
  /** Path as the caller referred to it. Only the basename lands in the pack. */
  path: string;
  /** File body, verbatim. Never rewritten. */
  content: string;
}

/** Everything the compiler needs. gitHash/builtAt are injected, not resolved here. */
export interface CompilePackInput {
  files: SourceFile[];
  title?: string;
  gitHash?: string;
  builtAt?: string;
}

/** The compiled pack, ready to hand to `push_context` as `{ content, meta }`. */
export interface CompiledPack {
  content: string;
  meta: Record<string, unknown>;
}

/**
 * Cross-platform basename. Node's `path.basename` is platform-specific (on POSIX
 * it does not treat `\` as a separator), which would make output depend on the
 * host OS. We split on both separators so the pack is identical everywhere and
 * tests are deterministic regardless of the runner's platform.
 */
function basename(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * Compile source files into a context pack.
 *
 * `content`: each file's body, in the given order, preceded by an
 * `<!-- source: <basename> -->` marker so a reader can trace any line back to
 * its origin. Bodies are otherwise untouched. Files are joined with a blank
 * line between blocks.
 *
 * `meta`: `{ source, title, gitHash, builtAt }` — `source` is the ordered list
 * of basenames; the rest are passed straight through from the caller.
 */
export function compilePack(inputs: CompilePackInput): CompiledPack {
  const files = inputs.files ?? [];
  const sources = files.map((f) => basename(f.path));

  const content = files
    .map((f) => `<!-- source: ${basename(f.path)} -->\n${f.content}`)
    .join("\n\n");

  const meta: Record<string, unknown> = {
    source: sources,
    title: inputs.title,
    gitHash: inputs.gitHash,
    builtAt: inputs.builtAt,
  };

  return { content, meta };
}

/** One file recovered from a compiled pack: its stamped name and verbatim body. */
export interface PulledFile {
  name: string;
  content: string;
}

/**
 * The inverse of `compilePack`'s `content`: split a pack back into its source files
 * by the `<!-- source: <name> -->` markers the compiler stamps.
 *
 * Works on either the raw compiled `content` or the full `get_context` output —
 * anything before the first marker (the `# Context pack ...` header and the
 * `<!-- meta: ... -->` line) is simply ignored, since nothing precedes the first
 * marker in a compiled pack. Pure: no FS, no clock.
 *
 * Faithfully recovers each body: the compiler joins blocks with a `\n\n` separator,
 * so every block except the last carries a trailing `\n\n` that is not part of the
 * file — we strip exactly that, and leave the final block untouched. A pack with no
 * markers (e.g. one pushed as raw content, not compiled from files) yields `[]`.
 */
export function splitPackIntoFiles(pack: string): PulledFile[] {
  const marker = /<!-- source: (.*?) -->\n/g;
  const matches = [...pack.matchAll(marker)];
  const files: PulledFile[] = [];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim();
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const isLast = i === matches.length - 1;
    const end = isLast ? pack.length : (matches[i + 1].index ?? pack.length);
    let content = pack.slice(start, end);
    // Non-final blocks end in the compiler's `\n\n` join separator — strip it.
    if (!isLast && content.endsWith("\n\n")) content = content.slice(0, -2);
    files.push({ name, content });
  }
  return files;
}
