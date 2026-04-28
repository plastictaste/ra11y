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
 *   did not resolve.
 * - `topUnresolvedHrefs` — sorted, de-duplicated list of distinct href
 *   values across those files (capped at
 *   {@link LINKED_STYLESHEET_TOP_HREFS_CAP} entries) so an agent reading
 *   the warning has concrete identifiers to scope a follow-up against
 *   without descending into the per-file AST.
 * - `count` — total number of `(file, href)` pairs the detector saw,
 *   pre-cap. Distinct from `topUnresolvedHrefs.length` (which is the
 *   capped distinct-href count) because one href can appear across
 *   multiple HTML pages and one HTML file can carry many links.
 *
 * Empty arrays + zero count when no link-stylesheet references were
 * present — callers conditional-spread on `count > 0`.
 */
export interface LinkedStylesheetsUnresolvedForContrast {
  readonly count: number;
  readonly htmlFiles: readonly string[];
  readonly topUnresolvedHrefs: readonly string[];
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
  for (const file of files) {
    if (!isPageHtmlFile(file)) continue;
    const fileHrefs = collectStylesheetHrefs(file.ast.root as HtmlDocument);
    if (fileHrefs.length === 0) continue;
    htmlFiles.add(file.filePath);
    for (const href of fileHrefs) {
      pairCount++;
      allHrefs.add(href);
    }
  }
  const sortedFiles = [...htmlFiles].sort();
  const sortedHrefs = [...allHrefs].sort();
  return {
    count: pairCount,
    htmlFiles: sortedFiles,
    topUnresolvedHrefs: sortedHrefs.slice(0, LINKED_STYLESHEET_TOP_HREFS_CAP),
  };
}

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
