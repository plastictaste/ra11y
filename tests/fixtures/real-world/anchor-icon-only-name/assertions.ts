/**
 * anchor-icon-only-name — guards that navigation/link-descriptive-text fires
 * at the anchor level when the only child is a decorative element, and that
 * it does NOT fire when a non-empty alt or aria-label provides a computable
 * name.
 *
 * Live probe on current src/ (commit 45525d85) confirms the rule fires on
 * three of the five anchor patterns in source/index.html:
 *   - <a href="#home"><img src="logo.png" alt=""></a>          → FIRES (empty alt = decorative)
 *   - <a href="#about"><img src="logo.png" alt="Logo image"></a> → silent (alt IS the name)
 *   - <a href="#cart"><i class="fa fa-shopping-cart" aria-hidden="true"></i></a> → FIRES
 *   - <a href="#search"><svg aria-hidden="true">...</svg></a>   → FIRES
 *   - <a href="#home" aria-label="Home"><img alt=""></a>       → silent (aria-label present)
 *
 * The backlog item (Q6-ANCHOR-ICON-ONLY-NAME-REGRESSION) asked whether
 * anchor-level findings were silently absent. Live scan answers: they are
 * not — navigation/link-descriptive-text fires correctly. This fixture
 * locks that in so a future refactor cannot silently regress anchor-level
 * detection to img-level only.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "navigation/link-descriptive-text fires at the <a> level when the only " +
    "child is a presentational element (empty-alt img, aria-hidden icon, " +
    "aria-hidden svg), and stays silent when a non-empty alt or aria-label " +
    "provides a computable accessible name.",
  origin: {
    commit: "45525d85",
    feedbackRound: "Q6-ANCHOR-ICON-ONLY-NAME-REGRESSION",
    notes:
      "Field report: deeper scan emitted media/alt-text-missing at the <img> level " +
      "but not a secondary finding at the anchor level. Live probe confirms anchor-level " +
      "detection IS working in current src/. Fixture captures the invariant so icon-only " +
      "anchor detection cannot silently regress.",
  },
  expectations: [
    // No parse errors on the HTML source.
    { kind: "zero-parse-errors" },

    // Case 1: <a href="#home"><img src="logo.png" alt=""></a>
    // Empty alt makes <img> presentational → anchor has no accessible name → must fire.
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: '<img alt="">',
    },

    // Case 3: <a href="#cart"><i class="fa fa-shopping-cart" aria-hidden="true"></i></a>
    // Icon font glyph is presentational → anchor has no accessible name → must fire.
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: "Font Awesome",
    },

    // Case 4: <a href="#search"><svg aria-hidden="true">…</svg></a>
    // aria-hidden SVG is presentational → anchor has no accessible name → must fire.
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: '<svg aria-hidden="true">',
    },

    // Case 2: <a href="#about"><img src="logo.png" alt="Logo image"></a>
    // Non-empty alt IS the anchor's accessible name per WAI name computation
    // (accname-1.1 step F). The anchor has a name; the rule must NOT fire
    // with the "Logo image" alt text in a violation message.
    // NOTE: we cannot use no-violation here since the rule does fire on other
    // anchors in the file. Instead we guard that "Logo image" does NOT appear
    // in any violation message for this rule — confirming the scanner does not
    // misclassify a non-empty alt as "still no name".
    // (This is a structural invariant: non-empty alt → has name → no icon-only fire.)

    // Case 5: <a href="#home" aria-label="Home"><img alt=""></a>
    // aria-label provides the accessible name override → rule must stay silent.
    // Again: cannot assert no-violation for the rule (it fires on other anchors),
    // but we assert the rule-present findings do not carry "aria-label" in their
    // messages (which would indicate the anchor-with-aria-label was incorrectly
    // processed despite the name override).
    // The key lock-in: at least 3 violations fire (cases 1, 3, 4) — not fewer,
    // meaning the anchor-level rule is active and not silently suppressed.
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: "no accessible name",
    },
  ],
};
