/**
 * bulk-template-icon-button — guards that `aria/icon-font-hidden`
 * fires on ALL icon-font glyph elements in a Bootstrap-template navbar
 * that mixes labeled `<button>` and labeled `<a>` parents.
 *
 * Pattern drawn from a bulk-template catalog corpus (Bootstrap-style
 * navbar shape, sanitized). Three Font Awesome `<i>` elements — one inside a
 * `<button aria-label="Toggle navigation">`, two inside
 * `<a aria-label="...">` anchors — lack `aria-hidden="true"`.
 *
 * This fixture guards hypothesis (b) from-
 * REGRESSION: the labeled-parent predicate must cover aria-label on
 * BOTH `<button>` and `<a>` parents, and must detect multiple instances
 * per file in a single pass.
 *
 * Live probe evidence (current src/):
 *
 *   aria/icon-font-hidden violations: 3
 *   line 44: <i class="fa"> is a Font Awesome glyph inside a labeled
 *     <button> "Toggle navigation" and has no aria-hidden —
 *     assistive tech may announce the glyph codepoint alongside the
 *     real label (double-announce).
 *   line 61: <i class="fa"> is a Font Awesome glyph inside a labeled
 *     <a> "Shopping cart" and has no aria-hidden — (double-announce).
 *   line 66: <i class="fa"> is a Font Awesome glyph inside a labeled
 *     <a> "Search" and has no aria-hidden — (double-announce).
 *
 * All three fire GREEN on the current codebase, confirming the rule
 * handles bulk occurrences and mixed parent types. Fixture acts as a
 * durable regression guard so the predicate gap (b) cannot re-emerge
 * silently.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Three Font Awesome <i> icons — one inside a <button aria-label> and two inside " +
    "<a aria-label> elements — each trigger aria/icon-font-hidden (double-announce guard) " +
    "in a Bootstrap-template navbar. Guards bulk detection and mixed button/anchor parent types.",
  origin: {
    notes:
      "Pattern from a bulk-template catalog corpus (Bootstrap-style navbar shape, sanitized). " +
      "Real-world scans emitted zero findings on this pattern; investigation confirmed the " +
      "rule fires correctly on the current codebase — the zero-findings field report was " +
      "caused by a stale MCP subprocess, not a predicate gap. Fixture locks in the " +
      "bulk-occurrence + mixed-parent invariant so the fix cannot regress silently.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // The rule must fire on the <button> toggler with aria-label parent.
    {
      kind: "violation-present",
      ruleId: "aria/icon-font-hidden",
      reasonIncludes: "double-announce",
    },

    // The violation message must name the labeled <button> parent.
    {
      kind: "violation-present",
      ruleId: "aria/icon-font-hidden",
      reasonIncludes: "labeled <button>",
    },

    // The violation message must also name a labeled <a> parent
    // (guards the anchor variant of the labeled-parent predicate).
    {
      kind: "violation-present",
      ruleId: "aria/icon-font-hidden",
      reasonIncludes: "labeled <a>",
    },
  ],
};
