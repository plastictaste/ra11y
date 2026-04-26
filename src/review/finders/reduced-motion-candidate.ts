/**
 * Candidate finder: review/reduced-motion-candidate
 * Criteria: wcag22:2.3.3, wcag21:2.3.3 (Animation from Interactions, AAA)
 * Spec: https://www.w3.org/TR/WCAG22/#animation-from-interactions
 *
 * 2.3.3 is formally AAA, so the rule lane (motion/animation-from-interactions)
 * only fires when the caller asks for AAA. AA-default scans never evaluate
 * `prefers-reduced-motion` presence — meaning a stylesheet that animates
 * UI without honoring the user's OS-level motion preference reaches the
 * agent with zero signal, even though the missing guard is the most
 * common reduced-motion gap and a partial proxy for 2.2.2 too.
 *
 * This finder reframes the AAA criterion as a level-agnostic review
 * candidate: when a CSS file declares `animation:` or `transition:` and
 * carries no `@media (prefers-reduced-motion: reduce)` block anywhere
 * in the same file, surface a single candidate so the agent can verify
 * whether the page honors the user's motion preference.
 *
 * The candidate is one-per-file, anchored at the first matching
 * declaration. Per the AI-first consumer doctrine, this is a question
 * (`reason` text frames "verify…"), not an assertion — once the file
 * carries any reduced-motion media query, the author has demonstrably
 * thought about the case and the candidate adds no further signal.
 *
 * Overlap with sibling motion checks is intentional and bounded:
 *   - `motion/pause-stop-hide` (WCAG 2.2.2 A) only fires on auto-updating
 *     motion that exceeds spec gates (5s+ duration, infinite/repeating
 *     iteration-count). A finite 0.6s entrance animation is spec-exempt
 *     from 2.2.2 but still warrants a 2.3.3-shaped reduced-motion check.
 *   - `motion/animation-from-interactions` (WCAG 2.3.3 AAA) is gated to
 *     AAA scans and to interaction-pseudo-class-gated selectors. AA
 *     scans see nothing from that lane.
 *
 * The finder fills the gap: 2.3.3 reframed at AA as a review candidate.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { walkCssAtRules, walkCssRules } from "../../engine/ast-helpers.ts";
import type { CssAtRule, CssRule, CssStylesheet } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import type { RuleContext } from "../../types/rule.ts";

const CRITERION_IDS = ["wcag22:2.3.3", "wcag21:2.3.3"] as const;

/**
 * CSS properties whose presence implies the stylesheet is animating
 * something. Matches both shorthand (`animation:`, `transition:`) and the
 * primary longhands an author reaches for. Intentionally narrow — we
 * surface on actual motion declarations, not on `animation-name` or
 * `animation-iteration-count` sitting orphaned without a paired
 * `animation-duration` (those by themselves can't run a paint).
 */
const MOTION_PROPERTIES: ReadonlySet<string> = new Set([
  "animation",
  "animation-duration",
  "transition",
  "transition-duration",
]);

interface FirstMotionAnchor {
  readonly line: number;
  readonly column: number;
  readonly property: string;
  readonly selector: string;
}

export const finder = defineCandidateFinder({
  id: "review/reduced-motion-candidate",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".css"] },
  docs: {
    description:
      "Surfaces CSS files that declare animation: or transition: properties without any `@media (prefers-reduced-motion: reduce)` block, framed as a 2.3.3 review candidate so AA-default scans still ask whether the page honors the user's motion preference.",
    reviewPrompt:
      "At each candidate, verify whether the page honors users' prefers-reduced-motion setting. Either wrap the animation/transition declarations in a `@media (prefers-reduced-motion: reduce)` block that sets `animation: none` / `transition: none` (or near-zero durations), or confirm that the motion is essential per the WCAG 2.3.3 exception. A universal `*, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }` override under the media query is the canonical opt-out shape.",
    references: [
      "https://www.w3.org/TR/WCAG22/#animation-from-interactions",
      "https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions",
      "https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion",
    ],
  },
  find(ctx) {
    if (ctx.language !== "css") return [];
    const stylesheet = ctx.ast as CssStylesheet;
    if (hasReducedMotionGuard(stylesheet)) return [];
    const anchor = findFirstMotionAnchor(stylesheet);
    if (!anchor) return [];
    return buildCandidates(ctx, anchor);
  },
});

/**
 * True iff the stylesheet contains at least one
 * `@media (prefers-reduced-motion …)` at-rule. The mere presence of
 * such a block (regardless of its body) is taken as evidence that the
 * author has considered the reduced-motion case — the candidate's job
 * is to surface the question, and once asked the agent should read the
 * file directly to assess the body. This is a deliberately permissive
 * gate: a guard that sets non-zero durations is still better than no
 * guard, and the candidate lane should not second-guess the body.
 */
function hasReducedMotionGuard(stylesheet: CssStylesheet): boolean {
  for (const atRule of walkCssAtRules(stylesheet)) {
    if (isReducedMotionMediaQuery(atRule)) return true;
  }
  return false;
}

function isReducedMotionMediaQuery(atRule: CssAtRule): boolean {
  if (atRule.name.toLowerCase() !== "media") return false;
  return /prefers-reduced-motion/i.test(atRule.params);
}

/**
 * Walks every rule in the stylesheet (including those nested inside
 * unrelated at-rules like `@supports`) and returns the first declaration
 * matching {@link MOTION_PROPERTIES}. The anchor's line/column point at
 * the rule's selector so the agent reads structural context first; the
 * matched property name and selector are echoed in the reason text.
 */
function findFirstMotionAnchor(stylesheet: CssStylesheet): FirstMotionAnchor | undefined {
  for (const cssRule of walkCssRules(stylesheet)) {
    const anchor = motionAnchorForRule(cssRule);
    if (anchor) return anchor;
  }
  return undefined;
}

function motionAnchorForRule(cssRule: CssRule): FirstMotionAnchor | undefined {
  for (const decl of cssRule.declarations) {
    if (!MOTION_PROPERTIES.has(decl.property.toLowerCase())) continue;
    return {
      line: cssRule.loc.start.line,
      column: cssRule.loc.start.column,
      property: decl.property.toLowerCase(),
      selector: cssRule.selector,
    };
  }
  return undefined;
}

function buildCandidates(ctx: RuleContext, anchor: FirstMotionAnchor): readonly ReviewCandidate[] {
  const reason =
    `'${anchor.selector}' declares '${anchor.property}' but the file contains no ` +
    "`@media (prefers-reduced-motion: reduce)` block — verify the page honors users' prefers-reduced-motion setting, or confirm the motion is essential per the WCAG 2.3.3 exception";
  const out: ReviewCandidate[] = [];
  for (const criterionId of CRITERION_IDS) {
    out.push({
      criterionId,
      location: { filePath: ctx.filePath, line: anchor.line, column: anchor.column },
      reason,
      // Static evidence is concrete (we observed the declaration and the
      // absence of any prefers-reduced-motion @media); the question
      // depends on whether the surrounding page logic actually triggers
      // the animation in a context users would notice. "medium" matches
      // the analogous flashing-content CSS branch.
      confidence: "medium",
    });
  }
  return out;
}
