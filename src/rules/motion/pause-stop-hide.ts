/**
 * Rule: motion/pause-stop-hide
 * Satisfies: wcag22:2.2.2, wcag21:2.2.2
 * Spec: https://www.w3.org/TR/WCAG22/#pause-stop-hide
 *
 * > For moving, blinking, scrolling, or auto-updating information, all
 * > of the following are true: [a mechanism to pause, stop, or hide is
 * > available].
 *
 * Source: https://www.w3.org/TR/WCAG22/#pause-stop-hide
 *
 * This rule checks five surfaces:
 *   1. HTML <marquee> — obsolete, always animated, no built-in pause.
 *   2. Standalone .css files — animation/transition properties without a
 *      prefers-reduced-motion guard.
 *   3. HTML <style> blocks — content parsed as CSS and fed through the
 *      same guard check (line numbers offset back into the HTML file).
 *   4. Inline style="animation: …" / style="transition-duration: …"
 *      attributes — a single element can't be meaningfully wrapped in a
 *      reduced-motion query, so any non-zero duration on one of these
 *      properties is flagged.
 *   5. Bootstrap data-bs-ride="carousel" — a static signal of auto-
 *      advancing content (5-second default cycle). Pause-on-hover is
 *      an incidental pause, not a user-operable mechanism; the WCAG
 *      criterion still requires explicit controls that the scanner
 *      cannot prove exist from the attribute alone.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
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

const ANIMATION_PROPERTIES: ReadonlySet<string> = new Set([
  "animation",
  "animation-name",
  "animation-duration",
  "transition",
  "transition-property",
  "transition-duration",
]);

export const rule = defineRule({
  id: "motion/pause-stop-hide",
  satisfies: ["wcag22:2.2.2", "wcag21:2.2.2"],
  severity: "error",
  scope: "node",
  fixClass: "runtime-only",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".css"],
  },
  docs: {
    description:
      "Moving or auto-updating content must have a mechanism to pause, stop, or hide. Flags <marquee>, CSS animations without a prefers-reduced-motion guard (including inline <style> blocks), inline style= animation/transition declarations, and Bootstrap data-bs-ride='carousel' auto-advance markers.",
    rationale:
      "People with attention deficits, vestibular disorders, or seizure conditions can be severely affected by motion they cannot control. A prefers-reduced-motion media query lets the browser honor the user's OS-level motion preference. Inline styles and Bootstrap carousel auto-advance attributes evade stylesheet-level guards, so they need individual scrutiny.",
    goodExample: `@media (prefers-reduced-motion: reduce) {\n  .spinner { animation: none; }\n}`,
    badExample: `<marquee>Breaking news</marquee>\n<div data-bs-ride="carousel">…</div>\n<div style="transition-duration: 2s"></div>\n\n.spinner { animation: spin 1s infinite; }`,
    normativeQuote:
      "For moving, blinking, scrolling, or auto-updating information, all of the following are true.",
    references: [
      "https://www.w3.org/TR/WCAG22/#pause-stop-hide",
      "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      const emit: Emit = (v) => ctx.emit(v);
      const doc = ctx.ast as HtmlDocument;
      checkHtmlMarquee(doc, emit);
      checkHtmlStyleBlocks(doc, emit);
      checkHtmlInlineStyles(doc, emit);
      checkHtmlCarouselAutoplay(doc, emit);
    }
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    checkCssStylesheet(ctx.ast as CssStylesheet, (v) => ctx.emit(v), {
      lineOffset: 0,
      colOffset: 0,
    });
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

interface PositionOffset {
  readonly lineOffset: number;
  readonly colOffset: number;
}

function checkHtmlMarquee(doc: HtmlDocument, emit: Emit): void {
  for (const element of findHtmlElementsByTag(doc, "marquee")) {
    emit({
      severity: "error",
      location: {
        filePath: "",
        line: element.loc.start.line,
        column: element.loc.start.column,
      },
      message:
        "<marquee> is an obsolete element that creates moving text with no built-in pause mechanism — it violates WCAG 2.2.2.",
      suggestion:
        "Remove <marquee> and replace with static text, or use a CSS animation wrapped in a prefers-reduced-motion media query with a visible pause/stop button.",
    });
  }
}

/**
 * Parses every <style> element's text content as CSS and applies the
 * stylesheet guard check. Line/column positions are offset so findings
 * point into the HTML file, not the extracted CSS string.
 */
function checkHtmlStyleBlocks(doc: HtmlDocument, emit: Emit): void {
  for (const styleEl of findHtmlElementsByTag(doc, "style")) {
    const textNode = firstTextChild(styleEl);
    if (!textNode) continue;
    if (textNode.value.trim().length === 0) continue;
    const parsed = parseCss(textNode.value);
    // First CSS line maps onto the HTML line where the text starts; its
    // column is offset by the HTML start column (`<style>` tag width).
    // Subsequent CSS lines use only the line offset — their columns are
    // already in their own coordinate space (starting at 1 of a new line
    // inside the style block).
    const offset: PositionOffset = {
      lineOffset: textNode.loc.start.line - 1,
      colOffset: textNode.loc.start.column - 1,
    };
    checkCssStylesheet(parsed.root, emit, offset);
  }
}

function firstTextChild(element: HtmlElement): HtmlText | null {
  for (const child of element.children) {
    if (child.kind === "HtmlText") return child;
  }
  return null;
}

/**
 * Flags inline style="…" attributes that set animation or transition
 * properties to a non-zero duration. Inline styles can't be wrapped in
 * a prefers-reduced-motion query, so any non-zero value is a violation.
 */
function checkHtmlInlineStyles(doc: HtmlDocument, emit: Emit): void {
  for (const element of walkHtmlElements(doc)) {
    const style = getHtmlAttribute(element, "style");
    if (style === null || style.trim().length === 0) continue;
    const offending = findOffendingInlineDeclaration(style);
    if (!offending) continue;
    const echoTag = `<${element.tagName.toLowerCase()}>`;
    const echoValue = truncateForEcho(`${offending.property}: ${offending.value}`);
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: element.loc.start.line,
        column: element.loc.start.column,
      },
      message: `${echoTag} inline style sets '${echoValue}' — inline declarations cannot be scoped to a prefers-reduced-motion media query, so users who prefer reduced motion cannot disable this motion.`,
      suggestion: `Move the ${offending.property} declaration into a stylesheet rule wrapped in @media (prefers-reduced-motion: reduce) { … } with a reduced-motion alternative (animation: none or duration: 0.01ms), or remove the inline declaration if the motion is decorative.`,
    });
  }
}

interface OffendingDeclaration {
  readonly property: string;
  readonly value: string;
}

function findOffendingInlineDeclaration(style: string): OffendingDeclaration | null {
  for (const part of style.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (!ANIMATION_PROPERTIES.has(property)) continue;
    if (isNoneValue(value)) continue;
    if (isNearZeroDuration(value)) continue;
    return { property, value };
  }
  return null;
}

/**
 * Flags every element with `data-bs-ride="carousel"` (Bootstrap's static
 * marker for auto-advancing carousels). Pause-on-hover is Bootstrap's
 * default but it is an incidental pause, not a user-operable mechanism
 * under WCAG 2.2.2. The scanner cannot prove from the attribute alone
 * that visible pause/prev/next controls are present, so each occurrence
 * is surfaced for verification.
 */
function checkHtmlCarouselAutoplay(doc: HtmlDocument, emit: Emit): void {
  for (const element of walkHtmlElements(doc)) {
    const ride = getHtmlAttribute(element, "data-bs-ride");
    if (ride === null) continue;
    const rideTrimmed = ride.trim().toLowerCase();
    if (rideTrimmed !== "carousel" && rideTrimmed !== "true") continue;
    const pause = getHtmlAttribute(element, "data-bs-pause");
    const pauseNote =
      pause === null
        ? "no data-bs-pause attribute present"
        : `data-bs-pause="${truncateForEcho(pause)}"`;
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: element.loc.start.line,
        column: element.loc.start.column,
      },
      message: `<${element.tagName.toLowerCase()} data-bs-ride="${rideTrimmed}"> auto-advances on page load (Bootstrap's default cycle is 5 seconds) — WCAG 2.2.2 requires a user-operable pause/stop/hide mechanism; ${pauseNote}.`,
      suggestion:
        "Verify that the carousel ships visible prev/next and pause/play buttons (not just pause-on-hover, which is incidental), or remove data-bs-ride so the carousel does not auto-advance until the user activates it.",
    });
  }
}

/**
 * Applies the stylesheet prefers-reduced-motion guard check. Callable
 * on a whole .css file (offsets 0/0) or on the CSS extracted from an
 * HTML <style> block (offsets shifting positions back into the HTML
 * source).
 */
function checkCssStylesheet(stylesheet: CssStylesheet, emit: Emit, offset: PositionOffset): void {
  const guardedRules = collectReducedMotionRules(stylesheet);
  // Universal override: `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { … } }`
  // is the canonical pattern recommended by MDN. When present, every selector in
  // the stylesheet is already covered — no need to flag individual animations.
  if (hasUniversalReducedMotionOverride(guardedRules)) return;
  for (const cssRule of walkCssRules(stylesheet)) {
    if (guardedRules.has(cssRule)) continue;
    for (const decl of cssRule.declarations) {
      if (!ANIMATION_PROPERTIES.has(decl.property.toLowerCase())) continue;
      // Skip declarations that disable animation (e.g., animation: none)
      if (isNoneValue(decl.value)) continue;
      // `cssRule.selector` is user-authored and echoed twice per
      // finding; escaped Tailwind class selectors can be quite long.
      const echoSelector = truncateForEcho(cssRule.selector);
      emit({
        severity: "warning",
        location: {
          filePath: "",
          line: decl.loc.start.line + offset.lineOffset,
          column:
            decl.loc.start.line === 1
              ? decl.loc.start.column + offset.colOffset
              : decl.loc.start.column,
        },
        message: `'${echoSelector}' uses ${decl.property} without a prefers-reduced-motion media query guard — users who prefer reduced motion cannot disable this animation.`,
        suggestion: `Wrap the animation in @media (prefers-reduced-motion: reduce) { ${echoSelector} { ${decl.property}: none; } } or move the entire rule inside a prefers-reduced-motion query.`,
      });
      // One violation per rule is enough — don't flag both animation and
      // animation-duration on the same selector.
      break;
    }
  }
}

/**
 * Collects all CssRule nodes that are nested inside a
 * @media (prefers-reduced-motion) at-rule.
 */
function collectReducedMotionRules(stylesheet: CssStylesheet): ReadonlySet<CssRule> {
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
 * When this pattern is present, every selector in the stylesheet is covered.
 */
function hasUniversalReducedMotionOverride(guardedRules: ReadonlySet<CssRule>): boolean {
  for (const rule of guardedRules) {
    if (!isUniversalSelector(rule.selector)) continue;
    if (disablesAnimationOrTransition(rule)) return true;
  }
  return false;
}

/**
 * True if the selector targets every element.
 *
 * Accepts both the MDN-canonical `*, *::before, *::after` and the Tailwind-
 * compiled `*, :before, :after, ::backdrop` forms. Any comma-separated list
 * whose parts are all universal-equivalent qualifies.
 */
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
  const parts = selector.split(",").map((s) => s.trim());
  if (parts.length === 0) return false;
  return parts.every((p) => UNIVERSAL_PARTS.has(p));
}

/** True if the rule zeroes out animation-duration or transition-duration. */
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
function isNearZeroDuration(value: string): boolean {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important\s*$/, "")
    .trim();
  // `0` alone counts. Otherwise require a number < 1 followed by `ms` or `s`.
  if (clean === "0") return true;
  const match = /^(\d*\.?\d+)(ms|s)$/.exec(clean);
  if (!match) return false;
  const n = Number.parseFloat(match[1] ?? "0");
  return match[2] === "ms" ? n < 1 : n < 0.001;
}

function* walkAtRuleChildren(atRule: CssAtRule): Iterable<CssRule> {
  for (const child of atRule.children) {
    if (child.kind === "CssRule") {
      yield child;
    } else if (child.kind === "CssAtRule") {
      yield* walkAtRuleChildren(child);
    }
  }
}

function isNoneValue(value: string): boolean {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/\s*!important\s*$/, "")
    .trim();
  return trimmed === "none" || trimmed === "0s" || trimmed === "0ms" || trimmed === "0";
}
