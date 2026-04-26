/**
 * buildFixClassBreakdown — parenthetical prose for the violations
 * headline on the CLI agent formatter (`AgentPlan.summary`).
 *
 * The MCP plan no longer carries a `summary` blurb (the duplicate
 * prose composite was dropped per "Composite headline counts are
 * dishonest"; the structured `plan.fixesByClass` sibling is now the
 * single surface). Kept under `src/output/agent-response/` for the
 * CLI surface, which still emits a human-readable headline.
 *
 * The breakdown counts violations by their rule-level `fixClass` lane,
 * not by whether the Violation carries a prose `suggestion` or a
 * `fixPaths.edit`. Those are orthogonal axes — `fixClass` describes
 * the *nature* of the fix the rule demands; `fixPaths` / `suggestion`
 * describe what the Violation *ships*. Conflating them produces the
 * old "131 guidance fixes" label that bucketed `runtime-only` and
 * `verify-in-source` findings as if they were prose-rewrite work.
 */

import type { FixClass } from "../../types/rule.ts";

/** Count of violations per `fixClass` lane, used by the summary prose. */
export type FixClassCounts = Readonly<Record<FixClass, number>>;

/**
 * Build the parenthetical `fixClass` breakdown appended to the violations
 * count in the plan summary, e.g. `" (31 mechanical, 30 guidance,
 * 24 runtime-only, 46 verify-in-source)"`. Zero-count lanes are omitted —
 * they add noise without signal. Lane order is stable:
 * `mechanical → guidance → runtime-only → verify-in-source`.
 *
 * Returns an empty string when no lane has any violations (defensive —
 * callers already check `violations > 0`, but a rule that emits a
 * violation without a `fixClass` would otherwise produce `" ()"`).
 *
 * @param counts - Per-lane violation counts keyed by `FixClass`.
 * @returns A space-prefixed parenthetical string, or `""` when all
 *   lane counts are zero.
 *
 * @example
 * buildFixClassBreakdown({ mechanical: 2, guidance: 0, "runtime-only": 1, "verify-in-source": 0 })
 * // => " (2 mechanical, 1 runtime-only)"
 */
export function buildFixClassBreakdown(counts: FixClassCounts): string {
  const lanes: readonly FixClass[] = ["mechanical", "guidance", "runtime-only", "verify-in-source"];
  const bits: string[] = [];
  for (const lane of lanes) {
    const n = counts[lane];
    if (n > 0) bits.push(`${n} ${lane}`);
  }
  if (bits.length === 0) return "";
  return ` (${bits.join(", ")})`;
}
