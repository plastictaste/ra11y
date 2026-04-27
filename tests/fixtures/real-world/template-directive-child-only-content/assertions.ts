/**
 * template-directive-child-only-content — locks the conceded-uncertainty
 * shape on the canonical Jekyll/Liquid post-list pattern:
 *
 *     <h2 itemprop="headline">
 *       <a href="{{ post.url }}">{{- post.title -}}</a>
 *     </h2>
 *
 * Both `semantics/empty-heading` and `navigation/link-descriptive-text`
 * fire on this shape: the heading's only descendant text is the inner
 * link's body, and the link's only body is a stripped Liquid expression
 * the static scanner cannot resolve. Per the AI-first consumer doctrine
 * ("Reason text and severity must agree" + "Heuristic emission is the
 * symmetric twin of heuristic suppression"), each finding must surface
 * but at conceded-uncertainty severity (`warning`) with reason text
 * framing the binding-resolves question rather than asserting "empty"
 * or "no accessible name."
 *
 * Invariants this fixture guards:
 *   - Both rules surface findings (surface-don't-suppress).
 *   - Each finding's reason names the template-directive uncertainty so
 *     an agent reading the message routes to "verify rendered output"
 *     instead of looping through suggest_fix on a false positive.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Heading wrapping a link whose only content is a stripped Liquid " +
    "expression must surface from BOTH rules (empty-heading and " +
    "link-descriptive-text) at conceded-uncertainty framing — the " +
    "reason text frames the rendered-output question rather than " +
    "asserting empty/no-name.",
  origin: {
    notes:
      "Jekyll / Eleventy / Hugo post-list templates ship this pattern " +
      "site-wide. The previous shape emitted `empty-heading` at " +
      "`error` and the link finding read 'no accessible name' even " +
      "though the only evidence was a stripped Liquid expression — " +
      "the static scanner has no runtime evidence the binding is " +
      "empty. Per the AI-first consumer doctrine, the rule must " +
      "demote severity to match the conceded uncertainty.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "semantics/empty-heading",
      reasonIncludes: "interpolated",
    },
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: "interpolated",
    },
  ],
};
