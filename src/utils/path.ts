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
 * True if `fileExt` matches any entry in `allowList`. A rule that declares
 * `.jsx` implicitly covers `.js` too, and `.tsx` implicitly covers `.ts` —
 * Next.js and other frameworks routinely ship JSX inside `.js` files, and
 * the TSX parser handles both alike, so the rule's extension filter must
 * agree. Rules that want to opt out of the alias can list extensions
 * explicitly.
 */
export function extensionMatches(fileExt: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  if (allowList.includes(fileExt)) return true;
  if (fileExt === ".js" && allowList.includes(".jsx")) return true;
  if (fileExt === ".ts" && allowList.includes(".tsx")) return true;
  // `.scss` is transformed into a CSS AST by the SCSS parser adapter,
  // so any rule declaring `.css` as its extension (contrast/minimum,
  // contrast/enhanced, contrast/non-text, layout/*) applies to `.scss`
  // files too. This keeps rules and telemetry in sync without teaching
  // every CSS-shaped rule about Sass.
  if (fileExt === ".scss" && allowList.includes(".css")) return true;
  // `.mdx` is transformed into a TSX AST by the MDX parser adapter —
  // the embedded JSX in an MDX page IS the authoring surface. Any rule
  // declaring `.tsx` or `.jsx` as its extension (alt-text/missing,
  // link-text/missing, etc.) applies to `.mdx` files too, so MDX-based
  // doc sites participate in the same rule coverage as a JSX app.
  if (fileExt === ".mdx" && (allowList.includes(".tsx") || allowList.includes(".jsx"))) {
    return true;
  }
  // `.astro` is transformed into an HTML AST by the Astro parser
  // adapter — the template body of a `.astro` file is just HTML
  // (with JSX-style expression braces that pass through as
  // literal text). Any rule declaring `.html` as its extension
  // applies to `.astro` files too, so Astro-authored sites
  // participate in the same rule coverage as plain HTML.
  if (fileExt === ".astro" && (allowList.includes(".html") || allowList.includes(".htm"))) {
    return true;
  }
  return false;
}
