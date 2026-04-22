/**
 * bootstrap-label-orphan-no-id — locks in the Q6-RULE-LABEL-ADJACENT-
 * UNASSOCIATED-NO-IDS fix on the canonical Bootstrap-template orphan
 * shape observed in website-templates' sb-admin/forms.html.
 *
 * The authoring pattern is pervasive: 12+ instances per form where a
 * `<label>Text Input</label>` sits immediately above an `<input>` that
 * carries NO id attribute at all. Before the widening, the rule only
 * fired when the input already had an id (so the agent could match it
 * against the absent for=) — real templates routinely omit the id and
 * the rule went silent, ceding the case to `forms/labels-required`'s
 * generic guidance. The richer "add for= + add id=" mechanical pair
 * never surfaced.
 *
 * Invariant this fixture guards: `forms/label-adjacent-unassociated`
 * fires on every orphan-shape pair in the file, even when neither
 * element carries an id. If a future refactor restores the old id-
 * required gate this fixture goes red.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Bootstrap-template orphan-label shape: `<label>Text Input</label>" +
    '<input class="form-control">` (no id on either element) must ' +
    "fire `forms/label-adjacent-unassociated` so the synthesized-id " +
    "mechanical pair reaches the agent.",
  origin: {
    notes:
      "website-templates sb-admin/forms.html:~142-230. The rule " +
      "previously required the input to already have an id so the " +
      "absent for= could be matched against it; real templates omit " +
      "the id, leaving 12+ high-value bugs unreported per form. Fix: " +
      "widen the adjacency predicate to fire regardless of id, and " +
      "synthesize an id from the label's visible text for the fix " +
      'pair (<label for="<synthesized>"> + <input id="<synthesized>">).',
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "text-input",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "password-input",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "email-address",
    },
    {
      kind: "violation-present",
      ruleId: "forms/label-adjacent-unassociated",
      reasonIncludes: "number-input",
    },
  ],
};
