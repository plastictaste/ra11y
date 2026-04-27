/**
 * `scan` tool's token-density budget merge. Extracted from `tools.ts`
 * so that file stays under the 500-effective-line budget enforced by
 * `scripts/check-limits.ts`. Mirrors the split already made for
 * `scan_project` (`scan-project-budget.ts`) and `scan_diff`
 * (`scan-diff-budget.ts`).
 *
 * `scan` has no `limit` / `offset` contract, so when the density cap
 * fires we emit `truncated: true` + `totalFilesWithFindings` + the
 * `response_token_budget_truncated` warning, but omit `nextOffset` —
 * the tool has no resumable paging primitive. The remediation the
 * agent takes is "narrow `paths` or switch to scan_project which does
 * paginate," surfaced via the warning code. Progress guarantee: the
 * helper always keeps at least one file.
 */

import type { applyTokenBudget } from "./token-budget.ts";
import { analyzeTopContributor } from "./token-budget-contributor.ts";
import {
  fillMissingWarningDetails,
  type ScanWarningCode,
  tokenBudgetTruncatedDetailsField,
} from "./warnings.ts";

/**
 * Merges the token-budget helper's decision into a `scan` response
 * body. Called only when `budgeted.droppedCount > 0` — the caller
 * owns the short-circuit for the under-budget case so we don't
 * rebuild the response object in the common path.
 *
 * Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE: the top-level `requestedLimit`
 * + `effectiveLimit` + `pageClipReason` triple mirrors the scan_project
 * pagination surface so a caller seeing `truncated: true` can tell
 * aggressive trims (50→10) from marginal ones (50→48) without cracking
 * open `warningsDetails`. `scan` has no `limit` axis, so
 * `requestedLimit` is the file count the density cap saw entering the
 * guard and `effectiveLimit` is the surviving count — the `token_density`
 * regime is the only clip reason this tool can emit at this layer.
 */
export function mergeScanTokenBudget<TFile>(args: {
  readonly tentative: Record<string, unknown>;
  readonly budgeted: ReturnType<typeof applyTokenBudget<TFile>>;
  readonly baseWarnings: readonly ScanWarningCode[];
  readonly totalFilesWithFindings: number;
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
}): Record<string, unknown> {
  // analyze the pre-trim files list
  // from the tentative response so the top-contributor triple reflects
  // the full population the density cap saw entering the guard, not
  // just the tail-trimmed survivors. Pulling from `tentative.files` is
  // safe — `mergeScanTokenBudget` runs after the tentative is fully
  // assembled, before the merge replaces `files` with the budgeted
  // (trimmed) array.
  const tentativeFiles = (args.tentative as Record<string, unknown>)["files"];
  const filesForAnalysis = Array.isArray(tentativeFiles)
    ? (tentativeFiles as readonly { readonly findings?: readonly Record<string, unknown>[] }[])
    : [];
  const topContributor = analyzeTopContributor(filesForAnalysis);
  const warnings: readonly ScanWarningCode[] = [
    ...args.baseWarnings,
    "response_token_budget_truncated",
  ];
  // Warnings-details schema discipline: stamp the density-cap rich
  // payload first, then ensure every other code in `warnings[]` (the
  // pre-existing `baseWarnings`) has a corresponding key. The base
  // came in without the matched `warningsDetails` because `scan` does
  // not currently thread the details map alongside the codes — until
  // it does, the marker fill keeps the membership invariant on this
  // surface.
  const tentativeDetails = readTentativeWarningsDetails(args.tentative);
  const densityFragment = tokenBudgetTruncatedDetailsField({
    requestedLimit: args.requestedLimit,
    effectiveLimit: args.effectiveLimit,
    topContributor,
  });
  const warningsDetails = fillMissingWarningDetails(warnings, {
    ...(tentativeDetails ?? {}),
    ...densityFragment.warningsDetails,
  });
  return {
    ...args.tentative,
    files: args.budgeted.files,
    truncated: true as const,
    totalFilesWithFindings: args.totalFilesWithFindings,
    requestedLimit: args.requestedLimit,
    effectiveLimit: args.effectiveLimit,
    pageClipReason: "token_density" as const,
    warnings,
    warningsDetails,
  };
}

/**
 * Warnings-details schema discipline: reads any pre-existing
 * `warningsDetails` map off the tentative response so the merge
 * helper can fold it under the membership-invariant pass. Returns
 * `undefined` when the field is absent or malformed — defensive
 * narrowing mirrors the `readWarningsDetails` helper in
 * `scan-project-budget.ts`.
 */
function readTentativeWarningsDetails(
  tentative: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const d = tentative["warningsDetails"];
  if (d === undefined || d === null || typeof d !== "object") return undefined;
  return d as Record<string, unknown>;
}
