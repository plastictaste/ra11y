/**
 * Per-extension `ra11y-disable` pragma form for checklist candidates.
 *
 * The `checklist` tool ships a ready-to-paste pragma on every review
 * candidate so an agent dismissing in source has the canonical
 * spelling without cross-referencing rule IDs or comment dialects.
 * Earlier the field was a 4-key object (`{ html, jsx, liquid, hugo }`)
 * shipped on every candidate regardless of the candidate's actual file
 * extension — an agent picking the `html` form on a `.scss` / `.css`
 * / `.js` / `.ts` candidate would corrupt source because HTML-comment
 * syntax is invalid in those contexts. The 4-key shape was the
 * canonical "ambiguous field shape is dishonest" failure mode (see
 * `docs/kb/architecture/ai-first-consumer.md`): the response advertised
 * four valid options when only ONE was syntactically valid for the
 * candidate's specific file.
 *
 * The replacement: a single string keyed off the candidate's file
 * extension, returning the comment shape that:
 *   1. Parses cleanly in that file's syntax (JSX expression for
 *      `.jsx` / `.tsx` / `.mdx`; CSS block comment for `.css` /
 *      `.scss` / `.sass` / `.less`; line comment for `.js` / `.ts`
 *      / `.mjs` / `.cjs`; HTML comment for `.html` / `.htm` /
 *      `.xhtml` / `.markdown` / `.md` / `.mkdn` / `.svg` / `.astro`
 *      / `.vue` / `.svelte` / `.erb` / `.liquid`); AND
 *   2. Is recognized by `parseInlineDisables` in
 *      `src/config/inline-disables.ts` so the suppression actually
 *      fires on subsequent scans.
 *
 * This is the region-opening (`ra11y-disable`) form, not the
 * `-next-line` variant. The checklist surface points the agent at the
 * criterion it should review; the agent typically dismisses by
 * scoping the disable to a region (the file or a sub-tree) rather
 * than a single line, since the candidate often represents a
 * spec-level concern that spans multiple sibling elements. The
 * line-scoped `-next-line` variant lives on the per-finding `fix`
 * shape (`build-finding.ts` `buildSuppressPragma`) where each finding
 * pinpoints a single line.
 *
 * Mirror-shape note: `tool-suppress.ts` carries the writer half for
 * the `-next-line` variant, and `build-finding.ts` carries the
 * per-finding agent-facing reader half. This module is the
 * candidate-facing reader half. All three converge on the same
 * extension table; if you add an extension here, mirror it in
 * `tool-suppress.ts` `EXT_SHAPES` (writer) and `build-finding.ts`
 * `buildSuppressPragma` (per-finding reader) so the three surfaces
 * stay aligned.
 */

/**
 * Returns the canonical `ra11y-disable <id>` pragma string for the
 * file at `filePath`, scoped to `criterionId`. The string is
 * ready-to-paste: the agent inserts it as a region-opening pragma
 * above the cited element / declaration.
 *
 * Unknown extensions fall back to the JS line-comment form
 * (`// ra11y-disable <id>`) since plain script files are the most
 * permissive shape that still parses on most extensions outside the
 * explicit table.
 *
 * @param filePath - The candidate's source path. Only the extension
 *   is consulted; case is normalized.
 * @param criterionId - The criterion ID the candidate covers
 *   (e.g. `wcag22:1.4.5`). Embedded after `ra11y-disable` so the
 *   suppression is scoped — a bare `ra11y-disable` would silence
 *   every rule on the surrounding region.
 * @returns A single-line pragma string syntactically valid for the
 *   file's extension AND recognized by the inline-disable parser.
 */
export function pragmaFormForExtension(filePath: string, criterionId: string): string {
  const lower = filePath.toLowerCase();

  // JSX expression form — valid in JSX template position and at
  // module scope. `.mdx` routes through MDX which embeds JSX
  // expressions verbatim.
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx") || lower.endsWith(".mdx")) {
    return `{/* ra11y-disable ${criterionId} */}`;
  }

  // CSS block-comment form — valid in `.css` / `.scss` / `.sass`
  // (despite Sass's whitespace syntax, `/* … */` block comments are
  // honored by every Sass dialect) / `.less`.
  if (
    lower.endsWith(".css") ||
    lower.endsWith(".scss") ||
    lower.endsWith(".sass") ||
    lower.endsWith(".less")
  ) {
    return `/* ra11y-disable ${criterionId} */`;
  }

  // HTML comment form — valid in markup files AND template languages
  // that pass HTML comments through verbatim. `.svg` is XML which
  // also accepts `<!-- … -->`. `.astro` / `.vue` / `.svelte` are
  // template-shaped and use HTML-comment syntax in template
  // position. `.erb` is HTML with embedded Ruby; the ERB pre-
  // processor passes `<!-- … -->` through unchanged. `.liquid` is
  // also HTML-with-bindings; while Liquid has its own
  // `{% comment %}…{% endcomment %}` form, the rendered HTML
  // includes the `<!-- … -->` form verbatim and the inline-disable
  // parser recognizes both. `.markdown` / `.md` / `.mkdn` route
  // through `parseHtml` after the markdown stripper (ADR 0025);
  // raw HTML comments pass through CommonMark verbatim.
  if (
    lower.endsWith(".html") ||
    lower.endsWith(".htm") ||
    lower.endsWith(".xhtml") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".md") ||
    lower.endsWith(".mkdn") ||
    lower.endsWith(".svg") ||
    lower.endsWith(".astro") ||
    lower.endsWith(".vue") ||
    lower.endsWith(".svelte") ||
    lower.endsWith(".erb") ||
    lower.endsWith(".liquid")
  ) {
    return `<!-- ra11y-disable ${criterionId} -->`;
  }

  // CSS-style block comment also works for `.js` / `.ts` / `.mjs`
  // / `.cjs` and is the canonical shape `parseInlineDisables`
  // reads. Could equivalently emit `// ra11y-disable …`; the block
  // form is preferred so the pragma reads identically across the
  // CSS-and-JS family of extensions.
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return `/* ra11y-disable ${criterionId} */`;
  }

  // Default: line-comment form. `parseInlineDisables` recognizes
  // `// ra11y-…` regardless of file extension, so unknown extensions
  // (config files, dotfiles without an extension table entry, etc.)
  // get the most universally compatible shape.
  return `// ra11y-disable ${criterionId}`;
}
