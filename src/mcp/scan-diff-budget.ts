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
import { analyzeTopContributor } from "./token-budget-contributor.ts";
import {
  fillMissingWarningDetails,
  type ScanWarningCode,
  tokenBudgetTruncatedDetailsField,
} from "./warnings.ts";

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
  // analyze the pre-trim file list so
  // the top-contributor triple reflects which finding actually pushed
  // the response over budget (the dropped tail or the kept head — the
  // analyzer doesn't care which side of the cap a finding ended up on,
  // only its byte count). The duck-type cast tolerates whatever
  // surface-specific wrapper shape the file entries carry; only
  // `findings[]` matters to the analyzer.
  const filesForAnalysis = files as readonly {
    readonly findings?: readonly Record<string, unknown>[];
  }[];
  const topContributor = analyzeTopContributor(filesForAnalysis);
  const detailsField = tokenBudgetTruncatedDetailsField({
    requestedLimit: files.length,
    effectiveLimit: budgeted.files.length,
    topContributor,
  });
  // Warnings-details schema discipline: ensure every code in the
  // merged `warnings[]` has a corresponding key on `warningsDetails`.
  // The pre-existing tentative may have shipped binary-presence codes
  // (e.g. `no_hunks_in_comparison`) without a paired `warningsDetails`
  // entry — the `{}` marker fill closes that gap so the membership
  // invariant holds across the response.
  const tentativeDetails = tentative["warningsDetails"];
  const tentativeDetailsRecord =
    tentativeDetails === undefined ||
    tentativeDetails === null ||
    typeof tentativeDetails !== "object"
      ? undefined
      : (tentativeDetails as Record<string, unknown>);
  const warningsDetails = fillMissingWarningDetails(warnings as readonly ScanWarningCode[], {
    ...(tentativeDetailsRecord ?? {}),
    ...detailsField.warningsDetails,
  });
  return {
    ...tentative,
    [filesKey]: budgeted.files,
    truncated: true as const,
    totalFilesWithFindings: files.length,
    // Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE: promote the density-cap
    // settlement to the same surface as `truncated` / `nextOffset`
    // on the paginated surfaces. scan_diff has no `limit` axis, so
    // `requestedLimit` is the files-with-findings count the cap saw
    // entering and `effectiveLimit` is what survived the trim. A
    // caller seeing `truncated: true` + `files.length: N` gets the
    // aggressive-vs-marginal trim distinction in one read without
    // cracking open `warningsDetails`.
    requestedLimit: files.length,
    effectiveLimit: budgeted.files.length,
    pageClipReason: "token_density" as const,
    warnings,
    warningsDetails,
  };
}
