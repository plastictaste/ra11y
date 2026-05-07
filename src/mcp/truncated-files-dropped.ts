/**
 * Q9 — rule-level impact of a
 * response-instance truncation pass. Extracted from
 * `scan-project-budget.ts` so the file stays under the 500-effective-
 * line budget enforced by `scripts/check-limits.ts`, and so both the
 * density-cap path (`mergeBudgetedFields`) and the slim-envelope path
 * (`buildSlimScanProjectEnvelope`) share one helper that pre-derives
 * the warning payload without duplicating the per-rule aggregation.
 *
 * The byte-level codes (`response_token_budget_truncated`,
 * `response_dropped_files_oversize`) name how MUCH of the response
 * was dropped; this code names WHICH rule families' findings just
 * disappeared from the wire so the agent can decide whether to
 * re-scope (a single dominant rule's noise was clipped → narrow via
 * `restrictToPaths` to that rule's families) or widen `limit` (the
 * cross-rule signal was uniformly clipped → just ask for more files).
 * Per the AI-first doctrine "Oversize-success is ambiguous failure"
 * (file-level analogue): an agent reading the byte-level warnings
 * alone cannot tell which rule families' findings just disappeared
 * from this response; the rule-level payload closes the silent-miss
 * gap.
 *
 * No I/O. Pure aggregator over the dropped-file inventory the caller
 * threads in. Caller is responsible for splicing the returned
 * `payload` onto its own `warningsDetails` and the new code onto its
 * own `warnings[]` only when `payload !== undefined` — a `undefined`
 * return signals "the dropped subset carried zero findings, suppress
 * the warning entirely" per the present-when-meaningful contract.
 */

import {
  type ScanWarningCode,
  type ScanWarningDetails,
  truncatedFilesDroppedDetailsField,
} from "./warnings.ts";

/**
 * Result of {@link computeTruncatedFilesDroppedWarning}. Caller
 * conditional-spreads when `payload !== undefined` — both the code
 * and the payload are present-when-meaningful.
 */
export interface TruncatedFilesDroppedResult {
  readonly payload: NonNullable<ScanWarningDetails["truncated_files_dropped"]> | undefined;
}

/**
 * Computes the `truncated_files_dropped` warning payload (or
 * `undefined` if no rule-bearing findings were dropped) from the
 * file inventory the caller is dropping.
 *
 * Accepts both the loose pre-trim shape used by `mergeBudgetedFields`
 * (typed `Record<string, unknown>` because the merge predates the
 * typed file inventory in scope) and the typed `AgentFinding[]`
 * shape from `formatted.files` used by the slim envelope. Skips
 * findings whose `ruleId` is missing or non-string for defensive
 * narrowing — the typed shape always populates `ruleId`, but the
 * loose shape is `Record<string, unknown>` from the upstream
 * pre-trim accumulator.
 *
 * Severity filter — info-severity findings are skipped so the per-
 * rule `droppedCount` axis aligns with the headline `plan.topRules[].count`
 * axis (which {@link import("./scan-assembly.ts").computeTopRules}
 * computes against the same error+warning slice). Without the
 * filter, an info-bearing rule like `contrast/minimum` (which emits
 * `severity: "info"` on hedged-uncertainty branches) would land a
 * `droppedCount` exceeding its headline `count` whenever the dropped
 * subset carried info findings — a within-response cross-field
 * count drift that violates the "Cross-surface count invariant"
 * doctrine bullet at the per-response level. Keeping both axes on
 * the same severity slice means the agent can read
 * `topRules[ruleId].count` minus `topDroppedRules[ruleId].droppedCount`
 * as the surviving on-wire emission count for that rule with no
 * cross-axis disambiguation.
 *
 * Canonical drop-count formulation — when
 * `options.totalFilesWithFindings` and `options.finalFilesShipped` are
 * provided, the payload's `droppedFileCount` is set to
 * `totalFilesWithFindings - finalFilesShipped`, the canonical answer
 * to "how many files-with-findings did this response keep off the
 * wire?" — which on a paginated bulk-vendor scan reconciles with the
 * `totalFilesWithFindings` denominator on the same response. The
 * caller still passes its `droppedFiles` array (the page-internal
 * trim, used for the per-rule arithmetic); when its length differs
 * from the canonical drop count, the page-internal count is preserved
 * separately as `pageClipFromRequestedLimit` so the agent can
 * distinguish "dropped from this page's tail" from "skipped by
 * paginator" without re-deriving from `nextOffset` and
 * `totalFilesWithFindings`. When `options` is omitted, the helper
 * falls back to `droppedFileCount: droppedFiles.length` (legacy
 * behavior — the slim-envelope path passes `formatted.files` as the
 * full inventory, so `droppedFiles.length === totalFilesWithFindings`
 * and no page-clip distinction applies).
 *
 * @param droppedFiles — file inventory the caller is dropping. The
 *   helper iterates `findings[]` on each entry to build the per-rule
 *   tally; entries missing `severity` (loose shape) are kept (the
 *   typed shape always populates it, so the only `undefined`-severity
 *   case is hand-authored test fixtures predating this filter).
 * @param options.totalFilesWithFindings — full pre-pagination
 *   inventory size of files-with-findings on this response. When
 *   present alongside `finalFilesShipped`, drives the canonical
 *   `droppedFileCount`.
 * @param options.finalFilesShipped — count of file entries the
 *   response actually ships (`response.files.length`
 *   post-density-cap). Pairs with `totalFilesWithFindings` to
 *   produce the canonical drop count.
 *
 * @returns `{ payload }` where `payload` is the spreadable
 *   `warningsDetails.truncated_files_dropped` value when at least
 *   one dropped non-info finding was rule-tagged, or `undefined` when
 *   the dropped subset carried no error/warning findings (caller
 *   suppresses both the code and the payload to avoid the "Ambiguous
 *   field shapes are dishonest" failure mode).
 */
export function computeTruncatedFilesDroppedWarning(
  droppedFiles: readonly {
    readonly findings?: readonly { readonly ruleId?: string; readonly severity?: string }[];
  }[],
  options?: {
    readonly totalFilesWithFindings?: number;
    readonly finalFilesShipped?: number;
  },
): TruncatedFilesDroppedResult {
  const droppedFindings = collectDroppedFindings(droppedFiles);
  if (droppedFindings.length === 0) return { payload: undefined };
  const hasCanonicalInputs =
    options?.totalFilesWithFindings !== undefined && options?.finalFilesShipped !== undefined;
  const canonicalDropCount = hasCanonicalInputs
    ? Math.max(
        0,
        (options?.totalFilesWithFindings ?? 0) - (options?.finalFilesShipped ?? 0),
      )
    : droppedFiles.length;
  // Page-internal trim count = the per-page subset the caller is
  // actually dropping in this response. Carry it separately when it
  // differs from the canonical count — the field-builder in
  // `warnings.ts` omits it when the two values agree (slim envelope:
  // page == full inventory; full-inventory page: paginator skipped
  // nothing).
  const pageClipFromRequestedLimit = hasCanonicalInputs ? droppedFiles.length : undefined;
  const payload = truncatedFilesDroppedDetailsField({
    droppedFileFindings: droppedFindings,
    droppedFileCount: canonicalDropCount,
    ...(pageClipFromRequestedLimit === undefined ? {} : { pageClipFromRequestedLimit }),
  });
  return { payload };
}

/**
 * Splices the rule-level `truncated_files_dropped` warning code +
 * payload onto a byte-level warnings/details pair returned by
 * {@link import("./oversize-envelope.ts").oversizeEnvelopeWarningsField}.
 * Caller passes the post-byte-level merged shape and the
 * pre-computed payload (or `undefined` to skip splicing); helper
 * de-dupes the code if it was already present and conditional-
 * spreads the payload key. Keys never overlap with the byte-level
 * codes the merge helper stamped, so the object spread is safe.
 *
 * Returns the splice as a pair of `readonly` fields the caller
 * spreads into the response body. Pure — never mutates `merged`.
 */
export function spliceTruncatedFilesDropped(
  merged: {
    readonly warnings: readonly ScanWarningCode[];
    readonly warningsDetails: ScanWarningDetails;
  },
  payload: NonNullable<ScanWarningDetails["truncated_files_dropped"]> | undefined,
): {
  readonly warnings: readonly ScanWarningCode[];
  readonly warningsDetails: ScanWarningDetails;
} {
  if (payload === undefined) return merged;
  const warnings = merged.warnings.includes("truncated_files_dropped")
    ? merged.warnings
    : [...merged.warnings, "truncated_files_dropped" as const];
  const warningsDetails: ScanWarningDetails = {
    ...merged.warningsDetails,
    truncated_files_dropped: payload,
  };
  return { warnings, warningsDetails };
}

/**
 * Internal: flattens the dropped-file subset's findings into a
 * `{ ruleId }` list for {@link truncatedFilesDroppedDetailsField}.
 * Pure over the input — skips findings whose `ruleId` is missing or
 * non-string, and skips info-severity findings so the per-rule
 * `droppedCount` axis matches the error+warning slice
 * {@link import("./scan-assembly.ts").computeTopRules} uses for
 * `plan.topRules[].count`. See the
 * {@link computeTruncatedFilesDroppedWarning} docblock for the
 * cross-field invariant rationale.
 */
function collectDroppedFindings(
  droppedFiles: readonly {
    readonly findings?: readonly { readonly ruleId?: string; readonly severity?: string }[];
  }[],
): readonly { readonly ruleId: string }[] {
  const out: { readonly ruleId: string }[] = [];
  for (const file of droppedFiles) {
    const findings = file.findings ?? [];
    for (const finding of findings) {
      const ruleId = finding.ruleId;
      if (typeof ruleId !== "string" || ruleId.length === 0) continue;
      if (finding.severity === "info") continue;
      out.push({ ruleId });
    }
  }
  return out;
}
