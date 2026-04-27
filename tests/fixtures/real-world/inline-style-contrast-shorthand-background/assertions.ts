/**
 * inline-style-contrast-shorthand-background — guards the inline-style
 * evaluation path in `contrast/minimum` for the `background:` shorthand
 * (not `background-color:`) and 3-digit hex (`#FFF`, `#FF1`) value
 * shapes.
 *
 * Background: Q7-RULE-INLINE-STYLE-CONTRAST-WIDEN re-reported the
 * `<strong style="color:#FFF317; background:#FFF">` silent-miss after
 * Q-SHARED-INLINE-STYLE-CONTRAST shipped. A live HEAD probe (2026-04-24)
 * confirmed the exact snippet fires `contrast/minimum` correctly — the
 * field signal traced to the canonical stale-MCP-subprocess fault
 * (recurring 2026-04-22+ pattern), not a missing code path. Cross-ref
 * Q6-CONTRAST-INLINE-STYLE-REGRESSION-AUDIT (closed, same root cause).
 *
 * The existing `inline-style-contrast-yellow-on-white` fixture covers
 * the 6-digit `background-color:#ffffff` long form; this fixture
 * complements it by locking the orthogonal value shapes that the
 * backlog example named:
 *   - `background:` (CSS shorthand) instead of `background-color:`
 *   - 3-digit hex shorthand (`#FFF`, `#FF1`) for both color and bg
 *   - Whitespace after `;` and around `:` in the declaration list
 *
 * If a future refactor of `_shared-inline.ts` (e.g. tightening the
 * declaration parser, moving the bg-shorthand fallback in
 * `readInlineBackground`, or changing the color tokenizer) drops
 * support for any of these shapes, this fixture fails loudly here
 * rather than silently regressing on real-world templates.
 *
 * Live probe evidence (2026-04-24, runner.ts harness against HEAD
 * = 9a868033):
 *   violation ruleId=contrast/minimum file=shorthand-bg.html line=9
 *   message: "<strong inline style color> has color contrast ratio
 *             1.16:1 against its inline background — WCAG 1.4.3 AA
 *             requires 4.5:1 for normal text."
 *   violation ruleId=contrast/minimum file=shorthand-bg.html line=10
 *   message: "<span inline style color> has color contrast ratio 1.07:1
 *             against its inline background — WCAG 1.4.3 AA requires
 *             4.5:1 for normal text."
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'contrast/minimum fires on inline `style="color:…;background:…"` declarations ' +
    "using the `background:` CSS shorthand and 3-digit hex value shapes — " +
    "regression lock complementing the long-form yellow-on-white fixture.",
  origin: {
    notes:
      "Re-reported field signal traced to the canonical stale-MCP-subprocess " +
      "fault (recurring 2026-04-22+ pattern); the Q-SHARED-INLINE-STYLE-CONTRAST " +
      "closure already handles this shape on current HEAD. Fixture added as a " +
      "durable lock so the next refactor of the inline-style declaration parser " +
      "or background-shorthand fallback fails loudly here rather than silently " +
      "regressing on real-world templates.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // <strong style="color:#FFF317; background:#FFF"> — the exact backlog
    // example. The `background:` shorthand (not `background-color:`) is
    // the orthogonal shape this fixture locks vs the existing yellow-on-
    // white fixture (which uses the `background-color:` long form).
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "shorthand-bg.html",
      reasonIncludes: "inline background",
    },

    // The message must name the inline-style surface specifically so
    // agents can distinguish a stylesheet finding from an inline-style
    // finding — same invariant as the yellow-on-white fixture.
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "shorthand-bg.html",
      reasonIncludes: "inline style color",
    },
  ],
};
