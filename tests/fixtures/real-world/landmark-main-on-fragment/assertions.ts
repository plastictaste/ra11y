/**
 * landmark-main-on-fragment — guards the doctrine "Reason text and
 * severity must agree" (conceded-uncertainty extension) against
 * regression on layout-partial substrates that emit a verify-in-source
 * `couldBeWrongBecause` token.
 *
 * Bug shape: `semantics/landmark-main` fires on a Jekyll-style
 * `_layouts/default.html` shell (with `<html>` envelope, `<body>`,
 * sibling landmarks, and a `{{ content }}` composition directive but no
 * `<main>`) and ships at `severity: warning` with
 * `couldBeWrongBecause: ["partial_or_layout_file_requires_composed_check"]`.
 * The reason concedes that the `<main>` may live in a sibling partial
 * the static scanner cannot see; the agent budgets against the warning,
 * reads the conceded reason, and discovers the budget was wasted.
 * Doctrine: a finding shipping a curated verify-in-source token must
 * downgrade to `severity: info` (with `confidence: low`) so the
 * attention-budget signal matches the conceded uncertainty. Pairs with
 * `manualCriteriaTally`'s expectation (the comment at
 * `src/mcp/manual-criteria-tally.ts` named `VERIFY_IN_SOURCE_TOKENS`)
 * that every token in that set rides at `severity: info` so the
 * cross-surface manual-review actionable count agrees on the same
 * substrate.
 *
 * Closure path chosen: structural couple-severity-to-verify-tokens at
 * the response-pipeline layer (`src/mcp/violation-severity-coupling.ts`),
 * applied once on the violation stream upstream of both the AgentFinding
 * pipeline and the manual-review tally so the wire shape and the tally
 * see the same severity. Per AI-first consumer doctrine "Reason text
 * and severity must agree" + "Cross-surface count invariant" — fixing
 * the contradiction at the rule-emission site would diverge across the
 * five rules with this shape (case (a)-(e) in the backlog) and risk the
 * tally walking a different stream.
 *
 * What the fixture locks in:
 *   - The rule still fires on this file (silent-miss regression guard
 *     — the doctrine never suppresses, only enriches and downgrades).
 *   - The post-enrichment AgentFinding ships at `severity: info` and
 *     `confidence: low`.
 *   - The structured `partial_or_layout_file_requires_composed_check`
 *     token is on `couldBeWrongBecause` so the agent can route on the
 *     code without parsing prose.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "semantics/landmark-main on a Jekyll `_layouts/default.html` shell with `{{ content }}` " +
    "composition directive must surface (not be silently suppressed) but downgrade to " +
    "severity:info / confidence:low when the per-finding response carries the " +
    "`partial_or_layout_file_requires_composed_check` verify-in-source token, so the " +
    "attention-budget signal matches the conceded reason.",
  origin: {
    notes:
      "Sanitized from the canonical Jekyll / Hugo / Eleventy `_layouts/default.html` " +
      "shape: an authored layout file that opens `<html>`/`<body>`, supplies sibling " +
      "landmarks (`<header>`, `<footer>`), and composes child content via " +
      "`{{ content }}`. The `<main>` typically lives in the post template the layout " +
      "wraps; the scanner cannot see that composition. Pre-fix the rule emitted at " +
      "`severity: warning` while the reason text conceded the `<main>` may live in a " +
      "sibling file — the canonical 'reason text and severity must agree' contradiction.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface-don't-suppress: the finding must still fire so the agent
    // sees the substrate. Silent skip on a layout-partial shell would
    // be indistinguishable from "clean scan."
    { kind: "violation-present", ruleId: "semantics/landmark-main" },

    // Per-finding shape: severity must downgrade to `info` and
    // confidence to `low` on the formatted files surface, paired with
    // the structured verify-in-source token. The structural coupling
    // pass at the response-pipeline layer is what makes this true —
    // the rule's emit-site severity stays `warning` because rule code
    // is shared across the five backlog cases (a)-(e); the coupling
    // pass normalizes downstream.
    {
      kind: "finding-shape",
      ruleId: "semantics/landmark-main",
      inFile: "_layouts/default.html",
      severity: "info",
      confidence: "low",
      couldBeWrongBecauseIncludes: "partial_or_layout_file_requires_composed_check",
    },
  ],
};
