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
 * This rule targets **auto-updating** motion — motion that starts
 * without user interaction (timers, autoplay attributes, bare
 * animation declarations). Motion that is gated by a user-interaction
 * pseudo-class (`:hover` / `:focus` / `:active` / `:focus-visible` /
 * `:focus-within`) is the domain of WCAG 2.3.3
 * "Animation from Interactions" — see the sibling rule
 * `motion/animation-from-interactions`.
 *
 * The rule checks five surfaces:
 *   1. HTML <marquee> — obsolete, always animated, no built-in pause.
 *   2. Standalone .css files — animation/transition properties without
 *      a prefers-reduced-motion guard, skipping rules whose selector
 *      is entirely user-interaction-gated.
 *   3. HTML <style> blocks — same walk, line numbers offset back into
 *      the HTML file.
 *   4. Inline style="animation: …" / style="transition-duration: …"
 *      attributes — a single element can't be meaningfully wrapped in
 *      a reduced-motion query, so any non-zero duration on one of
 *      these properties is flagged. Inline styles aren't gated by a
 *      pseudo-class, so they always live in the 2.2.2 lane.
 *   5. Bootstrap data-bs-ride="carousel" — a static signal of auto-
 *      advancing content (5-second default cycle).
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { CssStylesheet, HtmlDocument, HtmlElement } from "../../types/ast.ts";
import {
  ANIMATION_PROPERTIES,
  anyPartHasUserInteractionPseudoClass,
  type Emit,
  forEachStyleBlock,
  getHtmlAttribute,
  isNearZeroDuration,
  isNoneValue,
  isUserInteractionGatedSelector,
  type PositionOffset,
  truncateForEcho,
  walkCandidateRules,
} from "./_shared.ts";

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
      "Moving or auto-updating content must have a mechanism to pause, stop, or hide. Flags <marquee>, CSS animations without a prefers-reduced-motion guard (including inline <style> blocks), inline style= animation/transition declarations, and Bootstrap data-bs-ride='carousel' auto-advance markers. Skips user-interaction-gated animations (:hover / :focus / :active) — those are the domain of motion/animation-from-interactions (wcag22:2.3.3).",
    rationale:
      "People with attention deficits, vestibular disorders, or seizure conditions can be severely affected by motion they cannot control. A prefers-reduced-motion media query lets the browser honor the user's OS-level motion preference. Inline styles and Bootstrap carousel auto-advance attributes evade stylesheet-level guards, so they need individual scrutiny. Animations gated by user-interaction pseudo-classes run only when the user asks for them, and WCAG 2.3.3 (not 2.2.2) is the correct criterion for that trigger shape.",
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
      forEachStyleBlock({ doc, emit, onStylesheet: checkCssStylesheet });
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
 * Flags inline style="…" attributes that set animation or transition
 * properties to a non-zero duration. Inline styles can't be wrapped in
 * a prefers-reduced-motion query, so any non-zero value is a violation.
 * Inline styles are element-level and never gated by a pseudo-class,
 * so this always routes to the 2.2.2 lane.
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
    emitCarouselFinding(element, emit);
  }
}

function emitCarouselFinding(element: HtmlElement, emit: Emit): void {
  const ride = getHtmlAttribute(element, "data-bs-ride");
  if (ride === null) return;
  const rideTrimmed = ride.trim().toLowerCase();
  if (rideTrimmed !== "carousel" && rideTrimmed !== "true") return;
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

/**
 * Applies the stylesheet prefers-reduced-motion guard check in the
 * 2.2.2 lane. Skips CSS rules whose selector is ENTIRELY
 * user-interaction-gated — those belong to 2.3.3 and are flagged by
 * the sibling `motion/animation-from-interactions` rule. A mixed
 * selector list (`.foo, .foo:hover`) still fires under 2.2.2 because
 * the bare `.foo` part animates without interaction.
 */
function checkCssStylesheet(stylesheet: CssStylesheet, emit: Emit, offset: PositionOffset): void {
  for (const { rule: cssRule, decl } of walkCandidateRules(stylesheet)) {
    if (isUserInteractionGatedSelector(cssRule.selector)) continue;
    const echoSelector = truncateForEcho(cssRule.selector);
    const mixedNote = anyPartHasUserInteractionPseudoClass(cssRule.selector)
      ? " (selector list mixes interaction-gated and always-on parts — the non-gated parts animate without user input)"
      : "";
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
      message: `'${echoSelector}' uses ${decl.property} without a prefers-reduced-motion media query guard${mixedNote} — users who prefer reduced motion cannot disable this animation.`,
      suggestion: `Wrap the animation in @media (prefers-reduced-motion: reduce) { ${echoSelector} { ${decl.property}: none; } } or move the entire rule inside a prefers-reduced-motion query.`,
    });
  }
}
