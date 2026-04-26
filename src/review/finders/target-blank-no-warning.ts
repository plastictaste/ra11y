/**
 * Candidate finder: review/target-blank-no-warning
 * Criteria: wcag22:3.2.5, wcag21:3.2.5
 * Spec: https://www.w3.org/TR/WCAG22/#change-on-request
 *
 * > Changes of context are initiated only by user request or a
 * > mechanism is available to turn off such changes.
 *
 * Surfaces `<a target="_blank">` anchors (HTML and JSX `<a>` / `<Link>` /
 * `<NavLink>` / `<Anchor>`) whose link text and aria attributes do not
 * contain an unambiguous "opens in new window/tab" announcement. The
 * sibling rule `navigation/link-target-blank-announcement` fires
 * deterministically when no announcement phrase appears at all (the
 * accepted phrases include the bare word "external"); this finder
 * surfaces the broader review surface where the announcement evidence
 * is *ambiguous* — the text contains "external" but no explicit
 * "opens in"/"new window"/"new tab" phrase. The bare word "external"
 * may be a topical descriptor ("External Hard Drives Buying Guide")
 * rather than a context-change warning, and only the agent reading the
 * surrounding prose can decide.
 *
 * The finder does NOT gate emission on `rel="noopener"`. Per the test
 * matrix, `<a target="_blank" rel="noopener">External</a>` fires the
 * same as the bare variant — `rel` is a security primitive, not a
 * change-of-context signal. When `rel="noopener"` is absent, the
 * candidate `reason` notes the additional concern (a missing
 * `rel="noopener"` doesn't satisfy 3.2.5 either, but it's a worth-
 * mentioning corollary the agent can act on).
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, JsxNode, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:3.2.5", "wcag21:3.2.5"] as const;

/**
 * Phrases that unambiguously announce a new-window/tab context change.
 * Stricter than the rule's accepted-phrase list: the bare word
 * "external" is intentionally NOT in this set — "external" can be a
 * topical descriptor (e.g. "External Hard Drives") rather than a
 * context-change warning. Matched case-insensitively as substrings.
 */
const UNAMBIGUOUS_PHRASES: readonly string[] = ["new window", "new tab", "opens in"];

/** JSX tags that represent a link. Mirrors the sibling rule. */
const JSX_LINK_TAGS: ReadonlySet<string> = new Set(["a", "Link", "NavLink", "Anchor"]);

export const finder = defineCandidateFinder({
  id: "review/target-blank-no-warning",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      'Surfaces <a target="_blank"> anchors whose link text and aria attributes lack an unambiguous "opens in new window/tab" announcement. Complements the rule `navigation/link-target-blank-announcement` by catching the cases where the announcement evidence is ambiguous (e.g. visible text is just "External" — could be the topic, not a warning).',
    reviewPrompt:
      'Verify that activating this `target="_blank"` link tells the user, in the link body or visually-adjacent prose, that it will open in a new window or tab. A bare topical word like "External" is ambiguous — it might be the link\'s subject rather than a context-change warning. If the announcement is missing or unclear, add a visually-hidden span like `<span class="sr-only">(opens in new window)</span>` inside the link, or set `aria-label="… (opens in new window)"`. Also verify `rel="noopener"` is set as a security defence.',
    references: [
      "https://www.w3.org/TR/WCAG22/#change-on-request",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G201",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H83",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, ctx.wrappersForElement, candidates);
    }
    return candidates;
  },
});

function findHtmlCandidates(
  doc: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const a of findHtmlElementsByTag(doc, "a")) {
    if (getHtmlAttribute(a, "target") !== "_blank") continue;
    if (hasUnambiguousAnnouncementHtml(a)) continue;
    emitHtml(filePath, a, candidates);
  }
}

function findJsxCandidates(
  module: TsxModule,
  filePath: string,
  wrappersForA: ReadonlySet<string>,
  candidates: ReviewCandidate[],
): void {
  const seen = new Set<JsxElement>();
  const wrappers = new Set<string>([...JSX_LINK_TAGS, ...wrappersForA]);
  wrappers.delete("a");
  for (const el of findJsxElementsForTag(module, "a", wrappers)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (getJsxAttributeString(el, "target") !== "_blank") continue;
    if (hasUnambiguousAnnouncementJsx(el)) continue;
    emitJsx(filePath, el, candidates);
  }
}

function emitHtml(filePath: string, a: HtmlElement, candidates: ReviewCandidate[]): void {
  const visibleText = htmlTextContent(a).trim();
  const relValue = getHtmlAttribute(a, "rel");
  const reason = buildReason(`<a target="_blank">`, visibleText, relValue);
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line: a.loc.start.line, column: a.loc.start.column },
      reason,
      // Confidence "medium": deterministic match on
      // `target="_blank"` + missing-unambiguous-phrase, but whether
      // the text is a sufficient warning depends on surrounding prose
      // the scanner can't see. Always worth reading; the dismissal is
      // typically one Read away.
      confidence: "medium",
    });
  }
}

function emitJsx(filePath: string, el: JsxElement, candidates: ReviewCandidate[]): void {
  const visibleText = jsxTextContent(el).trim();
  const relValue = getJsxAttributeString(el, "rel");
  const reason = buildReason(`<${el.tagName} target="_blank">`, visibleText, relValue);
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
      reason,
      confidence: "medium",
    });
  }
}

/**
 * Checks all three accessible-name channels for an unambiguous
 * announcement phrase: the link's own `aria-label`, its rendered
 * descendant text, or any descendant element's `aria-label`. Mirrors
 * the rule's three-channel check but uses the stricter phrase list.
 */
function hasUnambiguousAnnouncementHtml(a: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(a, "aria-label");
  if (ariaLabel !== null && containsPhrase(ariaLabel)) return true;
  if (containsPhrase(htmlTextContent(a))) return true;
  for (const descendant of walkHtmlElements(a)) {
    const descLabel = getHtmlAttribute(descendant, "aria-label");
    if (descLabel !== null && containsPhrase(descLabel)) return true;
  }
  return false;
}

function hasUnambiguousAnnouncementJsx(el: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel !== null && containsPhrase(ariaLabel)) return true;
  if (containsPhrase(jsxTextContent(el))) return true;
  for (const descendant of jsxDescendantElements(el)) {
    const descLabel = getJsxAttributeString(descendant, "aria-label");
    if (descLabel !== null && containsPhrase(descLabel)) return true;
  }
  return false;
}

function* jsxDescendantElements(el: JsxElement): Iterable<JsxElement> {
  for (const child of el.children) {
    if (isJsxElementNode(child)) {
      yield child;
      yield* jsxDescendantElements(child);
    }
  }
}

function isJsxElementNode(node: JsxNode): node is JsxElement {
  return node.kind === "JsxElement";
}

function containsPhrase(text: string): boolean {
  const normalized = text.toLowerCase();
  for (const phrase of UNAMBIGUOUS_PHRASES) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

/**
 * Composes a reason string covering the visible text that was found,
 * what's missing, and (when applicable) the missing-rel corollary.
 * Reason text drives the agent's dismissal speed per the AI-first
 * consumer doctrine, so each branch surfaces concrete evidence rather
 * than a generic prompt.
 */
function buildReason(linkLabel: string, visibleText: string, relValue: string | null): string {
  const textClause = visibleText
    ? `visible text "${truncate(visibleText)}" does not contain "new window", "new tab", or "opens in"`
    : "the link has no visible text content";
  const relClause = hasNoopener(relValue)
    ? ""
    : ' Also verify `rel="noopener"` is set — its absence is a separate security concern, not part of 3.2.5, but typically wanted alongside the announcement.';
  return (
    `${linkLabel} opens a new window/tab but ${textClause} — verify the user is told, in the link body or visually-adjacent prose, that activation will change context to a new window/tab.` +
    relClause
  );
}

function hasNoopener(relValue: string | null): boolean {
  if (relValue === null) return false;
  return /\bnoopener\b/i.test(relValue);
}

function truncate(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
