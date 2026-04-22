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
