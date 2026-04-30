/**
 * bootstrap-floating-label-select — guards against a false positive
 * observed on twbs/bootstrap at
 * site/src/assets/examples/floating-labels/floating-label.html:77.
 *
 * A <select class="form-select" aria-label="Floating label select
 * example"> with four <option> children fired the semantics/label-in-
 * name rule 18x across the scan (13.7% of total findings), claiming
 * the "visible text 'Open this select menu One Two Three'" was not
 * contained in the aria-label.
 *
 * Per HTML AAM and WCAG 2.5.3, <option> descendants of a <select>
 * are the widget's VALUE set — not the widget's visible label. A
 * <select>'s accessible name is its aria-label / aria-labelledby /
 * associated <label for>; its visible label for the Label-in-Name
 * comparison is the <label> element (or direct text), not the
 * option text. Harvesting <option> text as "visible label" is the
 * false-positive source.
 *
 * This fixture locks in the fix: zero `semantics/label-in-name`
 * findings on a canonical floating-label-select pattern. If the
 * rule ever re-introduces option-text harvesting for <select>, this
 * fixture goes red.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "<select aria-label='...'><option>...</option></select> pattern produces " +
    "zero semantics/label-in-name findings — <option> text is the widget's " +
    "value, not its visible label (HTML AAM / WCAG 2.5.3).",
  origin: {
    notes:
      "twbs/bootstrap site/src/assets/examples/floating-labels/floating-label.html:77. " +
      "The rule treated option text as the <select>'s visible label and " +
      "compared it against aria-label, firing 18x on this pattern (13.7% " +
      "of the total scan). Fix: exclude <option> descendant text when " +
      "computing a <select>'s visible label.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    { kind: "no-violation", ruleId: "semantics/label-in-name" },
  ],
};
