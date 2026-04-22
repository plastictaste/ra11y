/**
 * Derives the set of criterion IDs whose satisfying rules had at least
 * one eligible input file on this scan. Paired with
 * {@link import("../reports/coverage.ts").buildCoverageReport}'s
 * `testableCriteria` option so the coverage report can split the
 * automatable-pass lane into `clean` ("ran + zero findings") vs.
 * `untestable` ("rule declared extension eligibility but zero applicable
 * input").
 *
 * Closely mirrors `deriveFiredCriteria` in `tool-vpat.ts` — the gate
 * condition is the only difference:
 *   - {@link deriveFiredCriteria} uses `filesEvaluated > 0` (the rule
 *     actually ran on ≥1 file and therefore produced evidence a VPAT
 *     reader can cite).
 *   - {@link deriveTestableCriteria} uses `filesEligible > 0` — "the
 *     rule had applicable input," which is the correct denominator
 *     signal for the Q-SHARED-PASS-RATE-COMPOSITE fix (the pass rate
 *     should sink only when a rule saw input and didn't flag it, not
 *     when a rule targeted `.css` in a Tailwind source tree with zero
 *     authored CSS files).
 *
 * Closure over `equivalentTo` so a rule satisfying `wcag22:1.4.3` also
 * marks `section508:1194.22.c` / `en301549:9.1.4.3` as testable —
 * matches the multi-standard model in CLAUDE.md §6.
 *
 * Rules absent from `perRuleCoverage` have no extension gate (project-
 * scoped `afterProject` rules ALSO appear in `perRuleCoverage` — see
 * `buildPerRuleCoverage` — but the fallback is kept for the rare case
 * where instrumentation skips a rule, so the helper errs on the side of
 * "present as testable" when coverage data is missing).
 *
 * `filesScanned === 0` falls through with an empty set so a scanner-
 * never-ran scan doesn't silently mark every criterion as testable.
 */

import type { CriteriaRegistry } from "../engine/registry/criteria.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";

export function deriveTestableCriteria(
  rules: readonly Rule[],
  perRuleCoverage: readonly PerRuleCoverage[],
  criteria: CriteriaRegistry,
): ReadonlySet<string> {
  const coverageByRuleId = new Map<string, PerRuleCoverage>();
  for (const entry of perRuleCoverage) {
    coverageByRuleId.set(entry.ruleId, entry);
  }
  const testable = new Set<string>();
  for (const rule of rules) {
    const coverage = coverageByRuleId.get(rule.id);
    // Coverage entry present: honor its eligibility verdict.
    // Absent: fall through — the rule is active and we can't disprove
    // eligibility from the coverage index alone, so mark as testable
    // (the rule would only be absent if the engine skipped
    // instrumentation, which is not a claim-making signal).
    if (coverage !== undefined && coverage.filesEligible === 0) continue;
    for (const declared of rule.satisfies) {
      for (const c of criteria.equivalenceClosure(declared)) testable.add(c);
    }
  }
  return testable;
}
