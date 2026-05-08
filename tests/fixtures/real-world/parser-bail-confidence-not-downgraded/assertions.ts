/**
 * parser-bail-confidence-not-downgraded — guards the invariant that
 * when a plain-JS file is routed through the TSX parser AND produces
 * zero findings (silent bail), every `meta.perRuleCoverage` row must
 * report non-`"high"` confidence.
 *
 * Bug shape: `scan_file` on a `.js` file routes through the TSX parser
 * (because the harness's extension dispatch aliases `.js` → `parseTsx`).
 * The TSX parser bails silently on relational expressions like
 * `items.length < limit` — the AST lands in `language: "tsx"` but the
 * file's natural parser is `"js"`. The scan produces zero rule-side
 * findings. Without the `applyParserBailRouteAdjustment` pass, every
 * `perRuleCoverage` row ships at `coverageConfidence: "high"` — the
 * per-rule label claims the rule observed full evidence, but the
 * routing-mismatch warning channel says the parser may have silenced
 * findings.
 *
 * The closure adds `applyParserBailRouteAdjustment` to the adjustment
 * cascade in `runScanAndFormat` so the same evidence that drives the
 * `scan_file_parser_bail_no_findings` warning also propagates to every
 * `perRuleCoverage` row crediting the bailed-route file.
 *
 * Assertions:
 *   1. The `warnings` meta array includes `scan_file_parser_bail_no_findings`.
 *   2. Every `perRuleCoverage` row (ruleId: "*") has
 *      `coverageConfidence !== "high"`.
 *
 * This fixture is marked `todo: true` because it is intentionally RED —
 * it captures the bug before the upstream `src/mcp/tools-helpers.ts`
 * fix lands. Once `applyParserBailRouteAdjustment` is wired into
 * `runScanAndFormat`, remove `todo` and the test will turn green.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A plain-JS file routed through the TSX parser (zero findings, routing mismatch) must " +
    "produce non-'high' coverageConfidence on every perRuleCoverage row, matching the " +
    "scan_file_parser_bail_no_findings warning that already fires in the warning channel.",
  origin: {
    notes:
      "Captures the Q15 bug: applyParserBailRouteAdjustment exists in per-rule-coverage-shared.ts " +
      "but was not wired into the runScanAndFormat adjustment cascade in tools-helpers.ts. " +
      "The warning channel reports the parser route ambiguity; the per-rule coverage layer " +
      "contradicts it by reporting high confidence on every row.",
  },
  toolInput: {
    verboseMeta: true,
  },
  // Intentionally RED — remove this flag once runScanAndFormat includes
  // applyParserBailRouteAdjustment in its per-rule-coverage cascade.
  todo: true,
  expectations: [
    // The harness must parse the .js file without recorded errors
    // (the TSX parser bails silently — no ast.errors, but the AST
    // evidence is degraded). This confirms the bail is silent, not
    // a hard parse-error.
    { kind: "zero-parse-errors" },

    // No rule-side violations expected — the file has no accessibility
    // patterns to flag. This confirms the "zero findings" predicate
    // that makes the routing-mismatch case qualify for downgrade.
    { kind: "no-violation", ruleId: "*" },

    // The meta warnings array must include the parser-bail code so the
    // agent knows the route was ambiguous. This is the warning-channel
    // side of the invariant — the per-rule side is the second assertion.
    {
      kind: "meta-field",
      path: ["warnings"],
      predicate: { contains: "scan_file_parser_bail_no_findings" },
    },

    // Every perRuleCoverage row must report non-"high" confidence.
    // The ruleId: "*" wildcard asserts the invariant corpus-wide
    // rather than for a single rule — a regression that preserves
    // "low" on one rule but silently keeps "high" on another would
    // still be caught here.
    //
    // This is the load-bearing assertion: it will FAIL until
    // applyParserBailRouteAdjustment is wired into runScanAndFormat.
    {
      kind: "per-rule-coverage-confidence",
      ruleId: "*",
      expected: "low",
      reasonIncludes: "parse-bailed-non-jsx-in-tsx-route",
    },
  ],
};
