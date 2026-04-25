/**
 * Rule: keyboard/anchor-button-not-focusable
 * Satisfies: wcag22:2.1.1, wcag21:2.1.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > 2.1.1 Keyboard: All functionality of the content is operable through a
 * > keyboard interface without requiring specific timings for individual
 * > keystrokes.
 *
 * > 4.1.2 Name, Role, Value: For all user interface components, the name and
 * > role can be programmatically determined; states, properties, and values
 * > that can be set by the user can be programmatically set.
 *
 * Source: https://www.w3.org/TR/WCAG22/#keyboard
 *         https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * Flags `<a>` elements that announce as buttons (either via
 * `role="button"` or a class-name token in the `btn` / `button` family)
 * but are not keyboard-focusable: an anchor without `href` is not in
 * the tab order, and without `tabindex="0"` (or any positive integer)
 * the keyboard cannot reach it. The visible text and the announced
 * role both promise an interactive button; only mouse/touch users can
 * activate it.
 *
 * Predicate (all must hold):
 *   1. element is `<a>`
 *   2. announces as a button — `role="button"` OR class attribute
 *      contains a `btn` / `button` token (whitespace-separated, or
 *      hyphen-/underscore-prefixed: `btn`, `btn-primary`, `button_lg`)
 *   3. no `href` attribute (any value, even `href="#"`, makes the
 *      anchor focusable — covered by other rules if degenerate)
 *   4. no `tabindex` with value `"0"` or a positive integer
 *
 * The conjunction is high-confidence per the AI-first doctrine: each
 * branch independently rules out the obvious focus pathways. Surface
 * honestly with a fix that walks the agent through both options
 * (add `tabindex="0"` and a keyboard handler, or migrate to
 * `<button type="button">`).
 *
 * SC mapping rationale:
 *   - 2.1.1 — keyboard users cannot reach the control at all (no
 *     focus, no activation).
 *   - 4.1.2 — the announced role ("button") is dishonest: the
 *     programmatic role promises a UI component the user can set, but
 *     no states/values can be set because the control isn't focusable.
 */
import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Matches a class-name token in the `btn` / `button` family. Tokens may
 * be:
 *   - bare (`btn`, `button`)
 *   - prefix of a BEM-ish modifier separated by `-` or `_`
 *     (`btn-primary`, `button_lg`)
 * Case-insensitive (Bootstrap, Tailwind, Bulma, Foundation, custom
 * design systems all converge on lowercase, but defensively case-fold).
 *
 * Tokens like `btnX` (no separator) are intentionally NOT matched —
 * they're typically utility-class prefixes (e.g. `btnGroup`,
 * `buttonbar`) where the host class doesn't promise button semantics.
 */
const BUTTON_CLASS_TOKEN = /^(btn|button)([-_]|$)/i;

export const rule = defineRule({
  id: "keyboard/anchor-button-not-focusable",
  satisfies: ["wcag22:2.1.1", "wcag21:2.1.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'An <a> announced as a button (role="button" or btn/button class token) must be keyboard-reachable: add href, tabindex="0", or change to <button>.',
    rationale:
      'An anchor with role="button" or a btn/button class promises a clickable control to both screen readers and sighted users. Without href or tabindex="0", the element is invisible to the tab order — keyboard users cannot reach it, let alone activate it. Mouse/touch users see and use the control normally, so the bug is silent during sighted testing. SC 2.1.1 is broken because the functionality is not keyboard-operable; SC 4.1.2 is broken because the programmatic role ("button") doesn\'t match the actual operable state (no focus, no activation). The fix is almost always to change the element to <button type="button"> — buttons are focusable, announce as "button", and fire click on Enter/Space natively.',
    goodExample: `<a class="btn" href="/orders">View orders</a>`,
    badExample: `<a class="btn">Click me</a>`,
    normativeQuote:
      "All functionality of the content is operable through a keyboard interface. ... For all user interface components, the name and role can be programmatically determined; states, properties, and values that can be set by the user can be programmatically set.",
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
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
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const anchor of findHtmlElementsByTag(doc, "a")) {
    if (hasHtmlAttribute(anchor, "href")) continue;
    const trigger = announcesAsButtonHtml(anchor);
    if (!trigger) continue;
    if (hasFocusableTabindexHtml(anchor)) continue;
    emit({
      severity: "error",
      location: { filePath: "", line: anchor.loc.start.line, column: anchor.loc.start.column },
      message: buildMessage(trigger),
      suggestion: buildSuggestion(trigger),
    });
  }
}

interface ButtonTrigger {
  readonly source: "role" | "class";
  readonly evidence: string;
}

function announcesAsButtonHtml(el: HtmlElement): ButtonTrigger | null {
  const role = getHtmlAttribute(el, "role");
  if (role !== null && role.toLowerCase() === "button") {
    return { source: "role", evidence: 'role="button"' };
  }
  const className = getHtmlAttribute(el, "class");
  const token = matchesButtonClassToken(className);
  if (token) {
    return { source: "class", evidence: `class token "${token}"` };
  }
  return null;
}

function hasFocusableTabindexHtml(el: HtmlElement): boolean {
  const tabindex = getHtmlAttribute(el, "tabindex");
  return isFocusableTabindexValue(tabindex);
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const anchor of findJsxElementsByTag(module, "a")) {
    if (hasJsxAttribute(anchor, "href")) continue;
    const trigger = announcesAsButtonJsx(anchor);
    if (!trigger) continue;
    if (hasFocusableTabindexJsx(anchor)) continue;
    emit({
      severity: "error",
      location: { filePath: "", line: anchor.loc.start.line, column: anchor.loc.start.column },
      message: buildMessage(trigger),
      suggestion: buildSuggestion(trigger),
    });
  }
}

function announcesAsButtonJsx(el: JsxElement): ButtonTrigger | null {
  const role = getJsxAttributeString(el, "role");
  if (role !== null && role.toLowerCase() === "button") {
    return { source: "role", evidence: 'role="button"' };
  }
  const className = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  const token = matchesButtonClassToken(className);
  if (token) {
    return { source: "class", evidence: `class token "${token}"` };
  }
  return null;
}

function hasFocusableTabindexJsx(el: JsxElement): boolean {
  const tabindex = getJsxAttributeString(el, "tabIndex") ?? getJsxAttributeString(el, "tabindex");
  return isFocusableTabindexValue(tabindex);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Returns the matching token (e.g. `"btn"`, `"btn-primary"`) when the
 * className contains a `btn`/`button` family token, else null. Splits
 * on whitespace per HTML spec; case-insensitive comparison.
 */
function matchesButtonClassToken(className: string | null): string | null {
  if (!className) return null;
  for (const raw of className.split(/\s+/)) {
    const token = raw.trim();
    if (token.length === 0) continue;
    if (BUTTON_CLASS_TOKEN.test(token)) return token;
  }
  return null;
}

/**
 * True when the `tabindex` attribute makes the element keyboard-focusable.
 * `"0"` and any positive integer (`"1"`, `"42"`) put the element into
 * the tab order. Negative values (`"-1"`) make the element
 * programmatically focusable but NOT in the tab order — keyboard users
 * still can't reach it via Tab, so we treat negative tabindex as
 * non-focusable for the SC 2.1.1 perspective.
 */
function isFocusableTabindexValue(value: string | null): boolean {
  if (value === null) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (!/^-?\d+$/.test(trimmed)) return false;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0;
}

function buildMessage(trigger: ButtonTrigger): string {
  return `<a> announces as a button (${trigger.evidence}) but has no href and no tabindex="0" — keyboard users cannot reach or activate it.`;
}

function buildSuggestion(trigger: ButtonTrigger): string {
  const evidence = trigger.evidence;
  if (trigger.source === "role") {
    return (
      `This <a> has ${evidence} but no href, so it is not in the tab order. ` +
      `Best fix: replace with <button type="button"> — buttons are focusable, ` +
      `announce as "button", and fire click on Enter/Space natively (the role ` +
      `attribute then becomes redundant). ` +
      `If the element must stay an <a>, add tabindex="0" plus an onkeydown/onkeyup ` +
      `handler that activates the same action Enter/Space would on a real button.`
    );
  }
  return (
    `This <a> carries the ${evidence} class which announces it as a button to ` +
    `users, but it has no href and no tabindex="0", so keyboard users cannot reach it. ` +
    `Best fix: replace with <button type="button"> and keep the same class — buttons ` +
    `are focusable, announce as "button", and fire click on Enter/Space natively. ` +
    `If the element must stay an <a> (e.g. a styled link rendered as a button), ` +
    `add href if it navigates, or add tabindex="0" plus an onkeydown handler if ` +
    `it triggers an action.`
  );
}
