/**
 * contact-form-title-tooltip-orphan — locks in the
 * V1-RULE-FORM-LABEL-ADJACENT-INPUT-WITHOUT-ID fix observed on a
 * real Bootstrap-derived contact template.
 *
 * Symptom: a five-row contact form had four <label>/<input> pairs and
 * one <label>/<textarea> pair, all visually labeled but none
 * programmatically associated. The rule fired on the textarea row
 * only — the four high-volume <input> rows were silently missed.
 *
 * Root cause: every <input> in the form carried a `title=` tooltip
 * attribute (Bootstrap's pattern for inline validation hints). The
 * rule's "is the control already labeled some other way" predicate
 * treated `title=` as a sufficient accessible name and bailed before
 * checking the adjacency shape — so the orphan-label intent the
 * author drew never surfaced as a finding. The textarea, which had
 * no `title=`, fired normally.
 *
 * Fix: drop `title=` from the predicate. `aria-label` and
 * `aria-labelledby` remain honest "developer chose a different
 * accessible name intentionally" signals, but `title` is a
 * tooltip-only fallback that does not override the visual `<label>`
 * sibling the author drew. The adjacency shape is the signal; the
 * fix is mechanical (synthesize id from label text + add for=).
 *
 * Invariant this fixture guards: every visible label/control pair
 * fires `forms/label-adjacent-unassociated` regardless of whether
 * the control carries `title=`.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Bootstrap contact-form orphan shape with `title=` tooltips on each " +
    "<input>. The rule must fire on every label/control pair (including " +
    "the title-bearing inputs), not only on the title-less textarea row.",
  origin: {
    notes:
      "BizPage-style contact template (sanitized). Five form-row pairs: " +
      "Name/Email/Subject/Phone (all <input>, all carry `title=`) and " +
      "Message (<textarea>, no title). Before the fix the predicate " +
      "treated `title=` as an existing accessible name and skipped the " +
      "four input rows — only the textarea row fired. The miss is the " +
      "highest-volume FN observed on this input set; the canonical " +
      "Bootstrap form-validation tooltip pattern propagates the bug to " +
      "every contact page derived from these templates.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "your-name",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "your-email",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "subject",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "phone",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "message",
    },
  ],
};
