/**
 * buildAgentPlan — violations + pre-built findings → AgentPlan headline.
 *
 * Replaces the former composite `fixSuggestionAvailable` counter with the
 * doctrine-compliant split:
 *   - `mechanicalEditsAvailable` — violations with `fixPaths?.primary.edit`
 *     present; deterministic, batch-apply work.
 *   - `guidanceFixesAvailable`   — violations with prose `suggestion` but no
 *     mechanical edit; route-to-rewrite work.
 *
 * Per CLAUDE.md §1 "Composite headline counts are dishonest": summing
 * categorically different sub-buckets into one counter forces agents to
 * budget against an inflated or misleading number. The split is honest
 * because both labels are provable from the Violation shape alone.
 *
 * Effort is computed from the combined fix count
 * (mechanicalEditsAvailable + guidanceFixesAvailable) so the semantics
 * are equivalent to the former formula that summed fixSuggestionAvailable.
 *
 * V1-SHAPE-CLI-AGENT-HEADLINE: `buildSummary` now breaks the violations
 * parenthetical down by the rule-level `fixClass` lane (`mechanical` /
 * `guidance` / `runtime-only` / `verify-in-source`) rather than the old
 * `mechanicalEdits` / `guidanceFixes` pair derived from `v.suggestion`
 * presence. Those axes are orthogonal: `fixClass` names the *nature* of
 * the fix the rule demands; `fixPaths` / `suggestion` names what the
 * Violation *ships*. The shared helper lives at
 * `./fix-class-breakdown.ts` so MCP and CLI emit the same format.
 */

import type { Violation } from "../../types/violation.ts";
import { buildFixClassBreakdown, type FixClassCounts } from "./fix-class-breakdown.ts";
import type { AgentFile, AgentPlan, Effort } from "./types.ts";

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
  readonly mechanicalEditsAvailable: number;
  readonly guidanceFixesAvailable: number;
}

/**
 * Count mechanical vs guidance fixes from source violations. Exported so
 * the MCP layer can reuse the same split-counter accounting without
 * rebuilding a full {@link AgentPlan} — its plan wrapper carries
 * MCP-specific fields (actionableManualItems, untargetedCriteria,
 * limitations, etc.) that the CLI plan deliberately doesn't.
 */
export function countFixes(violations: readonly Violation[]): FixCounts {
  let mechanicalEditsAvailable = 0;
  let guidanceFixesAvailable = 0;
  for (const v of violations) {
    const hasMechanicalEdit = v.fixPaths?.primary.edit !== undefined;
    if (hasMechanicalEdit) {
      mechanicalEditsAvailable += 1;
    } else if (typeof v.suggestion === "string" && v.suggestion.length > 0) {
      guidanceFixesAvailable += 1;
    }
  }
  return { mechanicalEditsAvailable, guidanceFixesAvailable };
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
 *   via `fixPaths.primary.edit` and guidance detection via `suggestion`).
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
  const { mechanicalEditsAvailable, guidanceFixesAvailable } = countFixes(violations);
  const { reviewNeeded, manualOnly, ruleCounts } = countCategories(files);
  const fixCount = mechanicalEditsAvailable + guidanceFixesAvailable;
  const effort = computeEffort(totalFindings, fixCount);

  // Tally violations by `fixClass` lane for the summary parenthetical.
  // This is a separate axis from mechanicalEditsAvailable/guidanceFixesAvailable:
  // those count *what the Violation ships* (edit vs prose); fixClass counts
  // *what the rule demands* (nature of the fix). Per V1-SHAPE-CLI-AGENT-HEADLINE.
  const fixClassTally = {
    mechanical: 0,
    guidance: 0,
    "runtime-only": 0,
    "verify-in-source": 0,
  };
  for (const v of violations) fixClassTally[v.fixClass] += 1;
  const fixClassCounts: FixClassCounts = fixClassTally;

  const summary = buildSummary(totalFindings, fixClassCounts, reviewNeeded, manualOnly, ruleCounts);

  return {
    totalFindings,
    mechanicalEditsAvailable,
    guidanceFixesAvailable,
    reviewNeeded,
    manualOnly,
    estimatedEffort: effort,
    summary,
  };
}
