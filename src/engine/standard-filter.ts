/**
 * Standard filter.
 *
 * Given an enabled set of standard IDs (and optionally an active
 * conformance level), computes:
 *
 *   1. Whether the rule should execute at all — is any criterion in
 *      `satisfies` (including its equivalence closure) owned by an
 *      enabled standard AND, if a level is set, at or below that level?
 *   2. The list of criterion IDs the rule should cite when producing
 *      violations, filtered to enabled standards only.
 *
 * Level gating is how the engine avoids firing AAA-only rules when the
 * caller asked for AA. A rule whose only cited criteria are higher than
 * the active level is skipped end-to-end — no wasted work, no spurious
 * "fix the contrast to 7:1" message when the user is targeting AA.
 * Section 508's `base` level is treated as always-matching because
 * Section 508 itself has no A/AA/AAA axis.
 *
 * This mechanism is how one rule can cover WCAG 2.2, WCAG 2.1,
 * Section 508, and EN 301 549 simultaneously, citing the right IDs
 * depending on what the user asked for.
 */

import type { Rule } from "../types/rule.ts";
import { titlesForCriteria } from "../utils/criteria-titles.ts";
import type { CriteriaRegistry } from "./registry/criteria.ts";

export type ConformanceLevel = "A" | "AA" | "AAA";

export interface StandardFilter {
  /** Should this rule execute under the enabled standards + level? */
  isRuleActive(rule: Rule): boolean;
  /** Criterion IDs the rule should cite, filtered to enabled standards. */
  citedCriteria(rule: Rule): readonly string[];
  /**
   * Human titles for {@link StandardFilter.citedCriteria}, aligned
   * index-for-index. Callers MUST pair the two by the same invocation
   * (both are deterministic for a given rule + filter state; the
   * alignment depends on the shared walker order). Unresolved IDs fall
   * back to the ID itself — never empty string. See `titlesForCriteria`.
   */
  citedCriteriaTitles(rule: Rule): readonly string[];
  /**
   * Diagnostic for an inactive rule: was the rule filtered out solely by
   * conformance level (every cited criterion under enabled standards is
   * strictly above the active level), and if so, what level does the
   * rule need? Returns `undefined` when the filter has no active level
   * (legacy behavior — every rule whose enabled-standard criteria set is
   * non-empty is active), or when the rule is inactive for a reason
   * other than level gating (no cited criteria belong to enabled
   * standards). Used by the per-rule-coverage builder to surface a
   * `skipReason: "gated_by_level"` row instead of letting the rule
   * disappear from the response (Q7-AAA-RULE-LOADER-SILENT-NORUN).
   */
  levelGateForInactiveRule(rule: Rule): LevelGateInfo | undefined;
}

/**
 * Diagnostic returned by {@link StandardFilter.levelGateForInactiveRule}
 * when a rule was inactive due to level gating. `requiredLevel` is the
 * lowest cited criterion level under enabled standards (the level a
 * caller would have to request for the rule to run); `requestedLevel`
 * is the filter's active level.
 */
export interface LevelGateInfo {
  readonly requiredLevel: ConformanceLevel;
  readonly requestedLevel: ConformanceLevel;
}

export function createStandardFilter(
  enabledStandards: ReadonlySet<string>,
  criteria: CriteriaRegistry,
  activeLevel?: ConformanceLevel,
): StandardFilter {
  return {
    isRuleActive(rule: Rule): boolean {
      for (const c of walkCitedCriteria(rule, criteria, enabledStandards)) {
        if (activeLevel === undefined) return true;
        const crit = criteria.get(c);
        if (crit && isCriterionAtOrBelow(crit.level, activeLevel)) return true;
      }
      return false;
    },

    citedCriteria(rule: Rule): readonly string[] {
      const cited = new Set<string>();
      for (const c of walkCitedCriteria(rule, criteria, enabledStandards)) cited.add(c);
      return [...cited].sort();
    },

    citedCriteriaTitles(rule: Rule): readonly string[] {
      const cited = new Set<string>();
      for (const c of walkCitedCriteria(rule, criteria, enabledStandards)) cited.add(c);
      const sorted = [...cited].sort();
      return titlesForCriteria(sorted, (id) => criteria.get(id)?.title);
    },

    levelGateForInactiveRule(rule: Rule): LevelGateInfo | undefined {
      // Level gating only applies when the filter has an active level.
      // Without one, an inactive rule was inactive for the orthogonal
      // "no cited criteria belong to enabled standards" reason, which
      // this diagnostic does not cover (the per-rule-coverage builder
      // skips that rule rather than synthesizing a level-gate row that
      // would be a lie).
      if (activeLevel === undefined) return undefined;
      const lowest = lowestCitedLevel(rule, criteria, enabledStandards);
      if (lowest === undefined) return undefined;
      // The lowest cited criterion is at-or-below the active level →
      // the rule should have been active. This branch is unreachable
      // when `isRuleActive` returned false, but the guard keeps the
      // helper honest if a future caller invokes it without checking
      // activity first.
      if (LEVEL_RANK[lowest] <= LEVEL_RANK[activeLevel]) return undefined;
      return { requiredLevel: lowest, requestedLevel: activeLevel };
    },
  };
}

/**
 * Iterates every criterion (via equivalence closure) a rule satisfies
 * that belongs to an enabled standard. Extracted so the two filter
 * methods share one walker and stay within the complexity budget.
 */
function* walkCitedCriteria(
  rule: Rule,
  criteria: CriteriaRegistry,
  enabledStandards: ReadonlySet<string>,
): Iterable<string> {
  for (const declared of rule.satisfies) {
    for (const c of criteria.equivalenceClosure(declared)) {
      const standardId = c.split(":")[0];
      if (!(standardId && enabledStandards.has(standardId))) continue;
      yield c;
    }
  }
}

const LEVEL_RANK: Readonly<Record<ConformanceLevel, number>> = { A: 1, AA: 2, AAA: 3 };

/**
 * Returns the lowest A/AA/AAA level cited by `rule` under enabled
 * standards, or `undefined` when:
 *
 *   - no cited criterion resolves to an enabled standard (the rule is
 *     inactive for the orthogonal "no enabled-standard criterion"
 *     reason, not level gating); OR
 *   - any cited criterion is `base`-level (Section 508 / EN 301 549
 *     style standards without an A/AA/AAA axis pass the level filter
 *     unconditionally, so the rule should have been active and the
 *     gate diagnostic must not lie about a `requiredLevel`).
 *
 * Used by {@link StandardFilter.levelGateForInactiveRule} to decide
 * whether to surface a structured `skipReason: "gated_by_level"` row
 * for a rule the per-rule-coverage builder otherwise drops
 * (Q7-AAA-RULE-LOADER-SILENT-NORUN).
 */
function lowestCitedLevel(
  rule: Rule,
  criteria: CriteriaRegistry,
  enabledStandards: ReadonlySet<string>,
): ConformanceLevel | undefined {
  let lowestRank: number | undefined;
  let lowestLevel: ConformanceLevel | undefined;
  for (const c of walkCitedCriteria(rule, criteria, enabledStandards)) {
    const crit = criteria.get(c);
    if (!crit) continue;
    if (crit.level === "base") return undefined;
    const rank = LEVEL_RANK[crit.level as ConformanceLevel];
    if (rank === undefined) continue;
    if (lowestRank === undefined || rank < lowestRank) {
      lowestRank = rank;
      lowestLevel = crit.level as ConformanceLevel;
    }
  }
  return lowestLevel;
}

/**
 * True when a criterion's level is at or below the active level, i.e.
 * should run when the caller asked for `activeLevel`. `base` covers
 * standards without an A/AA/AAA axis (Section 508) and is treated as
 * always-active. Unknown levels pass through so a future standard with
 * a novel taxonomy isn't silently dropped.
 */
function isCriterionAtOrBelow(criterionLevel: string, activeLevel: ConformanceLevel): boolean {
  if (criterionLevel === "base") return true;
  const critRank = LEVEL_RANK[criterionLevel as ConformanceLevel];
  if (critRank === undefined) return true;
  return critRank <= LEVEL_RANK[activeLevel];
}
