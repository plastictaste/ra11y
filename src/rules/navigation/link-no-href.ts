/**
 * Rule: navigation/link-no-href
 * Satisfies: wcag22:2.1.1, wcag21:2.1.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > All functionality of the content is operable through a keyboard
 * > interface without requiring specific timings for individual
 * > keystrokes […].
 *
 * Source: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * An `<a>` without an `href` is not in the default keyboard tab order
 * and is announced by screen readers as a generic container, not as
 * a link. If the element has an `onClick` (or `onclick`) handler, it
 * behaves like a button but can't be reached with Tab and can't be
 * activated with Enter — keyboard and AT users are locked out.
 *
 * The HTML spec is explicit: "The href content attribute on a and
 * area elements must have a value that is a valid URL potentially
 * surrounded by spaces." (https://html.spec.whatwg.org/#the-a-element)
 *
 * The fix depends on intent:
 *   - A link that navigates → add href
 *   - A control that toggles/submits → use <button type="button">
 *     instead of a bare <a onClick>
 */

import { defineRule } from "../../api/plugin.ts";
import {
  describeJsxExpressionIntent,
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttribute,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * `href=""` and `href="#"` are non-navigating placeholders — from a
 * screen-reader and keyboard perspective they are indistinguishable
 * from a missing href. Fragment navigation (`href="#section-id"`) is
 * legitimate and stays silent. Whitespace-only values collapse to the
 * same placeholder shape once trimmed (`" # "` → `"#"`).
 */
function isNonNavigatingHref(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "#";
}

type Intent = "navigation" | "mutation" | "unknown";

export const rule = defineRule({
  id: "navigation/link-no-href",
  satisfies: ["wcag22:2.1.1", "wcag21:2.1.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<a> elements with onClick but missing, empty, or placeholder (#) href are not keyboard-operable and are announced as generic containers. Use <button> instead, or add a real href.",
    rationale:
      "An anchor without an href is a dead link. It's not in the tab order, Enter doesn't activate it, and screen readers announce it as a generic container with no role. The common pattern <a onclick='…'>Click me</a> breaks keyboard and screen-reader users completely.",
    goodExample: `<button type="button" onClick={handleClick}>Toggle menu</button>`,
    badExample: `<a onClick={handleClick}>Toggle menu</a>`,
    normativeQuote: "All functionality of the content is operable through a keyboard interface.",
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://html.spec.whatwg.org/#the-a-element",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const anchor of findHtmlElementsByTag(doc, "a")) {
    // href="" and href="#" (with optional surrounding whitespace) are
    // non-navigating placeholders — indistinguishable from missing href
    // to screen readers and the keyboard tab order. Treat them the same.
    if (
      hasHtmlAttribute(anchor, "href") &&
      !isNonNavigatingHref(getHtmlAttribute(anchor, "href"))
    ) {
      continue;
    }
    if (!hasClickHandlerHtml(anchor)) continue;
    const intent = describeJsxExpressionIntent(getHtmlAttribute(anchor, "onclick"));
    emit(buildViolation(anchor.loc.start, intent));
  }
}

function hasClickHandlerHtml(element: HtmlElement): boolean {
  // HTML attribute names are case-insensitive.
  return hasHtmlAttribute(element, "onclick");
}

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const anchor of findJsxElementsByTag(module, "a")) {
    if (hasJsxAttribute(anchor, "href") && !hasNonNavigatingHrefJsx(anchor)) continue;
    if (!hasClickHandlerJsx(anchor)) continue;
    const intent = describeJsxExpressionIntent(jsxOnClickExpressionText(anchor));
    emit(buildViolation(anchor.loc.start, intent));
  }
}

/**
 * True when the JSX element's `href` is a string-literal equal to `""`
 * or `"#"` (trimmed). Expression-form `href={…}` is opaque — we assume
 * it resolves to real navigation and leave the element alone (the
 * consuming agent can investigate if the expression is suspicious).
 */
function hasNonNavigatingHrefJsx(element: JsxElement): boolean {
  const attr = getJsxAttribute(element, "href");
  if (!attr?.value) return false;
  if (attr.value.kind !== "StringLiteral") return false;
  return isNonNavigatingHref(attr.value.value);
}

function hasClickHandlerJsx(element: JsxElement): boolean {
  // React uses onClick (camelCase). The JSX parser preserves casing.
  return hasJsxAttribute(element, "onClick");
}

/**
 * Returns the raw source of the element's `onClick={…}` expression, or
 * `null` when the attribute is absent, a string-literal, or shorthand.
 * String-literal onClick is syntactically legal but semantically
 * nothing an intent probe can read — return null and let the
 * classifier fall through to "unknown".
 */
function jsxOnClickExpressionText(element: JsxElement): string | null {
  const attr = getJsxAttribute(element, "onClick");
  if (!attr?.value) return null;
  if (attr.value.kind !== "Expression") return null;
  return attr.value.raw;
}

function buildViolation(
  loc: { line: number; column: number },
  intent: Intent,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<a> with a click handler but no href is not keyboard-operable — it's not in the tab order and Enter won't activate it.`,
    suggestion: buildSuggestion(intent),
  };
}

function buildSuggestion(intent: Intent): string {
  if (intent === "navigation") {
    return `<a onClick={...}> appears to perform navigation (keywords: navigate/router/history). Replace with a real <a href="..."> so the browser and assistive tech treat it as a link — if you need to intercept the click, keep the href and use onClick={(e) => { e.preventDefault(); navigate(url); }}.`;
  }
  if (intent === "mutation") {
    return `<a onClick={...}> appears to perform a mutation (keywords: toggle/set/open). Use <button type="button" onClick={...}> instead — anchors convey navigation, buttons convey actions. Style the button to look like a link if the visual treatment matters.`;
  }
  return `<a onClick={...}> has no href — decide the intent: if it navigates, add a real href="..."; if it performs an action, use <button type="button"> instead. Anchors communicate navigation to assistive tech; buttons communicate action.`;
}
