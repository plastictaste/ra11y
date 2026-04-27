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
  ".xhtml",
  ".css",
  ".scss",
  ".less",
  ".mdx",
  ".astro",
  ".md",
  ".markdown",
  ".mkdn",
  ".svg",
  ".erb",
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
 *   - `.less` aliases into `.css`: the Less adapter likewise produces
 *     a CSS AST. Same reasoning as `.scss`.
 *   - `.mdx` aliases into TSX-family: the MDX adapter produces a TSX
 *     AST, so every `.tsx`/`.jsx`-scoped rule applies.
 *   - `.astro` aliases into HTML-family: the Astro adapter produces
 *     an HTML AST, so every `.html`/`.htm`-scoped rule applies.
 *   - `.md` / `.markdown` / `.mkdn` alias into HTML-family: the Markdown
 *     adapter (ADR 0025 Option B) strips markdown syntax, rewrites
 *     `![alt](url)` as `<img>`, and feeds the residue to parseHtml,
 *     producing an HTML AST. `.mkdn` is a common alternate Markdown
 *     extension (Vim, older static-site generators); routing it through
 *     the same adapter avoids dropping otherwise-valid Markdown input.
 *   - `.xhtml` aliases into HTML-family: XHTML is XML-serialized HTML
 *     (close-bracket angle slashes, `<?xml ... ?>` prologue, mandatory
 *     namespace on `<html>`); the existing HTML parser tolerates the
 *     prologue and self-closing tags so every `.html`-scoped rule
 *     applies without a dedicated XHTML adapter.
 *   - `.svg` aliases into HTML-family: the SVG adapter passes through
 *     to parseHtml (the HTML tokenizer tolerates SVG's tag zoo and
 *     preserves `<title>` as raw-text), so every `.html`/`.htm`-scoped
 *     rule that inspects `<svg>` / `<title>` / `role="img"` /
 *     `aria-label` / `aria-hidden` applies.
 *   - `.erb` aliases into HTML-family: ERB (`.html.erb`, `.erb`) is
 *     the Ruby embedded-template syntax (Rails views, Middleman
 *     templates, Jekyll `*.md.erb` scaffolds). We route straight to
 *     parseHtml — the HTML parser's `stripTemplateDirectives` pass
 *     already removes `<%= … %>` / `<% … %>` / `<%# … %>` spans from
 *     text nodes, so rules see the rendered-text shape. Every
 *     `.html`/`.htm`-scoped rule applies.
 */
const EXTENSION_ALIASES: readonly { readonly from: string; readonly to: readonly string[] }[] = [
  { from: ".js", to: [".jsx"] },
  { from: ".ts", to: [".tsx"] },
  { from: ".scss", to: [".css"] },
  { from: ".less", to: [".css"] },
  { from: ".mdx", to: [".tsx", ".jsx"] },
  { from: ".astro", to: [".html", ".htm"] },
  { from: ".md", to: [".html", ".htm"] },
  { from: ".markdown", to: [".html", ".htm"] },
  { from: ".mkdn", to: [".html", ".htm"] },
  { from: ".xhtml", to: [".html", ".htm"] },
  { from: ".svg", to: [".html", ".htm"] },
  { from: ".erb", to: [".html", ".htm"] },
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

/**
 * Extensions whose source represents rendered DOM — HTML markup or
 * JSX-bearing component files where the elements the parser surfaces
 * correspond to the runtime element tree. HTML-shape rules
 * (`document/iframe-title`, `navigation/href-empty-fragment`,
 * `navigation/href-javascript-scheme`, `tooltip/dismissable`) consult
 * this set as a belt-and-braces gate before acting on JSX nodes — the
 * `appliesTo.fileExtensions` check earlier in the pipeline aliases
 * `.js → .jsx` / `.ts → .tsx` to keep Next.js-style JSX-in-`.js` corpora
 * scanning, but minified JS plugins and packed bundles can still parse
 * to JSX-shaped substrings even when no real DOM element is present at
 * runtime (the parser's bare-JS gate is heuristic on JSX-import signals
 * and can miss). For rules that depend on the *DOM-rendered* role of an
 * element (the
 * anchor's role at click time, the iframe's announced name, the native
 * tooltip's keyboard behavior), bare `.js` / `.ts` is not the right
 * substrate even when the parser confidently produced JSX nodes — the
 * surrounding code may be a packed plugin embedding HTML strings, a
 * JS-API wrapper, or anything else where the substring isn't
 * a real DOM element. JSX-bearing extensions (`.jsx`, `.tsx`, `.mdx`,
 * `.astro`) and HTML-family extensions (`.html`, `.htm`, `.xhtml`, `.svg`, `.md`,
 * `.markdown`, `.mkdn`, `.erb`, `.vue`, `.svelte`) are trusted as DOM-origin.
 *
 * `.vue` and `.svelte` are listed for forward compatibility — the parser
 * registry doesn't dispatch dedicated SFC parsers today, but when it does
 * (the `<template>` block in either format is HTML-shape), the gate stays
 * correct without per-rule churn.
 */
const DOM_ORIGIN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".jsx",
  ".tsx",
  ".mdx",
  ".astro",
  ".svg",
  ".md",
  ".markdown",
  ".mkdn",
  ".erb",
  ".vue",
  ".svelte",
]);

/**
 * True when the file's extension represents rendered DOM markup or
 * JSX-bearing component source. Used by HTML-shape rules to skip bare
 * `.js` / `.ts` / `.mjs` / `.cjs` / `.mts` / `.cts` inputs even when the
 * upstream `appliesTo` alias (`.js → .jsx`) would otherwise let those
 * files through. See {@link DOM_ORIGIN_EXTENSIONS} for rationale.
 */
export function isDomOriginExtension(filePath: string): boolean {
  return DOM_ORIGIN_EXTENSIONS.has(extension(filePath));
}
