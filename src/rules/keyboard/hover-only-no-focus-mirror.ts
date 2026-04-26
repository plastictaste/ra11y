/**
 * Rule: keyboard/hover-only-no-focus-mirror
 * Satisfies: wcag22:1.4.13, wcag21:1.4.13, wcag22:2.1.1, wcag21:2.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus
 *        https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > Where receiving and then removing pointer hover or keyboard focus
 * > triggers additional content to become visible and then hidden, the
 * > [content is] dismissable, hoverable, and persistent.   (1.4.13)
 *
 * > All functionality of the content is operable through a keyboard
 * > interface without requiring specific timings for individual
 * > keystrokes.   (2.1.1)
 *
 * Flags CSS rules whose selector contains `:hover` and whose body
 * mutates a layout-affecting visual property (`transform`, `opacity`,
 * `visibility`, `display`) — when no sibling rule in the same
 * stylesheet provides the same mutation under `:focus` /
 * `:focus-within`. Canonical pattern: a card-overlay reveal —
 *
 *     .movie:hover .overview { transform: translateY(0); }
 *
 * — exposes content (an "overview" panel) on pointer hover only.
 * Keyboard users tabbing into the card never see it. The fix is to
 * mirror the rule:
 *
 *     .movie:hover .overview,
 *     .movie:focus-within .overview { transform: translateY(0); }
 *
 * Static predicate (provable from the CSS source alone): a `:hover`
 * rule declares one of the gated properties, AND no sibling rule in
 * the same stylesheet shares the same selector chain with `:hover`
 * substituted for `:focus` / `:focus-within` while declaring at least
 * one of the same gated properties. The mirror predicate is "same
 * selector chain modulo the user-state pseudo, plus same gated
 * property declared" — `:focus` rules that change unrelated
 * properties (`background-color`, `border-color`) are not mirrors
 * because they don't trigger the same reveal/transition.
 *
 * Why severity = `warning`:
 *
 *   - The static signal is high-confidence (the predicate is provable
 *     from the file alone and the failure pattern is real), but
 *     `:focus-visible` ergonomics on non-`:focus`-able elements vary
 *     by composition (a parent might add `tabindex="0"` in JSX/HTML;
 *     the focus mirror might live in a separate stylesheet imported
 *     via `@import`). Static analysis cannot fully prove the user
 *     site has no other path to keyboard parity. `warning` flags the
 *     pattern honestly and lets the agent verify in the consumer
 *     site, per the AI-first "Reason text and severity must agree"
 *     doctrine.
 *
 * Cross-file scope:
 *
 *   - The mirror search is single-file. A `:focus-within` rule in a
 *     different `.css` file imported via `@import` would not satisfy
 *     this predicate. Marked `crossFileCapable: false` so the per-rule
 *     coverage row honestly downgrades to `"medium"` confidence on
 *     single-file substrates per ADR 0026, rather than asserting
 *     `"high"` and silently miscalibrating the agent.
 */

import { defineRule } from "../../api/plugin.ts";
import { findCssDeclaration, walkCssRules } from "../../engine/ast-helpers.ts";
import type { CssRule, CssStylesheet } from "../../types/ast.ts";

/**
 * Visual-layout properties whose `:hover` declaration plausibly reveals
 * content or initiates a meaningful animation. Excludes color-only
 * properties (`background-color`, `color`, `border-color`) — those are
 * decorative state changes that don't reveal new content, and a sibling
 * `color/state-class-color-only` rule already covers the
 * "color-only-state" failure surface.
 */
const LAYOUT_MUTATION_PROPERTIES: ReadonlySet<string> = new Set([
  "transform",
  "opacity",
  "visibility",
  "display",
]);

/**
 * Pseudo-classes that establish keyboard-equivalent triggers. A sibling
 * rule with one of these in place of `:hover` qualifies as a mirror.
 * `:focus-within` is the most flexible (covers descendant focus;
 * matches the `.movie:focus-within .overview` pattern); `:focus` is
 * the historical default.
 */
const FOCUS_PSEUDO_VARIANTS: readonly string[] = [":focus-within", ":focus"];

/** Whole-token regex matching `:hover` (and only `:hover`, not `:hover-something`). */
const HOVER_PSEUDO_RE = /:hover(?![A-Za-z0-9_-])/;

export const rule = defineRule({
  id: "keyboard/hover-only-no-focus-mirror",
  satisfies: ["wcag22:1.4.13", "wcag21:1.4.13", "wcag22:2.1.1", "wcag21:2.1.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".css", ".scss", ".less"],
  },
  // Mirror search is in-file only — `@import`ed siblings are out of
  // scope and the agent reading the consumer site is the correct
  // arbiter. Honest downgrade per ADR 0026.
  crossFileCapable: false,
  docs: {
    description:
      "CSS :hover rules that mutate transform/opacity/visibility/display must have a paired :focus or :focus-within mirror so keyboard users can trigger the same reveal.",
    rationale:
      "Mouse users discover a hover-revealed panel by moving the pointer over its trigger; keyboard users have no equivalent gesture. WCAG 1.4.13 (Content on Hover or Focus) covers content that appears on hover OR focus, and 2.1.1 (Keyboard) requires every functional pathway have a keyboard equivalent — together they require any reveal-on-hover behavior to also fire on `:focus` / `:focus-within`. The fix is cheap and idiomatic: add the focus pseudo to the same selector chain (`.card:hover .panel, .card:focus-within .panel { transform: translateY(0); }`). Static analysis catches the canonical reveal pattern (transform / opacity / visibility / display mutated on `:hover` with no focus mirror); color-only state changes are out of scope (they don't reveal content) and live in `color/state-class-color-only`.",
    goodExample: `.card:hover .panel,\n.card:focus-within .panel {\n  transform: translateY(0);\n  opacity: 1;\n}`,
    badExample: `.card:hover .panel {\n  transform: translateY(0);\n  opacity: 1;\n}`,
    normativeQuote:
      "Where receiving and then removing pointer hover or keyboard focus triggers additional content to become visible and then hidden, the [content is] dismissable, hoverable, and persistent.",
    references: [
      "https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus",
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html",
      "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    const stylesheet = ctx.ast as CssStylesheet;
    const allRules = [...walkCssRules(stylesheet)];
    for (const cssRule of allRules) {
      if (!HOVER_PSEUDO_RE.test(cssRule.selector)) continue;
      const mutatedProps = listLayoutMutations(cssRule);
      if (mutatedProps.length === 0) continue;
      // Same-rule mirror — the author paired the hover and focus groups
      // in a single comma-separated selector list. The rule body
      // applies to both, so the mutation reaches keyboard users by
      // construction.
      if (hasInRuleFocusMirror(cssRule.selector)) continue;
      if (hasFocusMirror(cssRule, mutatedProps, allRules)) continue;
      ctx.emit({
        severity: "warning",
        location: {
          filePath: ctx.filePath,
          line: cssRule.loc.start.line,
          column: cssRule.loc.start.column,
        },
        message: buildMessage(cssRule.selector, mutatedProps),
        suggestion: buildSuggestion(cssRule.selector, mutatedProps),
      });
    }
  },
});

/**
 * True when the rule's own comma-separated selector list contains both
 * a `:hover` group AND a `:focus` / `:focus-within` group whose chain
 * matches the hover group modulo the pseudo substitution. The single
 * declaration block applies to every group, so a matching focus group
 * inside the same rule is a complete mirror.
 */
function hasInRuleFocusMirror(selector: string): boolean {
  const groups = selector.split(",").map((g) => normalizeSelector(g));
  for (const group of groups) {
    if (!HOVER_PSEUDO_RE.test(group)) continue;
    for (const variant of FOCUS_PSEUDO_VARIANTS) {
      const focusEquivalent = group.replace(/:hover(?![A-Za-z0-9_-])/g, variant);
      if (groups.includes(focusEquivalent)) return true;
    }
  }
  return false;
}

/** Collect declared layout-mutation properties from a CSS rule, in source order. */
function listLayoutMutations(cssRule: CssRule): readonly string[] {
  const seen: string[] = [];
  for (const decl of cssRule.declarations) {
    const prop = decl.property.toLowerCase();
    if (LAYOUT_MUTATION_PROPERTIES.has(prop) && !seen.includes(prop)) {
      seen.push(prop);
    }
  }
  return seen;
}

/**
 * Returns true when at least one rule in the same stylesheet has a
 * selector chain identical to `cssRule.selector` modulo replacing every
 * `:hover` token with `:focus` or `:focus-within`, AND that sibling
 * rule declares at least one of the layout properties from the hover
 * rule. The "same selector chain" check is purely textual: lowercase
 * the strings, replace whitespace runs with a single space, and compare
 * the post-substitution form. Comma-separated selector groups are
 * matched as whole-list strings — a comma group `.a:hover, .b:hover`
 * mirrors with `.a:focus, .b:focus`. (Mirror lists where the author
 * split focus and hover across two separate rule blocks ALSO match,
 * because each block's individual selector is examined too.)
 */
function hasFocusMirror(
  hoverRule: CssRule,
  mutatedProps: readonly string[],
  allRules: readonly CssRule[],
): boolean {
  const candidateMirrors = expandHoverToFocus(hoverRule.selector);
  for (const sibling of allRules) {
    if (sibling === hoverRule) continue;
    if (!declaresAtLeastOne(sibling, mutatedProps)) continue;
    const siblingNorm = normalizeSelector(sibling.selector);
    if (matchesMirrorWhole(siblingNorm, candidateMirrors)) return true;
    if (matchesMirrorByGroup(sibling.selector, hoverRule.selector)) return true;
  }
  return false;
}

/** True if the rule body declares at least one of the named properties. */
function declaresAtLeastOne(cssRule: CssRule, props: readonly string[]): boolean {
  for (const prop of props) {
    if (findCssDeclaration(cssRule, prop) !== undefined) return true;
  }
  return false;
}

/**
 * For each focus-pseudo variant, produce the normalized form of the
 * selector with every `:hover` token swapped to that variant. Returns
 * a list (one per variant) so a sibling rule using either `:focus` or
 * `:focus-within` qualifies.
 */
function expandHoverToFocus(selector: string): readonly string[] {
  const out: string[] = [];
  for (const variant of FOCUS_PSEUDO_VARIANTS) {
    const swapped = selector.replace(/:hover(?![A-Za-z0-9_-])/g, variant);
    out.push(normalizeSelector(swapped));
  }
  return out;
}

/** Whole-string match: sibling's normalized selector equals one of the candidate mirrors. */
function matchesMirrorWhole(siblingNorm: string, candidates: readonly string[]): boolean {
  for (const cand of candidates) {
    if (siblingNorm === cand) return true;
  }
  return false;
}

/**
 * Per-group match: at least one comma-separated group in the sibling
 * matches at least one comma-separated group in the hover selector
 * after `:hover`→`:focus[-within]` substitution. Handles the case
 * where the author wrote a separate focus rule (`.a:focus { … }`)
 * even though the hover rule was a single group (`.a:hover { … }`),
 * or the case where the focus rule fans into a longer comma list
 * (`.a:focus-within, .b:focus-within { … }`) covering a hover rule
 * that only listed `.a:hover`.
 */
function matchesMirrorByGroup(siblingSelector: string, hoverSelector: string): boolean {
  const siblingGroups = siblingSelector.split(",").map((s) => normalizeSelector(s));
  const hoverGroups = hoverSelector.split(",").map((s) => normalizeSelector(s));
  for (const hoverGroup of hoverGroups) {
    if (!HOVER_PSEUDO_RE.test(hoverGroup)) continue;
    for (const variant of FOCUS_PSEUDO_VARIANTS) {
      const focusEquivalent = hoverGroup.replace(/:hover(?![A-Za-z0-9_-])/g, variant);
      if (siblingGroups.includes(focusEquivalent)) return true;
    }
  }
  return false;
}

/**
 * Normalize a selector string for textual comparison: lowercase, collapse
 * whitespace runs (including newlines/tabs from multiline selectors) to
 * a single space, trim. Combinators stay in place — the goal is to
 * neutralize trivial whitespace differences while preserving the
 * structural meaning of the selector.
 */
function normalizeSelector(selector: string): string {
  return selector.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildMessage(selector: string, props: readonly string[]): string {
  const propList = props.join(", ");
  return `'${selector}' mutates ${propList} on hover with no \`:focus\` or \`:focus-within\` mirror — keyboard users tabbing into the element won't see the same reveal.`;
}

function buildSuggestion(selector: string, props: readonly string[]): string {
  const propList = props.join(", ");
  const focusEquivalent = selector.replace(/:hover(?![A-Za-z0-9_-])/g, ":focus-within");
  const propsBlock = props.map((p) => `  ${p}: <same as the :hover rule>;`).join("\n");
  return `Add a focus mirror so keyboard navigation triggers the same ${propList} change. Either widen the existing selector list — \`${selector}, ${focusEquivalent} { … }\` — or add a sibling block:\n\n${focusEquivalent} {\n${propsBlock}\n}\n\nUse \`:focus-within\` when the hover trigger is an ancestor of the revealed content (e.g. \`.card:hover .panel\` → \`.card:focus-within .panel\`); use \`:focus\` when the hover and focus targets are the same element. The revealed element may also need \`tabindex="0"\` (or a focusable child) so keyboard users can land focus inside the trigger in the first place.`;
}
