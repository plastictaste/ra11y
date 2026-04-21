/**
 * Path helpers. Thin wrappers around node:path that narrow our surface
 * to just what the scanner needs.
 */

import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export { extname, isAbsolute, join, relative, resolve, sep };

/** Returns the POSIX extension of a file (e.g., ".tsx"), or empty string. */
export function extension(filePath: string): string {
  return extname(filePath).toLowerCase();
}

/** True if the path ends with a known parseable extension. */
export function hasParseableExtension(filePath: string): boolean {
  return PARSEABLE_EXTENSIONS.has(extension(filePath));
}

/**
 * Canonical list of file extensions the parser registry knows how to
 * turn into an AST. Exported so error envelopes, documentation, and
 * telemetry can derive their "supported files" messaging from the same
 * source of truth instead of drifting copies. The set is the single
 * authority; `parseableExtensions()` returns a stable sorted array for
 * consumers that want a readonly list (e.g. to join into a remediation
 * string).
 */
export const PARSEABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".mdx",
  ".astro",
  ".md",
  ".markdown",
]);

/**
 * Sorted readonly array view over {@link PARSEABLE_EXTENSIONS}. Useful
 * for building remediation strings or deterministic docs output — the
 * sort keeps the list stable as the set grows so callers don't have to
 * re-sort at every call site.
 */
export function parseableExtensions(): readonly string[] {
  return [...PARSEABLE_EXTENSIONS].sort();
}

/**
 * True when the file's basename matches the Storybook story-file
 * convention: `Foo.stories.{tsx,jsx,ts,js}` or `Foo.story.{tsx,jsx,ts,js}`.
 * Used by `preset: "storybook"` plumbing to decide per-file whether
 * Storybook-specific transparency applies. Case-sensitive on the
 * `.stories` / `.story` marker (Storybook itself is) and accepts both
 * `/` and `\` path separators for Windows paths.
 */
export function isStorybookStoryFile(filePath: string): boolean {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = lastSep === -1 ? filePath : filePath.slice(lastSep + 1);
  return STORY_BASENAME_RE.test(basename);
}

/** Matches `<name>.stories.<ext>` or `<name>.story.<ext>` basenames. */
const STORY_BASENAME_RE = /^[^.]+\.(?:stories|story)\.(?:tsx|jsx|ts|js)$/;

/**
 * Extension-alias table: a file extension that maps into an AST
 * shape another extension already declares. Ordered by source
 * extension; each row lists every allow-list extension that should
 * match a file with the source extension.
 *
 *   - `.js` / `.ts` alias to JSX-family: Next.js and friends ship
 *     JSX inside plain `.js`, and the TSX parser handles both alike.
 *   - `.scss` aliases into `.css`: the SCSS adapter produces a CSS
 *     AST, so every `.css`-scoped rule applies.
 *   - `.mdx` aliases into TSX-family: the MDX adapter produces a TSX
 *     AST, so every `.tsx`/`.jsx`-scoped rule applies.
 *   - `.astro` aliases into HTML-family: the Astro adapter produces
 *     an HTML AST, so every `.html`/`.htm`-scoped rule applies.
 *   - `.md` / `.markdown` alias into HTML-family: the Markdown
 *     adapter (ADR 0025 Option B) strips markdown syntax, rewrites
 *     `![alt](url)` as `<img>`, and feeds the residue to parseHtml,
 *     producing an HTML AST.
 */
const EXTENSION_ALIASES: readonly { readonly from: string; readonly to: readonly string[] }[] = [
  { from: ".js", to: [".jsx"] },
  { from: ".ts", to: [".tsx"] },
  { from: ".scss", to: [".css"] },
  { from: ".mdx", to: [".tsx", ".jsx"] },
  { from: ".astro", to: [".html", ".htm"] },
  { from: ".md", to: [".html", ".htm"] },
  { from: ".markdown", to: [".html", ".htm"] },
];

/**
 * True if `fileExt` matches any entry in `allowList`. A rule that declares
 * `.jsx` implicitly covers `.js` too, and `.tsx` implicitly covers `.ts` —
 * Next.js and other frameworks routinely ship JSX inside `.js` files, and
 * the TSX parser handles both alike, so the rule's extension filter must
 * agree. Rules that want to opt out of the alias can list extensions
 * explicitly. See {@link EXTENSION_ALIASES} for the full alias table.
 */
export function extensionMatches(fileExt: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  if (allowList.includes(fileExt)) return true;
  const alias = EXTENSION_ALIASES.find((a) => a.from === fileExt);
  if (!alias) return false;
  return alias.to.some((to) => allowList.includes(to));
}
