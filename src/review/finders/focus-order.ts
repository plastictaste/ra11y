/**
 * Candidate finder: review/focus-order
 * Criteria: wcag22:2.4.3 (focus order, A)
 *           wcag21:2.4.3
 *
 * Spec:  https://www.w3.org/TR/WCAG22/#focus-order
 *
 * Surfaces natively-focusable controls (and elements with widget
 * roles) that carry `tabindex="-1"`. A negative tabindex removes the
 * element from sequential keyboard navigation while keeping it
 * programmatically focusable — the legitimate pattern is an
 * offscreen/hidden dialog whose focus is moved programmatically on
 * open, then returned on close. The accidental pattern is a control
 * the author silently disabled for keyboard users.
 *
 * Static evidence alone cannot tell the two apart — the reviewer
 * reads the surrounding focus-management code. Confidence is "high"
 * because the trigger predicate is deterministic (tabindex === -1
 * AND (natively-focusable tag OR widget role)); the question the
 * reviewer is asked is not.
 *
 * The sibling rule `focus/tabindex-positive` handles positive values
 * (>= 1), which are a pure anti-pattern; this finder handles -1 on
 * focusable controls, which is a reviewer question.
 *
 * Per CLAUDE.md §1 and docs/kb/architecture/ai-first-consumer.md we
 * surface honestly — no threshold, no heuristic suppression, no
 * bucket. The reason text carries the dismissal signal (point at the
 * a11y-dialog pattern) so the agent dismisses in one file read when
 * that is in fact what it is.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:2.4.3", "wcag21:2.4.3"] as const;

/**
 * Natively focusable HTML tags that participate in the default tab
 * order without needing `tabindex`. `<a>` is handled specially below
 * because its focusability depends on the presence of `href`.
 */
const NATIVELY_FOCUSABLE_TAGS: ReadonlySet<string> = new Set([
  "input",
  "textarea",
  "select",
  "button",
]);

/**
 * ARIA widget roles whose focusability expectation matches a native
 * interactive control. Elements carrying one of these roles are
 * authored as focusable widgets; removing them from tab order with
 * `tabindex="-1"` asks the same reviewer question as doing it to a
 * native control.
 */
const WIDGET_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "slider",
  "spinbutton",
  "switch",
]);

/** React uses camelCase `tabIndex`; HTML uses lowercase `tabindex`. Accept both. */
const JSX_TABINDEX_NAMES: readonly string[] = ["tabIndex", "tabindex"];

const REASON_SUFFIX =
  ' has tabindex="-1" — natively focusable control removed from tab order. Verify this is an intentional a11y-dialog pattern (focus moved programmatically on open, returned on close) and not an accidental suppression of keyboard access.';

const ROLE_REASON_SUFFIX =
  ' has tabindex="-1" — element with a widget role removed from tab order. Verify this is an intentional a11y-dialog pattern (focus moved programmatically on open, returned on close) and not an accidental suppression of keyboard access.';

export const finder = defineCandidateFinder({
  id: "review/focus-order",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      'Finds natively-focusable controls (<input>, <textarea>, <select>, <button>, <a href>) and widget-role elements (role="button"/"link"/"textbox"/"checkbox"/"radio"/"combobox"/"slider"/"spinbutton"/"switch") that carry tabindex="-1". A negative tabindex removes them from sequential keyboard navigation — legitimate for offscreen dialogs whose focus is moved programmatically, a regression when it silently disables keyboard access.',
    reviewPrompt:
      'At each candidate, read the surrounding focus-management code. If a script calls `.focus()` on this element when a dialog/panel opens and returns focus on close, the tabindex="-1" is correct. If no programmatic focus handoff exists, or the element is meant to be reachable by Tab, the attribute is an accidental suppression and should be removed (for native controls) or reconsidered (for widget-role elements).',
    references: [
      "https://www.w3.org/TR/WCAG22/#focus-order",
      "https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/tabindex",
      "https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/",
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
// HTML branch
// ---------------------------------------------------------------------------

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    if (!htmlHasNegativeTabindex(el)) continue;
    const trigger = classifyHtmlTrigger(el);
    if (trigger === null) continue;
    emit(filePath, el.loc.start, trigger, candidates);
  }
}

/**
 * True when the element carries `tabindex="-1"` (case-insensitive on
 * the attribute name; whitespace tolerated around the value). Any
 * other value (including `"0"`, `"1"`, unset, shorthand) returns false.
 */
function htmlHasNegativeTabindex(el: HtmlElement): boolean {
  if (!hasHtmlAttribute(el, "tabindex")) return false;
  const raw = getHtmlAttribute(el, "tabindex");
  if (raw === null) return false;
  return raw.trim() === "-1";
}

/**
 * Returns a short reason fragment ("`<input>`", `<a href="/x">`,
 * `<div role="button">`) when the element matches the trigger set,
 * or `null` when it does not. Case-insensitive on tag name and role
 * value per HTML/ARIA semantics.
 */
function classifyHtmlTrigger(el: HtmlElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (NATIVELY_FOCUSABLE_TAGS.has(tag)) {
    const typeAttr = getHtmlAttribute(el, "type");
    if (tag === "input" && typeAttr !== null) {
      return `<input type="${typeAttr}">${REASON_SUFFIX}`;
    }
    return `<${tag}>${REASON_SUFFIX}`;
  }
  if (tag === "a") {
    // <a> is focusable only when it has `href`. Case-insensitive
    // presence check — an empty `href=""` is still an href attribute
    // and still makes the anchor focusable.
    if (hasHtmlAttribute(el, "href")) {
      return `<a href>${REASON_SUFFIX}`;
    }
    return null;
  }
  const role = getHtmlAttribute(el, "role");
  if (role !== null) {
    const lowered = role.trim().toLowerCase();
    if (WIDGET_ROLES.has(lowered)) {
      return `<${tag} role="${lowered}">${ROLE_REASON_SUFFIX}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    if (!jsxHasNegativeTabindex(el)) continue;
    const trigger = classifyJsxTrigger(el);
    if (trigger === null) continue;
    emit(filePath, el.loc.start, trigger, candidates);
  }
}

/**
 * True when the element carries `tabIndex="-1"` (string literal) or
 * `tabIndex={-1}` (numeric expression). Variable/expression values
 * that the static reader cannot resolve (`tabIndex={foo}`,
 * `tabIndex={computed()}`) do not match — the reviewer cannot be
 * asked a question grounded in the source alone. The positive-tabindex
 * rule applies the same tradeoff for its expression-branch handling.
 */
function jsxHasNegativeTabindex(el: JsxElement): boolean {
  for (const name of JSX_TABINDEX_NAMES) {
    const attr = getJsxAttribute(el, name);
    if (!attr) continue;
    const literal = getJsxAttributeString(el, name);
    if (literal !== null) return literal.trim() === "-1";
    if (attr.value?.kind === "Expression") {
      const stripped = stripBraces(attr.value.raw).trim();
      return stripped === "-1";
    }
    return false;
  }
  return false;
}

/**
 * Mirror of `classifyHtmlTrigger` for the JSX branch. JSX tag names
 * preserve source casing — `<Button>` is a component and not a native
 * HTML `<button>`, so the check compares against the lowercase native
 * tag set exactly. An author who really has a native `<button>` wrote
 * it lowercase.
 */
function classifyJsxTrigger(el: JsxElement): string | null {
  const tag = el.tagName;
  if (NATIVELY_FOCUSABLE_TAGS.has(tag)) {
    const typeAttr = getJsxAttributeString(el, "type");
    if (tag === "input" && typeAttr !== null) {
      return `<input type="${typeAttr}">${REASON_SUFFIX}`;
    }
    return `<${tag}>${REASON_SUFFIX}`;
  }
  if (tag === "a") {
    const hrefAttr = getJsxAttribute(el, "href");
    // A bare `<a href>` shorthand would still make the anchor
    // focusable; a dynamic `href={x}` is unresolvable but the
    // attribute *is present*, which is all native focusability
    // requires — treat present-attribute as a trigger.
    if (hrefAttr) return `<a href>${REASON_SUFFIX}`;
    return null;
  }
  const role = getJsxAttributeString(el, "role");
  if (role !== null) {
    const lowered = role.trim().toLowerCase();
    if (WIDGET_ROLES.has(lowered)) {
      return `<${tag} role="${lowered}">${ROLE_REASON_SUFFIX}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function emit(
  filePath: string,
  loc: { line: number; column: number },
  reason: string,
  candidates: ReviewCandidate[],
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "high": the trigger predicate is deterministic —
    // tabindex === "-1" on a closed set of natively-focusable tags or
    // widget roles. The question the reviewer must answer (legitimate
    // a11y-dialog pattern vs. accidental suppression) is context the
    // scanner cannot see; the candidate itself is concrete.
    candidates.push({
      criterionId,
      location: { filePath, line: loc.line, column: loc.column },
      reason,
      confidence: "high",
    });
  }
}

/** Strips exactly one pair of outer braces from a JSX expression's raw text. */
function stripBraces(raw: string): string {
  let out = raw;
  if (out.startsWith("{")) out = out.slice(1);
  if (out.endsWith("}")) out = out.slice(0, -1);
  return out;
}
