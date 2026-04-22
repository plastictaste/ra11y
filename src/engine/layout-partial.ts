/**
 * Layout / template-partial detection for HTML documents.
 *
 * Document-level rules (landmark-main, skip-link, lang-attribute, etc.)
 * assume the file they're evaluating is the whole rendered page. In
 * template-composed ecosystems — Jekyll, Hugo, ERB/Rails, Razor,
 * Astro/Handlebars — that's routinely false: one file opens `<html>`,
 * a second hands over to `{{ content }}` / `<%= yield %>` /
 * `@RenderBody`, and a third closes `</body></html>`. The scanner only
 * sees one file at a time, so a confident "missing X" emit against a
 * layout wrapper is dishonest — the missing element might live in a
 * sibling partial.
 *
 * {@link isHtmlLayoutOrPartial} gives rules a single predicate they can
 * route on: when it returns true, the rule still surfaces the finding
 * (surface-don't-suppress per docs/kb/architecture/ai-first-consumer.md),
 * but enriches the emit with a structured `couldBeWrongBecause` code so
 * an agent reading the finding follows the composition chain in one
 * read rather than acting on a false positive at the call site. The
 * deterministic escape hatch remains the source-level disable pragma.
 *
 * Kept separate from `src/engine/ast-helpers.ts` so the (static-analysis)
 * helper surface stays focused on AST traversal; layout/partial detection
 * mixes AST reads with raw-source regex scans (the HTML parser strips
 * `{{ … }}` / `{% … %}` / `<% … %>` from text nodes before the AST
 * exists — see src/input/parsers/html-template-directives.ts), and the
 * mix is easier to reason about as its own module.
 */

import type { HtmlDocument } from "../types/ast.ts";
import { findHtmlElementsByTag } from "./ast-helpers.ts";

/**
 * Path segments under which Jekyll, Hugo, Eleventy, and similar SSGs
 * place files whose rendered output is composed by a parent layout —
 * `_includes/foo.html`, `_layouts/default.html`, `_docs/intro.md`, etc.
 * Detected as substrings flanked by `/` (or boundary) so a top-level
 * `_layouts/` matches but `my_layouts_dir/` does not.
 *
 * Used by {@link looksLikeContentPartialPath} as one of the OR-branches
 * for partial-or-layout detection in rules (heading-hierarchy,
 * page-titled, …) where the file's *path* is the strongest signal that
 * the rendered page is composed elsewhere — `_docs/intro.md` is a
 * Jekyll content partial whose `<h1>` is supplied by the layout's
 * `page.title` front-matter, not by the file itself.
 */
const PARTIAL_PATH_SEGMENTS: readonly string[] = [
  "_docs",
  "_includes",
  "_layouts",
  "_posts",
  "_partials",
];

/**
 * True when `filePath` lives under a directory segment conventionally
 * used by static-site generators for content partials, layout wrappers,
 * or include fragments (`_docs`, `_includes`, `_layouts`, `_posts`,
 * `_partials`). The segment must be flanked by path separators (or be
 * a leading segment), so `my_layouts_extra/` does not match `_layouts`.
 *
 * Pure path inspection — no AST or source content read. Cheap to call
 * before the structural / source-content branches of
 * {@link isHtmlLayoutOrPartial}.
 */
export function looksLikeContentPartialPath(filePath: string): boolean {
  if (filePath.length === 0) return false;
  const normalized = filePath.replace(/\\/g, "/");
  for (const segment of PARTIAL_PATH_SEGMENTS) {
    // Leading segment, mid-path segment, or trailing segment — the
    // separator-flanking is what distinguishes `_layouts/x` from
    // `my_layouts/x`.
    const needle = `/${segment}/`;
    if (normalized.startsWith(`${segment}/`)) return true;
    if (normalized.includes(needle)) return true;
  }
  return false;
}

/**
 * True when the file's first non-whitespace token is a Liquid / Jinja
 * template directive (`{%- include … -%}`, `{% if … %}`, `{{ page.title }}`)
 * — strong evidence the file is a partial whose rendered output is
 * composed by a parent template. Skips a UTF-8 BOM and leading
 * horizontal/vertical whitespace; an HTML comment or DOCTYPE at the top
 * does NOT count (those are full-page signals).
 *
 * Distinct from {@link isHtmlLayoutOrPartial}'s composition-directive
 * branch, which fires on `{% include %}` / `{{ content }}` / `<%= yield %>`
 * *anywhere* in the source. The leading-token check is stricter — it
 * fires only when the very top of the file is a directive, the shape
 * Jekyll `_includes/header.html` and similar partials take.
 */
export function hasLeadingTemplateDirective(source: string): boolean {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  while (i < source.length) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= source.length) return false;
  const head = source.slice(i, i + 2);
  // Liquid / Jinja interpolation, Liquid / Jinja tag (with optional
  // whitespace-control dash), ERB. The two-char prefix is sufficient —
  // we don't need to verify the closer here.
  return head === "{{" || head === "{%" || head === "<%";
}

/**
 * True when the parsed HTML file looks like a layout wrapper or template
 * partial — a file whose rendered output is composed at build time from
 * (a) its own markup AND (b) another file's content. Distinct from
 * `isHtmlFragment`, which is a stricter "no root tags" shape: a Jekyll
 * `_layouts/default.html` DOES have `<html>`/`<body>` but still cannot
 * be scanned as a self-contained page because the child content
 * (`{{ content }}`) is injected at render time.
 *
 * Detection branches (layered cheapest-first):
 *   1. Has `<html>` XOR has `<body>` — a layout-opener (head + opening
 *      body tag, Jekyll `_includes/top.html`) or layout-closer (closing
 *      body + footer, Jekyll `_includes/footer.html`). The asymmetric
 *      root-tag shape is strong evidence the file pairs with a sibling
 *      to form a complete document. A raw `<div>` snippet with NEITHER
 *      `<html>` NOR `<body>` doesn't qualify here — it's a component
 *      fragment, not a layout-composition site. That keeps the predicate
 *      honest: "no html, no body, no template evidence" is just a
 *      component, and `isHtmlFragment` already exists for that.
 *   2. Source starts with `---\nlayout:` — Jekyll / Eleventy front-matter
 *      declaring the file uses a parent layout at render time.
 *   3. Source contains a composition directive:
 *        - `{% include` / `{% render` (Liquid / Nunjucks / Jekyll / Shopify)
 *        - `{{ content }}` / `{{ body }}` (Liquid layouts, Hugo)
 *        - `<%= yield %>` / `<% yield %>` (ERB layouts — Rails, Middleman)
 *        - `@RenderBody` / `@RenderSection` (Razor / ASP.NET MVC)
 *      Presence of any one of these means part of the rendered page is
 *      injected from somewhere static analysis cannot reach.
 *
 * Pure function over the parsed document + raw source. Returns false
 * for self-contained HTML pages with no template directives and for
 * bare component fragments with neither root tag nor composition
 * evidence.
 *
 * @param doc parsed HTML document
 * @param source original file source text — required for branches 2/3
 *   (the parser strips template directives from text nodes, so the AST
 *   alone cannot see them)
 */
export function isHtmlLayoutOrPartial(doc: HtmlDocument, source: string): boolean {
  // Branch 1: asymmetric root shape — one of `<html>` / `<body>` present
  // without the other. Full-document pages have both; true fragments
  // have neither; layout-opener / layout-closer partials have exactly one.
  const hasHtml = findHtmlElementsByTag(doc, "html").length > 0;
  const hasBody = findHtmlElementsByTag(doc, "body").length > 0;
  if (hasHtml !== hasBody) return true;
  // Branch 2: Jekyll / Eleventy front-matter. The parser does not
  // consume the `---`-delimited YAML header; we read the raw source.
  if (hasJekyllLayoutFrontMatter(source)) return true;
  // Branch 3: composition directive anywhere in the source.
  return hasCompositionDirective(source);
}

/**
 * Returns true when `source` begins with a Jekyll / Eleventy front-matter
 * block whose YAML declares a `layout:` key. A bare `---` block without
 * `layout:` (e.g. Jekyll post with only `title:` / `date:`) does NOT
 * count as a layout partial — a stand-alone page with front-matter is
 * still a full page as far as the scanner is concerned.
 *
 * Accepts a UTF-8 BOM and a handful of leading blank lines so typical
 * authoring quirks don't produce false negatives.
 */
function hasJekyllLayoutFrontMatter(source: string): boolean {
  let i = 0;
  // Skip UTF-8 BOM.
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  // Skip leading blank lines.
  while (i < source.length && (source[i] === "\n" || source[i] === "\r")) i += 1;
  // Require an opening `---` on its own line.
  if (!source.startsWith("---", i)) return false;
  const afterOpener = i + 3;
  if (afterOpener >= source.length) return false;
  const nextChar = source[afterOpener];
  if (nextChar !== "\n" && nextChar !== "\r") return false;
  // Find the closing `---` line.
  const closer = source.indexOf("\n---", afterOpener);
  if (closer === -1) return false;
  const header = source.slice(afterOpener, closer);
  // Match a `layout:` key at the start of any header line. YAML allows
  // `layout: foo`, `layout:"foo"`, `layout : foo` — keep the match narrow
  // (key followed by `:`) rather than trying to parse YAML.
  return /(^|\n)\s*layout\s*:/.test(header);
}

/**
 * Returns true when `source` contains a template-engine composition
 * directive — the file emits markup at render time that pulls from
 * somewhere the static scanner cannot reach. Scans the raw source
 * because the HTML parser strips `{{ … }}` / `{% … %}` / `<% … %>` from
 * text nodes before the AST is built.
 */
function hasCompositionDirective(source: string): boolean {
  // Liquid / Nunjucks / Jekyll include or render tag. `{% include`
  // covers `{% include_relative`, `{% include %}`, `{%- include …`.
  if (/\{%-?\s*(?:include|render)\b/.test(source)) return true;
  // Liquid / Hugo child-content interpolation. Match the canonical
  // `{{ content }}` and `{{ body }}` without trying to resolve arbitrary
  // identifiers — false positives on e.g. `{{ content | filter }}` are
  // desired (the file still composes child content).
  if (/\{\{-?\s*(?:content|body)\s*(?:\||-?\}\})/.test(source)) return true;
  // ERB layouts — `<%= yield %>` (and `<% yield %>` for block forms).
  if (/<%=?\s*yield\b/.test(source)) return true;
  // Razor / ASP.NET — `@RenderBody()` / `@RenderSection("name")`.
  if (/@Render(?:Body|Section)\b/.test(source)) return true;
  return false;
}
