/**
 * navigation-link-no-href-on-href-empty-fragment — guards that
 * `navigation/link-no-href` fires only when the `href` attribute is
 * genuinely absent, not when it carries `href="#"` or another empty-
 * fragment value. The empty-fragment case is owned by
 * `navigation/href-empty-fragment`; emitting both rules at the same
 * line under contradictory message text ("with no href" while the
 * snippet shows `href="#"`) is dishonest, and findings double-emit
 * for the same conceptual problem.
 *
 * Bug shape: a vanilla-stack component-demo HTML page with a row of
 * `<a class="nav-link" href="#">…</a>` placeholder anchors produced
 * findings from `navigation/link-no-href` at `severity: error,
 * confidence: high` whose message text claimed `with no href` while
 * the same line of source was visibly `href="#"`. The same line
 * separately emitted `navigation/href-empty-fragment` — two rules
 * firing on one element with contradictory framing.
 *
 * Closure path (per "Reason text and severity must agree" extended
 * to message vs evidence): tighten the `navigation/link-no-href`
 * predicate to fire only when the `href` attribute is genuinely
 * absent. Let `navigation/href-empty-fragment` own `href="#"`,
 * `href=""`, and `href="javascript:…"` cases. The two rules become
 * non-overlapping and the message text matches the evidence.
 *
 * Fixture is RED (`todo: true`) until the predicate is tightened.
 * The first six anchors carry `href="#"` (or a real fragment / URL);
 * only the last one has the `href` attribute genuinely absent.
 * `navigation/link-no-href` must fire for the last anchor and stay
 * silent on the rest.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "navigation/link-no-href must fire only when the href attribute is genuinely " +
    'absent. Anchors carrying href="#" are owned by navigation/href-empty-fragment; ' +
    "the two rules must be non-overlapping. Today's emission contradicts its own " +
    "message text on the empty-fragment cases.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep on a vanilla-stack component-demo HTML page " +
      "observed navigation/link-no-href firing at severity:error, confidence:high " +
      'on rows of <a class="nav-link" href="#">…</a> placeholders. The rule\'s ' +
      'message read "with no href" while the snippet showed href="#" — message ' +
      "and evidence contradicted on the same line.",
  },
  // Intentionally RED — until the predicate is tightened, the rule fires on every
  // href="#" anchor and the no-violation assertion below fails. The
  // `violation-present` row pinned to the genuinely-missing-href anchor is the
  // load-bearing baseline that confirms the rule still fires when it should.
  todo: true,
  expectations: [
    { kind: "zero-parse-errors" },

    // The rule MUST still fire on the genuinely-missing-href anchor (line 13 in
    // source/index.html). If a future fix accidentally suppresses the rule
    // entirely instead of just on href="#" anchors, this lock-in catches it.
    {
      kind: "violation-present",
      ruleId: "navigation/link-no-href",
      reasonIncludes: "Genuinely missing href",
    },

    // The rule MUST NOT fire on anchors carrying href="#" — let
    // navigation/href-empty-fragment own that case. This is the load-bearing
    // assertion the fix must satisfy.
    {
      kind: "violation-present-without",
      ruleId: "navigation/link-no-href",
      reasonExcludes: "First",
    },
  ],
};
