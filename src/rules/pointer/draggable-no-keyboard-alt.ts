/**
 * Rule: pointer/draggable-no-keyboard-alt
 * Satisfies: wcag22:2.5.7, wcag22:2.1.1, wcag21:2.1.1, section508:2.1.1, en301549:9.2.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#dragging-movements
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > All functionality of the content is operable through a keyboard
 * > interface without requiring specific timings for individual
 * > keystrokes. (SC 2.1.1 Keyboard, Level A)
 *
 * > All functionality that uses a dragging movement for operation can
 * > be achieved by a single pointer without dragging, unless dragging
 * > is essential or the functionality is determined by the user agent
 * > and not modified by the author. (SC 2.5.7 Dragging Movements, Level AA)
 *
 * Sources:
 *   https://www.w3.org/TR/WCAG22/#keyboard
 *   https://www.w3.org/TR/WCAG22/#dragging-movements
 *
 * Static-analysis scope: flag JSX/TSX or HTML elements that opt into
 * native HTML5 drag-and-drop (`draggable="true"`) WITHOUT exposing any
 * keyboard event handler on the same element. The narrow predicate is
 * deliberate — once a keyboard handler is present, *what keys it
 * listens for* (Arrow keys, Home/End, Space) and *what it does with
 * them* are body-of-the-handler decisions the agent verifies by
 * reading the source. The static check answers only the binary
 * question: is there an `onkeydown` / `onKeyDown` handler at all?
 *
 * Co-rule coalescing (Q20-PAIR-RULE-DOUBLE-EMISSION closure):
 *   The bare `<div draggable="true">` / `<span draggable="true">` case
 *   is covered TWICE by sibling rules already — `keyboard/handler-missing`
 *   cites SC 2.1.1 on the same element (the bare div is non-natively
 *   interactive and has no keyboard handler), and `pointer/drag-alternative`
 *   cites SC 2.5.7 on the same element when no file-level click
 *   alternative is present. Emitting a third finding on the same
 *   element with overlapping criteria duplicates the agent's budget
 *   without adding signal. Per the AI-first doctrine "Per-tool lane
 *   and warning-set classification must agree" and "Composite headline
 *   counts are dishonest," this rule now suppresses on the elements
 *   the co-rules already cover.
 *
 *   Remaining unique scope (where this rule still fires):
 *     - JSX PascalCase components with `draggable="true"` —
 *       `keyboard/handler-missing` deliberately trusts custom components
 *       (their internals aren't visible), so 2.1.1 on draggable wrappers
 *       isn't covered there.
 *     - Natively interactive elements with `draggable="true"` (e.g.
 *       `<a draggable="true">`, `<button draggable="true">`) —
 *       `keyboard/handler-missing` exempts these (Enter/Space activate
 *       them), but the drag operation itself still has no keyboard
 *       pathway. This rule is the canonical 2.1.1 emitter for that
 *       specific shape.
 *
 * Severity is "warning" because keyboard equivalence may be wired
 * elsewhere (a parent component, a `useEffect` adding listeners on
 * mount via `addEventListener`, a global keymap routed through a
 * hook). The rule's bounded evidence is in-element-only; the agent
 * reading the surrounding code is the correct arbiter.
 */
import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { EmittedViolation, FileContext } from "../../types/rule.ts";

/** JSX keyboard event handler names (camelCase). */
const JSX_KEYBOARD_HANDLERS: readonly string[] = ["onKeyDown", "onKeyUp", "onKeyPress"];

/** HTML keyboard event handler attributes (lowercase). */
const HTML_KEYBOARD_HANDLERS: readonly string[] = ["onkeydown", "onkeyup", "onkeypress"];

/**
 * Tags that `keyboard/handler-missing` covers for the bare-element drag
 * grammar (non-natively-interactive, non-PascalCase). When an element
 * matches one of these AND has `draggable="true"` AND has no keyboard
 * handler, `keyboard/handler-missing` already emits a SC 2.1.1 finding
 * and `pointer/drag-alternative` covers SC 2.5.7 (modulo file-level
 * click alternatives). Suppressing this rule on those elements avoids
 * triple-emission with the same criterion set — see the file header's
 * "Co-rule coalescing" note. The set is intentionally explicit rather
 * than "any non-natively-interactive tag" so that future additions to
 * either co-rule's coverage stay observable as test regressions on
 * this rule.
 */
const CORULE_COVERED_BARE_TAGS: ReadonlySet<string> = new Set([
  "div",
  "span",
  "li",
  "p",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "figure",
  "figcaption",
  "ul",
  "ol",
  "tr",
  "td",
  "th",
]);

/**
 * Tags that are natively interactive (focusable, Enter/Space activate
 * them) — `keyboard/handler-missing` exempts these, so this rule is
 * the canonical 2.1.1 emitter when one carries `draggable="true"`
 * without a keyboard handler. Mirrors the
 * `NATIVELY_INTERACTIVE_TAGS` set in `keyboard/handler-missing.ts`.
 */
const NATIVELY_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

/**
 * `true` when `tagName` starts with an uppercase ASCII letter — the
 * JSX convention for custom components. Mirrors `isPascalCaseComponent`
 * in `keyboard/handler-missing.ts`.
 */
function isPascalCaseComponent(tagName: string): boolean {
  const first = tagName[0];
  return first !== undefined && first >= "A" && first <= "Z";
}

/**
 * `true` when this element is one of the bare structural tags that
 * `keyboard/handler-missing` already covers for the drag grammar.
 * Suppressing on these avoids the triple-emission described in the
 * file header.
 */
function isCoRuleCoveredBare(tagName: string): boolean {
  return CORULE_COVERED_BARE_TAGS.has(tagName.toLowerCase());
}

/**
 * `true` when this element is natively interactive AND not a custom
 * component — the case where neither co-rule covers SC 2.1.1 on a
 * draggable variant, so this rule remains the canonical emitter.
 */
function isNativelyInteractiveTag(tagName: string): boolean {
  return NATIVELY_INTERACTIVE_TAGS.has(tagName.toLowerCase());
}

export const rule = defineRule({
  id: "pointer/draggable-no-keyboard-alt",
  satisfies: [
    "wcag22:2.5.7",
    "wcag22:2.1.1",
    "wcag21:2.1.1",
    "section508:2.1.1",
    "en301549:9.2.1.1",
  ],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  // The keyboard handler may be attached from a parent component, a
  // hook, or `addEventListener` in a sibling module — none of which
  // the in-file walk can see. ADR 0026 routes a clean tally on this
  // rule to `coverageConfidence: "medium"` so the agent reads the
  // surrounding code rather than trusting a `"high"` signal the
  // bounded evidence cannot honestly support.
  crossFileCapable: false,
  docs: {
    description:
      "draggable element must expose a keyboard handler (onkeydown / onKeyDown) so users who cannot drag can reorder, move, or pick up the item via the keyboard.",
    rationale:
      'Native HTML5 drag-and-drop (`draggable="true"`) is mouse/touch only — the platform exposes no keyboard pathway to start, drag, or drop. Users on switch input, head pointers, eye-gaze, or keyboard-only workflows cannot operate a draggable element unless the author wires keyboard equivalents (typically Arrow keys to move, Home/End to send to extremes, Space to pick up / drop). Without any keyboard handler at all the operation is keyboard-inoperable, failing SC 2.1.1; combined with no drag-free pathway, it also fails SC 2.5.7.',
    goodExample: `<a href="#" draggable="true" onKeyDown={handleArrows}>
  Drag me — or use Arrow keys to move
</a>`,
    badExample: `<a href="#" draggable="true">
  Drag me
</a>`,
    normativeQuote:
      "All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes.",
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/TR/WCAG22/#dragging-movements",
      "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html",
      "https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html",
    ],
    knownLimitations: [
      "single-file scope: keyboard handlers attached via addEventListener from a sibling module, parent-component prop, or hook are not resolved — a draggable element wired this way will be flagged.",
      "binary predicate: the rule does not inspect the body of the keyboard handler; an empty or no-op onKeyDown will satisfy the static check. The agent reads the handler body to verify it implements the move/pick-up/drop operation.",
      'co-rule coalescing: bare structural tags (<div>, <span>, <li>, etc.) with draggable="true" are intentionally not flagged here — keyboard/handler-missing covers SC 2.1.1 on those tags and pointer/drag-alternative covers SC 2.5.7. This rule fires only on natively interactive tags (e.g. <a draggable="true">) and JSX PascalCase components, where neither co-rule covers SC 2.1.1 for the drag operation.',
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      // Cross-file-candidate signal: any element with `draggable="true"`
      // is a token whose keyboard wiring may live in a parent
      // component / hook the rule cannot see. Files with zero such
      // elements carry no cross-file question — confidence stays
      // `"high"`.
      const doc = ctx.ast as HtmlDocument;
      if (htmlHasDraggable(doc)) ctx.markCrossFileCandidate?.();
      checkHtml(ctx as FileContext & { ast: HtmlDocument });
      return;
    }
    if (ctx.language === "tsx" || ctx.language === "jsx") {
      const module = ctx.ast as TsxModule;
      if (jsxHasDraggable(module)) ctx.markCrossFileCandidate?.();
      checkJsx(ctx as FileContext & { ast: TsxModule });
      return;
    }
  },
});

function jsxHasDraggable(module: TsxModule): boolean {
  for (const el of walkJsxElements(module)) {
    if (getJsxAttributeString(el, "draggable") === "true") return true;
  }
  return false;
}

function htmlHasDraggable(doc: HtmlDocument): boolean {
  for (const el of walkHtmlElements(doc)) {
    if (getHtmlAttribute(el, "draggable") === "true") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(ctx: FileContext & { ast: TsxModule }): void {
  for (const el of walkJsxElements(ctx.ast)) {
    if (getJsxAttributeString(el, "draggable") !== "true") continue;
    if (jsxHasKeyboardHandler(el)) continue;
    if (jsxIsExempt(el)) continue;
    // Co-rule coalescing: `keyboard/handler-missing` covers SC 2.1.1
    // on bare structural tags (`<div>`, `<span>`, `<li>`, etc.) with
    // `draggable="true"`, and `pointer/drag-alternative` covers SC
    // 2.5.7 on the same element when no file-level click alternative
    // is present. Emitting here on the same bare element would
    // duplicate the agent's budget with overlapping criteria — see
    // the file header. Skip and let the co-rules carry the signal.
    if (isCoRuleCoveredBare(el.tagName)) continue;
    ctx.emit(buildJsxViolation(el, ctx.filePath));
  }
}

function jsxHasKeyboardHandler(el: JsxElement): boolean {
  for (const handler of JSX_KEYBOARD_HANDLERS) {
    if (hasJsxAttribute(el, handler)) return true;
  }
  return false;
}

function jsxIsExempt(el: JsxElement): boolean {
  if (hasJsxAttribute(el, "disabled")) return true;
  if (getJsxAttributeString(el, "aria-disabled") === "true") return true;
  return false;
}

function buildJsxViolation(el: JsxElement, filePath: string): EmittedViolation {
  const tag = el.tagName;
  const isNative = isNativelyInteractiveTag(tag);
  const contextNote = isNative
    ? ` <${tag}> is keyboard-focusable by default (Enter/Space activate it), but the drag operation itself remains keyboard-inoperable.`
    : isPascalCaseComponent(tag)
      ? ` <${tag}> is a custom component; if its internals already wire keyboard handling for the drag, hoist the handler onto this attribute set or document the wiring.`
      : "";
  return {
    severity: "warning",
    location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
    message: `<${tag}> sets draggable="true" but has no keyboard handler — drag-and-drop is mouse/touch only on the platform, so this control is keyboard-inoperable (SC 2.1.1) with no non-dragging alternative on the element (SC 2.5.7).`,
    suggestion: `<${tag}> sets draggable="true" but has no \`onKeyDown\` handler. Add a keyboard equivalent on this element: typically Arrow keys to move the item, Home/End to send it to the extremes, and Space to pick up or drop. The handler body should update the same data the drag operation does, so keyboard and pointer paths reach the same result.${contextNote}`,
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(ctx: FileContext & { ast: HtmlDocument }): void {
  for (const el of walkHtmlElements(ctx.ast)) {
    if (getHtmlAttribute(el, "draggable") !== "true") continue;
    if (htmlHasKeyboardHandler(el)) continue;
    if (htmlIsExempt(el)) continue;
    // Co-rule coalescing: see checkJsx for the doctrine note.
    if (isCoRuleCoveredBare(el.tagName)) continue;
    ctx.emit(buildHtmlViolation(el, ctx.filePath));
  }
}

function htmlHasKeyboardHandler(el: HtmlElement): boolean {
  for (const handler of HTML_KEYBOARD_HANDLERS) {
    if (hasHtmlAttribute(el, handler)) return true;
  }
  return false;
}

function htmlIsExempt(el: HtmlElement): boolean {
  if (hasHtmlAttribute(el, "disabled")) return true;
  if (getHtmlAttribute(el, "aria-disabled") === "true") return true;
  return false;
}

function buildHtmlViolation(el: HtmlElement, filePath: string): EmittedViolation {
  const tag = el.tagName;
  const isNative = isNativelyInteractiveTag(tag);
  const contextNote = isNative
    ? ` <${tag}> is keyboard-focusable by default (Enter/Space activate it), but the drag operation itself remains keyboard-inoperable.`
    : "";
  return {
    severity: "warning",
    location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
    message: `<${tag}> sets draggable="true" but has no keyboard handler — drag-and-drop is mouse/touch only on the platform, so this control is keyboard-inoperable (SC 2.1.1) with no non-dragging alternative on the element (SC 2.5.7).`,
    suggestion: `<${tag}> sets draggable="true" but has no \`onkeydown\` handler. Add a keyboard equivalent on this element: typically Arrow keys to move the item, Home/End to send it to the extremes, and Space to pick up or drop. The handler body should update the same data the drag operation does, so keyboard and pointer paths reach the same result.${contextNote}`,
  };
}
