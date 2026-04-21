/**
 * scan_diff's token-density budget wiring. Extracted from
 * `tool-scan-diff.ts` so that file stays under the 500-effective-line
 * budget enforced by `scripts/check-limits.ts`.
 *
 * scan_diff has no `limit` / `offset` contract, so when the budget
 * fires it emits `truncated: true` + `totalFilesWithFindings` + the
 * `response_token_budget_truncated` warning, but omits `nextOffset`
 * — the tool has no resumable paging primitive. The remediation
 * surfaced via the warning is "narrow the comparison ref or baseline
 * scope," not "paginate."
 */

import { applyTokenBudget } from "./token-budget.ts";
import { tokenBudgetTruncatedDetailsField } from "./warnings.ts";

/**
 * Applies the ADR 0021 amendment token-density secondary budget to a
 * scan_diff response body. Returns the body unchanged when under the
 * budget; otherwise trims trailing file entries from the named files
 * field, flips `truncated: true`, records `totalFilesWithFindings`,
 * and merges the `response_token_budget_truncated` warning into any
 * already-present warnings (the hunks-mode `no_hunks_in_comparison`
 * coexists cleanly in the same array).
 *
 * The progress guarantee from `applyTokenBudget` keeps ≥1 file entry
 * even when the single survivor exceeds the budget.
 */
export function applyScanDiffTokenBudget<TFile>(
  tentative: Record<string, unknown>,
  files: readonly TFile[],
  filesKey: "newViolations",
): Record<string, unknown> {
  const budgeted = applyTokenBudget({
    response: tentative,
    filesKey,
    files,
    offset: 0,
  });
  if (budgeted.droppedCount === 0) return tentative;
  const existing = tentative["warnings"];
  const existingList = Array.isArray(existing) ? (existing as readonly string[]) : [];
  const warnings = existingList.includes("response_token_budget_truncated")
    ? existingList
    : [...existingList, "response_token_budget_truncated"];
  // Echo requested vs. effective file counts — scan_diff has no
  // pagination primitive, so `requestedLimit` is the full
  // files-with-findings set the density cap saw entering the guard,
  // and `effectiveLimit` is what survived the trim. Agents branching
  // on `response_token_budget_truncated` can tell aggressive trims
  // from marginal ones without a re-page.
  const detailsField = tokenBudgetTruncatedDetailsField({
    requestedLimit: files.length,
    effectiveLimit: budgeted.files.length,
  });
  return {
    ...tentative,
    [filesKey]: budgeted.files,
    truncated: true as const,
    totalFilesWithFindings: files.length,
    warnings,
    ...detailsField,
  };
}
