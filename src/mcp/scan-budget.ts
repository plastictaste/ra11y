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
import { type ScanWarningCode, tokenBudgetTruncatedDetailsField } from "./warnings.ts";

/**
 * Merges the token-budget helper's decision into a `scan` response
 * body. Called only when `budgeted.droppedCount > 0` — the caller
 * owns the short-circuit for the under-budget case so we don't
 * rebuild the response object in the common path.
 */
export function mergeScanTokenBudget<TFile>(args: {
  readonly tentative: Record<string, unknown>;
  readonly budgeted: ReturnType<typeof applyTokenBudget<TFile>>;
  readonly baseWarnings: readonly ScanWarningCode[];
  readonly totalFilesWithFindings: number;
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
}): Record<string, unknown> {
  return {
    ...args.tentative,
    files: args.budgeted.files,
    truncated: true as const,
    totalFilesWithFindings: args.totalFilesWithFindings,
    warnings: [...args.baseWarnings, "response_token_budget_truncated"] satisfies ScanWarningCode[],
    ...tokenBudgetTruncatedDetailsField({
      requestedLimit: args.requestedLimit,
      effectiveLimit: args.effectiveLimit,
    }),
  };
}
