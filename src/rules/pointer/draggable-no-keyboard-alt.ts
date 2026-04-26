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
 * Companion to `pointer/drag-alternative` (which checks for a
 * single-pointer click alternative). A draggable element with no
 * keyboard handler fails 2.1.1 (the drag is keyboard-inoperable) and
 * also leans into 2.5.7 (no non-dragging path to the same operation).
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
    goodExample: `<div draggable="true" onKeyDown={handleArrows}>
  Drag me — or use Arrow keys to move
</div>`,
    badExample: `<div draggable="true">
  Drag me
</div>`,
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
  return {
    severity: "warning",
    location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
    message: `<${tag}> sets draggable="true" but has no keyboard handler — drag-and-drop is mouse/touch only on the platform, so this control is keyboard-inoperable (SC 2.1.1) with no non-dragging alternative on the element (SC 2.5.7).`,
    suggestion: `<${tag}> sets draggable="true" but has no \`onKeyDown\` handler. Add a keyboard equivalent on this element (typically: Arrow keys to move the item, Home/End to send it to the extremes, Space to pick up or drop). If keyboard wiring lives in a parent component or hook this rule cannot see, suppress with \`{/* ra11y-disable pointer/draggable-no-keyboard-alt */}\` and document where the handler lives.`,
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
  return {
    severity: "warning",
    location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
    message: `<${tag}> sets draggable="true" but has no keyboard handler — drag-and-drop is mouse/touch only on the platform, so this control is keyboard-inoperable (SC 2.1.1) with no non-dragging alternative on the element (SC 2.5.7).`,
    suggestion: `<${tag}> sets draggable="true" but has no \`onkeydown\` handler. Add a keyboard equivalent on this element (typically: Arrow keys to move the item, Home/End to send it to the extremes, Space to pick up or drop). If keyboard wiring is attached at runtime via \`addEventListener\` this static rule cannot see, suppress with \`<!-- ra11y-disable pointer/draggable-no-keyboard-alt -->\` and document where the handler lives.`,
  };
}
