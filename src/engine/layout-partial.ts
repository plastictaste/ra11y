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

import type { HtmlDocument, HtmlElement } from "../types/ast.ts";
import { findHtmlElementsByTag, walkHtmlElements } from "./ast-helpers.ts";

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

// ---------------------------------------------------------------------------
// looksLikeFullPage — full-page-vs-fragment eligibility predicate
// ---------------------------------------------------------------------------
//
// A page "looks like a page" when one of the following signals is
// present in the body. The branches are layered cheapest-first and
// reflect successively weaker structural evidence:
//
//   A. Explicit landmark structure — header, nav, footer, or aside.
//      The author has already reached for landmarks; expecting `main`
//      is the natural completion.
//
//   B. An `<h1>` plus body content (≥ 5 element descendants of body).
//      A top-level page heading paired with non-trivial body content
//      is the canonical "I'm a page" shape — counter / FAQ / multi-step
//      widget pages all hit this branch. The descendant threshold keeps
//      one-h1-plus-one-img demonstration fixtures (alt-text snippets,
//      parsing-id-shape snippets) below the bar.
//
//   C. Any heading + a list (ul/ol/dl) + at least one interactive
//      element. A heading naming a list of items below an interactive
//      control is "real content area" shape — the hidden-search /
//      product-list pattern. This branch is intentionally narrow: it
//      requires three concurrent signals so isolated demo fixtures
//      (radio group with a heading, link cluster with a heading) stay
//      below the bar.
//
//   D. Any heading + a `<script>` descendant of `<body>`. A page that
//      loads its own JavaScript in the body is a real script-driven
//      page, not a fragment/fixture (no good-path HTML fixture in the
//      repo carries a `<script>` at all). The `<h3>`-only expanding-
//      cards / card-gallery shape hits this branch: card titles are
//      headings below h1, and the widget script is included at body
//      close. Pairing script-presence with *any* heading (not h1
//      specifically) catches the shape without widening past the
//      "author wrote content" baseline that branches B and C assume.
//
//   E. Empty-structural-shell — body has ≥3 visible (non-script,
//      non-style) descendants AND zero headings AND zero landmarks.
//      Pages shaped like `<body><div>…</div><div>…</div><div>…</div>
//      </body>` (theme-clock, kinetic-loader, random-image-generator,
//      hoverboard — vanilla JS demo projects whose visible UI is
//      composed of decorative `<div>` and `<img>` containers) clear
//      none of branches A-D because they have no heading and no
//      landmark anywhere. The empty body is a *stronger* 1.3.1 signal
//      than a page with the wrong heading level — there is nothing
//      programmatically determinable about page structure at all — so
//      treating it as a fragment under-surfaces the worst case.
//      Branch E is intentionally narrow: ≥3 visible descendants
//      ensures we don't false-positive on tiny snippets, and the
//      "no heading AND no landmark" condition guarantees branches
//      A-D don't fire for a different reason. A body with ONLY a
//      `<script>` (vanilla JS demo whose DOM is generated at runtime)
//      is a different shape — covered by V1-EMPTY-ROOT-DIV-SCRIPT-
//      ONLY-WARNING and explicitly NOT by this branch (the visible-
//      descendant tally excludes script + style nodes).
//
// Below the bar: minimal documents (alt-text snippets, attribute-rule
// fixtures, email templates) that have no landmarks, no h1 + body
// content, no heading + list + interactive trio, no heading + body-
// script pair, and fewer than 3 visible body descendants. Treating
// those as fragments avoids noisy "missing <main>" warnings on
// documents that genuinely have nothing to wrap.
//
// Doctrine note (`docs/kb/architecture/ai-first-consumer.md`): the
// thresholds here gate *whether the rule evaluates*, not whether a
// finding is reported. A document above the bar always emits its
// finding to the agent; a document below the bar is treated as a
// fragment, the same way a body-less document is. This is rule-level
// scope selection, not finding-level suppression.
//
// Shared between `semantics/landmark-main` (used to gate "missing
// `<main>`" emits) and `semantics/heading-hierarchy` (used to gate the
// "missing `<h1>` on a full page" variant per Q3-HEADING-HIERARCHY-
// MISSING-H1-VARIANT). Conceptual opposite of {@link looksLikeContentPartialPath}
// + {@link hasLeadingTemplateDirective}: those mark a file as a
// fragment composed by a parent layout; this one marks a file as a
// self-contained page that should carry its own landmarks + heading
// hierarchy.

const LANDMARK_TAGS: ReadonlySet<string> = new Set(["header", "nav", "footer", "aside"]);
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const LIST_TAGS: ReadonlySet<string> = new Set(["ul", "ol", "dl"]);
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
]);

interface BodyShape {
  readonly hasExplicitLandmark: boolean;
  readonly hasH1: boolean;
  readonly hasHeading: boolean;
  readonly hasList: boolean;
  readonly hasInteractive: boolean;
  readonly hasBodyScript: boolean;
  readonly descendantCount: number;
  /**
   * Body-scoped descendant count restricted to *visible* elements —
   * excludes `<script>`, `<style>`, `<noscript>`, and `<template>`
   * (HTML5 elements that contribute no rendered output to the page).
   * Used by branch E (`looksLikeFullPage`) to gate the empty-shell
   * detection so a body holding only a `<script>` does not cross the
   * threshold; that script-only shape is a distinct case tracked by
   * V1-EMPTY-ROOT-DIV-SCRIPT-ONLY-WARNING.
   */
  readonly visibleDescendantCount: number;
}

/**
 * True when `el` is a descendant of `body` — implemented via source-range
 * containment because HtmlElement nodes don't carry parent pointers and
 * the document walk surfaces `<head>` children, the `<html>` root, and
 * any post-`</body>` content alongside body descendants. Range comparison
 * is the cheapest filter that distinguishes them in a single O(n) pass.
 */
function isInsideBody(el: HtmlElement, body: HtmlElement): boolean {
  return el !== body && el.range.start >= body.range.start && el.range.end <= body.range.end;
}

interface ContentSignals {
  hasH1: boolean;
  hasHeading: boolean;
  hasList: boolean;
  hasInteractive: boolean;
  hasBodyScript: boolean;
}

function tallySignals(tag: string, signals: ContentSignals): void {
  if (tag === "h1") signals.hasH1 = true;
  if (HEADING_TAGS.has(tag)) signals.hasHeading = true;
  if (LIST_TAGS.has(tag)) signals.hasList = true;
  if (INTERACTIVE_TAGS.has(tag)) signals.hasInteractive = true;
  if (tag === "script") signals.hasBodyScript = true;
}

/**
 * Tags that contribute no rendered output to the page — body-scoped
 * descendants in this set are excluded from `visibleDescendantCount`
 * so branch E (empty-structural-shell) doesn't flag a body whose only
 * children are `<script>` / `<style>` / `<noscript>` / `<template>`.
 * The script-only body shape is a different case tracked by
 * V1-EMPTY-ROOT-DIV-SCRIPT-ONLY-WARNING; keeping it out of branch E
 * ensures the two cases route separately.
 */
const NON_VISIBLE_TAGS: ReadonlySet<string> = new Set(["script", "style", "noscript", "template"]);

function inspectBody(body: HtmlElement, doc: HtmlDocument): BodyShape {
  let hasExplicitLandmark = false;
  let descendantCount = 0;
  let visibleDescendantCount = 0;
  const signals: ContentSignals = {
    hasH1: false,
    hasHeading: false,
    hasList: false,
    hasInteractive: false,
    hasBodyScript: false,
  };
  // Single document walk: landmark check sees the whole tree (so a
  // `<header>` placed outside `<body>` in parser-tolerant input still
  // counts), content-signal tally is restricted to body descendants
  // via `isInsideBody` — `hasBodyScript` in particular MUST be body-
  // scoped (scripts in `<head>` are the common pattern for asset
  // bundlers and would false-positive on minimal rule-testing
  // fixtures).
  for (const el of walkHtmlElements(doc)) {
    const tag = el.tagName.toLowerCase();
    if (LANDMARK_TAGS.has(tag)) hasExplicitLandmark = true;
    if (!isInsideBody(el, body)) continue;
    descendantCount += 1;
    if (!NON_VISIBLE_TAGS.has(tag)) visibleDescendantCount += 1;
    tallySignals(tag, signals);
  }
  return { hasExplicitLandmark, ...signals, descendantCount, visibleDescendantCount };
}

/**
 * True when the parsed HTML body looks like a self-contained, full
 * rendered page — the kind of document that should carry its own
 * `<main>` landmark and own heading hierarchy. See the four-branch
 * walkthrough above for the layered evidence the predicate accepts.
 *
 * Pure function over the parsed document. Returns false for minimal
 * documents that look like component fragments, alt-text fixtures, OG
 * meta shells, or email templates.
 *
 * @param body the document's `<body>` element (the caller is expected
 *   to have already verified one exists)
 * @param doc the parsed document — needed to scan for landmark tags
 *   that may sit outside `<body>` in parser-tolerant input
 */
export function looksLikeFullPage(body: HtmlElement, doc: HtmlDocument): boolean {
  const shape = inspectBody(body, doc);
  // Branch A: explicit landmark structure (existing behavior).
  if (shape.hasExplicitLandmark) return true;
  // Branch B: top-level heading + non-trivial body content.
  if (shape.hasH1 && shape.descendantCount >= 5) return true;
  // Branch C: heading + list + interactive (content-area shape).
  if (shape.hasHeading && shape.hasList && shape.hasInteractive) return true;
  // Branch D: any heading + body-level <script> (widget-page shape).
  // A body-scoped script is the strongest zero-false-positive page-
  // vs-fragment signal we have — zero good-path HTML fixtures in the
  // repo carry a body script — and pairing it with *any* heading
  // catches the h3-only expanding-cards / card-gallery shape that
  // branch B (h1-gated) and branch C (list+interactive-gated) miss.
  if (shape.hasHeading && shape.hasBodyScript) return true;
  // Branch E: empty-structural-shell — body has visible content but
  // zero headings AND zero landmarks. Pages composed entirely of
  // decorative `<div>` / `<img>` (theme-clock, kinetic-loader,
  // random-image-generator, hoverboard) clear none of branches A-D
  // because they have no heading anywhere; the absence of any
  // landmark + any heading is itself a *stronger* 1.3.1 signal than
  // a page with the wrong heading level. The visible-descendant
  // threshold (≥3, where visible excludes script/style/noscript/
  // template) keeps the branch from firing on tiny fragments and
  // explicitly routes the script-only body shape through V1-EMPTY-
  // ROOT-DIV-SCRIPT-ONLY-WARNING instead of through here.
  if (!(shape.hasExplicitLandmark || shape.hasHeading) && shape.visibleDescendantCount >= 3) {
    return true;
  }
  return false;
}
