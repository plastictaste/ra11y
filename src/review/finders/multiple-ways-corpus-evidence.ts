/**
 * Cross-file evidence helpers for the multiple-ways finder.
 *
 * Split out so the in-file budget on multiple-ways.ts stays under the
 * 500-effective-line ceiling. Same scope, same caller — these helpers
 * exist solely to compute corpus-level signals consumed by every
 * 2.4.5 candidate's reason text.
 *
 * - `computeCorpusEvidence` aggregates per-file `dirname()` values and
 *   sibling-HTML-page anchor presence into a single `CorpusEvidence`
 *   record.
 * - `formatCorpusEvidence` turns that record into the trailing reason
 *   segment ("single-file scan: …" / "scan covered N distinct
 *   directory roots with no cross-anchors detected") or returns null
 *   when no enrichment applies.
 *
 * The single-file `hasSiblingHtmlPageLink` predicate stays in
 * multiple-ways.ts (where the per-file annotation chain consumes it
 * directly); this module imports nothing from there.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";
import type { ProjectFile } from "../../types/review.ts";

const HTML_PAGE_HREF_RE = /\.html?(?:$|[?#])/i;
const NON_NAVIGABLE_SCHEME_RE = /^(?:mailto:|tel:|sms:|javascript:|data:|blob:|about:)/i;
const EXTERNAL_URL_RE = /^(?:https?:)?\/\//i;

/**
 * Cross-file evidence about the corpus surrounding any per-file
 * candidate. Computed once per project pass and threaded into every
 * candidate's reason so the agent can dismiss standalone-page,
 * one-off-demo, or single-directory-of-unrelated-files cases without
 * reopening the cited file.
 */
export interface CorpusEvidence {
  readonly singleFileScan: boolean;
  readonly distinctDirectoryCount: number;
  readonly hasCrossFileAnchor: boolean;
}

const SINGLE_FILE_SCAN_HINT =
  "single-file scan: cross-page navigation cannot be evaluated from this input alone";

export function computeCorpusEvidence(files: readonly ProjectFile[]): CorpusEvidence {
  const directories = new Set<string>();
  let hasCrossFileAnchor = false;
  for (const file of files) {
    directories.add(dirnameOf(file.filePath));
    if (!hasCrossFileAnchor && fileHasSiblingPageAnchor(file)) hasCrossFileAnchor = true;
  }
  return {
    singleFileScan: files.length <= 1,
    distinctDirectoryCount: directories.size,
    hasCrossFileAnchor,
  };
}

export function formatCorpusEvidence(evidence: CorpusEvidence): string | null {
  if (evidence.singleFileScan) return SINGLE_FILE_SCAN_HINT;
  if (evidence.hasCrossFileAnchor) return null;
  // Multi-file scan with no cross-anchor evidence anywhere — the
  // strongest corpus-level "this scan likely isn't a multi-page set"
  // signal. The agent reading the reason gets the directory count so
  // they can decide whether to dismiss (single dir of unrelated
  // demos), investigate (multi-dir without inter-page links), or
  // suppress at source (genuinely standalone file).
  const dirCount = evidence.distinctDirectoryCount;
  const dirNoun = dirCount === 1 ? "directory root" : "directory roots";
  return `scan covered ${dirCount} distinct ${dirNoun} with no cross-anchors detected`;
}

/**
 * Returns the directory portion of a file path — everything up to the
 * last `/` or `\`. Path-separator-agnostic so it works on both POSIX
 * and Windows-shaped paths the scanner may surface unchanged through
 * `ctx.files[].filePath`.
 */
function dirnameOf(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSep < 0) return "";
  return filePath.slice(0, lastSep);
}

function fileHasSiblingPageAnchor(file: ProjectFile): boolean {
  const ast = file.ast;
  if (ast.language === "html") {
    return hasSiblingHtmlPageAnchor(ast.root);
  }
  if (
    ast.language === "tsx" ||
    ast.language === "jsx" ||
    ast.language === "ts" ||
    ast.language === "js"
  ) {
    return hasSiblingJsxPageAnchor(ast.root);
  }
  return false;
}

function hasSiblingHtmlPageAnchor(root: HtmlDocument): boolean {
  for (const el of walkHtmlElements(root)) {
    if (el.tagName.toLowerCase() !== "a") continue;
    const href = getHtmlAttribute(el, "href");
    if (isSiblingHtmlPageHref(href)) return true;
  }
  return false;
}

function hasSiblingJsxPageAnchor(root: TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    if (el.tagName !== "a" && el.tagName !== "Link" && el.tagName !== "NavLink") continue;
    const href = getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to");
    if (isSiblingHtmlPageHref(href)) return true;
  }
  return false;
}

function isSiblingHtmlPageHref(href: string | null): boolean {
  if (href === null) return false;
  const trimmed = href.trim();
  if (trimmed === "") return false;
  if (trimmed.startsWith("#")) return false;
  if (NON_NAVIGABLE_SCHEME_RE.test(trimmed)) return false;
  // External URLs (http(s)://, //cdn...) point to some other domain's
  // page set — a single-page file might link out to external docs
  // without becoming "multi-page."
  if (EXTERNAL_URL_RE.test(trimmed)) return false;
  return HTML_PAGE_HREF_RE.test(trimmed);
}
