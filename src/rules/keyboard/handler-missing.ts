/**
 * Rule: keyboard/handler-missing
 * Satisfies: wcag22:2.1.1, wcag21:2.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > All functionality of the content is operable through a keyboard
 * > interface without requiring specific timings for individual
 * > keystrokes.
 *
 * Source: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * Flags JSX/HTML elements that declare interactive behavior on a
 * non-interactive element without a keyboard pathway. Two failure
 * grammars are covered:
 *
 * 1. Event-handler grammar — `onclick="…"` in HTML or `onClick={…}`
 *    in JSX on a bare `<div>`/`<span>` with no `onkeydown`/`onkeyup`.
 *    Mouse users can click it; keyboard users can't reach it or
 *    press Enter to activate it.
 * 2. Attribute-interaction grammar — Bootstrap's `data-bs-toggle`,
 *    `data-bs-dismiss`, `data-bs-ride` (and the BS4 `data-toggle` /
 *    `data-dismiss` / `data-ride` predecessors) declare interactive
 *    behavior at the attribute level. Bootstrap's JS wires up the
 *    click handler, but on a bare `<div>`/`<span>` the element is
 *    never focusable and Enter/Space never activate it. Putting
 *    these attributes on a `<button>` or `<a href>` is fine — both
 *    are focusable and keyboard-activate natively.
 *
 * Non-interactive means: any element that isn't a native interactive
 * element (a[href], button, input, select, textarea, summary) and
 * doesn't have role="button" / role="link". `<a>` with any non-null
 * href value — including `href="#"` — is focusable and Enter
 * activates it, so it's exempt from the attribute-interaction check
 * even though the URL is degenerate. `<a>` without href is flagged
 * separately because it is not focusable at all.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";

/** HTML tags that are natively interactive and therefore exempt. */
const NATIVELY_INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

/**
 * Attributes that declare interactive behavior on their host element.
 * Bootstrap 5 uses the `data-bs-*` prefix; Bootstrap 4 and earlier
 * used `data-*` without the `bs-` segment. When any of these appears
 * on a non-interactive host, the host is effectively a button in UX
 * terms but not in accessibility terms — no focus, no Enter/Space.
 *
 * Attributes are lowercased; HTML attribute comparison is already
 * case-insensitive via `getHtmlAttribute`.
 */
const INTERACTIVE_ATTRIBUTES: readonly string[] = [
  "data-bs-toggle",
  "data-bs-dismiss",
  "data-bs-ride",
  "data-toggle",
  "data-dismiss",
  "data-ride",
];

export const rule = defineRule({
  id: "keyboard/handler-missing",
  satisfies: ["wcag22:2.1.1", "wcag21:2.1.1"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Elements that declare click or toggle behavior (onClick, data-bs-toggle, etc.) must be reachable by keyboard: use a native button/link or add tabIndex plus an onKeyDown/onKeyUp that handles Enter and Space.",
    rationale:
      "Mouse users can click anywhere; keyboard users can't. An onClick on a bare <div>, or a Bootstrap-style data-bs-toggle/data-bs-dismiss/data-bs-ride on a <div> or <span>, means the functionality is invisible to people who navigate with the keyboard — blind users, motor-impaired users, and anyone without a mouse. The attribute-based grammar is especially dangerous because the interaction still works for mouse users (Bootstrap's JS listens for click), so the bug is silent during sighted testing. The fix is almost always to host the attribute on a <button> instead.",
    goodExample: `<button type="button" data-bs-toggle="modal" data-bs-target="#my-modal">Open</button>`,
    badExample: `<div data-bs-toggle="modal" data-bs-target="#my-modal">Open</div>`,
    normativeQuote: "All functionality of the content is operable through a keyboard interface.",
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G202",
      "https://www.w3.org/WAI/ARIA/apg/patterns/button/",
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

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const el of walkHtmlElements(doc)) {
    const violation = checkOneHtmlElement(el);
    if (violation) emit(violation);
  }
  for (const anchor of findHtmlElementsByTag(doc, "a")) {
    const violation = checkOneHtmlAnchor(anchor);
    if (violation) emit(violation);
  }
}

function checkOneHtmlElement(el: import("../../types/ast.ts").HtmlElement): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} | null {
  const tag = el.tagName.toLowerCase();
  const hasClick = hasHtmlAttribute(el, "onclick");
  const interactiveAttr = findInteractiveHtmlAttribute(el);
  if (!hasClick && interactiveAttr === null) return null;
  if (isNativelyInteractive(tag)) return null;
  // role="button"/etc. does NOT exempt — see module doc comment.
  if (hasHtmlAttribute(el, "onkeydown") || hasHtmlAttribute(el, "onkeyup")) return null;
  const role = getHtmlAttribute(el, "role") ?? null;
  if (hasClick) {
    return {
      severity: "error",
      location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
      message: `<${el.tagName}> has onclick but no keyboard handler — keyboard users can't activate it.`,
      suggestion: buildSuggestion(el.tagName, role),
    };
  }
  // Attribute-interaction grammar (Bootstrap `data-bs-toggle`, etc.).
  // Unreachable without interactiveAttr being non-null — the early
  // return above guarantees at least one signal is present.
  const attr = interactiveAttr as NonNullable<typeof interactiveAttr>;
  return {
    severity: "error",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: `<${el.tagName}> declares interactive behavior via ${attr.name}="${attr.value}" but is not keyboard-focusable — keyboard users can't reach or activate it.`,
    suggestion: buildAttributeSuggestion(el.tagName, attr.name, attr.value, role),
  };
}

function checkOneHtmlAnchor(anchor: import("../../types/ast.ts").HtmlElement): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} | null {
  // <a> with any href value (including href="#") is focusable and
  // Enter-activates natively; only href-less anchors are a keyboard
  // problem here.
  if (hasHtmlAttribute(anchor, "href")) return null;
  const hasClick = hasHtmlAttribute(anchor, "onclick");
  const interactiveAttr = findInteractiveHtmlAttribute(anchor);
  if (!hasClick && interactiveAttr === null) return null;
  if (hasHtmlAttribute(anchor, "onkeydown") || hasHtmlAttribute(anchor, "onkeyup")) return null;
  if (hasClick) {
    return {
      severity: "error",
      location: { filePath: "", line: anchor.loc.start.line, column: anchor.loc.start.column },
      message: `<a> without href but with onclick is not keyboard-focusable. Add href, change to <button>, or set tabindex.`,
      suggestion:
        'Replace with <button type="button"> if the element triggers an action, or add a real href if it navigates.',
    };
  }
  const attr = interactiveAttr as NonNullable<typeof interactiveAttr>;
  return {
    severity: "error",
    location: { filePath: "", line: anchor.loc.start.line, column: anchor.loc.start.column },
    message: `<a> without href declares interactive behavior via ${attr.name}="${attr.value}" but is not keyboard-focusable.`,
    suggestion: `Add href (even href="#") to make the link focusable, or replace with <button type="button"> — Bootstrap and similar libraries still wire the ${attr.name} handler to either element.`,
  };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    const violation = checkOneJsxElement(el);
    if (violation) emit(violation);
  }
  for (const anchor of findJsxElementsByTag(module, "a")) {
    const violation = checkOneJsxAnchor(anchor);
    if (violation) emit(violation);
  }
}

function checkOneJsxElement(el: import("../../types/ast.ts").JsxElement): {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} | null {
  const hasClick = hasJsxAttribute(el, "onClick");
  const interactiveAttr = findInteractiveJsxAttribute(el);
  if (!hasClick && interactiveAttr === null) return null;
  if (isNativelyInteractive(el.tagName.toLowerCase())) return null;
  if (hasJsxAttribute(el, "onKeyDown") || hasJsxAttribute(el, "onKeyUp")) return null;
  // Backdrop pattern: a div/span with onClick but no text content, no
  // aria-label, no role — this is a click-to-dismiss overlay, not a
  // button. Keyboard dismiss is via Escape on the parent dialog.
  if (hasClick && isBackdropPattern(el)) return null;
  // PascalCase components (ActionButton, IconButton, etc.) are custom
  // components whose internals this rule can't see. Trust them by
  // default — "we can't verify" is not a finding. Users whose codebase
  // has a genuinely broken custom component can surface it by scanning
  // that component's source file, where the issue is on a real DOM
  // element. Registering a wrapper in nativeWrappers is for explicit
  // allow-listing when desired.
  if (isPascalCaseComponent(el.tagName)) return null;
  const role = getJsxAttributeString(el, "role");
  if (hasClick) {
    return {
      severity: "error",
      location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
      message: `<${el.tagName}> has onClick but no keyboard handler — keyboard users can't activate it.`,
      suggestion: buildSuggestion(el.tagName, role),
    };
  }
  const attr = interactiveAttr as NonNullable<typeof interactiveAttr>;
  return {
    severity: "error",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: `<${el.tagName}> declares interactive behavior via ${attr.name}${attr.value === null ? "" : `="${attr.value}"`} but is not keyboard-focusable — keyboard users can't reach or activate it.`,
    suggestion: buildAttributeSuggestion(el.tagName, attr.name, attr.value, role),
  };
}

function checkOneJsxAnchor(anchor: import("../../types/ast.ts").JsxElement): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} | null {
  if (hasJsxAttribute(anchor, "href")) return null;
  const hasClick = hasJsxAttribute(anchor, "onClick");
  const interactiveAttr = findInteractiveJsxAttribute(anchor);
  if (!hasClick && interactiveAttr === null) return null;
  if (hasJsxAttribute(anchor, "onKeyDown") || hasJsxAttribute(anchor, "onKeyUp")) return null;
  if (hasClick) {
    return {
      severity: "error",
      location: { filePath: "", line: anchor.loc.start.line, column: anchor.loc.start.column },
      message: `<a> without href but with onClick is not keyboard-focusable.`,
      suggestion:
        'Replace with <button type="button"> if it triggers an action, or add a real href if it navigates.',
    };
  }
  const attr = interactiveAttr as NonNullable<typeof interactiveAttr>;
  return {
    severity: "error",
    location: { filePath: "", line: anchor.loc.start.line, column: anchor.loc.start.column },
    message: `<a> without href declares interactive behavior via ${attr.name}${attr.value === null ? "" : `="${attr.value}"`} but is not keyboard-focusable.`,
    suggestion: `Add href (even href="#") to make the link focusable, or replace with <button type="button"> — Bootstrap and similar libraries still wire the ${attr.name} handler to either element.`,
  };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function isNativelyInteractive(tagName: string): boolean {
  return NATIVELY_INTERACTIVE_TAGS.has(tagName);
}

function isPascalCaseComponent(tagName: string): boolean {
  const first = tagName[0];
  return first !== undefined && first >= "A" && first <= "Z";
}

/**
 * Detects the modal backdrop pattern: a div with onClick that wraps a
 * dialog element. The onClick is click-to-dismiss on the backdrop
 * overlay — keyboard users close via Escape on the dialog itself.
 * This is a standard ARIA modal pattern, not a keyboard-operability gap.
 */
function isBackdropPattern(el: import("../../types/ast.ts").JsxElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag !== "div" && tag !== "span") return false;
  if (hasJsxAttribute(el, "role")) return false;
  // Check if any child has role="dialog" or role="alertdialog"
  return hasDialogChild(el);
}

function hasDialogChild(el: import("../../types/ast.ts").JsxElement): boolean {
  for (const child of el.children) {
    if (child.kind !== "JsxElement") continue;
    const role = getJsxAttributeString(child, "role");
    if (role === "dialog" || role === "alertdialog") return true;
    if (child.tagName === "dialog") return true;
  }
  return false;
}

function buildSuggestion(tagName: string, role: string | null): string {
  if (role) {
    return `This <${tagName}> has role="${role}" but no keyboard handler. Add onKeyDown/onKeyUp handling Enter and Space keys, and ensure the element has tabIndex={0} so it's focusable.`;
  }
  return `The simplest fix is to change <${tagName}> to <button type="button"> — buttons are focusable, announce as "button" to screen readers, and fire onClick on Enter/Space automatically.`;
}

function buildAttributeSuggestion(
  tagName: string,
  attrName: string,
  attrValue: string | null,
  role: string | null,
): string {
  const valueClause = attrValue === null ? "" : `="${attrValue}"`;
  if (role) {
    return `This <${tagName}> has role="${role}" and ${attrName}${valueClause} but is not keyboard-focusable. Change to <button type="button"> (preserves ${attrName} — the toggle library still wires it) or add tabIndex={0} plus onKeyDown handling Enter and Space.`;
  }
  return `The simplest fix is to change <${tagName}> to <button type="button"> and keep the ${attrName} attribute — Bootstrap and similar libraries wire the toggle/dismiss/ride behavior off the attribute, so the interaction still works and keyboard users get native focus + Enter/Space activation.`;
}

/**
 * Returns the first interactive-behavior attribute on an HTML element,
 * or null if none is present. Uses a case-insensitive lookup.
 */
function findInteractiveHtmlAttribute(
  el: import("../../types/ast.ts").HtmlElement,
): { readonly name: string; readonly value: string | null } | null {
  for (const name of INTERACTIVE_ATTRIBUTES) {
    if (hasHtmlAttribute(el, name)) {
      return { name, value: getHtmlAttribute(el, name) };
    }
  }
  return null;
}

/**
 * Returns the first interactive-behavior attribute on a JSX element,
 * or null if none is present. JSX preserves the original attribute
 * casing — `data-bs-toggle="modal"` in source stays that way in the
 * AST — so the lookup is case-sensitive against the lower-case list.
 */
function findInteractiveJsxAttribute(
  el: import("../../types/ast.ts").JsxElement,
): { readonly name: string; readonly value: string | null } | null {
  for (const name of INTERACTIVE_ATTRIBUTES) {
    if (hasJsxAttribute(el, name)) {
      return { name, value: getJsxAttributeString(el, name) };
    }
  }
  return null;
}
