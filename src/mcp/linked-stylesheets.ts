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
 * sheet inline (full resolution is out of scope here) — it partitions
 * unresolved hrefs into per-predicate slices so the agent can scope a
 * follow-up via `additionalPaths`, `propose_config`, or a separate
 * `scan` against the linked CSS. Drives THREE warning codes (one per
 * partition predicate, per AI-first doctrine "Skipped-extension
 * warnings are split by predicate so the actionable text-source subset
 * doesn't get buried"):
 *
 *   - `linked_stylesheet_local_unresolved` — relative-path hrefs the
 *     resolver could not match in the parsed-file set. Actionable.
 *   - `linked_stylesheet_external_cdn_skipped` — `http:` / `https:` /
 *     `//` / `data:` hrefs the offline scanner cannot consult.
 *   - `template_expression_in_href` — `{ident}` / `{{ident}}` /
 *     `<%= ident %>` directives the parser saw as text.
 *
 * Each slice carries its own `warningsDetails.<code>` payload so the
 * agent reads one definite payload per fired code (per AI-first
 * doctrine "Empty `warningsDetails.<code>: {}` is dishonest").
 *
 * Extracted from `scan-assembly.ts` so the broader assembler stays
 * under the file-budget limit and the predicate's evidence model lives
 * next to its only consumer (the warnings dispatch).
 */

import { posix } from "node:path";
import { getHtmlAttribute, isHtmlFragment, walkHtmlElements } from "../engine/ast-helpers.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { HtmlDocument } from "../types/ast.ts";

/**
 * Result shape from {@link detectLinkedStylesheetsNotResolvedForContrast}.
 *
 * Hrefs are partitioned into THREE non-overlapping slices so the warning
 * channel can ship one code per actionable predicate (per AI-first
 * doctrine "Skipped-extension warnings are split by predicate so the
 * actionable text-source subset doesn't get buried"):
 *
 *   - **local-unresolved** — relative-path hrefs that the resolver could
 *     not match to a same-directory sibling in the parsed-file set. The
 *     actionable subset: the agent can scope a follow-up via
 *     `additionalPaths` to bring the linked CSS into the scan, OR audit
 *     the page's color tokens directly. Drives the
 *     `linked_stylesheet_local_unresolved` warning code + payload.
 *   - **external-CDN** — hrefs whose scheme is `http:`, `https:`, `//`
 *     (protocol-relative), or `data:`. Definitionally not resolvable
 *     from a static scan (the scanner is offline-only by architectural
 *     invariant). The agent reads the cited CDN URL and decides whether
 *     to audit the remote sheet out-of-band. Drives the
 *     `linked_stylesheet_external_cdn_skipped` warning code + payload.
 *   - **template-expression** — hrefs whose value carries a templating
 *     directive shape (`{extraCss}`, `{{styles}}`, `<%= css %>`,
 *     `${theme}`, `{% raw %}`) the parser saw as text rather than a
 *     resolved URL. Drives the `template_expression_in_href` warning
 *     code + payload.
 *
 * Each slice carries (count, files, top-hrefs) following the same naming
 * discipline (per AI-first doctrine "Sibling fields naming the same
 * concept must use one shape"): the file-count is derivable from
 * `<slice>Files.length`, the distinct-href count from
 * `top<Slice>Hrefs.length`, and the pre-cap pair count is
 * `<slice>HrefCount` — distinct because one href can repeat across
 * pages and one page can carry multiple links.
 *
 * Empty arrays + zero `<slice>HrefCount` when no link-stylesheet
 * references of the given kind were present — callers conditional-
 * spread on a meaningful slice being positive.
 */
export interface LinkedStylesheetsUnresolvedForContrast {
  readonly localUnresolvedHrefCount: number;
  readonly localUnresolvedFiles: readonly string[];
  readonly topLocalUnresolvedHrefs: readonly string[];
  readonly externalCdnHrefCount: number;
  readonly externalCdnFiles: readonly string[];
  readonly topExternalCdnHrefs: readonly string[];
  readonly templateExpressionHrefCount: number;
  readonly templateExpressionFiles: readonly string[];
  readonly templateExpressionHrefs: readonly string[];
}

/**
 * Hard cap on the per-slice top-href lists
 * (`topLocalUnresolvedHrefs`, `topExternalCdnHrefs`,
 * `templateExpressionHrefs`) surfaced under each slice's paired
 * `warningsDetails.<code>` payload. Ten mirrors the
 * `SOURCEMAP_TOP_PATHS_CAP` pattern: enough for the agent to recognize
 * whether links cluster by a single bundle path vs. heterogeneous CDN
 * URLs, but tight enough to stay sub-1KB on a realistic corpus. The
 * full per-file evidence remains accessible via the agent's own Read on
 * the cited HTML files.
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
 * **Three-way href partition.** Hrefs are sorted into one of three
 * non-overlapping buckets so the warning channel can ship one code per
 * actionable predicate (per AI-first doctrine "Skipped-extension
 * warnings are split by predicate so the actionable text-source subset
 * doesn't get buried"):
 *
 *   1. **template-expression** ({@link isTemplateExpressionHref}) — href
 *      value carries a `{ident}` / `{{ident}}` / `<%= ident %>` /
 *      `${ident}` / `{% raw %}` shape; the parser saw it as text, not a
 *      URL. Drives the `template_expression_in_href` warning.
 *   2. **external-CDN** ({@link isExternalSchemeHref}) — href starts with
 *      `http://`, `https://`, `//`, or `data:`. Definitionally not
 *      resolvable by an offline scanner. Drives the
 *      `linked_stylesheet_external_cdn_skipped` warning.
 *   3. **local-unresolved** — relative-path href that fell through both
 *      checks above. The actionable subset: bring the linked CSS into
 *      the scan via `additionalPaths`, OR audit color tokens directly.
 *      Drives the `linked_stylesheet_local_unresolved` warning.
 *
 * The partition is checked in declaration order — template first (so a
 * `{{theme}}.css` doesn't accidentally land under external-CDN), then
 * external (so `https://cdnjs...` doesn't fall to local-unresolved),
 * then the same-directory sibling check (resolved → silent), then the
 * local-unresolved bucket as the residual.
 *
 * **Same-directory sibling resolution.** Before counting a relative-path
 * href as local-unresolved, the detector checks whether the href
 * resolves to a stylesheet sitting in the SAME directory as the linking
 * HTML file AND already in the parsed-file set (`<htmlDir>/<href>`
 * joined as POSIX). When the candidate matches an in-scope CSS-shaped
 * sibling (`.css`, `.scss`, `.less`), the href is treated as resolved
 * — the warning does NOT fire on `(html, css)` pairs the contrast rule
 * will actually read together. The resolution scope is intentionally
 * narrow — only same-directory siblings are matched. Cross-directory
 * hrefs (`css/style.css`, `../shared/theme.css`, absolute
 * `/assets/...`) stay under the local-unresolved bucket because
 * resolving them requires walking conventions (build root, document
 * root, alias maps) the scanner doesn't track.
 *
 * Pure over its inputs. Output is deterministic across runs: each slice's
 * file list is sorted ascending and the top-href list is the
 * de-duplicated, sorted-ascending slice capped at
 * {@link LINKED_STYLESHEET_TOP_HREFS_CAP}.
 */
export function detectLinkedStylesheetsNotResolvedForContrast(
  files: readonly ParsedFile[],
): LinkedStylesheetsUnresolvedForContrast {
  const inScopeStylesheetPaths = collectInScopeStylesheetPaths(files);
  const acc: PartitionAccumulator = {
    local: { files: new Set<string>(), hrefs: new Set<string>(), pairCount: 0 },
    external: { files: new Set<string>(), hrefs: new Set<string>(), pairCount: 0 },
    template: { files: new Set<string>(), hrefs: new Set<string>(), pairCount: 0 },
  };
  for (const file of files) {
    if (!isPageHtmlFile(file)) continue;
    const fileHrefs = collectStylesheetHrefs(file.ast.root as HtmlDocument);
    if (fileHrefs.length === 0) continue;
    for (const href of fileHrefs) {
      partitionHrefIntoSlice(file.filePath, href, inScopeStylesheetPaths, acc);
    }
  }
  return {
    localUnresolvedHrefCount: acc.local.pairCount,
    localUnresolvedFiles: [...acc.local.files].sort(),
    topLocalUnresolvedHrefs: [...acc.local.hrefs].sort().slice(0, LINKED_STYLESHEET_TOP_HREFS_CAP),
    externalCdnHrefCount: acc.external.pairCount,
    externalCdnFiles: [...acc.external.files].sort(),
    topExternalCdnHrefs: [...acc.external.hrefs].sort().slice(0, LINKED_STYLESHEET_TOP_HREFS_CAP),
    templateExpressionHrefCount: acc.template.pairCount,
    templateExpressionFiles: [...acc.template.files].sort(),
    templateExpressionHrefs: [...acc.template.hrefs]
      .sort()
      .slice(0, LINKED_STYLESHEET_TOP_HREFS_CAP),
  };
}

/**
 * Per-slice accumulator the partition walk threads through. One field
 * per output bucket; each field tracks the de-duplicated file set, the
 * de-duplicated href set, and the running pair count (`(file, href)`
 * pairs the slice received). Held mutably for the duration of the
 * detector's walk, then frozen-by-spread into the result shape.
 */
interface PartitionAccumulator {
  readonly local: PartitionSlice;
  readonly external: PartitionSlice;
  readonly template: PartitionSlice;
}

interface PartitionSlice {
  readonly files: Set<string>;
  readonly hrefs: Set<string>;
  pairCount: number;
}

/**
 * Per-href dispatch: routes an `(htmlFilePath, href)` pair into one of
 * the three partition slices based on the href's string shape and the
 * resolver's same-directory-sibling check. Extracted from
 * {@link detectLinkedStylesheetsNotResolvedForContrast} to keep the
 * orchestrator under the cognitive-complexity cap as the partition set
 * grew from two slices (template + unresolved) to three (template +
 * external + local).
 *
 * Routing order — template first (so a `{{theme}}.css` doesn't
 * accidentally land under external-CDN), then external (so
 * `https://cdnjs...` doesn't fall to local-unresolved), then the
 * same-directory sibling check (resolved → silent), then local-
 * unresolved as the residual.
 */
function partitionHrefIntoSlice(
  htmlFilePath: string,
  href: string,
  inScopeStylesheetPaths: ReadonlySet<string>,
  acc: PartitionAccumulator,
): void {
  if (isTemplateExpressionHref(href)) {
    acc.template.files.add(htmlFilePath);
    acc.template.hrefs.add(href);
    acc.template.pairCount++;
    return;
  }
  if (isExternalSchemeHref(href)) {
    acc.external.files.add(htmlFilePath);
    acc.external.hrefs.add(href);
    acc.external.pairCount++;
    return;
  }
  if (resolvesToSameDirectorySibling(htmlFilePath, href, inScopeStylesheetPaths)) {
    return;
  }
  acc.local.files.add(htmlFilePath);
  acc.local.hrefs.add(href);
  acc.local.pairCount++;
}

/**
 * Builds the lookup set of CSS-shaped file paths in the parsed-file
 * input. Restricted to the extensions the contrast rule actually
 * consults during resolution (`.css`, `.scss`, `.less`) so an in-scope
 * non-stylesheet sibling (e.g. a `style.html` with the same basename)
 * does not falsely satisfy the resolution check. Pure over its input;
 * output is a Set so the per-href lookup stays O(1).
 */
function collectInScopeStylesheetPaths(files: readonly ParsedFile[]): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const file of files) {
    if (isStylesheetExtension(file.filePath)) paths.add(file.filePath);
  }
  return paths;
}

/**
 * `(htmlFilePath, href, inScopeStylesheetPaths) -> boolean` predicate:
 * returns `true` when the href is a same-directory stylesheet sibling
 * already in the scan set.
 *
 * Resolution is intentionally narrow — only the literal
 * `<htmlDir>/<href>` join is attempted (with a leading `./` stripped if
 * present). Hrefs containing `/` after the optional `./` prefix are
 * cross-directory references and stay unresolved by design — resolving
 * them would require knowing the build root / document root, conventions
 * the scanner does not track. Per the backlog item closing this:
 * "Don't widen the resolver beyond same-directory siblings — anything
 * cross-directory is a separate scope."
 *
 * Hrefs carrying a query/fragment suffix (`?v=hash`, `#anchor`) are
 * rejected from the same-directory-resolution path — the suffix is a
 * cache-busting / fragment marker the scanner cannot strip without
 * inferring intent (the literal href `style.css?v=2` may or may not
 * map to a sibling `style.css?v=2` file). Better to let the warning
 * fire on those and surface the literal value to the agent than to
 * silently resolve the wrong shape.
 */
function resolvesToSameDirectorySibling(
  htmlFilePath: string,
  href: string,
  inScopeStylesheetPaths: ReadonlySet<string>,
): boolean {
  if (href.includes("?") || href.includes("#")) return false;
  const stripped = href.startsWith("./") ? href.slice(2) : href;
  if (stripped.length === 0) return false;
  if (stripped.includes("/")) return false;
  if (!isStylesheetExtension(stripped)) return false;
  const candidate = posix.join(posix.dirname(htmlFilePath), stripped);
  return inScopeStylesheetPaths.has(candidate);
}

/**
 * Predicate: returns `true` when the path's lowercase suffix is one of
 * the stylesheet extensions the contrast rule consults during
 * resolution. Centralized so the in-scope index and the same-directory
 * resolver agree on the extension set.
 */
function isStylesheetExtension(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less");
}

/**
 * Predicate: returns `true` when an href STRING value carries an
 * external scheme the static scanner cannot resolve. Recognized:
 *
 *   - `http://…` and `https://…` — absolute remote URLs (the canonical
 *     CDN shape, e.g. `https://cdnjs.cloudflare.com/.../font-awesome.min.css`).
 *   - `//cdn.example.com/…` — protocol-relative URLs that resolve to the
 *     same scheme as the loading page; not fetchable by an offline
 *     scanner.
 *   - `data:text/css;base64,…` — inline data URIs; the bytes are present
 *     in the href but the scanner does not decode them as a parsed
 *     stylesheet for contrast resolution. Surfacing them under the
 *     external bucket is honest because the resolution path is the same:
 *     the contrast rule does not consult them.
 *
 * Per the network-isolation invariant (`src/` never references `fetch`),
 * external-scheme hrefs are *definitionally* unresolvable by the static
 * scanner — partitioning them out of the local-unresolved bucket lets
 * the agent triage the actionable subset (relative paths the scanner
 * could have read with a wider scope) separately from the
 * out-of-scope subset (CDN URLs the scanner cannot read regardless of
 * scope). Per AI-first doctrine "Skipped-extension warnings are split
 * by predicate so the actionable text-source subset doesn't get buried."
 *
 * Detection is string-shape only and case-insensitive on the scheme
 * token. Identifier content past the scheme is not validated — the
 * partition's only contract is "this is not a relative path the
 * resolver could ever match."
 */
function isExternalSchemeHref(href: string): boolean {
  if (href.startsWith("//")) return true;
  const lower = href.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("data:");
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
 * dishonest" — `topLocalUnresolvedHrefs` reads as "real stylesheet
 * failed to load," and a template token is provably-different evidence
 * (a directive token co-occurrence on the href value) so the partition
 * is deterministic, not heuristic. Out-of-scope shapes that look like
 * literal hrefs (`/path/with-dashes.css`, `?v=hash` query strings)
 * stay under the local-unresolved bucket where they belong.
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
