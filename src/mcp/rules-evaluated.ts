/**
 * Canonical builder for the `meta.rulesEvaluated` shape surfaced by
 * every scan-family / scan-derivative MCP tool.
 *
 * Before Q4-RULES-EVALUATED-COMPOSITE this field was a single number
 * that read as "rules that ran" but actually counted every loaded /
 * post-standard-filter rule regardless of whether it had any eligible
 * inputs in the scan. On a pure-HTML/SSG project, dozens of React-
 * specific rules reported `filesEligible: 0` under `perRuleCoverage` —
 * the composite "52 evaluated" headline inflated the work the agent
 * budgeted against because the summary number didn't split categorically
 * different sub-buckets. Per the AI-first doctrine in
 * `docs/kb/architecture/ai-first-consumer.md`, "Composite headline
 * counts are dishonest": if a top-level counter names one concept, it
 * must count one kind of thing.
 *
 * The shape splits into three honest sub-counters:
 *
 *   - `loaded`: total rules the scanner had available after the config
 *     on/off filter (i.e. `activeRules.length`). This is the ceiling —
 *     everything else is a subset.
 *   - `withEligibleInputs` (optional): rules whose input-filter matched
 *     at least one scanned file — `perRuleCoverage.filter(r =>
 *     r.filesEligible > 0).length`. Omitted when the caller has no
 *     `perRuleCoverage` to derive from (e.g. `list_suppressions`,
 *     `propose_config` — tools that don't scan or do scans the tool
 *     doesn't retain coverage for).
 *   - `fired` (optional): rules that emitted at least one finding —
 *     `perRuleCoverage.filter(r => r.findingsEmitted > 0).length`.
 *     Same conditional-spread rule as `withEligibleInputs`.
 *
 * Monotone invariant when all three are present:
 *   `fired <= withEligibleInputs <= loaded`.
 *
 * Conditional-spread on the optional fields follows CLAUDE.md §1
 * "Ambiguous field shapes are dishonest" — a tool that can't honestly
 * compute `withEligibleInputs` / `fired` omits them entirely rather
 * than emitting `0` or `null` that an agent would silently treat as
 * real data.
 */

import type { PerRuleCoverage } from "../types/violation.ts";

/**
 * Structured `rulesEvaluated` meta field. `loaded` is always populated;
 * the other two ride under conditional spread per this module's contract.
 */
export interface RulesEvaluated {
  readonly loaded: number;
  readonly withEligibleInputs?: number;
  readonly fired?: number;
}

/**
 * Builds the canonical `rulesEvaluated` object.
 *
 * Tools that ran the scanner and carry the per-rule coverage array pass
 * it in so the helper can derive the `withEligibleInputs` / `fired`
 * sub-counters; tools that don't (e.g. `list_suppressions`,
 * `propose_config` top-level meta, `apply_fix` when threading is out
 * of scope) omit it and get back a single-field `{ loaded }` object.
 *
 * `withEligibleInputs` counts per-rule coverage rows where
 * `filesEligible > 0` — the "this rule had something to look at" signal.
 * Project-scoped rules whose only lifecycle is `afterProject` always
 * synthesize `filesEligible = filesScanned`, so a scan with zero
 * parseable files would surface `withEligibleInputs: 0` honestly
 * instead of inflating by the project-scoped-rule count.
 *
 * `fired` counts per-rule coverage rows where `findingsEmitted > 0`
 * — the set of rules that actually produced a violation on this scan.
 * Zero is a meaningful signal ("rule ran, saw eligible inputs, didn't
 * flag anything") paired with `coverageConfidence` in the underlying
 * `perRuleCoverage` rows.
 */
export function buildRulesEvaluated(args: {
  readonly loadedCount: number;
  readonly perRuleCoverage?: readonly PerRuleCoverage[];
}): RulesEvaluated {
  const { loadedCount, perRuleCoverage } = args;
  if (perRuleCoverage === undefined) {
    return { loaded: loadedCount };
  }
  let withEligibleInputs = 0;
  let fired = 0;
  for (const row of perRuleCoverage) {
    if (row.filesEligible > 0) withEligibleInputs += 1;
    if (row.findingsEmitted > 0) fired += 1;
  }
  return {
    loaded: loadedCount,
    withEligibleInputs,
    fired,
  };
}
