/**
 * inline-style-contrast — guards that `contrast/minimum` and
 * `contrast/non-text` evaluate inline `style="…"` declarations on
 * HTML elements.
 *
 * The contrast rules historically only looked at standalone `.css`
 * files and `<style>` blocks — every inline `style="color:…;
 * background:…"` pair went unevaluated. A sanitized static-site-
 * template pattern (`<p style="background-color:#cccccc">` on a
 * paragraph whose inherited text was dark gray) shipped the silent
 * miss across every sampled template.
 *
 * This fixture encodes the invariant that survives refactors of the
 * internal helper layout: an HTML element with an inline
 * color + background-color pair below 4.5:1 emits a
 * `contrast/minimum` finding, and a `<button>` with inline
 * border + background below 3:1 emits a `contrast/non-text` finding.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Inline `style='color:…;background:…'` on an HTML element below 4.5:1 " +
    "triggers contrast/minimum, and inline border on a <button> below 3:1 " +
    "triggers contrast/non-text — catching the static-site-template silent-miss.",
  origin: {
    notes:
      "Pattern sanitized from a static-site-template codebase where a paragraph " +
      "carried `style='background-color:#cccccc'` with dark inherited text — the " +
      "anti-pattern is the inline declaration itself, not the specific template content.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      reasonIncludes: "inline background",
    },
    {
      kind: "violation-present",
      ruleId: "contrast/non-text",
      reasonIncludes: "inline background",
    },
  ],
};
