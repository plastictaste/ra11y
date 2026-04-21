/**
 * 50p-radio-group-naked-name-sharing — guards that
 * `forms/radio-group-without-fieldset` fires when four
 * `<input type="radio" name="answer">` inputs share a name attribute
 * but have no wrapping `<fieldset>+<legend>` and no `role="radiogroup"`
 * container.
 *
 * The "naked name-sharing" pattern is the most common radio-group bug:
 * the author groups radios by `name` (which makes them mutually exclusive
 * in the form submission model) but omits the programmatic grouping that
 * exposes the relationship to assistive technology. Without a wrapper,
 * screen readers announce each option individually ("Option A, radio
 * button, 1 of unknown") with no indication that the choices answer a
 * specific question.
 *
 * The `forms/fieldset-legend` rule covers the "has a fieldset but
 * no legend" variant; this fixture guards the "no wrapper at all" case —
 * the baseline that turn-31 (Q5-RADIO-GROUP-FIELDSET) introduced.
 *
 * What the fixture locks in:
 *   - The rule fires on four radios sharing `name="answer"` with no
 *     `<fieldset>`, `<legend>`, `role="radiogroup"`, or `aria-labelledby`.
 *   - The violation message names the `answer` group so the agent knows
 *     which set of inputs to fix.
 *   - Zero parse errors.
 *
 * Source: 50projects50days/17-quiz-app/index.html (sanitized).
 * Option labels replaced with generic placeholders; quiz logic removed.
 * Field test observed as non-firing due to stale MCP subprocess.
 * Live probe on current src/ confirms the rule fires correctly.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'Four <input type="radio" name="answer"> with individual <label> elements but no ' +
    '<fieldset>+<legend> and no role="radiogroup" wrapper triggers ' +
    "forms/radio-group-without-fieldset (naked name-sharing case).",
  origin: {
    feedbackRound: "Q5-RADIO-GROUP-NAKED-NAME-SHARING",
    notes:
      "Sanitized from 50projects50days/17-quiz-app/index.html. Labels preserved; option text " +
      "replaced with generic placeholders. No structural rewrite — the HTML skeleton is faithful " +
      "to the original: four radios inside <li> elements, no fieldset anywhere in the tree. " +
      "Field test observed as non-firing due to stale subprocess; live probe confirms detection.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "forms/radio-group-without-fieldset",
      reasonIncludes: "answer",
    },
  ],
};
