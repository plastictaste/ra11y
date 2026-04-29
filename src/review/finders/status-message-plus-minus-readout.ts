/**
 * Candidate finder: review/status-message-plus-minus-readout
 * Criteria: wcag22:4.1.3, wcag21:4.1.3
 * Spec: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * Surfaces the canonical "plus/minus counter" layout that real-world
 * quantity-stepper UIs use:
 *
 *     <button>+</button>
 *     <span id="size">10</span>
 *     <button>−</button>
 *
 * Sighted users see the middle element's value increment / decrement
 * each time a button is clicked, but assistive tech announces nothing
 * unless the value-bearing element is exposed as a status message
 * (`aria-live`, `role="status"`, `role="alert"`) or is a native
 * `<output>` (which is an implicit `role="status"`). Per WCAG 4.1.3,
 * status changes communicated via visual update alone fail when no
 * programmatic-announcement channel is wired.
 *
 * The shape (a value-bearing inline element flanked by two buttons
 * whose visible text is `+` and `-`) is unambiguous from the AST
 * alone: the buttons exist as syntactic siblings, their visible text
 * is one character each, and the matched character set is a tight
 * three-codepoint window (ASCII `+`, ASCII `-`, U+2212 MINUS SIGN —
 * covering the "real" minus most quantity steppers ship now that
 * typographic correctness has migrated through design systems). The
 * U+2013 EN DASH and U+2014 EM DASH are deliberately NOT matched —
 * those are dash characters used for ranges and parentheticals, not
 * decrement labels, and accepting them would widen the predicate
 * onto pagination / breadcrumb shapes that have nothing to do with
 * SC 4.1.3.
 *
 * Why a review candidate, not a hard rule:
 *
 *   - Static analysis cannot verify the click handler actually
 *     produces a stateful value update — the buttons might dispatch
 *     a one-shot action (jump-to-page, navigate-by-step) whose
 *     announcement requirements are different from a stateful
 *     counter.
 *   - The fix path depends on what the middle element holds: if it
 *     already carries a numeric label like `<span aria-label="size:
 *     10">`, the announcement may be plumbed through a sibling live
 *     region; if the value lives only in a child text node, the
 *     fix is to add `aria-live="polite"` / `role="status"` directly
 *     OR convert the element to `<output>`.
 *
 * Predicate (conservative):
 *   - Element X is `<span>`, `<div>`, or `<output>` AND has at least
 *     one syntactic sibling on each side that is a `<button>` whose
 *     trimmed, whitespace-collapsed visible text is exactly `+` or
 *     `−` / `-`.
 *   - X lacks `aria-live`, `role="status"`, `role="alert"`.
 *   - X is NOT itself `<output>` (native `role="status"`).
 *
 * Per AI-first doctrine "Surface, don't suppress" the predicate
 * stays strict — class-based `/(increment|decrement|inc|dec)/`
 * matches are deliberately NOT OR'd with the strict shape, since
 * a `<div class="increment-banner">` is just as plausibly a CSS
 * animation header as a stepper widget.
 *
 * Confidence `high`: the match is fully static — three syntactic
 * siblings, two exact-text matches, one missing-attribute predicate.
 * The agent reading the cited file confirms the click handlers wire
 * a stateful update; the finder points at an unambiguous shape.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:4.1.3", "wcag21:4.1.3"] as const;

/**
 * Tags that may host a numeric value rendered in a stepper layout.
 * Restricted to neutral inline / generic structural containers — a
 * `<span>` carries the value most often; `<div>` covers grid-laid
 * stepper layouts where the value sits in its own block; `<output>`
 * is included so the *negative* case (the value-bearing element is
 * already `<output>`, which is implicitly `role="status"`) reads
 * cleanly. `<output>` instances are filtered out before emission;
 * they're included in the candidate-tag set so a future widen of
 * the negative path stays local to one place.
 */
const VALUE_BEARING_TAGS: ReadonlySet<string> = new Set(["span", "div", "output"]);

/**
 * Visible-text labels matched on a `<button>` to count it as a
 * `+` / `−` stepper button. Three codepoints — ASCII `+`, ASCII `-`,
 * and U+2212 MINUS SIGN — cover the typographic conventions modern
 * design systems ship. EN/EM dashes are deliberately omitted (they
 * label ranges, not decrements).
 */
const PLUS_MINUS_GLYPHS: ReadonlySet<string> = new Set(["+", "-", "−"]);

/**
 * JSX tags treated as native `<button>` wrappers for cross-library
 * coverage. Mirrors the convention in
 * `src/review/finders/toggle-button-pressed-missing.ts`. The Pascal-
 * cased `Button` covers the common React / design-system component
 * naming.
 */
const JSX_BUTTON_TAGS: ReadonlySet<string> = new Set(["button", "Button"]);

export const finder = defineCandidateFinder({
  id: "review/status-message-plus-minus-readout",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds plus/minus counter layouts (a <span>/<div> sibling between two <button> elements whose visible text is '+' and '-' or U+2212 MINUS SIGN) where the value-bearing element lacks aria-live, role='status', role='alert', and is not <output>.",
    reviewPrompt:
      "Verify whether the value displayed in the middle element changes at runtime when the +/− buttons are clicked. If yes, expose the change to assistive tech: add aria-live='polite' (or role='status') to the value-bearing element, or convert it to <output> (implicit role='status'). If the buttons dispatch a one-shot action that does not update an in-place value (e.g. they navigate to a paginated route), no change is needed — but verify the navigation announcement is plumbed elsewhere.",
    references: [
      "https://www.w3.org/TR/WCAG22/#status-messages",
      "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html",
      "https://www.w3.org/WAI/ARIA/apg/patterns/spinbutton/",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  // The triple may sit at the document root (no enclosing layout
  // element) OR inside any element. Walking both surfaces covers
  // both cases without re-traversing.
  inspectHtmlChildren(root.children, filePath, candidates);
  for (const element of walkHtmlElements(root)) {
    inspectHtmlChildren(element.children, filePath, candidates);
  }
}

function inspectHtmlChildren(
  children: readonly HtmlNode[],
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  // Filter out everything but elements — text nodes between tags
  // (whitespace, formatting indents, template directives) are not
  // semantic siblings for the stepper-shape match. Comments and
  // doctypes likewise.
  const elementChildren: HtmlElement[] = [];
  for (const child of children) {
    if (child.kind === "HtmlElement") elementChildren.push(child);
  }
  if (elementChildren.length < 3) return;
  for (let i = 1; i < elementChildren.length - 1; i++) {
    const middle = elementChildren[i];
    const prev = elementChildren[i - 1];
    const next = elementChildren[i + 1];
    if (!(middle && prev && next)) continue;
    if (!isStepperTripleHtml(prev, middle, next)) continue;
    pushCandidates(
      candidates,
      filePath,
      middle.loc.start.line,
      middle.loc.start.column,
      reason(middle.tagName.toLowerCase()),
    );
  }
}

function isStepperTripleHtml(prev: HtmlElement, middle: HtmlElement, next: HtmlElement): boolean {
  const middleTag = middle.tagName.toLowerCase();
  if (!VALUE_BEARING_TAGS.has(middleTag)) return false;
  // <output> is implicitly role="status" — the criterion is already
  // satisfied; do not surface.
  if (middleTag === "output") return false;
  if (middleHasAnnouncementOptInHtml(middle)) return false;
  if (!isPlusMinusButtonHtml(prev)) return false;
  if (!isPlusMinusButtonHtml(next)) return false;
  return true;
}

function isPlusMinusButtonHtml(element: HtmlElement): boolean {
  if (element.tagName.toLowerCase() !== "button") return false;
  const text = htmlTextContent(element);
  return matchesPlusMinus(text);
}

function middleHasAnnouncementOptInHtml(element: HtmlElement): boolean {
  if (hasHtmlAttribute(element, "aria-live")) return true;
  const role = getHtmlAttribute(element, "role");
  if (role !== null) {
    const lowered = role.trim().toLowerCase();
    if (lowered === "status" || lowered === "alert") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const top of root.jsxElements) {
    inspectJsxElement(top, filePath, candidates);
  }
}

function inspectJsxElement(
  element: JsxElement,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  inspectJsxChildren(element.children, filePath, candidates);
  for (const child of element.children) {
    if (child.kind === "JsxElement") inspectJsxElement(child, filePath, candidates);
  }
}

function inspectJsxChildren(
  children: readonly JsxNode[],
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  const elementChildren: JsxElement[] = [];
  for (const child of children) {
    if (child.kind === "JsxElement") elementChildren.push(child);
  }
  if (elementChildren.length < 3) return;
  for (let i = 1; i < elementChildren.length - 1; i++) {
    const middle = elementChildren[i];
    const prev = elementChildren[i - 1];
    const next = elementChildren[i + 1];
    if (!(middle && prev && next)) continue;
    if (!isStepperTripleJsx(prev, middle, next)) continue;
    pushCandidates(
      candidates,
      filePath,
      middle.loc.start.line,
      middle.loc.start.column,
      reason(middle.tagName.toLowerCase()),
    );
  }
}

function isStepperTripleJsx(prev: JsxElement, middle: JsxElement, next: JsxElement): boolean {
  const middleTag = middle.tagName.toLowerCase();
  if (!VALUE_BEARING_TAGS.has(middleTag)) return false;
  if (middleTag === "output") return false;
  if (middleHasAnnouncementOptInJsx(middle)) return false;
  if (!isPlusMinusButtonJsx(prev)) return false;
  if (!isPlusMinusButtonJsx(next)) return false;
  return true;
}

function isPlusMinusButtonJsx(element: JsxElement): boolean {
  if (!JSX_BUTTON_TAGS.has(element.tagName)) return false;
  const text = jsxTextContent(element);
  return matchesPlusMinus(text);
}

function middleHasAnnouncementOptInJsx(element: JsxElement): boolean {
  if (hasJsxAttribute(element, "aria-live")) return true;
  const role = getJsxAttributeString(element, "role");
  if (role !== null) {
    const lowered = role.trim().toLowerCase();
    if (lowered === "status" || lowered === "alert") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * True when `text`, after trimming and whitespace-collapsing, matches
 * one of the three accepted stepper glyphs. The whole-string match is
 * intentional — `+` matches, `+1` does not (the latter is a
 * conventional "increase by one" verbose label whose announcement
 * requirements are different and out of scope for this finder).
 */
function matchesPlusMinus(text: string): boolean {
  const normalized = text.replace(/\s+/gu, "").trim();
  if (normalized.length === 0) return false;
  return PLUS_MINUS_GLYPHS.has(normalized);
}

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reasonText: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "high": the static signal (three syntactic siblings,
    // two exact-text plus/minus button matches on either side, missing
    // announcement-opt-in attribute on a value-bearing tag) is fully
    // resolvable from the AST. The agent confirms the runtime click
    // handler updates the value; the finder commits on the shape.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason: reasonText,
      confidence: "high",
    });
  }
}

function reason(middleTag: string): string {
  return (
    `<${middleTag}> sits between two <button> elements whose visible text is "+" and "−" — ` +
    `counter-shaped layout — verify value updates are announced (aria-live, role="status", or convert to <output>). ` +
    `If the buttons update an in-place value, expose the change to assistive tech: ` +
    `add aria-live="polite" (or role="status") to this element, or convert it to <output> (implicit role="status"). ` +
    `If the buttons dispatch a one-shot action with no in-place value update, no change is needed — but verify the announcement is plumbed elsewhere.`
  );
}
