/**
 * State-class predicate path for `color/meaning-by-color-only`.
 *
 * Companion file split out from the main rule under the §11 file-line
 * limit. The predicate fires when an element carries a toggled-state
 * class (`.active`, `.selected`, `.checked`, plus `is-active` /
 * `is-selected` / `is-checked` variants) without a programmatic state
 * channel. See the rule docstring in `meaning-by-color-only.ts` for the
 * full pass-condition list and the doctrine rationale for `severity:
 * warning` paired with the `state_class_may_have_text_or_aria_sibling`
 * `couldBeWrongBecause` code.
 */

import {
  getHtmlAttribute,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlElement, JsxElement } from "../../types/ast.ts";

/**
 * `couldBeWrongBecause` code surfaced on the state-class predicate path.
 * The static rule cannot prove the consumer site lacks a programmatic
 * state channel — an `aria-pressed` set at runtime, a sibling element
 * whose `checked` attribute is the truth source, an icon swap driven by
 * JSX state. The agent reading the consumer site is the correct arbiter;
 * this code marks the uncertainty so the agent's per-finding triage can
 * key on it. Per the AI-first doctrine on "Heuristic emission is the
 * symmetric twin of heuristic suppression": low-confidence evidence
 * lives at `severity: warning` paired with a machine-readable reason.
 */
export const STATE_CLASS_MAY_HAVE_TEXT_OR_ARIA_SIBLING =
  "state_class_may_have_text_or_aria_sibling";

/**
 * Class tokens whose presence on an element signals toggled state. The
 * `is-*` variants ship in BEM / SUIT / Bootstrap-flavored class naming;
 * the bare forms ship across the same plus jQuery-era idioms. Whole-
 * token match (whitespace-delimited).
 */
const STATE_CLASS_TOKENS: ReadonlySet<string> = new Set([
  "active",
  "selected",
  "checked",
  "is-active",
  "is-selected",
  "is-checked",
]);

/**
 * State words that, when present anywhere in the element's visible text
 * as a whole-word match, satisfy the prose-channel pass condition.
 */
const STATE_WORDS: readonly string[] = [
  "active",
  "selected",
  "current",
  "checked",
  "pressed",
  "expanded",
  "collapsed",
];

const STATE_ANYWHERE_RE = new RegExp(`\\b(${STATE_WORDS.join("|")})\\b`, "iu");

/**
 * ARIA state attributes. When any is present, the element supplies a
 * programmatic state channel and the predicate does not fire.
 */
const ARIA_STATE_ATTRS: readonly string[] = [
  "aria-pressed",
  "aria-selected",
  "aria-checked",
  "aria-current",
  "aria-expanded",
];

/**
 * Native HTML state attributes. `<input checked>` / `<option selected>`
 * expose state to AT directly — no aria-* needed.
 */
const NATIVE_STATE_ATTRS: readonly string[] = ["checked", "selected", "disabled"];

/**
 * Returns the first state-class token found in `classValue`, or `null`
 * when none is present. Whole-token match (whitespace-delimited).
 */
export function firstStateToken(classValue: string): string | null {
  for (const t of classValue.split(/\s+/u)) {
    if (STATE_CLASS_TOKENS.has(t)) return t;
  }
  return null;
}

export function textContainsStateWord(text: string): boolean {
  return STATE_ANYWHERE_RE.test(text);
}

/**
 * Predicate-host hooks. The rule file owns the accessible-name / status-
 * role / sr-only / live-region detection (shared with the status-color
 * predicate); the state-class predicate calls those via these hooks.
 */
export interface HtmlPredicateHooks {
  readonly hasAccessibleName: (el: HtmlElement) => boolean;
  readonly hasStatusRole: (el: HtmlElement) => boolean;
  readonly ancestorHasStatusRole: (
    el: HtmlElement,
    parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
  ) => boolean;
  readonly isSrOnlyWithText: (el: HtmlElement) => boolean;
}

export interface JsxPredicateHooks {
  readonly hasAccessibleName: (el: JsxElement) => boolean;
  readonly hasStatusRole: (el: JsxElement) => boolean;
  readonly ancestorHasStatusRole: (
    el: JsxElement,
    parentOf: ReadonlyMap<JsxElement, JsxElement>,
  ) => boolean;
  readonly isSrOnlyWithText: (el: JsxElement) => boolean;
  readonly walkDescendants: (el: JsxElement) => Iterable<JsxElement>;
}

/**
 * True when the element supplies a programmatic state channel: an
 * aria-state attribute, a native HTML state attribute, an accessible
 * name, a text-state word, a status role / live region, or a sr-only
 * descendant carrying state text.
 */
export function htmlHasStateChannel(
  el: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
  hooks: HtmlPredicateHooks,
): boolean {
  if (htmlHasAnyAriaStateAttr(el)) return true;
  if (htmlHasAnyNativeStateAttr(el)) return true;
  if (hooks.hasAccessibleName(el)) return true;
  if (hooks.hasStatusRole(el)) return true;
  if (hooks.ancestorHasStatusRole(el, parentOf)) return true;
  if (textContainsStateWord(htmlTextContent(el))) return true;
  for (const descendant of walkHtmlElements(el)) {
    if (hooks.isSrOnlyWithText(descendant)) return true;
  }
  return false;
}

function htmlHasAnyAriaStateAttr(el: HtmlElement): boolean {
  for (const attr of ARIA_STATE_ATTRS) {
    const v = getHtmlAttribute(el, attr);
    if (v !== null && v.trim().length > 0) return true;
    // Boolean-attribute form (`<button aria-pressed>`) — both shapes
    // count as a programmatic channel.
    if (hasHtmlAttribute(el, attr)) return true;
  }
  return false;
}

function htmlHasAnyNativeStateAttr(el: HtmlElement): boolean {
  for (const attr of NATIVE_STATE_ATTRS) {
    if (hasHtmlAttribute(el, attr)) return true;
  }
  return false;
}

export function jsxHasStateChannel(
  el: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
  hooks: JsxPredicateHooks,
): boolean {
  if (jsxHasAnyAriaStateAttr(el)) return true;
  if (jsxHasAnyNativeStateAttr(el)) return true;
  if (hooks.hasAccessibleName(el)) return true;
  if (hooks.hasStatusRole(el)) return true;
  if (hooks.ancestorHasStatusRole(el, parentOf)) return true;
  if (textContainsStateWord(jsxTextContent(el))) return true;
  for (const descendant of hooks.walkDescendants(el)) {
    if (hooks.isSrOnlyWithText(descendant)) return true;
  }
  return false;
}

function jsxHasAnyAriaStateAttr(el: JsxElement): boolean {
  for (const attr of ARIA_STATE_ATTRS) {
    if (hasJsxAttribute(el, attr)) return true;
  }
  return false;
}

function jsxHasAnyNativeStateAttr(el: JsxElement): boolean {
  for (const attr of NATIVE_STATE_ATTRS) {
    if (hasJsxAttribute(el, attr)) return true;
  }
  return false;
}

export interface Loc {
  readonly line: number;
  readonly column: number;
}

export interface StateClassViolation {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause: readonly string[];
}

export function buildStateClassViolation(
  descriptor: string,
  stateToken: string,
  text: string,
  loc: Loc,
): StateClassViolation {
  const ariaAttr = ariaAttrForStateToken(stateToken);
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: buildStateClassMessage(descriptor, stateToken, ariaAttr, text),
    suggestion: buildStateClassSuggestion(descriptor, stateToken, ariaAttr),
    couldBeWrongBecause: [STATE_CLASS_MAY_HAVE_TEXT_OR_ARIA_SIBLING],
  };
}

/**
 * Maps a state-class token to the ARIA state attribute that would expose
 * the same state programmatically. `.active` → `aria-pressed` (toggle)
 * or `aria-current` (navigation, named in suggestion text); `.selected`
 * → `aria-selected`; `.checked` → `aria-checked`.
 */
function ariaAttrForStateToken(token: string): string {
  const stripped = token.replace(/^is-/, "");
  if (stripped === "selected") return "aria-selected";
  if (stripped === "checked") return "aria-checked";
  // `.active` is ambiguous between toggle (aria-pressed) and navigation
  // (aria-current) — the suggestion names both.
  return "aria-pressed";
}

function buildStateClassMessage(
  descriptor: string,
  stateToken: string,
  ariaAttr: string,
  text: string,
): string {
  const textSample = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `${descriptor} carries the state class "${stateToken}" but exposes no programmatic state channel — no ${ariaAttr} / aria-current / aria-expanded attribute, no native checked/selected attribute, no accessible name, and the visible text "${textSample}" carries no state word. If the class drives only a color difference between this element and its base, sighted full-color users see the state but screen-reader users, colorblind users, and users under color-inverted themes receive no signal that the element is in a different state. Verify the consumer site exposes the state through an aria-* attribute or a non-color visual cue.`;
}

function buildStateClassSuggestion(
  descriptor: string,
  stateToken: string,
  ariaAttr: string,
): string {
  const stripped = stateToken.replace(/^is-/, "");
  return `Expose the "${stripped}" state programmatically on ${descriptor}. Any of: (1) add ${ariaAttr}="true" (or aria-current="page" / aria-current="true" if this is a navigation/wayfinding cue) so assistive tech announces the state; (2) if the class drives only a color shift, add a non-color visual cue in CSS (\`font-weight: 600\`, \`text-decoration: underline\`, \`border-bottom: 2px solid …\`) so the state reaches users who can't perceive color; (3) include the state in the accessible name — \`aria-label="<label> (${stripped})"\` or a \`.visually-hidden\` span carrying " (${stripped})" — so the prose names the state. Pick the channel that matches how the widget exposes its state at runtime.`;
}
