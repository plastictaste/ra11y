/**
 * scan_project's response-assembly + token-density budget wiring.
 *
 * Extracted from `tool-scan-project.ts` so that file stays under the
 * 500-effective-line budget enforced by `scripts/check-limits.ts`.
 * Nothing here is meant to be reused by other tools — `scan_diff` and
 * `scan` have their own response shapes and handle the same budget via
 * their own in-file helpers.
 */

import { BUILTIN_RULES } from "../rules/index.ts";
import { applyMetaCacheMode } from "./meta-cache.ts";
import type { ReferenceGuide } from "./reference-guide.ts";
import { ruleCatalogField } from "./rule-catalog.ts";
import type { McpSession } from "./session.ts";
import { applyTokenBudget } from "./token-budget.ts";
import type { ScanFormatted } from "./tools-helpers.ts";
import { type ScanWarningCode, tokenBudgetTruncatedDetailsField } from "./warnings.ts";

type FileEntry = ScanFormatted["files"][number];

interface PaginationFields {
  readonly truncated?: true;
  readonly nextOffset?: number;
  readonly totalFilesWithFindings?: number;
}

interface PageShape {
  readonly files: readonly FileEntry[];
  readonly paginationFields: PaginationFields;
}

interface HoistedShape {
  readonly files: readonly FileEntry[];
  readonly referenceGuide: ReferenceGuide | undefined;
}

interface AssembleArgs {
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
  readonly formatted: ScanFormatted;
  readonly hoisted: HoistedShape;
  readonly page: PageShape;
  readonly pageOffset: number;
  readonly fullMeta: Record<string, unknown>;
  readonly baseWarnings: readonly ScanWarningCode[];
}

/**
 * Assembles the scan_project response body, then applies the ADR 0021
 * amendment token-density secondary budget. Building the object twice
 * (once tentative, once final) lets the budget helper measure the REAL
 * wire shape before deciding how many file entries to drop.
 */
export function assembleScanProjectResponse(args: AssembleArgs): Record<string, unknown> {
  const { params, session, formatted, hoisted, page, pageOffset, fullMeta, baseWarnings } = args;
  const tentative = {
    plan: formatted.plan,
    files: hoisted.files,
    ...page.paginationFields,
    ...(hoisted.referenceGuide === undefined ? {} : { referenceGuide: hoisted.referenceGuide }),
    ...ruleCatalogField(params, BUILTIN_RULES, formatted.files),
    ...(baseWarnings.length > 0 ? { warnings: baseWarnings } : {}),
    meta: applyMetaCacheMode({ toolName: "scan_project", params, fullMeta, session }),
  };
  const budgeted = applyTokenBudget({
    response: tentative,
    filesKey: "files",
    files: hoisted.files,
    offset: pageOffset,
  });
  if (budgeted.droppedCount === 0) return tentative;
  return mergeBudgetedFields({
    tentative,
    budgeted,
    baseWarnings,
    totalFilesWithFindings: formatted.files.length,
    // `requestedLimit` is the file count the density cap saw entering
    // the guard — `hoisted.files` is the post-pagination, pre-density
    // page. `effectiveLimit` is what survived the trim. Together they
    // name the settlement so a caller seeing `files.length: 10` +
    // `truncated: true` can tell whether the density cap trimmed
    // aggressively (50→10) or marginally (50→48) without a re-page.
    requestedLimit: hoisted.files.length,
    effectiveLimit: budgeted.files.length,
  });
}

/**
 * Merges the token-budget helper's decision back into the scan_project
 * response body. Token truncation composes with the file-count cap —
 * either or both may fire, and the caller cannot tell which by reading
 * `truncated: true` alone — so we emit the
 * `response_token_budget_truncated` warning whenever the density cap
 * dropped any entries. `totalFilesWithFindings` always reflects the
 * full pre-truncation count so the caller sees inventory size either
 * way.
 */
function mergeBudgetedFields(args: {
  readonly tentative: Record<string, unknown>;
  readonly budgeted: ReturnType<typeof applyTokenBudget<FileEntry>>;
  readonly baseWarnings: readonly ScanWarningCode[];
  readonly totalFilesWithFindings: number;
  readonly requestedLimit: number;
  readonly effectiveLimit: number;
}): Record<string, unknown> {
  const {
    tentative,
    budgeted,
    baseWarnings,
    totalFilesWithFindings,
    requestedLimit,
    effectiveLimit,
  } = args;
  const warnings: ScanWarningCode[] = warningsWithDensityCode(baseWarnings);
  const detailsField = tokenBudgetTruncatedDetailsField({ requestedLimit, effectiveLimit });
  return {
    ...tentative,
    files: budgeted.files,
    // `truncated` stays present-only (never `false`) per CLAUDE.md
    // §1 "Ambiguous field shapes are dishonest"; `nextOffset` tracks
    // the next resumable offset; `totalFilesWithFindings` persists so
    // the caller still sees the full inventory size even when both
    // caps fired.
    truncated: true as const,
    ...(budgeted.nextOffset === undefined ? {} : { nextOffset: budgeted.nextOffset }),
    totalFilesWithFindings,
    warnings,
    // Echo the requested vs. effective file counts the density cap
    // settled on, so a caller seeing
    // `warnings: ["response_token_budget_truncated"]` can tell
    // aggressive trims (50→10) from marginal ones (50→48) without a
    // re-page. Structured payload lives under the ADR 0023 sibling
    // channel; the bare-string warnings array stays unchanged.
    ...detailsField,
  };
}

function warningsWithDensityCode(base: readonly ScanWarningCode[]): ScanWarningCode[] {
  if (base.includes("response_token_budget_truncated")) return [...base];
  return [...base, "response_token_budget_truncated"];
}
