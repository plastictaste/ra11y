/**
 * inline-style-contrast-yellow-on-white — guards the inline-style evaluation
 * path in `contrast/minimum` (and `contrast/enhanced`) for HTML `style=""`
 * attributes.
 *
 * Background: the `contrast/minimum` rule originally only walked standalone
 * `.css` files and `<style>` blocks. Static-site template scans consistently
 * reported zero contrast findings despite heavy inline-style use — a silent
 * miss on a common real-world pattern. The `_shared-inline.ts` module and the
 * `checkHtmlInlineStyles` branch in `minimum.ts` closed that gap.
 *
 * Backlog item: (2026-04-22).
 * Diagnosis: possibility (1) — the closure shipped; field symptoms were from a
 * pre-closure MCP subprocess (stale-subprocess fault). The rule fires correctly
 * on the current HEAD.
 *
 * Source files:
 *   yellow-on-white.html      — <strong style="color:#FFF317;background-color:#ffffff">
 *                               ratio 1.16:1, line 10 — mirrors the vteam index.html pattern
 *   yellow-span-on-white.html — <span style="color:#FFEA00;background-color:#ffffff">
 *                               ratio 1.23:1, line 8 — mirrors the street-life h1/span pattern
 *
 * Live probe evidence (2026-04-22, runner.ts harness):
 *   violation ruleId=contrast/minimum file=yellow-on-white.html line=10
 *   message: "<strong inline style color> has color contrast ratio 1.16:1 against its
 *             inline background — WCAG 1.4.3 AA requires 4.5:1 ..."
 *   violation ruleId=contrast/minimum file=yellow-span-on-white.html line=8
 *   message: "<span inline style color> has color contrast ratio 1.23:1 against its
 *             inline background — WCAG 1.4.3 AA requires 4.5:1 ..."
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'contrast/minimum fires on HTML style="" inline declarations (yellow-on-white patterns) ' +
    "via the _shared-inline.ts path — regression lock on the inline-style evaluation branch " +
    "that was absent before Q-SHARED-INLINE-STYLE-CONTRAST shipped.",
  origin: {
    notes:
      "Backlog item (2026-04-22). Field symptoms " +
      "(1.17:1 yellow-on-white on website-templates) were traced to a stale MCP subprocess " +
      "serving a pre-closure bundle — diagnosis (1): stale-subprocess. The rule fires " +
      "correctly on current HEAD. This fixture is a durable regression lock so a future " +
      "refactor of the inline-style path cannot silently drop the HTML branch.",
  },
  expectations: [
    // Both HTML files must parse cleanly — the inline style attribute is
    // standard HTML syntax, no parse errors expected.
    { kind: "zero-parse-errors" },

    // contrast/minimum must fire on the <strong style="color:#FFF317;..."> element.
    // This is the primary regression guard: if the checkHtmlInlineStyles branch is
    // removed or gated out, this expectation fails loudly.
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "yellow-on-white.html",
      reasonIncludes: "inline background",
    },

    // contrast/minimum must also fire on the <span style="color:#FFEA00;..."> element
    // in the second file — different tag name, same inline-style path. Guards that the
    // walker covers all element types, not just <strong>.
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "yellow-span-on-white.html",
      reasonIncludes: "inline background",
    },

    // The message must name the inline-style surface specifically so agents can
    // distinguish a stylesheet finding from an inline-style finding.
    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "yellow-on-white.html",
      reasonIncludes: "inline style color",
    },

    {
      kind: "violation-present",
      ruleId: "contrast/minimum",
      inFile: "yellow-span-on-white.html",
      reasonIncludes: "inline style color",
    },
  ],
};
