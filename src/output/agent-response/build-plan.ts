/**
 * buildAgentPlan — violations + pre-built findings → AgentPlan headline.
 *
 * Emits two honest fix counters on the plan:
 *
 *   - `mechanicalEditsAvailable` — violations that ship an inline
 *     `fixPaths.primary.edit`, i.e. work `apply_fix` can batch-apply
 *     without a round-trip.
 *   - `fixesByClass` — a structured tally keyed by the rule-level
 *     `fixClass`: `{ mechanical, guidance, runtimeOnly, verifyInSource }`.
 *     Each key counts one kind of thing, per CLAUDE.md §1 "Composite
 *     headline counts are dishonest."
 *
 * The former `guidanceFixesAvailable` counter summed four categorically
 * different `fixClass` lanes under one label — any violation with a prose
 * `suggestion` but no mechanical edit landed in the same bucket whether it
 * was a `guidance`, `runtime-only`, or `verify-in-source` rule. Agents
 * budgeting against the headline treated all of them as "things
 * `suggest_fix` can help with," which was wrong for the latter two lanes.
 * Exposing the fixClass tally as a structured sibling lets the agent
 * budget per-lane without a guess.
 *
 * Effort is computed from the combined count of violations that carry
 * any actionable remediation (mechanical edit or prose-only guidance),
 * preserving the semantics of the former `mechanicalEditsAvailable +
 * guidanceFixesAvailable` sum.
 *
 * `buildSummary` breaks the violations parenthetical down by the
 * rule-level `fixClass` lane via the shared helper in
 * `./fix-class-breakdown.ts` so MCP and CLI emit the same format.
 */

import type { FixClass } from "../../types/rule.ts";
import type { Violation } from "../../types/violation.ts";
import { buildFixClassBreakdown, type FixClassCounts } from "./fix-class-breakdown.ts";
import type { AgentFile, AgentPlan, Effort, FixesByClass } from "./types.ts";

const MODERATE_THRESHOLD = 5;
const TOP_RULES_COUNT = 3;

function computeEffort(total: number, fixCount: number): Effort {
  if (total === 0) return "trivial";
  if (fixCount === 0) return "trivial"; // all notes/review — nothing to fix
  if (fixCount > MODERATE_THRESHOLD) return "moderate";
  return "trivial";
}

function topN(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function buildSummary(
  total: number,
  fixClassCounts: FixClassCounts,
  reviewNeeded: number,
  manualOnly: number,
  ruleCounts: Map<string, number>,
): string {
  if (total === 0) return "No accessibility violations found.";

  // Build the fixClass-lane parenthetical for the violations count.
  // Zero-count lanes are omitted by buildFixClassBreakdown.
  const laneBreakdown = buildFixClassBreakdown(fixClassCounts);

  const trailingParts: string[] = [];
  if (reviewNeeded > 0) trailingParts.push(`${reviewNeeded} need review`);
  if (manualOnly > 0) trailingParts.push(`${manualOnly} manual`);

  // Compose: "<N> findings (31 mechanical, …, 2 need review, 1 manual)."
  // The lane breakdown and trailing parts are both in the same parenthetical
  // so the shape stays compact and consistent with the MCP summary format.
  let countSuffix = laneBreakdown;
  if (trailingParts.length > 0) {
    if (countSuffix.length > 0) {
      // Already have "(31 mechanical, …)" — append trailing inside the parens.
      countSuffix = `${countSuffix.slice(0, -1)}, ${trailingParts.join(", ")})`;
    } else {
      countSuffix = ` (${trailingParts.join(", ")})`;
    }
  }

  const noun = total === 1 ? "finding" : "findings";
  let summary = `${total} ${noun}${countSuffix}.`;

  const topRules = topN(ruleCounts, TOP_RULES_COUNT);
  if (topRules.length > 0) {
    const ruleList = topRules.map(([id, n]) => `${id} (${n})`).join(", ");
    summary += ` Most common: ${ruleList}.`;
  }

  return summary;
}

export interface FixCounts {
  /** Count of violations with an inline `fixPaths.primary.edit`. */
  readonly mechanicalEditsAvailable: number;
  /**
   * Count of violations that ship a prose `suggestion` but no mechanical
   * edit. Internal to {@link buildAgentPlan}'s effort computation — NOT
   * exposed on the plan because the count conflates four `fixClass` lanes.
   * Callers that need per-lane budgeting should read `fixesByClass` on
   * the plan instead.
   */
  readonly proseOnlySuggestions: number;
}

/**
 * Count the violations with a mechanical edit vs. prose-only suggestion.
 *
 * Exported so the MCP layer can reuse the same accounting without
 * rebuilding a full {@link AgentPlan} — its plan wrapper carries
 * MCP-specific fields (actionableManualItems, untargetedCriteria,
 * limitations, etc.) that the CLI plan deliberately doesn't.
 *
 * The returned `proseOnlySuggestions` is an internal effort-math input,
 * not a headline counter: it sums across four `fixClass` lanes and is
 * therefore not honest on its own. For per-lane budgeting agents should
 * consume `plan.fixesByClass` (which is keyed by `fixClass` and counts
 * one kind of thing per key).
 */
export function countFixes(violations: readonly Violation[]): FixCounts {
  let mechanicalEditsAvailable = 0;
  let proseOnlySuggestions = 0;
  for (const v of violations) {
    const hasMechanicalEdit = v.fixPaths?.primary.edit !== undefined;
    if (hasMechanicalEdit) {
      mechanicalEditsAvailable += 1;
    } else if (typeof v.suggestion === "string" && v.suggestion.length > 0) {
      proseOnlySuggestions += 1;
    }
  }
  return { mechanicalEditsAvailable, proseOnlySuggestions };
}

/**
 * Tally violations by their rule-level {@link FixClass} lane.
 *
 * Returns the `{ mechanical, guidance, runtimeOnly, verifyInSource }`
 * shape consumed by `plan.fixesByClass` — one key per lane, each
 * counting one kind of thing. Distinct axis from
 * {@link FixCounts#mechanicalEditsAvailable}: that one answers "does
 * this violation ship a ready-to-apply edit?", this one answers "which
 * remediation lane does the rule route into?".
 */
export function countFixesByClass(violations: readonly Violation[]): FixesByClass {
  const counts: Record<FixClass, number> = {
    mechanical: 0,
    guidance: 0,
    "runtime-only": 0,
    "verify-in-source": 0,
  };
  for (const v of violations) counts[v.fixClass] += 1;
  return {
    mechanical: counts.mechanical,
    guidance: counts.guidance,
    runtimeOnly: counts["runtime-only"],
    verifyInSource: counts["verify-in-source"],
  };
}

interface CategoryCounts {
  readonly reviewNeeded: number;
  readonly manualOnly: number;
  readonly ruleCounts: Map<string, number>;
}

/** Tally review/manual categories and per-rule counts from pre-built findings. */
function countCategories(files: readonly AgentFile[]): CategoryCounts {
  let reviewNeeded = 0;
  let manualOnly = 0;
  const ruleCounts = new Map<string, number>();
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.category === "review") reviewNeeded += 1;
      else if (finding.category === "manual") manualOnly += 1;
      ruleCounts.set(finding.ruleId, (ruleCounts.get(finding.ruleId) ?? 0) + 1);
    }
  }
  return { reviewNeeded, manualOnly, ruleCounts };
}

/**
 * Build the {@link AgentPlan} headline from source violations and their
 * pre-built {@link AgentFile} representations.
 *
 * @param violations - The source violations (used for mechanical-edit detection
 *   via `fixPaths.primary.edit`, prose detection via `suggestion`, and
 *   per-{@link FixClass} lane tallying via `fixClass`).
 * @param files - Pre-built AgentFile array (used for per-rule counts and
 *   category tallies that derive from the finding shape).
 * @param totalFindings - Total finding count (usually `violations.length`;
 *   passed in so callers can apply pre-filtering without recomputing here).
 */
export function buildAgentPlan(
  violations: readonly Violation[],
  files: readonly AgentFile[],
  totalFindings: number,
): AgentPlan {
  const { mechanicalEditsAvailable, proseOnlySuggestions } = countFixes(violations);
  const fixesByClass = countFixesByClass(violations);
  const { reviewNeeded, manualOnly, ruleCounts } = countCategories(files);
  const fixCount = mechanicalEditsAvailable + proseOnlySuggestions;
  const effort = computeEffort(totalFindings, fixCount);

  // The `fixClass` tally drives the summary parenthetical. It's a
  // separate axis from `mechanicalEditsAvailable` — that one counts
  // "what the Violation ships" (edit present), this one counts "what
  // the rule demands" (remediation lane). The two are not
  // interchangeable; see the module docblock.
  const fixClassCounts: FixClassCounts = {
    mechanical: fixesByClass.mechanical,
    guidance: fixesByClass.guidance,
    "runtime-only": fixesByClass.runtimeOnly,
    "verify-in-source": fixesByClass.verifyInSource,
  };

  const summary = buildSummary(totalFindings, fixClassCounts, reviewNeeded, manualOnly, ruleCounts);

  return {
    totalFindings,
    mechanicalEditsAvailable,
    fixesByClass,
    reviewNeeded,
    manualOnly,
    estimatedEffort: effort,
    summary,
  };
}
