/**
 * Candidate finder: review/live-region-pre-existence
 * Criteria: wcag22:4.1.3, wcag21:4.1.3 (Status Messages, AA)
 * Spec: https://www.w3.org/TR/WCAG22/#status-messages
 *
 * Surfaces ARIA live-region containers (`role="alert"`, `role="status"`,
 * `role="log"`, or `aria-live="polite|assertive"`) that are hidden at
 * initial render via `display: none`, `visibility: hidden`, the `hidden`
 * boolean attribute, or a hiding class name (`d-none`, `is-hidden`,
 * `invisible`, `hide` — Bootstrap / common-utility patterns). When the
 * live region is hidden at initial render, the element does not exist
 * in the accessibility tree at the moment a script later inserts a
 * message into it; many AT/browser combinations therefore fail to
 * announce the inserted message. The widely-cited Bootstrap Toasts
 * documentation calls this gotcha out: an initially-hidden live region
 * with a non-pre-existing inserted message does not reliably announce.
 *
 * `sr-only` / `visually-hidden` / `screen-reader-text` are NOT treated
 * as hiding signals — those are visually-hidden-but-AT-visible utility
 * classes whose entire purpose is "render to AT but not to sighted
 * users." A live region wrapped in `sr-only` is the correct pattern.
 *
 * Detection signals (any of):
 *   - inline `style` containing `display: none` (whitespace tolerant)
 *   - inline `style` containing `visibility: hidden`
 *   - the `hidden` boolean attribute
 *   - class name matching `/(^|\s)(d-none|is-hidden|invisible|hide)($|\s)/`
 *
 * Cross-element scope: the hiding signal may sit on the live-region
 * element itself OR on any ancestor (a parent `<div class="d-none">`
 * also takes the live region out of the accessibility tree until the
 * ancestor is shown). The reason text names the matched signal so the
 * agent can dismiss when, e.g., `sr-only` semantics actually apply or
 * the runtime visibility flow keeps the region present in the AT tree.
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures. Reviewer's job: confirm
 * whether the runtime mutation pattern primes the live region (toggles
 * the hide class BEFORE inserting text, with a tick of delay) or fails
 * the announce-on-insert contract.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import type {
  HtmlAttribute,
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxAttribute,
  JsxAttributeValue,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:4.1.3", "wcag21:4.1.3"] as const;

/**
 * Class-name tokens that hide an element from the accessibility tree.
 * Matched as whole tokens (whitespace-delimited) so substring collisions
 * (`hide-on-mobile`, `is-hidden-lg`) don't fire.
 *
 * Excluded (intentionally — these are AT-visible utility classes):
 *   `sr-only`, `visually-hidden`, `visually-hidden-focusable`,
 *   `screen-reader-text`, `aria-hidden`. A live region wrapped in any
 *   of these is the canonical pre-existing-but-invisible pattern.
 */
const HIDING_CLASS_TOKENS = ["d-none", "is-hidden", "invisible", "hide"] as const;
const HIDING_CLASS_PATTERN = new RegExp(`(?:^|\\s)(${HIDING_CLASS_TOKENS.join("|")})(?:$|\\s)`);

/** `display: none` / `display:none` — any amount of inter-token whitespace. */
const STYLE_DISPLAY_NONE = /\bdisplay\s*:\s*none\b/i;
/** `visibility: hidden` / `visibility:hidden` — same shape as display. */
const STYLE_VISIBILITY_HIDDEN = /\bvisibility\s*:\s*hidden\b/i;

const REASON_PREFIX =
  "live-region container is hidden at initial render via $SIGNAL — if the region is shown and a message is inserted at runtime, AT may not announce because the live region must exist in the accessibility tree before the message is inserted (WCAG 4.1.3 Status Messages)";
const REASON_SUFFIX =
  ". Verify the runtime pattern: the live region should be present from initial render (consider `sr-only` / `visually-hidden` for visually-hidden-but-AT-visible) and the message inserted into the already-mounted region — toggling the hide class and inserting the message in the same tick is unreliable across AT/browser combinations.";

export const finder = defineCandidateFinder({
  id: "review/live-region-pre-existence",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      'Surfaces ARIA live-region containers (role=alert/status/log or aria-live) that are hidden at initial render via display:none, visibility:hidden, the hidden attribute, or a hiding class (d-none, is-hidden, invisible, hide). sr-only / visually-hidden are NOT treated as hiding — those classes keep the element in the accessibility tree.',
    reviewPrompt:
      "For each candidate, verify whether the runtime pattern primes the live region before inserting a message. The live region must exist in the accessibility tree at the moment text is inserted; toggling a hide class and inserting the message in the same tick is unreliable across AT/browser combinations. The fix is usually to keep the live region mounted from initial render (use sr-only / visually-hidden for visually-hidden-but-AT-visible) and only mutate the contained text. WCAG 4.1.3 Status Messages.",
    references: [
      "https://www.w3.org/TR/WCAG22/#status-messages",
      "https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html",
      "https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/ARIA_Live_Regions",
    ],
  },
  find(ctx) {
    const out: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, out);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, out);
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function findHtmlCandidates(doc: HtmlDocument, filePath: string, out: ReviewCandidate[]): void {
  walkHtmlWithAncestors(doc.children, [], (el, ancestors) => {
    const liveSignal = htmlLiveRegionSignal(el);
    if (!liveSignal) return;
    const hidingSignal = nearestHtmlHidingSignal(el, ancestors);
    if (!hidingSignal) return;
    emitCandidates(out, filePath, el.loc.start.line, el.loc.start.column, liveSignal, hidingSignal);
  });
}

function walkHtmlWithAncestors(
  nodes: readonly HtmlNode[],
  ancestors: readonly HtmlElement[],
  visit: (el: HtmlElement, ancestors: readonly HtmlElement[]) => void,
): void {
  for (const node of nodes) {
    if (node.kind !== "HtmlElement") continue;
    visit(node, ancestors);
    walkHtmlWithAncestors(node.children, [...ancestors, node], visit);
  }
}

/**
 * Returns a short label naming the live-region attribute that triggered
 * the match (`role="alert"`, `aria-live="polite"`, etc.), or `null` when
 * the element is not a live region. We prefer the exact matched value
 * so the reason text echoes what the author wrote.
 */
function htmlLiveRegionSignal(el: HtmlElement): string | null {
  for (const attr of el.attributes) {
    const name = attr.name.toLowerCase();
    if (name === "role" && attr.value !== null) {
      const role = attr.value.trim().toLowerCase();
      if (role === "alert" || role === "status" || role === "log") {
        return `role="${role}"`;
      }
    }
    if (name === "aria-live" && attr.value !== null) {
      const live = attr.value.trim().toLowerCase();
      if (live === "polite" || live === "assertive") {
        return `aria-live="${live}"`;
      }
    }
  }
  return null;
}

/**
 * Returns the nearest hiding signal — checks the element first, then
 * each ancestor outward. Returns null when no hiding signal is in
 * effect. The match string identifies the element ("self" / "ancestor
 * <tag>") so the reviewer knows where to look.
 */
function nearestHtmlHidingSignal(
  el: HtmlElement,
  ancestors: readonly HtmlElement[],
): string | null {
  const selfSignal = htmlElementHidingSignal(el);
  if (selfSignal) return `${selfSignal} on the element itself`;
  // Walk ancestors innermost-first so the closest hide wins (the message
  // the agent reads is about the nearest blocker).
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (!ancestor) continue;
    const sig = htmlElementHidingSignal(ancestor);
    if (sig) return `${sig} on ancestor <${ancestor.tagName.toLowerCase()}>`;
  }
  return null;
}

/**
 * Inspect a single HTML element's attributes for a hiding signal.
 * Returns a short label naming the attribute and matched fragment so
 * the reason text can echo the author's source verbatim.
 */
function htmlElementHidingSignal(el: HtmlElement): string | null {
  for (const attr of el.attributes) {
    const sig = describeHtmlAttributeHide(attr);
    if (sig) return sig;
  }
  return null;
}

function describeHtmlAttributeHide(attr: HtmlAttribute): string | null {
  const name = attr.name.toLowerCase();
  if (name === "hidden") return "the `hidden` attribute";
  if (name === "style" && attr.value !== null) {
    if (STYLE_DISPLAY_NONE.test(attr.value)) return "inline `style=\"display: none\"`";
    if (STYLE_VISIBILITY_HIDDEN.test(attr.value)) return "inline `style=\"visibility: hidden\"`";
  }
  if (name === "class" && attr.value !== null) {
    const match = HIDING_CLASS_PATTERN.exec(attr.value);
    if (match) return `class \`${match[1]}\``;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(module: TsxModule, filePath: string, out: ReviewCandidate[]): void {
  walkJsxWithAncestors(module.jsxElements, [], (el, ancestors) => {
    const liveSignal = jsxLiveRegionSignal(el);
    if (!liveSignal) return;
    const hidingSignal = nearestJsxHidingSignal(el, ancestors);
    if (!hidingSignal) return;
    emitCandidates(out, filePath, el.loc.start.line, el.loc.start.column, liveSignal, hidingSignal);
  });
}

function walkJsxWithAncestors(
  elements: readonly JsxElement[],
  ancestors: readonly JsxElement[],
  visit: (el: JsxElement, ancestors: readonly JsxElement[]) => void,
): void {
  for (const el of elements) {
    visit(el, ancestors);
    const childElements: JsxElement[] = [];
    for (const child of el.children) {
      if (isJsxElementNode(child)) childElements.push(child);
    }
    if (childElements.length > 0) {
      walkJsxWithAncestors(childElements, [...ancestors, el], visit);
    }
  }
}

function isJsxElementNode(node: JsxNode): node is JsxElement {
  return node.kind === "JsxElement";
}

function jsxLiveRegionSignal(el: JsxElement): string | null {
  for (const attr of el.attributes) {
    if (attr.name === "role") {
      const role = jsxAttributeStringValue(attr.value);
      if (role === "alert" || role === "status" || role === "log") {
        return `role="${role}"`;
      }
    }
    if (attr.name === "aria-live" || attr.name === "ariaLive") {
      const live = jsxAttributeStringValue(attr.value);
      if (live === "polite" || live === "assertive") {
        return `aria-live="${live}"`;
      }
    }
  }
  return null;
}

function nearestJsxHidingSignal(
  el: JsxElement,
  ancestors: readonly JsxElement[],
): string | null {
  const selfSignal = jsxElementHidingSignal(el);
  if (selfSignal) return `${selfSignal} on the element itself`;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (!ancestor) continue;
    const sig = jsxElementHidingSignal(ancestor);
    if (sig) return `${sig} on ancestor <${ancestor.tagName}>`;
  }
  return null;
}

function jsxElementHidingSignal(el: JsxElement): string | null {
  for (const attr of el.attributes) {
    const sig = describeJsxAttributeHide(attr);
    if (sig) return sig;
  }
  return null;
}

function describeJsxAttributeHide(attr: JsxAttribute): string | null {
  if (attr.name === "hidden") {
    if (attr.value === null) return "the `hidden` attribute";
    if (attr.value.kind === "StringLiteral") return "the `hidden` attribute";
    // {expression} — only count it when the expression is a literal `true`.
    // Any other value (`{maybeHidden}`, `{false}`) is the agent's call.
    const raw = attr.value.raw.replace(/\s+/g, "");
    if (raw === "{true}") return "the `hidden` attribute";
    return null;
  }
  if (attr.name === "style" && attr.value !== null) {
    return describeJsxStyleHide(attr.value);
  }
  if ((attr.name === "className" || attr.name === "class") && attr.value !== null) {
    const literal = jsxAttributeStringValue(attr.value);
    if (literal !== null) {
      const match = HIDING_CLASS_PATTERN.exec(literal);
      if (match) return `class \`${match[1]}\``;
    }
  }
  return null;
}

/**
 * JSX `style` may be a string literal (`style="display:none"` — rare in
 * idiomatic React but valid in JSX-as-HTML usage) or an expression like
 * `style={{ display: "none" }}`. We match both, leaning conservative:
 * for object expressions we look for `display: "none"` / `display:'none'`
 * patterns in the raw expression text. Anything more dynamic than a
 * literal value (e.g. `display: hidden ? "none" : undefined`) does not
 * match — the reviewer's call.
 */
function describeJsxStyleHide(value: JsxAttributeValue): string | null {
  if (value.kind === "StringLiteral") {
    if (STYLE_DISPLAY_NONE.test(value.value)) return "inline `style=\"display: none\"`";
    if (STYLE_VISIBILITY_HIDDEN.test(value.value)) return "inline `style=\"visibility: hidden\"`";
    return null;
  }
  // Expression — match the most idiomatic JSX object-style shapes.
  if (/\bdisplay\s*:\s*['"]none['"]/i.test(value.raw)) {
    return "inline `style={{ display: \"none\" }}`";
  }
  if (/\bvisibility\s*:\s*['"]hidden['"]/i.test(value.raw)) {
    return "inline `style={{ visibility: \"hidden\" }}`";
  }
  return null;
}

function jsxAttributeStringValue(value: JsxAttributeValue | null): string | null {
  if (value === null) return null;
  if (value.kind === "StringLiteral") return value.value.trim().toLowerCase();
  return null;
}

// ---------------------------------------------------------------------------
// Shared emission
// ---------------------------------------------------------------------------

function emitCandidates(
  out: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  liveSignal: string,
  hidingSignal: string,
): void {
  const reason = `${REASON_PREFIX
    .replace("$SIGNAL", `${hidingSignal} (live-region marker: ${liveSignal})`)}${REASON_SUFFIX}`;
  for (const criterionId of CRITERION_IDS) {
    // Confidence "medium": the static signals (role/aria-live + a hiding
    // attribute or class) are concrete and deterministic, but the
    // reviewer's question — "does the runtime mutation pattern prime the
    // live region before inserting the message?" — depends on the JS
    // flow the scanner cannot see. The candidate is always worth reading;
    // dismissal is one Read away. Per ai-first-consumer.md we surface
    // and annotate rather than gate on a heuristic.
    out.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "medium",
    });
  }
}
