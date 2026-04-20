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
 * V1-SHAPE-FIXCLASS-HEADLINE: the violations parenthetical now breaks
 * down by the rule-level `fixClass` lane (`mechanical` / `guidance` /
 * `runtime-only` / `verify-in-source`) rather than summing prose-only
 * items under a single "guidance fixes" label. The old label collided
 * with the `fixClass: "guidance"` value and conflated four categorically
 * different work lanes — agents budgeting against the headline got
 * `runtime-only` and `verify-in-source` items counted as "guidance"
 * without a way to split them back out from the prose.
 */

import type { FixClass } from "../types/rule.ts";

/** Count of violations per `fixClass` lane, used by the summary prose. */
export type FixClassCounts = Readonly<Record<FixClass, number>>;

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
    parts.push(
      `${violations} violation${violations === 1 ? "" : "s"}${buildFixClassBreakdown(fixClassCounts)}`,
    );
  }
  if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"} to review`);
  return parts;
}

/**
 * Build the parenthetical `fixClass` breakdown, e.g. `" (31 mechanical,
 * 30 guidance, 24 runtime-only, 46 verify-in-source)"`. Zero-count lanes
 * are omitted by default — they add noise without signal, and the lane
 * order (mechanical → guidance → runtime-only → verify-in-source) keeps
 * the prose stable across scans.
 *
 * Returns an empty string when no lane has any violations (defensive —
 * the caller already checks `violations > 0`, but a rule that emits a
 * violation without a `fixClass` would otherwise produce `" ()"`).
 */
function buildFixClassBreakdown(counts: FixClassCounts): string {
  const lanes: readonly FixClass[] = ["mechanical", "guidance", "runtime-only", "verify-in-source"];
  const bits: string[] = [];
  for (const lane of lanes) {
    const n = counts[lane];
    if (n > 0) bits.push(`${n} ${lane}`);
  }
  if (bits.length === 0) return "";
  return ` (${bits.join(", ")})`;
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
