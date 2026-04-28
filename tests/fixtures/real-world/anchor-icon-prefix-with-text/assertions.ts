/**
 * anchor-icon-prefix-with-text — guards that
 * `navigation/link-descriptive-text` stays silent on the canonical
 * icon-prefix-with-label pattern: a presentational icon child followed
 * by a sibling text node carrying the link's accessible name.
 *
 * Field report claimed the "every child is presentational" predicate
 * misclassifies `<a><i class="<icon>"></i> User Profile</a>` as
 * icon-only because the predicate walks element children only and
 * misses sibling text nodes. Live probe on current src/ shows the
 * predicate already walks both HtmlText and HtmlElement children
 * correctly — the bug is already fixed. The unit test at
 * `tests/unit/rules/navigation/link-descriptive-text.test.ts` ("icon
 * sits alongside descriptive text") encodes the invariant; this
 * fixture pins the same invariant at the full-scanner-pipeline layer
 * that survives refactors of the rule's internal AST helpers.
 *
 * Sibling fixture `anchor-icon-only-name` guards the positive invariant
 * (rule fires when no text accompanies the icon).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "navigation/link-descriptive-text stays silent when an anchor's " +
    "presentational icon child is followed by a sibling text node " +
    "carrying the accessible name (canonical labeled-icon-link pattern).",
  origin: {
    commit: "5c681b66",
    notes:
      "Field report claimed icon-prefix-with-text patterns " +
      '(`<a><i class="<icon>"></i> Label</a>`) misfire as icon-only. ' +
      "Live probe shows the rule's visible-text walker correctly handles " +
      "HtmlText siblings of presentational HtmlElement children. Fixture " +
      "guards against a future refactor narrowing the walker to elements only.",
  },
  expectations: [
    // No parse errors on the HTML source.
    { kind: "zero-parse-errors" },

    // The whole point of this fixture: every anchor on the page has
    // an accessible name (the text following the icon), so the rule
    // must stay completely silent on this file.
    {
      kind: "no-violation",
      ruleId: "navigation/link-descriptive-text",
    },
  ],
};
