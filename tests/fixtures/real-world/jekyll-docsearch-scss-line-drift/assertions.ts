/**
 * jekyll-docsearch-scss-line-drift — guards the 2.3.1 flash-threshold
 * finder's positional honesty on multi-line CSS rulesets.
 *
 * Origin: a Jekyll docs site shipped `_sass/_docsearch.scss` with the
 * `:valid ~ .searchbox__reset` ruleset spanning ~14 lines; the
 * `animation:` declaration sits ten-plus lines past the selector
 * opener. The 2.3.1 finder cited the declaration line, not the
 * ruleset opener — a 14-line drift between "what the agent reads
 * first" and "the structural anchor that matters." With two adjacent
 * rulesets sharing leading tokens (`.searchbox`, `.searchbox__reset`),
 * landing on the wrong line directs the agent to read the wrong
 * block. The fix walks the CSS AST by ruleset position, not by
 * declaration position.
 *
 * The fixture pairs `candidate-at-line` (positional truth) with
 * `candidate-present` carrying a `reasonIncludes` substring so the
 * regression guard catches both axes of drift:
 *   - line drifts off the ruleset opener → `candidate-at-line` fails
 *   - reason text loses the selector-specific phrasing → `candidate-
 *     present`'s `reasonIncludes` fails
 *
 * Pairs with Q2R2-FORM-TIMING (validation-timing finder, similar
 * "evidence line != finder-reported line" anti-pattern shape).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Guards review/flashing-content (wcag22:2.3.1) finder against CSS line-drift: " +
    "the candidate must point at the opening line of the ruleset that contains " +
    "the flagged animation declaration, not at the declaration's own line " +
    "many rows below the selector.",
  origin: {
    notes:
      "Sanitized excerpt of docsearch `_sass/_docsearch.scss` shipped by every " +
      "jekyll-doc-theme site. Captures the multi-line-ruleset shape that " +
      "exposed Q4-LIQUID-LINE-DRIFT-SASS-SELECTOR — the 2.3.1 finder cited " +
      "the `animation:` declaration line instead of the `:valid ~ " +
      ".searchbox__reset` selector line above it.",
  },
  expectations: [
    // Source must parse cleanly — a parse error would mask the line-drift signal.
    { kind: "zero-parse-errors" },

    // The candidate must surface (surface, don't suppress) — no regression
    // that silently drops the 2.3.1 finding on this shape.
    {
      kind: "candidate-present",
      criterionId: "wcag22:2.3.1",
      reasonIncludes: ":valid ~ .searchbox__reset",
    },

    // Positional honesty: the candidate must anchor on line 22, the
    // opening line of the `:valid ~ .searchbox__reset { ... }` ruleset.
    // The `animation: fade-in 0.3s linear forwards;` declaration sits on
    // line 32; pointing there is the bug this fixture guards against.
    // The first ruleset (`.searchbox` opens line 10) shares leading
    // tokens — a token-first regex implementation would land at line 10.
    {
      kind: "candidate-at-line",
      criterionId: "wcag22:2.3.1",
      path: "_docsearch.css",
      line: 22,
      reasonIncludes: ":valid ~ .searchbox__reset",
    },
  ],
};
