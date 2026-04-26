/**
 * Rule: focus/not-obscured
 * Satisfies: wcag22:2.4.11
 * Spec: https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum
 *
 * > When a user interface component receives keyboard focus, the
 * > component is not entirely hidden due to author-created content.
 *
 * Source: https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum
 *
 * SC 2.4.11 (new in WCAG 2.2, AA) requires that a focused element is
 * not *entirely* obscured by author content. The most common failure
 * pattern in modern web apps is a sticky/fixed header (or footer) that
 * covers a focused element after the browser scrolls it into view: the
 * browser scrolls just enough to make the element pip into the
 * viewport, but the sticky bar sits on top of it, hiding it completely.
 *
 * The browser-native fix is `scroll-padding-top` / `scroll-padding-bottom`
 * (or the `scroll-padding` shorthand) on the scroll container — usually
 * `html`, `:root`, or `body`. With scroll-padding set, the browser keeps
 * the focused element clear of the reserved space.
 *
 * Perfect detection requires runtime layout. This rule statically flags
 * the high-signal pattern: a CSS rule declares `position: fixed` or
 * `position: sticky` with a `top` / `bottom` offset anchoring it to the
 * viewport edge AND the stylesheet sets no corresponding non-zero
 * `scroll-padding-top` / `scroll-padding-bottom` on `html`, `:root`,
 * `body`, or `*`. Tiny affordances (both width AND height ≤ 48px) are
 * skipped — they're typically icon buttons, not full-width bars.
 *
 * v0.0.x coverage: in-file CSS rules only. Cross-file scroll-padding
 * (e.g. a global reset stylesheet) is not yet traced.
 */

import { defineRule } from "../../api/plugin.ts";
import { findCssDeclaration, walkCssRules } from "../../engine/ast-helpers.ts";
import type { CssRule, CssStylesheet } from "../../types/ast.ts";

/** Selectors that we accept as "the scroll container" for scroll-padding. */
const SCROLL_CONTAINER_SELECTORS: ReadonlySet<string> = new Set([
  "html",
  "body",
  ":root",
  "*",
  "html, body",
  "body, html",
]);

/**
 * A candidate element is skipped if BOTH width and height are this size
 * or smaller. Picks up icon-sized affordances (a 40px floating chat
 * button) that cannot plausibly hide an entire focused element.
 */
const TINY_AFFORDANCE_PX = 48;

/**
 * Matches a modal-family class token within a selector — `.modal`,
 * `.modal-backdrop`, `.modal-dialog`, `.modal-content`, `.modal_header`,
 * etc. Modal/dialog/backdrop elements default to `display: none` until
 * shown by script (Bootstrap, common admin frameworks, …), so a
 * sticky/fixed declaration on one of these classes is conditional, not
 * persistent chrome — the rule below uses additional signals (display:none
 * on the same rule, `:not(.show)` qualifier, sibling `.modal.show` rule)
 * to confirm and skip.
 */
const MODAL_CLASS_RE = /\.(modal(?:[-_][a-z0-9-]+)?)\b/gi;

/**
 * Selector qualifiers that indicate the rule applies to the modal in its
 * default-hidden state (e.g. `.modal:not(.show)`). Their presence means
 * the rule is explicitly scoped to "the modal when it is NOT visible," so
 * the sticky/fixed positioning isn't author-created persistent chrome.
 */
const HIDDEN_STATE_QUALIFIER_RE =
  /:not\(\s*(?:\.(?:show|in|active|is-open|visible|open)|\[open\])\s*\)/i;

/**
 * Selector qualifiers that mark the *visible* state of a modal (e.g.
 * `.modal.show`, `.modal[open]`). When a sibling rule in the same
 * stylesheet uses one of these on the same modal class, the unqualified
 * rule on that class is the default-hidden state and should be skipped.
 */
const VISIBLE_STATE_QUALIFIER_RE = /(?:\.(?:show|in|active|is-open|visible|open)\b|\[open\])/i;

export const rule = defineRule({
  id: "focus/not-obscured",
  satisfies: ["wcag22:2.4.11"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".css"],
  },
  docs: {
    description:
      "Sticky or fixed-position headers and footers must be paired with `scroll-padding-top` / `scroll-padding-bottom` on the scroll container so focused elements scrolled into view are not entirely hidden underneath them.",
    rationale:
      "WCAG 2.2 SC 2.4.11 requires that a focused component is not entirely hidden by author content. A sticky header is the most common cause: the browser scrolls a focused element to the top of the viewport, but the sticky bar covers it. Setting `scroll-padding-top` on `html` (or `body`) reserves space so the focused element stays visible.",
    goodExample: `html { scroll-padding-top: 64px; }\n.site-header { position: sticky; top: 0; height: 64px; }`,
    badExample: `.site-header { position: sticky; top: 0; height: 64px; }\n/* no scroll-padding on html/body */`,
    normativeQuote:
      "When a user interface component receives keyboard focus, the component is not entirely hidden due to author-created content.",
    references: [
      "https://www.w3.org/TR/WCAG22/#focus-not-obscured-minimum",
      "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html",
      "https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-padding",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    const stylesheet = ctx.ast as CssStylesheet;
    checkStylesheet(stylesheet, (v) => ctx.emit(v));
  },
});

type Severity = "error" | "warning" | "info";
type Emit = (v: {
  severity: Severity;
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

interface ScrollPadding {
  /** Non-zero scroll-padding-top found anywhere on a container selector. */
  readonly top: boolean;
  /** Non-zero scroll-padding-bottom found anywhere on a container selector. */
  readonly bottom: boolean;
}

interface AnchorCandidate {
  readonly cssRule: CssRule;
  /** Which viewport edge the element is anchored to. */
  readonly side: "top" | "bottom";
  /** Declared height if any (raw value, e.g. "64px"). */
  readonly height: string | null;
  /** Whether the element is plausibly an icon-sized affordance. */
  readonly tiny: boolean;
}

function checkStylesheet(stylesheet: CssStylesheet, emit: Emit): void {
  const padding = collectScrollPadding(stylesheet);
  const visibleStateModalClasses = collectVisibleStateModalClasses(stylesheet);
  for (const candidate of collectAnchorCandidates(stylesheet)) {
    if (candidate.tiny) continue;
    if (candidate.side === "top" && padding.top) continue;
    if (candidate.side === "bottom" && padding.bottom) continue;
    if (isConditionalModalRule(candidate.cssRule, visibleStateModalClasses)) continue;
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: candidate.cssRule.loc.start.line,
        column: candidate.cssRule.loc.start.column,
      },
      message: buildMessage(candidate),
      suggestion: buildSuggestion(candidate),
    });
  }
}

/**
 * Decides whether a candidate rule is the default-hidden state of a modal
 * dialog and should not be treated as persistent author-created chrome.
 *
 * Three independent signals each suffice (any one means "skip"):
 *   1. The rule declares `display: none` (the modal is hidden by default).
 *   2. The selector itself contains a `:not(.show)` / `:not([open])` / etc.
 *      qualifier that scopes the rule to the hidden state.
 *   3. A sibling rule elsewhere in the same stylesheet targets the same
 *      modal class together with a visibility-state qualifier
 *      (`.modal.show`, `.modal[open]`, `.modal.in`, …) — that's the
 *      "shown" state, which means the unqualified rule is the "hidden"
 *      default that this sibling overrides.
 *
 * If the selector doesn't reference a modal class at all, this check
 * returns false and the candidate is reported normally.
 */
function isConditionalModalRule(
  cssRule: CssRule,
  visibleStateModalClasses: ReadonlySet<string>,
): boolean {
  const modalClasses = extractModalClasses(cssRule.selector);
  if (modalClasses.length === 0) return false;

  // Signal 1: explicit `display: none` on this rule.
  const displayDecl = findCssDeclaration(cssRule, "display");
  if (displayDecl && displayDecl.value.trim().toLowerCase() === "none") return true;

  // Signal 2: selector qualifier limits this rule to the hidden state.
  if (HIDDEN_STATE_QUALIFIER_RE.test(cssRule.selector)) return true;

  // Signal 3: a sibling rule provides the visible state for one of these
  // modal classes — that confirms the unqualified rule here is the hidden
  // default.
  for (const cls of modalClasses) {
    if (visibleStateModalClasses.has(cls)) return true;
  }
  return false;
}

/**
 * Returns the lowercased modal class tokens (without leading `.`) referenced
 * by a selector. `.modal` → `["modal"]`, `.modal-backdrop` → `["modal-backdrop"]`,
 * `.modal.show` → `["modal"]`. Non-modal classes are ignored.
 */
function extractModalClasses(selector: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Reset the global regex's lastIndex so repeated calls don't skip matches.
  MODAL_CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null = MODAL_CLASS_RE.exec(selector);
  while (match !== null) {
    const cls = match[1]?.toLowerCase();
    if (cls && !seen.has(cls)) {
      seen.add(cls);
      out.push(cls);
    }
    match = MODAL_CLASS_RE.exec(selector);
  }
  return out;
}

/**
 * Walks the stylesheet and collects every modal class that appears in a
 * selector alongside a visibility-state qualifier — `.modal.show`,
 * `.modal[open]`, `.modal-dialog.in`, etc. The presence of such a sibling
 * rule means the same modal class is being toggled on and off, so any
 * unqualified rule on that class is the default-hidden state.
 */
function collectVisibleStateModalClasses(stylesheet: CssStylesheet): ReadonlySet<string> {
  const classes = new Set<string>();
  for (const cssRule of walkCssRules(stylesheet)) {
    if (!VISIBLE_STATE_QUALIFIER_RE.test(cssRule.selector)) continue;
    for (const cls of extractModalClasses(cssRule.selector)) {
      classes.add(cls);
    }
  }
  return classes;
}

/** Walks the stylesheet and records non-zero scroll-padding on container selectors. */
function collectScrollPadding(stylesheet: CssStylesheet): ScrollPadding {
  let top = false;
  let bottom = false;
  for (const cssRule of walkCssRules(stylesheet)) {
    if (!isScrollContainerSelector(cssRule.selector)) continue;
    const sides = scrollPaddingSidesFromRule(cssRule);
    if (sides.top) top = true;
    if (sides.bottom) bottom = true;
  }
  return { top, bottom };
}

/** Inspects a single rule and reports which scroll-padding sides it sets non-zero. */
function scrollPaddingSidesFromRule(cssRule: CssRule): { top: boolean; bottom: boolean } {
  let top = false;
  let bottom = false;
  for (const decl of cssRule.declarations) {
    const sides = scrollPaddingSidesFromDecl(decl.property, decl.value);
    if (sides.top) top = true;
    if (sides.bottom) bottom = true;
  }
  return { top, bottom };
}

/** Returns which sides a single scroll-padding* declaration sets non-zero. */
function scrollPaddingSidesFromDecl(
  property: string,
  value: string,
): { top: boolean; bottom: boolean } {
  const prop = property.toLowerCase();
  const trimmed = value.trim();
  if (prop === "scroll-padding-top") {
    return { top: isNonZeroLength(trimmed), bottom: false };
  }
  if (prop === "scroll-padding-bottom") {
    return { top: false, bottom: isNonZeroLength(trimmed) };
  }
  if (prop === "scroll-padding" || prop === "scroll-padding-block") {
    return parseShorthandSides(trimmed);
  }
  return { top: false, bottom: false };
}

/** True if a selector targets a documented scroll container. */
function isScrollContainerSelector(selector: string): boolean {
  const normalized = selector.trim().toLowerCase().replace(/\s+/g, " ");
  if (SCROLL_CONTAINER_SELECTORS.has(normalized)) return true;
  // Selector lists like "html, body, :root" — accept if every segment is a container.
  if (normalized.includes(",")) {
    const segments = normalized.split(",").map((s) => s.trim());
    if (segments.every((s) => SCROLL_CONTAINER_SELECTORS.has(s))) return true;
  }
  return false;
}

/** True for length values that aren't zero. Accepts "0", "0px", "0rem", "0em", etc. */
function isNonZeroLength(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" || trimmed === "0") return false;
  if (/^0(?:\.0+)?(?:px|rem|em|vh|vw|%|pt|cm|mm|in)?$/.test(trimmed)) return false;
  return true;
}

/**
 * Parses the top/bottom components of the `scroll-padding` shorthand.
 * Per CSS spec the shorthand follows the same 1-4 value pattern as
 * `padding`: 1=all, 2=v/h, 3=top/h/bottom, 4=top/right/bottom/left.
 * `scroll-padding-block` takes 1 or 2 values (top, bottom) — we treat
 * a single value as covering both.
 */
function parseShorthandSides(value: string): { top: boolean; bottom: boolean } {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 0) return { top: false, bottom: false };
  const first = parts[0] ?? "";
  if (parts.length === 1) {
    const nz = isNonZeroLength(first);
    return { top: nz, bottom: nz };
  }
  if (parts.length === 2) {
    const nz = isNonZeroLength(first);
    return { top: nz, bottom: nz };
  }
  // 3 or 4 values: top is parts[0], bottom is parts[2].
  const third = parts[2] ?? "";
  return { top: isNonZeroLength(first), bottom: isNonZeroLength(third) };
}

/** Walks the stylesheet and records each rule that anchors something to a viewport edge. */
function collectAnchorCandidates(stylesheet: CssStylesheet): readonly AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  for (const cssRule of walkCssRules(stylesheet)) {
    const candidate = classifyRule(cssRule);
    if (candidate) out.push(candidate);
  }
  return out;
}

/** Decides whether a rule plausibly creates a viewport-anchored sticky/fixed bar. */
function classifyRule(cssRule: CssRule): AnchorCandidate | null {
  const positionDecl = findCssDeclaration(cssRule, "position");
  if (!positionDecl) return null;
  const position = positionDecl.value.trim().toLowerCase();
  if (position !== "fixed" && position !== "sticky") return null;

  const topDecl = findCssDeclaration(cssRule, "top");
  const bottomDecl = findCssDeclaration(cssRule, "bottom");
  const anchoredTop = topDecl !== undefined && isAnchorOffset(topDecl.value);
  const anchoredBottom = bottomDecl !== undefined && isAnchorOffset(bottomDecl.value);
  if (!(anchoredTop || anchoredBottom)) return null;
  // If both are set (rare on a bar — usually means the element fills the viewport),
  // prefer top as the side users scroll under.
  const side: "top" | "bottom" = anchoredTop ? "top" : "bottom";

  const heightDecl = findCssDeclaration(cssRule, "height");
  const widthDecl = findCssDeclaration(cssRule, "width");
  const height = heightDecl?.value.trim() ?? null;
  const tiny = isTinyAffordance(widthDecl?.value ?? null, height);
  return { cssRule, side, height, tiny };
}

/** True for offset values that pin to the viewport edge: 0, 0px, 0%, 0rem, etc. */
function isAnchorOffset(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "0" || /^0(?:\.0+)?(?:px|rem|em|vh|vw|%|pt|cm|mm|in)$/.test(trimmed)) return true;
  return false;
}

/**
 * Heuristic: skip elements whose declared width AND height are both ≤ 48px.
 * Such elements (chat bubbles, scroll-to-top buttons) cannot plausibly
 * hide an entire focused row of content.
 */
function isTinyAffordance(width: string | null, height: string | null): boolean {
  const w = parsePxValue(width);
  const h = parsePxValue(height);
  if (w === null || h === null) return false;
  return w <= TINY_AFFORDANCE_PX && h <= TINY_AFFORDANCE_PX;
}

/** Parses a length like "40px" / "2.5rem" into a px-equivalent number. Returns null otherwise. */
function parsePxValue(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  const pxMatch = trimmed.match(/^(\d+(?:\.\d+)?)px$/);
  if (pxMatch?.[1]) return Number.parseFloat(pxMatch[1]);
  const remMatch = trimmed.match(/^(\d+(?:\.\d+)?)rem$/);
  // Assume the conventional 16px root font-size for the heuristic.
  if (remMatch?.[1]) return Number.parseFloat(remMatch[1]) * 16;
  const emMatch = trimmed.match(/^(\d+(?:\.\d+)?)em$/);
  if (emMatch?.[1]) return Number.parseFloat(emMatch[1]) * 16;
  return null;
}

function buildMessage(c: AnchorCandidate): string {
  const heightFragment = c.height ? ` with height ${c.height}` : "";
  const property = c.side === "top" ? "scroll-padding-top" : "scroll-padding-bottom";
  return `'${c.cssRule.selector}' is positioned at the viewport ${c.side}${heightFragment} but no '${property}' is set on 'html', ':root', or 'body' — focused elements scrolled into view can be entirely hidden underneath it (WCAG 2.2 SC 2.4.11).`;
}

function buildSuggestion(c: AnchorCandidate): string {
  const property = c.side === "top" ? "scroll-padding-top" : "scroll-padding-bottom";
  const measurement = c.height ?? (c.side === "top" ? "64px" : "80px");
  const measureNote = c.height
    ? ""
    : " (use the actual rendered height of the bar — 64px is a common header height)";
  return `Add \`html { ${property}: ${measurement}; }\` so the browser reserves space when scrolling focused elements into view${measureNote}. The value should match (or slightly exceed) the rendered height of '${c.cssRule.selector}'. \`scroll-padding\` shorthand or a value on \`:root\` / \`body\` also works.`;
}
