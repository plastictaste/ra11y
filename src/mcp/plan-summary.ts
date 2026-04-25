/**
 * Composes the human-readable `plan.summary` string for scan responses.
 * Extracted from tools-helpers.ts so the helpers module stays under the
 * 500-line file budget after the P1-M + P1-H split added the split-
 * counters logic.
 *
 * Leads the manual-review fragment with the actionable count (grounded
 * candidates with file:line) instead of the old composite that summed
 * grounded + bare-criterion into a single inflated headline. Per
 * CLAUDE.md §1 "Composite headline counts are dishonest," the count
 * consumers read first must match the count agents budget against.
 *
 * V1-SHAPE-FIXCLASS-HEADLINE: the violations parenthetical breaks
 * down by the rule-level `fixClass` lane (`mechanical` / `guidance` /
 * `runtime-only` / `verify-in-source`) rather than summing prose-only
 * items under a single "guidance fixes" label. The old label collided
 * with the `fixClass: "guidance"` value and conflated four categorically
 * different work lanes — agents budgeting against the headline got
 * `runtime-only` and `verify-in-source` items counted as "guidance"
 * without a way to split them back out from the prose.
 *
 * Q7-PLAN-VIOLATIONS-COMPOSITE: the lane breakdown is no longer
 * preceded by an "N findings" composite total. Two of the four
 * `fixClass` lanes (`guidance`, `verify-in-source`) are prose-only —
 * "please verify / please rewrite" signals that aren't directly
 * actionable in the way `mechanical` edits are. Leading with a
 * single composite headline that sums them under any noun
 * ("findings" / "violations") promises one kind of work and delivers
 * four — the exact "composite headline counts are dishonest"
 * mismatch flagged in the AI-first consumer doctrine, and the same
 * shape as the `plan.totalFindings` and `plan.safeEditsAvailable`
 * precedents that were dropped (not renamed). The summary now emits
 * the per-lane breakdown directly (e.g. `"2 mechanical, 1
 * verify-in-source"`) so each fragment names exactly what it
 * measures. Callers that want the flat count sum the four lanes
 * themselves.
 */

import {
  buildFixClassBreakdown,
  type FixClassCounts,
} from "../output/agent-response/fix-class-breakdown.ts";

// Re-export so callers that typed against the MCP path keep compiling.
export type { FixClassCounts };

/**
 * Arguments for {@link buildPlanSummary}. Keyed rather than positional
 * because the shape grew with the P1-M + P1-H split — callers now pass
 * per-`fixClass` lane counts, actionable-manual, and untargeted counts,
 * and a positional signature would be unreadable.
 */
export interface PlanSummaryArgs {
  readonly violations: number;
  readonly notes: number;
  /** Violation count per `fixClass` lane (see {@link FixClassCounts}). */
  readonly fixClassCounts: FixClassCounts;
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
}

export function buildPlanSummary(args: PlanSummaryArgs): string {
  const parts = buildFindingParts(args.violations, args.notes, args.fixClassCounts);
  if (args.actionableManual > 0 || args.untargetedCriteria > 0) {
    parts.push(buildManualReviewPart(args.actionableManual, args.untargetedCriteria));
  }
  return `${parts.join(". ")}.`;
}

function buildFindingParts(
  violations: number,
  notes: number,
  fixClassCounts: FixClassCounts,
): string[] {
  if (violations === 0 && notes === 0) return ["No automated findings"];
  const parts: string[] = [];
  if (violations > 0) {
    // Per Q7-PLAN-VIOLATIONS-COMPOSITE the per-lane breakdown is the
    // honest signal; no leading composite "N findings" headline
    // wrapping the four lanes. `buildFixClassBreakdown` returns a
    // space-prefixed parenthetical (e.g. " (2 mechanical, 1
    // verify-in-source)") — strip the wrapper so the fragment reads
    // as a comma-separated lane list ("2 mechanical, 1
    // verify-in-source"). Defensive fallback: when the breakdown is
    // empty (no rule with a `fixClass` produced a violation — should
    // never happen on real scans) the lane fragment drops; downstream
    // fragments (notes, manual review) still ride on the wire.
    const breakdown = buildFixClassBreakdown(fixClassCounts);
    if (breakdown.length > 0) {
      parts.push(stripLeadingParens(breakdown));
    }
  }
  if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"} to review`);
  return parts;
}

/**
 * Strips the leading " (" and trailing ")" from a parenthetical
 * fragment produced by {@link buildFixClassBreakdown}, so the lane
 * list reads as a flat fragment (`"2 mechanical, 1 verify-in-source"`)
 * rather than a parenthetical attached to a now-deleted composite
 * headline. Defensive: returns the input unchanged if the wrapper
 * is missing (the breakdown helper is the only caller, but
 * keeping the helper tolerant means the summary never emits a
 * malformed sentence on an unexpected input).
 */
function stripLeadingParens(parenthetical: string): string {
  const trimmed = parenthetical.trimStart();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Builds the manual-review fragment of the plan summary. Leads with the
 * actionable count because that's what agents budget against; the
 * untargeted count trails as "+ N untargeted criteria" so it's visible
 * without dominating. The `checklist` call-to-action stays attached.
 */
function buildManualReviewPart(actionable: number, untargeted: number): string {
  const actionableNoun = actionable === 1 ? "item" : "items";
  const untargetedNoun = untargeted === 1 ? "criterion" : "criteria";
  if (actionable > 0 && untargeted > 0) {
    return `${actionable} actionable manual review ${actionableNoun} + ${untargeted} untargeted ${untargetedNoun} — call \`checklist\``;
  }
  if (actionable > 0) {
    return `${actionable} actionable manual review ${actionableNoun} — call \`checklist\``;
  }
  return `${untargeted} untargeted ${untargetedNoun} — call \`checklist\``;
}
