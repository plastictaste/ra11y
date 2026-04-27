/**
 * verify-account-otp-cluster-collapse — guards the
 * `forms/labels-required` rule-emission dedupe contract for visually-
 * grouped sibling input clusters.
 *
 * Canonical repro: a one-time-code (OTP) entry — six
 * `<input class="otp" type="number" maxlength="1">` siblings sharing
 * one parent `<form>`, each missing a label and each carrying a unique
 * `id`. Before collapse, `forms/labels-required` emitted six findings
 * with identical `groupKey` and identical fix shape. Per the AI-first
 * consumer model this is honest pattern aggregation: the four
 * preconditions for collapse — same parent, same `(tagName, type,
 * attributes-modulo-id)` fingerprint, ≥3 siblings, all fail the label
 * check — are deterministic from the AST. The agent reads ONE finding
 * carrying `siblingInstances: [{ line, id }, …]` enumerating every
 * sibling, instead of six near-identical rows.
 *
 * What the fixture locks in:
 *   - Zero parse errors.
 *   - The rule still surfaces (surface-don't-suppress — the
 *     consolidated finding must remain visible). A regression that
 *     suppressed the entire cluster would trip this assertion.
 *   - The collapsed finding's message names the rollup shape so an
 *     agent reading the message alone knows it is one finding standing
 *     in for N siblings — and knows to read `siblingInstances` for the
 *     per-sibling line/id trail.
 *
 * Pairs with the closed
 * (review-finder image variant) and
 * (review-finder cluster detection). Those address the cluster-
 * detection axis on the review surface; this one is the rule-emission
 * dedupe axis on the violation surface.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "forms/labels-required collapses 6 OTP-shaped <input> siblings sharing the same parent " +
    "and the same (tagName, type, attributes-modulo-id) fingerprint into ONE canonical " +
    "finding carrying `siblingInstances` for the per-sibling line/id trail.",
  origin: {
    notes:
      "Sanitized from a verify-account UI's six <input class='otp' type='number' " +
      "maxlength='1'> sibling cluster. Pairs with " +
      "(closed, image variant) and (closed, OTP review " +
      "finder). The unit suite at tests/unit/rules/forms/labels-required.test.ts covers " +
      "the count contract (6 → 1 with siblingInstances of length 6); this fixture guards " +
      "the rule still fires end-to-end on the canonical cluster shape.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface, don't suppress: collapse reduces 6 findings to 1, but
    // the 1 still fires. A regression that hid the cluster (silent-miss
    // failure) would trip this.
    {
      kind: "violation-present",
      ruleId: "forms/labels-required",
      reasonIncludes: "siblingInstances",
    },

    // The collapsed finding's message names the rollup count so an
    // agent reading the message alone learns it is a grouped finding.
    {
      kind: "violation-present",
      ruleId: "forms/labels-required",
      reasonIncludes: "5 adjacent sibling",
    },
  ],
};
