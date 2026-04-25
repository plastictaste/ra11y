/**
 * scan_project's response-assembly + token-density budget wiring.
 *
 * Extracted from `tool-scan-project.ts` so that file stays under the
 * 500-effective-line budget enforced by `scripts/check-limits.ts`.
 * Nothing here is meant to be reused by other tools — `scan_diff` and
 * `scan` have their own response shapes and handle the same budget via
 * their own in-file helpers.
 */

import { applyMetaCacheMode } from "./meta-cache.ts";
import type { NextStepStructured } from "./next-step.ts";
import type { ReferenceGuide } from "./reference-guide.ts";
import { ruleCatalogField } from "./rule-catalog.ts";
import type { ScanProjectReviewCandidate } from "./scan-project-review-candidates.ts";
import type { McpSession } from "./session.ts";
import { applyTokenBudget } from "./token-budget.ts";
import { analyzeTopContributor } from "./token-budget-contributor.ts";
import type { ScanFormatted } from "./tools-helpers.ts";
import {
  type ScanWarningCode,
  type ScanWarningDetails,
  tokenBudgetTruncatedDetailsField,
} from "./warnings.ts";

type FileEntry = ScanFormatted["files"][number];

/**
 * Structured reason a paginated response returned fewer files than
 * the caller's `limit`. Three regimes the caller cannot otherwise
 * distinguish from `files.length < requestedLimit` alone:
 *
 * - `token_density` — the density cap trimmed trailing entries so
 *   the response fits under {@link DEFAULT_TOKEN_BUDGET_CHARS}.
 *   Resumable via `nextOffset`; the dropped files live on the next
 *   page.
 * - `end_of_results` — the page is the last page and the remaining
 *   file-count is naturally less than `limit`. Not resumable (there
 *   are no more files); `nextOffset` is absent.
 * - `per_criterion_cap` — not emitted by scan_project today; reserved
 *   for future use in case the tool grows a per-criterion clip
 *   primitive. The matching orthogonal signal in `checklist` today
 *   is `perCriterionClipped: true`, not this `pageClipReason` code,
 *   because checklist's clip is per-criterion-within-page rather
 *   than a whole-page reason.
 */
type PageClipReason = "token_density" | "end_of_results" | "per_criterion_cap";

interface PaginationFields {
  /**
   * V1-TRUNCATED-FIELD-PRESENCE-CONTRACT: load-bearing negative —
   * `truncated: false` means "this IS the full inventory." Always
   * present on scan_project responses; never conditional-spread.
   * The density-cap path in {@link mergeBudgetedFields} overrides
   * to `true as const` when it drops trailing entries.
   */
  readonly truncated: boolean;
  readonly nextOffset?: number;
  /**
   * V1-TRUNCATED-FIELD-PRESENCE-CONTRACT: always emitted alongside
   * `truncated`. When `truncated: false`, this equals the response's
   * `files.length`; when `truncated: true`, it carries the full
   * pre-truncation inventory size so the caller still sees the
   * total even with trimmed pages.
   */
  readonly totalFilesWithFindings: number;
  readonly requestedLimit?: number;
  readonly effectiveLimit?: number;
  readonly pageClipReason?: PageClipReason;
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
  /**
   * V1-NEXTSTEP-DEDUP-META-VS-TOP-LEVEL: the English next-call hint and
   * its machine-parseable twin ship at the TOP level of the response,
   * not inside `meta`. `nextStep` is load-bearing agent direction —
   * hoisting to the top level keeps it discoverable next to `plan` and
   * `files`, and removes the "appears in both places" dedup risk the
   * doctrine warns against (one pointer, one place per Q6 de-duplication).
   * `nextStepStructured` stays present-when-meaningful: omitted when
   * the builder fell back to generic prose with no concrete first
   * finding to name.
   */
  readonly nextStep: string;
  readonly nextStepStructured?: NextStepStructured;
  /**
   * Top-level `warnings[]` codes that the scan-meta pass produced.
   * Optional so the caller can conditional-spread — present-when-
   * meaningful applies to the *wire* shape; internally a caller
   * that has no codes to report simply omits the key rather than
   * passing `[]`, keeping the assembly site honest.
   */
  readonly baseWarnings?: readonly ScanWarningCode[];
  /**
   * Structured sibling payloads for the `baseWarnings` codes that
   * carry one (see `ScanWarningDetails`). Threaded through the
   * assembler so codes like `vendor_css_dominates_findings` reach
   * the response on the non-truncated path too — the prior shape
   * only emitted a details payload when the token-density cap
   * fired, which would silently drop the new code's per-file
   * pivot on the common "response fit" case. Omit when no code
   * has a structured payload.
   */
  readonly baseWarningsDetails?: ScanWarningDetails;
  /**
   * Q-SHARED-SCAN-PROJECT-INLINE-REVIEW-CANDIDATES: inline manual-review
   * candidates for the narrow `formatted.files.length === 0 &&
   * actionableManualItems > 0` case. Already filtered to `manualIds`
   * and capped at the caller's `limit` by the handler's helper.
   * Caller conditional-spreads — when the field reaches the assembler
   * it is non-empty by construction; this keeps the "present-when-
   * meaningful" shape honest (CLAUDE.md §1 "Ambiguous field shapes
   * are dishonest").
   */
  readonly reviewCandidates?: readonly ScanProjectReviewCandidate[];
}

/**
 * Assembles the scan_project response body, then applies the ADR 0021
 * amendment token-density secondary budget. Building the object twice
 * (once tentative, once final) lets the budget helper measure the REAL
 * wire shape before deciding how many file entries to drop.
 */
export function assembleScanProjectResponse(args: AssembleArgs): Record<string, unknown> {
  const {
    params,
    session,
    formatted,
    hoisted,
    page,
    pageOffset,
    fullMeta,
    baseWarnings,
    baseWarningsDetails,
    reviewCandidates,
    nextStep,
    nextStepStructured,
  } = args;
  const hasBaseCodes = baseWarnings !== undefined && baseWarnings.length > 0;
  const hasBaseDetails =
    baseWarningsDetails !== undefined && Object.keys(baseWarningsDetails).length > 0;
  // Q-SHARED-SCAN-PROJECT-INLINE-REVIEW-CANDIDATES: conditional-spread
  // the field — caller only passes it when `formatted.files.length ===
  // 0 && candidates survive`, so reaching this point means the array
  // is meaningful. Defensive `.length > 0` here keeps the shape honest
  // if a future caller forgets the gate.
  const hasInlineReview = reviewCandidates !== undefined && reviewCandidates.length > 0;
  const tentative = {
    plan: formatted.plan,
    files: hoisted.files,
    ...page.paginationFields,
    ...(hoisted.referenceGuide === undefined ? {} : { referenceGuide: hoisted.referenceGuide }),
    ...ruleCatalogField(params, session.registry.rules, formatted.files),
    ...(hasInlineReview ? { reviewCandidates } : {}),
    ...(hasBaseCodes ? { warnings: baseWarnings } : {}),
    ...(hasBaseDetails ? { warningsDetails: baseWarningsDetails } : {}),
    // V1-NEXTSTEP-DEDUP-META-VS-TOP-LEVEL: one pointer, one place —
    // `nextStep` + `nextStepStructured` ship at the top level only.
    // Pre-change they rode in `meta` next to scan-confidence telemetry,
    // which crowded the load-bearing agent-direction signal into a
    // field the doctrine labels "verbose scan-confidence telemetry"
    // and forced the agent to hop into meta to read the canonical
    // next call. Top-level is the discoverability default per
    // `.claude/rules/mcp-response-shapes.md` Q6 de-duplication doctrine.
    nextStep,
    ...(nextStepStructured === undefined ? {} : { nextStepStructured }),
    meta: applyMetaCacheMode({ toolName: "scan_project", params, fullMeta, session }),
  };
  const budgeted = applyTokenBudget({
    response: tentative,
    filesKey: "files",
    files: hoisted.files,
    offset: pageOffset,
  });
  if (budgeted.droppedCount === 0) return tentative;
  // The caller's requested page size is the top-level `requestedLimit`
  // — what the caller asked for, not the post-pagination page count
  // the density cap saw entering. `page.paginationFields.requestedLimit`
  // is stamped by the paginator on every page that carries pagination
  // state; it's the clamped `limit` param. Falling back to
  // `hoisted.files.length` covers the (unreachable in production) case
  // where the paginator emitted no pagination fields but the density
  // cap still fired.
  const callerRequestedLimit = page.paginationFields.requestedLimit ?? hoisted.files.length;
  return mergeBudgetedFields({
    tentative,
    budgeted,
    ...(hasBaseCodes ? { baseWarnings } : {}),
    ...(hasBaseDetails ? { baseWarningsDetails } : {}),
    totalFilesWithFindings: formatted.files.length,
    // `warningsDetails.response_token_budget_truncated.requestedLimit`
    // keeps its original meaning — the file count the density cap saw
    // entering the guard — so the payload echo (50→10 vs 50→48) stays
    // anchored to the density cap's input, not the caller's kwarg. The
    // top-level `requestedLimit` below uses the caller's kwarg. Both
    // pivots are useful: the density echo for debugging the cap's
    // decision; the top-level for "did the response honor my page
    // size" at a glance.
    densityRequestedLimit: hoisted.files.length,
    densityEffectiveLimit: budgeted.files.length,
    topLevelRequestedLimit: callerRequestedLimit,
    topLevelEffectiveLimit: budgeted.files.length,
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
  readonly baseWarnings?: readonly ScanWarningCode[];
  readonly baseWarningsDetails?: ScanWarningDetails;
  readonly totalFilesWithFindings: number;
  readonly densityRequestedLimit: number;
  readonly densityEffectiveLimit: number;
  readonly topLevelRequestedLimit: number;
  readonly topLevelEffectiveLimit: number;
}): Record<string, unknown> {
  const {
    tentative,
    budgeted,
    baseWarnings,
    baseWarningsDetails,
    totalFilesWithFindings,
    densityRequestedLimit,
    densityEffectiveLimit,
    topLevelRequestedLimit,
    topLevelEffectiveLimit,
  } = args;
  const warnings: ScanWarningCode[] = warningsWithDensityCode(baseWarnings);
  // Q7-RESPONSE-TOKEN-BUDGET-DETAIL: analyze the PRE-TRIM files list
  // (the full hoisted set the density cap saw entering the guard) so
  // the contributor triple reflects which finding was actually the
  // budget-blower, not whichever finding happened to survive the
  // tail-drop. Honest framing: the agent learns "rule X had a 4 KB
  // payload" regardless of whether rule X's file was kept or dropped.
  const tentativeFiles = (tentative as Record<string, unknown>)["files"];
  const filesForAnalysis = Array.isArray(tentativeFiles)
    ? (tentativeFiles as readonly { readonly findings?: readonly Record<string, unknown>[] }[])
    : [];
  const topContributor = analyzeTopContributor(filesForAnalysis);
  const densityDetails = tokenBudgetTruncatedDetailsField({
    requestedLimit: densityRequestedLimit,
    effectiveLimit: densityEffectiveLimit,
    topContributor,
  }).warningsDetails;
  // Merge the density-cap payload with the pre-existing
  // `baseWarningsDetails` so codes like
  // `vendor_css_dominates_findings` that rode in from the scan
  // meta aren't lost when the truncation path overwrites the
  // field. Keys never overlap (density code is scan-assembly-
  // only), so an object-spread is safe.
  const mergedDetails: ScanWarningDetails = {
    ...(baseWarningsDetails ?? {}),
    ...densityDetails,
  };
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
    // Overwrite the paginator's top-level pagination settlement. The
    // paginator stamped `effectiveLimit: hoisted.files.length` and (on
    // last-page clips) `pageClipReason: "end_of_results"`; the density
    // cap ran AFTER pagination, so the truthful top-level shape is the
    // post-density file count plus `pageClipReason: "token_density"`.
    // The pre-density paginator-level settlement is recoverable via
    // `warningsDetails.response_token_budget_truncated.requestedLimit`
    // (the density cap's input) vs. this top-level `requestedLimit`
    // (the caller's kwarg). Two pivots, two useful views.
    requestedLimit: topLevelRequestedLimit,
    effectiveLimit: topLevelEffectiveLimit,
    pageClipReason: "token_density" as const,
    warnings,
    // Echo the requested vs. effective file counts the density cap
    // settled on, so a caller seeing
    // `warnings: ["response_token_budget_truncated"]` can tell
    // aggressive trims (50→10) from marginal ones (50→48) without a
    // re-page. Structured payload lives under the ADR 0023 sibling
    // channel; the bare-string warnings array stays unchanged.
    warningsDetails: mergedDetails,
  };
}

function warningsWithDensityCode(base: readonly ScanWarningCode[] | undefined): ScanWarningCode[] {
  if (base === undefined) return ["response_token_budget_truncated"];
  if (base.includes("response_token_budget_truncated")) return [...base];
  return [...base, "response_token_budget_truncated"];
}
