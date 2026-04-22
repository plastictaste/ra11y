/**
 * Shared CSS-motion helpers. `motion/pause-stop-hide` (WCAG 2.2.2) and
 * `motion/animation-from-interactions` (WCAG 2.3.3) both walk stylesheets
 * looking for `animation`/`transition` declarations, and both honor the
 * `@media (prefers-reduced-motion: reduce)` guard. They differ only in
 * which trigger-shape they care about:
 *
 *   - 2.2.2 targets auto-updating content. Fires when the animation
 *     applies without a user-interaction trigger — e.g. `.spinner`,
 *     `.pulse`, `body > .banner`. The author cannot disable this motion
 *     at the element level, so a `prefers-reduced-motion` guard is the
 *     only honest opt-out.
 *   - 2.3.3 targets animation from interactions (AAA). Fires when the
 *     animation is gated by a user-interaction pseudo-class —
 *     `:hover` / `:focus` / `:active` / `:focus-visible` / `:focus-within`.
 *     The animation runs only when the user points, tabs, or clicks,
 *     which is exactly the shape 2.3.3 calls out.
 *
 * Each emit cites a single SC so agents can route the finding to the
 * correct standard lane without disambiguation.
 *
 * The classification key: every comma-separated selector part must
 * share the same trigger-shape for the rule to fire. A mixed list
 * (`.foo, .foo:hover { transition: … }`) is not purely
 * user-interaction-gated — the bare `.foo` part would run without any
 * interaction — so it routes to 2.2.2, not 2.3.3.
 */

import {
  getHtmlAttribute,
  truncateForEcho,
  walkCssAtRules,
  walkCssRules,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import { parseCss } from "../../input/parsers/css.ts";
import type {
  CssAtRule,
  CssRule,
  CssStylesheet,
  HtmlDocument,
  HtmlElement,
  HtmlText,
} from "../../types/ast.ts";

export const ANIMATION_PROPERTIES: ReadonlySet<string> = new Set([
  "animation",
  "animation-name",
  "animation-duration",
  "transition",
  "transition-property",
  "transition-duration",
]);

/**
 * Pseudo-classes that only match when the user is actively interacting
 * with the element. Animation/transition gated by any of these only
 * runs in response to pointer/keyboard input, which is the trigger
 * shape WCAG 2.3.3 targets.
 *
 * `:focus-visible` and `:focus-within` are included because keyboard
 * focus is a user interaction (matching the SC's framing "motion
 * animation triggered by interaction"). `:target` is excluded — it
 * tracks the URL fragment, which is navigation state the user doesn't
 * hover/focus their way into.
 */
export const USER_INTERACTION_PSEUDO_CLASSES: readonly string[] = [
  ":hover",
  ":focus",
  ":active",
  ":focus-visible",
  ":focus-within",
];

export type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

export interface PositionOffset {
  readonly lineOffset: number;
  readonly colOffset: number;
}

/**
 * True if every comma-separated part of the selector contains at least
 * one user-interaction pseudo-class. A mixed list (some parts
 * interaction-gated, some not) returns false — the non-gated parts
 * would animate without user input, which belongs to the 2.2.2 lane.
 */
export function isUserInteractionGatedSelector(selector: string): boolean {
  const parts = splitSelectorList(selector);
  if (parts.length === 0) return false;
  return parts.every(containsUserInteractionPseudoClass);
}

/**
 * True if at least one comma-separated selector part carries a
 * user-interaction pseudo-class. Used by the 2.2.2 lane as the negative
 * half of `isUserInteractionGatedSelector` — a mixed list (`.a, .a:hover`)
 * is still a 2.2.2 finding, because `.a` alone animates without
 * interaction.
 *
 * Semantically: `isUserInteractionGatedSelector === true` is the strict
 * 2.3.3 criterion; its negation is the 2.2.2 domain.
 */
export function anyPartHasUserInteractionPseudoClass(selector: string): boolean {
  const parts = splitSelectorList(selector);
  return parts.some(containsUserInteractionPseudoClass);
}

function splitSelectorList(selector: string): readonly string[] {
  return selector
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function containsUserInteractionPseudoClass(part: string): boolean {
  const lower = part.toLowerCase();
  for (const pc of USER_INTERACTION_PSEUDO_CLASSES) {
    if (!lower.includes(pc)) continue;
    // Guard against accidental substring matches — `:focus` must not
    // match `:focus-visible` when scanning for `:focus` specifically,
    // and `:active` must not match a hypothetical `:active-link`. We
    // check the character immediately following the match to make sure
    // it's not an identifier continuation.
    // Identifier continuation rules out a real pseudo-class boundary.
    // Acceptable terminators: end-of-string, `,`, space, `>`, `+`, `~`,
    // `(`, `:`, `)`, `[`, `.`, `#`, `*`, `{`. Note: `-` after `:focus`
    // is allowed only when it's followed by a recognized suffix — we
    // handle that by listing `:focus-visible` and `:focus-within` in
    // USER_INTERACTION_PSEUDO_CLASSES and checking them first via the
    // outer loop.
    let searchFrom = 0;
    while (searchFrom <= lower.length) {
      const hit = lower.indexOf(pc, searchFrom);
      if (hit === -1) break;
      const next = lower.charAt(hit + pc.length);
      if (next === "" || !/[a-z0-9_-]/.test(next)) return true;
      searchFrom = hit + pc.length;
    }
  }
  return false;
}

/**
 * Collects all CssRule nodes that are nested inside a
 * `@media (prefers-reduced-motion: …)` at-rule.
 */
export function collectReducedMotionRules(stylesheet: CssStylesheet): ReadonlySet<CssRule> {
  const guarded = new Set<CssRule>();
  for (const atRule of walkCssAtRules(stylesheet)) {
    if (!isReducedMotionQuery(atRule)) continue;
    for (const child of walkAtRuleChildren(atRule)) {
      guarded.add(child);
    }
  }
  return guarded;
}

function isReducedMotionQuery(atRule: CssAtRule): boolean {
  if (atRule.name.toLowerCase() !== "media") return false;
  return /prefers-reduced-motion/i.test(atRule.params);
}

/**
 * Recognizes the canonical universal override:
 *   @media (prefers-reduced-motion: reduce) {
 *     *, *::before, *::after {
 *       animation-duration: 0.01ms !important;
 *       transition-duration: 0.01ms !important;
 *     }
 *   }
 * When this pattern is present, every selector in the stylesheet is
 * covered — both 2.2.2 and 2.3.3 rules should bail out.
 */
export function hasUniversalReducedMotionOverride(guardedRules: ReadonlySet<CssRule>): boolean {
  for (const rule of guardedRules) {
    if (!isUniversalSelector(rule.selector)) continue;
    if (disablesAnimationOrTransition(rule)) return true;
  }
  return false;
}

const UNIVERSAL_PARTS: ReadonlySet<string> = new Set([
  "*",
  "*::before",
  "*::after",
  "*::backdrop",
  "*:root",
  "::before",
  "::after",
  "::backdrop",
  ":before",
  ":after",
]);

function isUniversalSelector(selector: string): boolean {
  const parts = splitSelectorList(selector);
  if (parts.length === 0) return false;
  return parts.every((p) => UNIVERSAL_PARTS.has(p));
}

function disablesAnimationOrTransition(rule: CssRule): boolean {
  for (const decl of rule.declarations) {
    const prop = decl.property.toLowerCase();
    if (!ANIMATION_PROPERTIES.has(prop)) continue;
    if (isNoneValue(decl.value) || isNearZeroDuration(decl.value)) return true;
  }
  return false;
}

/**
 * Accepts any value that disables animation for practical purposes:
 * 0, 0s, 0ms, .01ms, 0.01ms, etc. The `!important` suffix is tolerated.
 */
export function isNearZeroDuration(value: string): boolean {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important\s*$/, "")
    .trim();
  if (clean === "0") return true;
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(clean);
  if (!match) return false;
  const n = Number.parseFloat(match[1] ?? "0");
  return match[2] === "ms" ? n < 1 : n < 0.001;
}

export function isNoneValue(value: string): boolean {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important\s*$/, "")
    .trim();
  return trimmed === "none" || trimmed === "0s" || trimmed === "0ms" || trimmed === "0";
}

export function* walkAtRuleChildren(atRule: CssAtRule): Iterable<CssRule> {
  for (const child of atRule.children) {
    if (child.kind === "CssRule") {
      yield child;
    } else if (child.kind === "CssAtRule") {
      yield* walkAtRuleChildren(child);
    }
  }
}

/**
 * Runs the common animation-walk and calls back with each offending
 * (rule, declaration) pair the caller should consider. Skips
 * reduced-motion-guarded rules and universal-override stylesheets
 * upfront. Returns `null` when the universal override is present (no
 * per-rule walk needed); otherwise returns the set of guarded rules
 * callers must skip.
 */
export function* walkCandidateRules(
  stylesheet: CssStylesheet,
): Iterable<{ rule: CssRule; decl: CssRule["declarations"][number] }> {
  const guardedRules = collectReducedMotionRules(stylesheet);
  if (hasUniversalReducedMotionOverride(guardedRules)) return;
  for (const cssRule of walkCssRules(stylesheet)) {
    if (guardedRules.has(cssRule)) continue;
    for (const decl of cssRule.declarations) {
      if (!ANIMATION_PROPERTIES.has(decl.property.toLowerCase())) continue;
      if (isNoneValue(decl.value)) continue;
      yield { rule: cssRule, decl };
      // One violation per rule — don't flag both animation and
      // animation-duration on the same selector.
      break;
    }
  }
}

export interface StyleBlockEmitParams {
  readonly doc: HtmlDocument;
  readonly emit: Emit;
  readonly onStylesheet: (stylesheet: CssStylesheet, emit: Emit, offset: PositionOffset) => void;
}

/**
 * Parses every `<style>` element's text content as CSS and invokes
 * `onStylesheet` with the right line/column offset so findings point
 * back into the HTML source.
 */
export function forEachStyleBlock(params: StyleBlockEmitParams): void {
  for (const styleEl of walkHtmlElements(params.doc)) {
    if (styleEl.tagName.toLowerCase() !== "style") continue;
    const textNode = firstTextChild(styleEl);
    if (!textNode) continue;
    if (textNode.value.trim().length === 0) continue;
    const parsed = parseCss(textNode.value);
    const offset: PositionOffset = {
      lineOffset: textNode.loc.start.line - 1,
      colOffset: textNode.loc.start.column - 1,
    };
    params.onStylesheet(parsed.root, params.emit, offset);
  }
}

function firstTextChild(element: HtmlElement): HtmlText | null {
  for (const child of element.children) {
    if (child.kind === "HtmlText") return child;
  }
  return null;
}

export { getHtmlAttribute, truncateForEcho };
