/**
 * Q7-SUGGEST-FIX-NONE-NEAREST-FINDING breadcrumb helper for the
 * `kind: "none"` branch of `buildSuggestFixPayload`. Pure function over
 * its inputs; lives in its own module so `tool-suggest-fix-internals.ts`
 * stays under the MCP-handler line budget (`scripts/check-limits.ts`).
 */

import type { Violation } from "../types/violation.ts";

/**
 * Half-window for the `nearestFinding` / `didYouMean` breadcrumb in the
 * `kind: "none"` branch. The window is `±NEAREST_FINDING_WINDOW` lines
 * around the requested line; chosen to absorb the typical line-drift
 * sources (paginated diff stamping, intermediate edits inserting a few
 * lines above the violation, agents that re-prompted after truncation)
 * without sliding into "any nearby finding will do." A window above ~10
 * starts producing too many false-positive matches in dense JSX/CSS
 * files; below ~5 misses common pagination drift.
 */
const NEAREST_FINDING_WINDOW = 10;

/**
 * Cap on the `didYouMean` array. Three is enough to disambiguate the
 * common multi-match window without becoming a buried list the agent
 * skips. Sorted by absolute line distance from the requested line so the
 * closest candidate sits first.
 */
const DID_YOU_MEAN_CAP = 3;

/**
 * Walks `sameFileFindings` for findings sharing `ruleId` within
 * {@link NEAREST_FINDING_WINDOW} lines of the requested line and
 * returns the breadcrumb spread for the `kind: "none"` branch:
 *
 *   - exactly one same-rule finding in window → `{ nearestFinding: { ruleId, line } }`
 *   - two or more → `{ didYouMean: [{ ruleId, line }, …] }` (top
 *     {@link DID_YOU_MEAN_CAP}, sorted by absolute distance from the
 *     requested line, then by line ascending so output is deterministic
 *     across ties)
 *   - zero (or no findings list provided) → `{}` (no breadcrumb)
 *
 * Closes Q7-SUGGEST-FIX-NONE-NEAREST-FINDING. The two field shapes are
 * mutually exclusive — `nearestFinding` is the singular case the agent
 * can act on directly; `didYouMean` is the plural case where the agent
 * has to choose. Conditional-spread per CLAUDE.md §1 "Ambiguous field
 * shapes are dishonest" — the field is absent when no breadcrumb fits,
 * never `nearestFinding: null` or `didYouMean: []`.
 */
export function nearestFindingSpread(
  ruleId: string,
  requestedLine: number,
  sameFileFindings: readonly Violation[] | undefined,
): {
  readonly nearestFinding?: { readonly ruleId: string; readonly line: number };
  readonly didYouMean?: ReadonlyArray<{ readonly ruleId: string; readonly line: number }>;
} {
  if (!sameFileFindings || sameFileFindings.length === 0) return {};
  const inWindow = sameFileFindings
    .filter(
      (v) =>
        v.ruleId === ruleId && Math.abs(v.location.line - requestedLine) <= NEAREST_FINDING_WINDOW,
    )
    .map((v) => ({ ruleId: v.ruleId, line: v.location.line }));
  if (inWindow.length === 0) return {};
  if (inWindow.length === 1) {
    const only = inWindow[0];
    if (!only) return {};
    return { nearestFinding: only };
  }
  const ranked = [...inWindow].sort((a, b) => {
    const distDelta = Math.abs(a.line - requestedLine) - Math.abs(b.line - requestedLine);
    if (distDelta !== 0) return distDelta;
    return a.line - b.line;
  });
  return { didYouMean: ranked.slice(0, DID_YOU_MEAN_CAP) };
}
