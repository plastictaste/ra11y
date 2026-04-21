/**
 * website-templates-aria-labelledby-dangling — guards that
 * `aria/labelledby-target-exists` fires when a Bootstrap 3 modal carries
 * `aria-labelledby="myModalLabel"` but no element in the document has
 * `id="myModalLabel"`.
 *
 * The pattern appears verbatim in the website-templates field corpus
 * (coffee-shop-free-html5-template/index.html line 162). The `<h4>` inside
 * the modal carries `class="modal-title"` but never `id="myModalLabel"` —
 * the wire-up is silently dead. Screen readers fall back to the dialog's
 * role announcement ("dialog") with no accessible name.
 *
 * This fixture locks in the positive-detection shape:
 *   - The rule fires (does not silently miss the dangling reference).
 *   - The violation message names the missing id ("myModalLabel") so the
 *     agent knows exactly which attribute to fix.
 *
 * The field test observed the rule as non-firing (stale MCP subprocess).
 * Probing against current src/ confirms the rule fires correctly.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'aria-labelledby="myModalLabel" on a role="dialog" element that has no ' +
    "matching id in the document triggers aria/labelledby-target-exists, naming " +
    "the broken token so the agent knows the exact fix (add id or correct the reference).",
  origin: {
    feedbackRound: "Q6-RULE-ARIA-REF-MISMATCH-WIDEN-ATTRS",
    notes:
      "Sanitized from coffee-shop-free-html5-template/index.html (website-templates corpus). " +
      'The modal header contains class="modal-title" but never id="myModalLabel". ' +
      "Field test observed as non-firing due to stale MCP subprocess; live probe on current " +
      "src/ confirms the rule fires and names the token.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "aria/labelledby-target-exists",
      reasonIncludes: "myModalLabel",
    },
  ],
};
