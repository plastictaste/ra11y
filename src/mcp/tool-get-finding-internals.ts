/**
 * Helpers for the `get_finding` MCP tool. Extracted from
 * `tool-get-finding.ts` so the tool handler stays under the per-MCP-tool
 * effective-line budget while the per-id lookup logic remains a single
 * pure function over its inputs (no I/O, no side effects).
 *
 * The split mirrors the doctrine in
 * `docs/kb/architecture/ai-first-consumer.md`: the tool's wire shape
 * lives in `tool-get-finding.ts` (description, schema, handler);
 * predicate logic lives here so the wire shape stays inspectable on its
 * own.
 */

import type { ScanProjectReviewCandidate } from "./scan-project-review-candidates.ts";
import { type McpToolResult, type ScanFormatted, textResult } from "./tools-helpers.ts";

/**
 * Maximum number of review candidates to materialize when scanning for
 * a `findingId` match. The id-lookup walks every surfaced candidate
 * before declaring `found: false`, so the cap must be large enough that
 * no plausible candidate count gets clipped — picked at 100k to
 * comfortably exceed the actionableManualItems counter on bulk-template
 * catalogs (ceiling observed at ~6k). The value is lookup-internal; we
 * never serialize the list, so the cap doesn't touch the response token
 * budget.
 */
export const FINDING_LOOKUP_CANDIDATE_LIMIT = 100_000;

/**
 * Walks every emitted finding looking for a `findingId` match. Returns
 * the canonical violation-side response payload, or null when no match
 * is found. Pure over its inputs.
 *
 * The returned response carries a `nextStepStructured` chain hint into
 * `suggest_fix(ruleId, file, line)` so the agent's first follow-up
 * call lands directly on the per-call surface that needs the
 * `(ruleId, file, line)` triple.
 */
export function lookupViolationById(args: {
  readonly findingId: string;
  readonly formatted: ScanFormatted;
  readonly filesScanned: number;
  readonly root: string;
}): McpToolResult | null {
  const { findingId, formatted, filesScanned, root } = args;
  for (const file of formatted.files) {
    for (const finding of file.findings) {
      if (finding.findingId !== findingId) continue;
      return textResult({
        found: true,
        kind: "violation",
        finding: { ...finding, file: file.path },
        filesScanned,
        scanned: { root },
        nextStep: `suggest_fix({ ruleId: "${finding.ruleId}", file: "${file.path}", line: ${finding.line} })`,
        nextStepStructured: {
          tool: "suggest_fix",
          args: { ruleId: finding.ruleId, file: file.path, line: finding.line },
        },
      });
    }
  }
  return null;
}

/**
 * Walks the surfaced review-candidate set looking for a `findingId`
 * match. Returns the canonical candidate-side response payload, or null
 * when no match is found.
 *
 * The chain hint uses the first criterion ID in the sorted `criteria`
 * union — `suggest_fix` accepts either a `ruleId` or a criterion ID
 * and resolves to the most-specific satisfying rule when given a
 * criterion (see the criterion-id bridge in `tool-suggest-fix.ts`).
 */
export function lookupCandidateById(args: {
  readonly findingId: string;
  readonly candidates: readonly ScanProjectReviewCandidate[];
  readonly filesScanned: number;
  readonly root: string;
}): McpToolResult | null {
  const { findingId, candidates, filesScanned, root } = args;
  for (const candidate of candidates) {
    if (candidate.findingId !== findingId) continue;
    const primaryCriterionId = candidate.criteria[0];
    return textResult({
      found: true,
      kind: "reviewCandidate",
      candidate,
      filesScanned,
      scanned: { root },
      ...(primaryCriterionId === undefined
        ? {}
        : {
            nextStep: `suggest_fix({ ruleId: "${primaryCriterionId}", file: "${candidate.file}", line: ${candidate.line} })`,
            nextStepStructured: {
              tool: "suggest_fix",
              args: {
                ruleId: primaryCriterionId,
                file: candidate.file,
                line: candidate.line,
              },
            },
          }),
    });
  }
  return null;
}

/**
 * Builds the honest miss response for a `findingId` lookup that found
 * neither a violation nor a review candidate. Per AI-first doctrine
 * "Zero-output success is ambiguous failure," the structured `reason`
 * plus `filesScanned` lets the caller distinguish "id genuinely
 * doesn't exist on this corpus" from "scan never ran on a useful
 * corpus."
 */
export function buildIdNotFoundResult(args: {
  readonly findingId: string;
  readonly filesScanned: number;
  readonly root: string;
}): McpToolResult {
  const { findingId, filesScanned, root } = args;
  return textResult({
    found: false,
    reason: "finding_id_not_found",
    filesScanned,
    scanned: { root },
    findingId,
    remediation:
      "The id may belong to an emission that no longer exists (file was edited, rule disabled, suppressed). Re-run the originating scan call and capture a fresh `findingId` before chaining to `suggest_fix`.",
  });
}

/**
 * Builds the zero-files-scanned envelope. The `warnings:
 * ["scanned_zero_files"]` code lets the caller distinguish "tool ran
 * but the cwd produced no parseable files" from "id genuinely not
 * present" via the structured `reason` discriminator alone.
 */
export function buildZeroFilesResult(args: {
  readonly findingId: string;
  readonly root: string;
}): McpToolResult {
  const { findingId, root } = args;
  return textResult({
    found: false,
    reason: "scanned_zero_files",
    filesScanned: 0,
    scanned: { root },
    findingId,
    warnings: ["scanned_zero_files"],
  });
}
