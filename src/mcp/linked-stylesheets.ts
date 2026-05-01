/**
 * `<link rel="stylesheet" href="…">` cross-reference detector.
 *
 * Scanning HTML files that link an external stylesheet does not pull
 * the linked sheet into contrast-rule resolution — the rule operates
 * on parsed CSS / SCSS files in isolation and never follows link
 * references from HTML into linked sheets. Without a top-level signal,
 * a multi-page site whose pages reference one bundled stylesheet
 * (canonical case: 14 `.html` files linking `bootstrap.min.css`) reads
 * as a clean scan despite the entire color substrate sitting outside
 * the rule's evidence horizon — the canonical "Routing skips that
 * drop content are the symmetric twin of suppression" failure mode in
 * `docs/kb/architecture/ai-first-consumer.md`, one layer deeper than
 * the parse-time skip warnings (`text_source_skipped`,
 * `js_innerhtml_template_literal_unparsed`).
 *
 * Per the "deferring full resolution is acceptable, silent omission is
 * not" framing, this detector does not attempt to resolve the linked
 * sheet inline (full resolution is out of scope here) — it just names
 * the unresolved hrefs so the agent can scope a follow-up via
 * `additionalPaths`, `propose_config`, or a separate `scan` against
 * the linked CSS. Drives the
 * `linked_stylesheet_not_resolved_for_contrast` warning code + its
 * paired `warningsDetails.linked_stylesheet_not_resolved_for_contrast`
 * payload.
 *
 * Extracted from `scan-assembly.ts` so the broader assembler stays
 * under the file-budget limit and the predicate's evidence model lives
 * next to its only consumer (the warnings dispatch).
 */

import { getHtmlAttribute, isHtmlFragment, walkHtmlElements } from "../engine/ast-helpers.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { HtmlDocument } from "../types/ast.ts";

/**
 * Result shape from {@link detectLinkedStylesheetsNotResolvedForContrast}.
 *
 * - `htmlFiles` — sorted list of HTML files that declared at least one
 *   `<link rel="stylesheet" href="…">` whose target the contrast rule
 *   did not resolve. Per AI-first doctrine "Sibling fields naming the
 *   same concept must use one shape," the file-count is derivable from
 *   `htmlFiles.length` rather than shipped as a parallel scalar twin.
 *   Houses ONLY pages with literal-href references (e.g.
 *   `bootstrap.min.css`); pages whose only `<link>` references resolved
 *   to template expressions (`{extraCss}`, `{{styles}}`, `<%= css %>`)
 *   are accounted for under {@link templateExpressionFiles} instead so
 *   the contrast-resolution warning's predicate stays "actually failed
 *   to load" (per AI-first doctrine "Heuristic-mislabeled meta sub-
 *   fields are dishonest").
 * - `topUnresolvedHrefs` — sorted, de-duplicated list of distinct href
 *   values across those files (capped at
 *   {@link LINKED_STYLESHEET_TOP_HREFS_CAP} entries) so an agent reading
 *   the warning has concrete identifiers to scope a follow-up against
 *   without descending into the per-file AST. The capped distinct-href
 *   count is `topUnresolvedHrefs.length` (post-cap) — distinct from
 *   `unresolvedHrefCount` below. Excludes template-expression hrefs
 *   (see {@link templateExpressionHrefs}) — those are not actually-
 *   fetched-but-failed values, they're directives the parser saw as
 *   text, and surfacing them under "unresolved href" reads as "a real
 *   stylesheet failed to load."
 * - `unresolvedHrefCount` — total number of `(htmlFile, href)` pairs
 *   with literal href values the detector saw, pre-cap. Names the slice
 *   precisely so the three sibling counts in the payload
 *   (`unresolvedHrefCount`, `htmlFiles.length`,
 *   `topUnresolvedHrefs.length`) cannot collide on the generic name
 *   `count`. One href can repeat across multiple pages and one page can
 *   carry multiple links, so this number is generally different from
 *   both the file count and the capped distinct-href count.
 * - `templateExpressionFiles` — sorted list of HTML files whose `<link
 *   rel="stylesheet" href="…">` carried a template-token shape (single-
 *   brace `{ident}`, mustache/Handlebars `{{ident}}`, ERB/EJS
 *   `<%= ident %>`, template-literal `${ident}`, Jinja `{% raw %}`,
 *   etc.). Drives the separate `template_expression_in_href` warning
 *   code; reserved out of `htmlFiles` so the contrast-resolution
 *   warning stays honest.
 * - `templateExpressionHrefs` — sorted, de-duplicated list of the
 *   template-expression href values across those files (capped at
 *   {@link LINKED_STYLESHEET_TOP_HREFS_CAP}). Same shape as
 *   `topUnresolvedHrefs` but for the template-expression slice — the
 *   agent reads the literal token (`{extraCss}`, `{{theme}}`) to recognize
 *   the templating system in use rather than mistaking it for a missing
 *   bundle path.
 * - `templateExpressionHrefCount` — total number of `(htmlFile, href)`
 *   pairs with template-expression values, pre-cap. Same naming
 *   discipline as `unresolvedHrefCount`.
 *
 * Empty arrays + zero `unresolvedHrefCount` / `templateExpressionHrefCount`
 * when no link-stylesheet references of the given kind were present —
 * callers conditional-spread on the kind-specific count being positive.
 */
export interface LinkedStylesheetsUnresolvedForContrast {
  readonly unresolvedHrefCount: number;
  readonly htmlFiles: readonly string[];
  readonly topUnresolvedHrefs: readonly string[];
  readonly templateExpressionHrefCount: number;
  readonly templateExpressionFiles: readonly string[];
  readonly templateExpressionHrefs: readonly string[];
}

/**
 * Hard cap on `topUnresolvedHrefs` entries surfaced under
 * `warningsDetails.linked_stylesheet_not_resolved_for_contrast`. Ten
 * mirrors the `SOURCEMAP_TOP_PATHS_CAP` pattern: enough for the agent
 * to recognize whether links cluster by single bundle path vs.
 * heterogeneous CDN URLs, but tight enough to stay sub-1KB on a
 * realistic corpus. The full per-file evidence remains accessible via
 * the agent's own Read on the cited HTML files.
 */
const LINKED_STYLESHEET_TOP_HREFS_CAP = 10;

/**
 * Walks every parsed HTML document in `files` for
 * `<link rel="stylesheet" href="…">` references — the canonical
 * mechanism by which an HTML page pulls in an external stylesheet that
 * the contrast rule does not currently consult during resolution. The
 * detector is conservative: it skips fragments (no `<html>`/`<body>`
 * envelope — fragments don't establish a page-level link context), and
 * it only counts `<link>` elements whose `rel` attribute (case-
 * insensitive, whitespace-tolerant) names `stylesheet` and whose `href`
 * attribute is a non-empty string. `rel="alternate stylesheet"` and
 * preload-shaped variants (`<link rel="preload" as="style">`) are
 * intentionally excluded — they don't activate the same parse-and-
 * resolve path the warning is about.
 *
 * Pure over its inputs. Output is deterministic across runs:
 * `htmlFiles` is sorted ascending and `topUnresolvedHrefs` is the
 * de-duplicated, sorted-ascending href slice capped at
 * {@link LINKED_STYLESHEET_TOP_HREFS_CAP}.
 */
export function detectLinkedStylesheetsNotResolvedForContrast(
  files: readonly ParsedFile[],
): LinkedStylesheetsUnresolvedForContrast {
  const htmlFiles = new Set<string>();
  const allHrefs = new Set<string>();
  let pairCount = 0;
  const templateFiles = new Set<string>();
  const templateHrefs = new Set<string>();
  let templatePairCount = 0;
  for (const file of files) {
    if (!isPageHtmlFile(file)) continue;
    const fileHrefs = collectStylesheetHrefs(file.ast.root as HtmlDocument);
    if (fileHrefs.length === 0) continue;
    for (const href of fileHrefs) {
      if (isTemplateExpressionHref(href)) {
        templateFiles.add(file.filePath);
        templateHrefs.add(href);
        templatePairCount++;
        continue;
      }
      htmlFiles.add(file.filePath);
      pairCount++;
      allHrefs.add(href);
    }
  }
  const sortedFiles = [...htmlFiles].sort();
  const sortedHrefs = [...allHrefs].sort();
  const sortedTemplateFiles = [...templateFiles].sort();
  const sortedTemplateHrefs = [...templateHrefs].sort();
  return {
    unresolvedHrefCount: pairCount,
    htmlFiles: sortedFiles,
    topUnresolvedHrefs: sortedHrefs.slice(0, LINKED_STYLESHEET_TOP_HREFS_CAP),
    templateExpressionHrefCount: templatePairCount,
    templateExpressionFiles: sortedTemplateFiles,
    templateExpressionHrefs: sortedTemplateHrefs.slice(0, LINKED_STYLESHEET_TOP_HREFS_CAP),
  };
}

/**
 * Predicate: returns `true` when an href STRING value carries a
 * templating-directive shape the parser saw as text rather than a
 * resolved URL. Detection is intentionally string-shape only — the
 * scanner does not attempt to identify the templating system or
 * resolve the variable, just to recognize that the value is a directive
 * and therefore not "actually fetched but failed."
 *
 * Recognized shapes (case-sensitive on the bracket tokens; identifier
 * content is permissive — see {@link TEMPLATE_EXPRESSION_PATTERNS}):
 *
 *   - single-brace `{ident}` — handlebars-lite, .NET String.Format,
 *     custom interpolation.
 *   - mustache / Handlebars / Vue `{{ident}}`, `{{{ident}}}`.
 *   - ERB / EJS `<%= ident %>`, `<% ident %>`, `<%- ident %>`.
 *   - JS template-literal interpolation already in source: `${ident}`.
 *   - Jinja / Liquid block tags: `{% raw %}`, `{%- if … %}`,
 *     `{%- endraw -%}`.
 *
 * Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are
 * dishonest" — `topUnresolvedHrefs` reads as "real stylesheet failed to
 * load," and a template token is provably-different evidence (a
 * directive token co-occurrence on the href value) so the partition is
 * deterministic, not heuristic. Out-of-scope shapes that look like
 * literal hrefs (`/path/with-dashes.css`, `?v=hash` query strings)
 * stay under the unresolved-href bucket where they belong.
 */
function isTemplateExpressionHref(href: string): boolean {
  for (const pattern of TEMPLATE_EXPRESSION_PATTERNS) {
    if (pattern.test(href)) return true;
  }
  return false;
}

/**
 * Template-token shapes recognized by {@link isTemplateExpressionHref}.
 * Each pattern requires at least one non-bracket character inside the
 * delimiters so the empty literal `{}` does not match (a bare `{}` is
 * almost always a CSS class-glob escape or a stray brace, not a
 * directive). Patterns are ordered by approximate frequency on real
 * corpora — mustache/Handlebars first, then JS template literals, then
 * the ERB/EJS family, then single-brace, then Jinja/Liquid blocks.
 */
const TEMPLATE_EXPRESSION_PATTERNS: readonly RegExp[] = [
  /\{\{[^}]+\}\}/, // {{ident}} / {{{ident}}}
  /\$\{[^}]+\}/, // ${ident}
  /<%[=-]?[^%]+%>/, // <%= ident %> / <% ident %> / <%- ident %>
  /\{%[^%]+%\}/, // {% raw %} / {% endraw %} / {%- if … %}
  /\{[A-Za-z_][^}]*\}/, // {ident} — single-brace; require leading identifier char to avoid matching `{}` and CSS escapes
];

/**
 * Page-shaped HTML predicate: parsed-HTML language tag plus a non-
 * fragment root. Fragments don't establish a page-level link-resolution
 * context; a `<link>` inside a partial is consumed by whichever
 * document composes it, not by the partial alone. Skipping fragments
 * keeps the warning's evidence honest — the page that triggers the
 * unresolved-resolution shape is the one whose `<head>` actually ships
 * the `<link>` to the user agent.
 */
function isPageHtmlFile(file: ParsedFile): boolean {
  if (file.ast.language !== "html") return false;
  return !isHtmlFragment(file.ast.root as HtmlDocument);
}

/**
 * Walks an HTML document and returns every non-empty `href` value from
 * `<link rel="stylesheet" href="…">` elements. Extracted from the
 * orchestrator to keep the per-file branch logic flat — the orchestrator
 * just unions the per-file results without re-stating the predicate.
 */
function collectStylesheetHrefs(doc: HtmlDocument): readonly string[] {
  const hrefs: string[] = [];
  for (const el of walkHtmlElements(doc)) {
    const href = stylesheetHrefFromElement(el);
    if (href !== undefined) hrefs.push(href);
  }
  return hrefs;
}

/**
 * Per-element predicate: returns the trimmed non-empty `href` when the
 * element is a `<link rel="stylesheet" href="…">` and `undefined`
 * otherwise. Centralizes the four-attribute gate (tag + rel + non-null
 * href + non-empty trimmed href) so the orchestrator stays under the
 * cognitive-complexity cap.
 */
function stylesheetHrefFromElement(el: import("../types/ast.ts").HtmlElement): string | undefined {
  if (el.tagName.toLowerCase() !== "link") return undefined;
  const rel = getHtmlAttribute(el, "rel");
  if (rel === null || !isStylesheetRel(rel)) return undefined;
  const href = getHtmlAttribute(el, "href");
  if (href === null) return undefined;
  const trimmed = href.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

/**
 * `rel="…"` predicate: returns `true` when the attribute carries the
 * `stylesheet` token by itself (the common case, e.g.
 * `rel="stylesheet"`). Multi-token values like `rel="alternate stylesheet"`
 * and shapes like `rel="preload"` (with `as="style"`) are intentionally
 * excluded — they do not activate the canonical parse-and-resolve path
 * the contrast rule would consult, and treating them identically would
 * over-surface the warning on every preload-shaped reference.
 */
function isStylesheetRel(rel: string): boolean {
  return rel.trim().toLowerCase() === "stylesheet";
}
