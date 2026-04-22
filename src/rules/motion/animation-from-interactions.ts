/**
 * Rule: motion/animation-from-interactions
 * Satisfies: wcag22:2.3.3, wcag21:2.3.3
 * Spec: https://www.w3.org/TR/WCAG22/#animation-from-interactions
 *
 * > Motion animation triggered by interaction can be disabled, unless
 * > the animation is essential to the functionality or the information
 * > being conveyed.
 *
 * Source: https://www.w3.org/TR/WCAG22/#animation-from-interactions
 *
 * This rule is the user-interaction counterpart to
 * `motion/pause-stop-hide` (WCAG 2.2.2). 2.2.2 targets auto-updating
 * content; 2.3.3 targets animation that only runs when the user
 * hovers, focuses, or activates an element. Both are AAA-level in
 * substance but 2.3.3 is formally the AAA row.
 *
 * Classification: a CSS rule is user-interaction-gated when EVERY
 * comma-separated part of its selector contains one of
 * `:hover`, `:focus`, `:active`, `:focus-visible`, or `:focus-within`.
 * Mixed lists (`.btn, .btn:hover { transition: … }`) stay in the
 * 2.2.2 lane because the bare part animates without user input.
 *
 * Like the 2.2.2 lane, this rule bails out when a
 * `@media (prefers-reduced-motion: reduce)` guard applies — the
 * guard is the honest opt-out for both auto and user-triggered
 * motion.
 *
 * The rule walks two surfaces:
 *   1. Standalone .css files — flag interaction-gated rules with
 *      animation/transition properties and no reduced-motion guard.
 *   2. HTML <style> blocks — same walk, offsets re-mapped into the
 *      HTML source.
 *
 * Inline `style="transition: …"`, `<marquee>`, and
 * `data-bs-ride="carousel"` are NOT 2.3.3 surfaces: inline styles
 * aren't pseudo-class-gated, and marquee/carousel are auto-advancing
 * by definition — those stay in the 2.2.2 lane of
 * `motion/pause-stop-hide`.
 */

import { defineRule } from "../../api/plugin.ts";
import type { CssStylesheet, HtmlDocument } from "../../types/ast.ts";
import {
  type Emit,
  forEachStyleBlock,
  isUserInteractionGatedSelector,
  type PositionOffset,
  truncateForEcho,
  walkCandidateRules,
} from "./_shared.ts";

export const rule = defineRule({
  id: "motion/animation-from-interactions",
  satisfies: ["wcag22:2.3.3", "wcag21:2.3.3"],
  severity: "warning",
  scope: "node",
  fixClass: "runtime-only",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".css"],
  },
  docs: {
    description:
      "Flags CSS animation/transition declarations whose selector is entirely gated by a user-interaction pseudo-class (:hover, :focus, :active, :focus-visible, :focus-within). WCAG 2.3.3 AAA requires a mechanism to disable motion triggered by interaction unless the animation is essential — a @media (prefers-reduced-motion: reduce) guard satisfies that mechanism.",
    rationale:
      "Motion triggered by hover/focus/activate is usually decorative but can still provoke vestibular or attention symptoms in users who depend on keyboard navigation or pointer exploration. Unlike auto-updating motion (2.2.2), interaction-gated motion is bounded by user intent — but users who cannot avoid the interaction (keyboard tab-through, mobile hover-on-tap) still need a way to disable it. A prefers-reduced-motion guard is the standard mechanism; essential animation (drag feedback, spatial reorientation) is out of scope per the SC's exception.",
    goodExample: `@media (prefers-reduced-motion: reduce) {\n  .btn:hover { transition: none; }\n}\n.btn:hover { transition: transform 0.2s; }`,
    badExample: `.btn:hover { transition: transform 0.2s ease; }\n.card:focus-visible { animation: pulse 0.6s; }`,
    normativeQuote:
      "Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed.",
    references: [
      "https://www.w3.org/TR/WCAG22/#animation-from-interactions",
      "https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions",
    ],
  },
  check(ctx) {
    if (ctx.language !== "html") return;
    const emit: Emit = (v) => ctx.emit(v);
    const doc = ctx.ast as HtmlDocument;
    forEachStyleBlock({ doc, emit, onStylesheet: checkCssStylesheet });
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    checkCssStylesheet(ctx.ast as CssStylesheet, (v) => ctx.emit(v), {
      lineOffset: 0,
      colOffset: 0,
    });
  },
});

/**
 * Flags animation/transition declarations whose selector is entirely
 * user-interaction-gated and is not already wrapped in a
 * prefers-reduced-motion query. Callable on a whole .css file (offsets
 * 0/0) or on the CSS extracted from an HTML <style> block.
 */
function checkCssStylesheet(stylesheet: CssStylesheet, emit: Emit, offset: PositionOffset): void {
  for (const { rule: cssRule, decl } of walkCandidateRules(stylesheet)) {
    if (!isUserInteractionGatedSelector(cssRule.selector)) continue;
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
      message: `'${echoSelector}' uses ${decl.property} on a user-interaction pseudo-class without a prefers-reduced-motion guard — users who prefer reduced motion cannot disable this interaction-triggered animation.`,
      suggestion: `Wrap the animation in @media (prefers-reduced-motion: reduce) { ${echoSelector} { ${decl.property}: none; } }, or move the entire rule inside a prefers-reduced-motion query. Keep the original selector so hover/focus remain visually distinct — only the motion needs to be suppressed.`,
    });
  }
}
