/**
 * scan_project's response-assembly + token-density budget wiring.
 *
 * Extracted from `tool-scan-project.ts` so that file stays under the
 * 500-effective-line budget enforced by `scripts/check-limits.ts`.
 * Nothing here is meant to be reused by other tools — `scan_diff` and
 * `scan` have their own response shapes and handle the same budget via
 * their own in-file helpers.
 */

import { posix } from "node:path";
import { applyMetaCacheMode } from "./meta-cache.ts";
import {
  type NextStepStructured,
  perRuleNarrowingNextStep,
  pickTopRuleByCount,
  shouldRerouteToPerRuleNarrowing,
} from "./next-step.ts";
import {
  guardOversizeEnvelope,
  type OversizeEnvelopeReason,
  oversizeEnvelopeWarningsField,
} from "./oversize-envelope.ts";
import {
  type FixDescriptions,
  type ReferenceGuide,
  repairResponseDangling,
} from "./reference-guide.ts";
import { buildScanProjectReviewFields } from "./review-candidate-prompts.ts";
import { ruleCatalogField } from "./rule-catalog.ts";
import { applyPagingHintToNextStep } from "./scan-project-paging-hint.ts";
import type { ScanProjectReviewCandidate } from "./scan-project-review-candidates.ts";
import {
  buildSlimNextStepStructured,
  SLIM_NEXT_STEP_PROSE,
} from "./scan-project-slim-next-step.ts";
import type { McpSession } from "./session.ts";
import { applyTokenBudget } from "./token-budget.ts";
import { analyzeTopContributor } from "./token-budget-contributor.ts";
import type { ScanFormatted } from "./tools-helpers.ts";
import {
  computeTruncatedFilesDroppedWarning,
  spliceTruncatedFilesDropped,
} from "./truncated-files-dropped.ts";
import {
  fillMissingWarningDetails,
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
   * load-bearing negative —
   * `truncated: false` means "this IS the full inventory." Always
   * present on scan_project responses; never conditional-spread.
   * The density-cap path in {@link mergeBudgetedFields} overrides
   * to `true as const` when it drops trailing entries.
   */
  readonly truncated: boolean;
  readonly nextOffset?: number;
  /**
   * always emitted alongside
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
  /**
   * Complete pre-truncation `fixDescriptions` map computed during the
   * hoist pass — see {@link import("./reference-guide.ts").hoistAndBuildReferenceGuide}.
   * Threaded through the assembler so the
   * {@link import("./reference-guide.ts").repairDanglingDescriptionRefs}
   * invariant guard at the end of {@link assembleScanProjectResponse}
   * has the source-of-truth map to re-inline from when a future
   * truncation site drops `referenceGuide` while keeping findings
   * with `fix.descriptionRef`. Optional for backward compatibility
   * with callers that haven't been updated; absent → no repair pass.
   */
  readonly originalFixDescriptions?: FixDescriptions;
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
   * the English next-call hint and
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
  /**
   * Cross-surface candidate-shape contract: the per-criterion
   * shared-reason hoist. When every candidate of a criterion shares
   * the same `reason` text, the verbatim form is hoisted here once
   * so the wire shape doesn't repeat the same prose under every
   * sibling row. Mirrors `scan_file.reviewCandidatePrompts` /
   * `checklist.reviewCandidatePrompts` /
   * `review_candidates.prompts[criterionId].genericReason` so an
   * agent reading any review-candidate-bearing surface reads the
   * dedup signal off the same field name. Per `docs/kb/architecture/
   * ai-first-consumer.md` "Per-tool review-candidate shape must
   * agree across surfaces."
   *
   * Caller conditional-spreads; an empty map is omitted entirely —
   * present-when-meaningful per CLAUDE.md §1.
   */
  readonly reviewCandidatePrompts?: Readonly<
    Record<string, import("./review-candidate-prompts.ts").ReviewCandidatePromptEntry>
  >;
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
    reviewCandidatePrompts,
    nextStep,
    nextStepStructured,
  } = args;
  const hasBaseCodes = baseWarnings !== undefined && baseWarnings.length > 0;
  const hasBaseDetails =
    baseWarningsDetails !== undefined && Object.keys(baseWarningsDetails).length > 0;
  // Q-SHARED-SCAN-PROJECT-INLINE-REVIEW-CANDIDATES: caller only passes
  // these when `formatted.files.length === 0 && candidates survive`,
  // so reaching this point means the inputs are meaningful. Helper
  // packs both review fields into one spreadable record.
  const reviewFields = buildScanProjectReviewFields(reviewCandidates, reviewCandidatePrompts);
  const tentative = {
    plan: formatted.plan,
    files: hoisted.files,
    ...page.paginationFields,
    ...(hoisted.referenceGuide === undefined ? {} : { referenceGuide: hoisted.referenceGuide }),
    ...ruleCatalogField(params, session.registry.rules, formatted.files),
    ...reviewFields,
    ...(hasBaseCodes ? { warnings: baseWarnings } : {}),
    ...(hasBaseDetails ? { warningsDetails: baseWarningsDetails } : {}),
    // one pointer, one place —
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
  const postDensity =
    budgeted.droppedCount === 0
      ? tentative
      : mergeBudgetedFields({
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
          // The caller's requested page size is the top-level
          // `requestedLimit` — what the caller asked for, not the post-
          // pagination page count the density cap saw entering.
          // `page.paginationFields.requestedLimit` is stamped by the
          // paginator on every page that carries pagination state; it's
          // the clamped `limit` param. Falling back to
          // `hoisted.files.length` covers the (unreachable in production)
          // case where the paginator emitted no pagination fields but the
          // density cap still fired.
          topLevelRequestedLimit: page.paginationFields.requestedLimit ?? hoisted.files.length,
          topLevelEffectiveLimit: budgeted.files.length,
        });
  // last-resort hard-ceiling
  // guard. After the density cap settled, the response can still be
  // over the MCP host's ~25k-token wall — single-file pathology (the
  // density helper's progress guarantee keeps one entry even when its
  // payload alone exceeds the budget) or verbose-meta dominance
  // (perRuleCoverage + scannedBuildArtifacts + scope.files inflating
  // the envelope independent of the file-count axis). When the
  // post-density envelope crosses the hard ceiling exported from
  // `./oversize-envelope.ts`, degrade to the minimum-honest envelope
  // rather than letting the host drop the response (which reads to
  // the agent as "tool never ran" — the canonical
  // oversize-success-is-ambiguous-failure shape per doctrine). The
  // slim-builder owns the replacement shape.
  const guarded = guardOversizeEnvelope({
    original: postDensity,
    // `formatted.files.length` is the full pre-pagination, pre-
    // density-cap inventory of files-with-findings — passed through
    // so the slim path's warningsDetails payload can ship a sibling
    // `totalFilesWithFindings` next to `droppedFileCountFromRequestedLimit`.
    // Without it, an agent reading the slim warning sees only the
    // post-density count being dropped now (e.g. "1 dropped" on a
    // 4936-files-with-findings corpus where the density cap clipped
    // 4936→1) and concludes the corpus was nearly empty — the silent
    // underreport this counter exists to defeat.
    totalFilesWithFindings: formatted.files.length,
    buildSlim: (reason) =>
      buildSlimScanProjectEnvelope({
        original: postDensity,
        reason,
        formatted,
        fullMeta,
        params,
        session,
      }),
  });
  // when the assembled response ships
  // `truncated: true` + `nextOffset`, prepend a paging hint to the
  // prose AND surface the paging call as the primary structured next-
  // step (moving the prior triage call into
  // `nextStepStructuredAlternatives`). Without this overlay an agent
  // following the structured shape proceeds to single-finding triage
  // and silently never pages the rest. Slim envelope (`files: []`, no
  // `nextOffset`) is filtered by the helper; ships its own prose.
  const withPaging = applyPagingHintToNextStep({ response: guarded.response, params });
  // dangling-pointer
  // invariant guard: every `fix.descriptionRef.hash` emitted in the
  // response must resolve in `referenceGuide.fixDescriptions[ruleId]`
  // in the same response, OR the finding must carry an inline
  // `fix.description`. The doctrine bullet "Truncated containers must
  // rename or sentinel, not retain" forbids the dangling-pointer
  // shape: looks like a populated reference but resolves to nothing.
  //
  // Today's truncation paths preserve the invariant by construction —
  // the density cap keeps `referenceGuide` intact via the `tentative`
  // spread, and the slim envelope drops `files: []` so no surviving
  // finding can dangle. The guard fires regardless as defense-in-depth
  // for any future truncation site that drops `referenceGuide` (or
  // trims its entries) without rewriting surviving findings. Identity-
  // preserving on the common case where every ref resolves cleanly.
  return repairResponseDangling(withPaging, hoisted.originalFixDescriptions);
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
  // analyze the PRE-TRIM files list
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
  // Q9 rule-level impact of the density-cap drop. Pass
  // `totalFilesWithFindings` + `finalFilesShipped` so the helper
  // computes the CANONICAL drop count (= full inventory minus shipped),
  // not just the page-internal tail-trim — see the canonical
  // drop-count formulation in `truncated-files-dropped.ts` and the
  // `truncated_files_dropped.droppedFileCount` field doc in `warnings.ts`.
  const droppedTailFiles = filesForAnalysis.slice(budgeted.files.length);
  const truncatedFilesDroppedPayload = computeTruncatedFilesDroppedWarning(droppedTailFiles, {
    totalFilesWithFindings,
    finalFilesShipped: budgeted.files.length,
  }).payload;
  if (truncatedFilesDroppedPayload !== undefined && !warnings.includes("truncated_files_dropped")) {
    warnings.push("truncated_files_dropped");
  }
  // Merge the density-cap payload with the pre-existing
  // `baseWarningsDetails` so codes like
  // `vendor_css_dominates_findings` that rode in from the scan
  // meta aren't lost when the truncation path overwrites the
  // field. Keys never overlap (density code is scan-assembly-
  // only), so an object-spread is safe. Warnings-details schema
  // discipline: stamp empty markers for any codes in `warnings`
  // that don't already have keys (defensive — `baseWarningsDetails`
  // came through `warningsField` so the codes already have keys,
  // but the helper guarantees the invariant either way).
  const mergedDetails: ScanWarningDetails = fillMissingWarningDetails(warnings, {
    ...(baseWarningsDetails ?? {}),
    ...densityDetails,
    ...(truncatedFilesDroppedPayload === undefined
      ? {}
      : { truncated_files_dropped: truncatedFilesDroppedPayload }),
  });
  // when the density cap clipped
  // the page to ≤ 2 files AND the project carries > 100 files-with-
  // findings, the standard `nextStep` (suggest_fix on the first
  // finding) leads the agent into a per-file pagination loop that may
  // take ~totalFilesWithFindings round trips on bulk-template repros.
  // Override `nextStep` + `nextStepStructured` to a per-rule narrowing
  // hint (`explain_rule({ ruleId: topRuleId })`) so the agent can
  // triage the dominant rule's wave once instead of paging through
  // every file. Reroute is additive routing for the degenerate regime;
  // every other field on the response is unchanged (surface-don't-
  // suppress — the per-file findings still ship).
  const perRuleReroute = perRuleNarrowingRerouteFields({
    files: filesForAnalysis,
    effectiveLimit: topLevelEffectiveLimit,
    totalFilesWithFindings,
  });
  return {
    ...tentative,
    ...perRuleReroute,
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

/**
 * builds the spreadable
 * `nextStep` / `nextStepStructured` override fragment for the
 * degenerate-pagination regime. Returns an empty record when the gate
 * fails (page wasn't clipped to ≤ 2 files OR inventory ≤ 100 OR the
 * dominant rule was ambiguous), so the merge call site keeps the
 * standard nextStep unchanged via spread-then-override semantics —
 * the override only stamps when all preconditions hold.
 *
 * The reroute target is `explain_rule({ ruleId: topRuleId })` rather
 * than `scan_project({ ruleIds: [...] })` because `scan_project` does
 * not currently accept a `ruleIds` parameter. Per the AI-first
 * doctrine "Don't duplicate capability the agent already has" +
 * "Interrogate the problem before accepting the solution's shape,"
 * the structured hint must name an existing tool with parameters the
 * tool actually accepts; routing to a non-existent param would
 * silently fail when the agent copies `nextStepStructured.args` into
 * the next call. The pairing item tracks
 * the future `findings_by_rule` primitive that would route here
 * directly; until that lands, `explain_rule` is the honest first step
 * — the agent reads what the dominant rule does, decides whether the
 * wave is a vendor-noise mass-suppress candidate or a single-fix
 * mechanical edit that propagates, then acts once instead of paging.
 */
function perRuleNarrowingRerouteFields(args: {
  readonly files: readonly { readonly findings?: readonly Record<string, unknown>[] }[];
  readonly effectiveLimit: number;
  readonly totalFilesWithFindings: number;
}): {
  readonly nextStep?: string;
  readonly nextStepStructured?: NextStepStructured;
} {
  const { files, effectiveLimit, totalFilesWithFindings } = args;
  if (!shouldRerouteToPerRuleNarrowing({ effectiveLimit, totalFilesWithFindings })) {
    return {};
  }
  const filesForCount = files.map((f) => ({ findings: f.findings ?? [] }));
  const topRuleId = pickTopRuleByCount(filesForCount);
  if (topRuleId === undefined) return {};
  const rerouted = perRuleNarrowingNextStep({
    topRuleId,
    totalFilesWithFindings,
    effectiveLimit,
  });
  return {
    nextStep: rerouted.prose,
    ...(rerouted.structured === undefined ? {} : { nextStepStructured: rerouted.structured }),
  };
}

function warningsWithDensityCode(base: readonly ScanWarningCode[] | undefined): ScanWarningCode[] {
  const code = "response_token_budget_truncated" as const;
  return base === undefined || !base.includes(code) ? [...(base ?? []), code] : [...base];
}

/**
 * builds the minimum-honest
 * envelope when the post-density-cap response is still over the host
 * ceiling. The shape is the smallest set of load-bearing fields the
 * agent needs to route once: `plan` (so the agent sees the per-lane
 * `fixesByClass` tally, the manual-review counters, the executive
 * `summary`), `meta` slimmed to scan-confidence telemetry that fits
 * (`configSource`, `scanned`, `filesScanned`, `durationMs`, `tool`,
 * `version`, `standards`, `level`), `nextStep` rerouted to recommend
 * narrower scope, and the `warnings` channel carrying every code that
 * accumulated through the clip chain plus the new
 * `response_dropped_files_oversize` code with its byte-arithmetic
 * payload.
 *
 * Drops `files[]` entirely (`[]`) — surface-don't-suppress would
 * normally argue against this, but the alternative when the host
 * drops the whole envelope is no `files[]` AT ALL, plus no `plan`,
 * meta, warnings, or nextStep. Trading per-file findings for the
 * load-bearing routing channel is the doctrine's prescribed move
 * ("the agent can still route once on what arrived; without the
 * envelope, it cannot"). The agent's recovery path is to re-call
 * scan_project with a narrower scope, reading the per-file findings
 * one slice at a time.
 *
 * `nextStep` is rewritten to name the recovery — the original
 * `nextStep` may have pointed at `suggest_fix` or `explain_rule` on a
 * specific rule that survived the per-file trim, but that pointer is
 * misleading once `files[]` is dropped (the agent has no per-finding
 * `findingId` to feed to `suggest_fix`). The rewritten prose names
 * "narrow scope" and the structured form points at `scan_project`
 * with a hint to pass `additionalPaths` or a tighter `cwd`. We do
 * NOT recommend `summaryOnly: true` — that mode does not exist yet
 * (tracked under). When the
 * summary mode lands, this nextStep is the natural caller to thread
 * it through.
 */
function buildSlimScanProjectEnvelope(args: {
  readonly original: Record<string, unknown>;
  readonly reason: OversizeEnvelopeReason;
  readonly formatted: ScanFormatted;
  readonly fullMeta: Record<string, unknown>;
  readonly params: Record<string, unknown>;
  readonly session: McpSession;
}): Record<string, unknown> {
  const { original, reason, formatted, fullMeta, params, session } = args;
  // Slim the meta block to just the scan-confidence telemetry that
  // fits comfortably under the minimum-envelope target. The full meta
  // (perRuleCoverage, scannedBuildArtifacts, scope.files,
  // analysisCoverage with per-extension maps) is the canonical bloat
  // source on bulk-corpus repros — keeping it would defeat the
  // fallback. Agents calling back with a narrower scope will get the
  // full meta on the next response.
  const slimMeta = buildSlimMeta(fullMeta);
  // Names of top-level meta sub-fields the slim builder discarded.
  // Threaded into the warnings payload as
  // `warningsDetails.response_dropped_files_oversize.metaFieldsDropped`
  // so an agent reading the surviving slim `meta` block can
  // distinguish "this codebase has no scan-confidence concerns" from
  // "the meta block was clipped to fit the envelope" — the
  // "Truncated containers must rename or sentinel, not retain"
  // doctrine bullet. Order is the pre-slim key order from the full
  // meta block so the wire shape stays deterministic.
  const metaFieldsDropped = Object.keys(fullMeta).filter((k) => !(k in slimMeta));
  // Original `warnings` / `warningsDetails` may exist (e.g. when the
  // density cap fired its own code first). Read them off `original`
  // so we preserve the full clip chain on the wire.
  const baseWarnings = readWarnings(original);
  const baseWarningsDetails = readWarningsDetails(original);
  // Trim verbose arrays that survive the meta-key drop. Even with
  // `meta` slimmed and `files: []`, the surviving envelope can still
  // serialize past {@link MINIMUM_ENVELOPE_TARGET_CHARS} on bulk-vendor
  // corpora because:
  //   - `plan.topRules` carries up to {@link TOP_RULES_DEFAULT_LIMIT}
  //     entries (~250 chars/entry → 2.5KB).
  //   - `plan.findingsByFile` carries up to
  //     {@link import("./scan-assembly.ts").FINDINGS_BY_FILE_DEFAULT_LIMIT}
  //     entries (~60–120 chars/entry → 2.4KB).
  //   - `warningsDetails.bulk_catalog_detected.suggestedExcludes`
  //     carries scanner-derived globs, one per top vendor basename.
  //   - `warningsDetails.scanned_minified_file.files` and
  //     `warningsDetails.scss_unresolved_variables.files` carry full
  //     identity arrays (one path per qualifying file).
  // Each gets head-sliced to a small deterministic prefix; the
  // pre-trim length lands in
  // `warningsDetails.response_dropped_files_oversize.slimTruncations`
  // so the agent reading the slim envelope sees how aggressive the
  // trim was. Symmetric to the meta-keys-dropped channel: both close
  // the "Truncated containers must rename or sentinel, not retain"
  // doctrine bullet for the slim path.
  const slimmedPlan = slimPlanForSlimEnvelope(formatted.plan);
  const slimmedDetails = slimWarningsDetailsForSlimEnvelope(baseWarningsDetails);
  const slimTruncations: SlimTruncationEntry[] = [
    ...slimmedPlan.truncations,
    ...slimmedDetails.truncations,
  ];
  // Q9 rule-level impact of the slim path's drop — ships `files: []`,
  // dropping the entire `formatted.files` set. Pass canonical inputs;
  // both values agree (canonical == page-internal), so the field-builder
  // omits the redundant `pageClipFromRequestedLimit` per
  // present-when-meaningful. See `truncated-files-dropped.ts`.
  const truncatedFilesDroppedPayload = computeTruncatedFilesDroppedWarning(formatted.files, {
    totalFilesWithFindings: formatted.files.length,
    finalFilesShipped: 0,
  }).payload;
  const merged = oversizeEnvelopeWarningsField({
    reason,
    ...(baseWarnings === undefined ? {} : { baseWarnings }),
    ...(slimmedDetails.details === undefined
      ? {}
      : { baseWarningsDetails: slimmedDetails.details }),
    ...(metaFieldsDropped.length > 0 ? { metaFieldsDropped } : {}),
    ...(slimTruncations.length > 0 ? { slimTruncations } : {}),
  });
  // Splice the rule-level warning + payload onto the byte-level
  // result returned by `oversizeEnvelopeWarningsField`. Keys never
  // overlap with the codes that helper just stamped, so the merge
  // is safe — see `spliceTruncatedFilesDropped` for the details.
  const { warnings: finalWarnings, warningsDetails: finalWarningsDetails } =
    spliceTruncatedFilesDropped(merged, truncatedFilesDroppedPayload);
  return {
    plan: slimmedPlan.plan,
    files: [],
    // The slim envelope drops every per-file finding entry (`files: []`)
    // — that IS a truncation, regardless of whether the density cap
    // fired earlier. Without `truncated: true` the agent reads
    // `files: []` alongside an absent or `null` flag and cannot
    // distinguish "clean scan" from "envelope had to drop the per-file
    // detail to fit." Symmetric to the density-cap path in
    // `mergeBudgetedFields`, which stamps the same `truncated: true`
    // when it trims the tail. `totalFilesWithFindings` rides alongside
    // so the inventory size is visible — the agent's recovery path
    // (re-call with narrower scope) needs to know how many files were
    // dropped, not just that some were. See the
    // "Truncated containers must rename or sentinel, not retain" and
    // "Oversize-success is ambiguous failure" bullets in
    // `docs/kb/architecture/ai-first-consumer.md`.
    truncated: true as const,
    totalFilesWithFindings: formatted.files.length,
    // Disambiguates the slim path's `files: []` from the
    // density-cap path's `files: [<survivors>]` and from a clean
    // small-corpus response that legitimately ships fewer files than
    // the inventory. `truncated: true` + `totalFilesWithFindings`
    // already imply truncation engaged, but the density-cap path
    // stamps the same pair while still shipping a non-empty `files[]`
    // (trimmed tail, surviving head). Without a dedicated flag the
    // agent cannot tell "envelope dropped every per-file entry" from
    // "envelope kept some, trimmed others" by reading the truncation
    // pair alone — both paths look the same until the agent counts
    // `files[]` and discovers it's empty, which is the
    // silent-distinction failure mode the
    // "Truncated containers must rename or sentinel, not retain"
    // doctrine bullet calls out. Sibling boolean rather than
    // restructuring `files` into a `{ truncated, droppedCount }`
    // object — keeps the wire-shape contract for `files` (always an
    // array) intact for every consumer that already iterates it, and
    // the count payload already lives on
    // `warningsDetails.response_dropped_files_oversize.droppedFileCountFromRequestedLimit`
    // (which pairs with `totalFilesWithFindings` for the pre-cap
    // denominator).
    filesArrayDropped: true as const,
    nextStep: SLIM_NEXT_STEP_PROSE,
    nextStepStructured: buildSlimNextStepStructured({
      formatted,
      params,
      isVendor: buildVendorPredicate(fullMeta),
    }),
    warnings: finalWarnings,
    warningsDetails: finalWarningsDetails,
    meta: applyMetaCacheMode({ toolName: "scan_project", params, fullMeta: slimMeta, session }),
  };
}

/**
 * Reads the `warnings` field off the original response if present and
 * shaped as a string array. Defensive: the response object is typed
 * `Record<string, unknown>`, so we narrow before propagating.
 */
function readWarnings(original: Record<string, unknown>): readonly ScanWarningCode[] | undefined {
  const w = original["warnings"];
  return Array.isArray(w) ? (w as readonly ScanWarningCode[]) : undefined;
}

/**
 * Reads the `warningsDetails` field off the original response if
 * present and shaped as an object. Defensive narrowing matches
 * {@link readWarnings} for the symmetric channel.
 */
function readWarningsDetails(original: Record<string, unknown>): ScanWarningDetails | undefined {
  const d = original["warningsDetails"];
  return d !== null && typeof d === "object" ? (d as ScanWarningDetails) : undefined;
}

/**
 * Slims the full meta block to just the scan-confidence telemetry the
 * agent needs to know the scan ran for real. Drops every per-rule /
 * per-file / per-extension fan-out — those are the canonical bloat
 * sources on bulk-corpus repros.
 *
 * Kept fields (in priority order):
 *   - `tool`, `version`, `standards`, `level` — identity telemetry
 *     stamped by the scan harness so the agent knows which scanner /
 *     standards / conformance level produced this response.
 *   - `filesScanned`, `durationMs` — top-line scan-completeness
 *     telemetry. Without these the agent can't tell "tool ran on
 *     small input" from "tool ran on bulk corpus and had to slim."
 *   - `configSource` — the load-bearing config-resolution telemetry
 *     per the doctrine's "verbose meta is signal" rule. Tells the
 *     agent which `ra11y.config.ts` (if any) shaped the scan.
 *   - `scanned` — root + extras envelope (paths, scan kind). Lets
 *     the agent re-issue a narrower call against the same root.
 *   - `rootSource`, `scanMode` — additional routing context.
 *   - `hostDeclaredRoots`, `rootsOverlapNote` — MCP-protocol routing
 *     telemetry stamped by the host's `roots` capability. Tiny scalar
 *     list / scalar string respectively; keeping them on slim lets the
 *     agent see "the host declared these roots, which is why my call
 *     fell through to <root>" even when the per-file detail had to
 *     drop. Bulk-corpus slim responses without these would leave the
 *     agent guessing why the scope landed where it did, which is the
 *     "Truncated containers must rename or sentinel, not retain" silent-
 *     miss failure mode.
 *   - `restrictToPathsApplied` — present-when-meaningful scope-confirmation
 *     telemetry stamped by `applyRestrictToPaths` whenever the caller
 *     passed a non-empty `restrictToPaths` param. The payload carries
 *     the resolved paths plus pre/post intersection counts, which an
 *     agent reading the slim envelope needs to distinguish "restrict
 *     scoped to N files" from "restrict silently ignored, full corpus
 *     scanned" — without it, an oversize-fallback response with
 *     `filesScanned: 4936` reads as a full-corpus scan even when the
 *     caller had explicitly narrowed via `restrictToPaths`. Inverts
 *     the meaning of `filesScanned` if dropped. Tiny payload (paths +
 *     two scalar counters), no slimming needed; conditional-spread
 *     ensures it stays absent on calls that didn't pass the param.
 *
 * Everything else (perRuleCoverage, scannedBuildArtifacts,
 * analysisCoverage, scope, additionalPathsScanned, …) is dropped on
 * the slim path. The agent will get the full meta when it calls back
 * with a narrower scope.
 */
function buildSlimMeta(fullMeta: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_META_KEYS) {
    if (key in fullMeta) slim[key] = fullMeta[key];
  }
  return slim;
}

const SLIM_META_KEYS: readonly string[] = [
  "tool",
  "version",
  "standards",
  "level",
  "filesScanned",
  "durationMs",
  "configSource",
  "scanned",
  "rootSource",
  "scanMode",
  "hostDeclaredRoots",
  "rootsOverlapNote",
  "restrictToPathsApplied",
];

/**
 * Head-slice cap for `plan.topRules` on the slim envelope. The full
 * rollup carries up to {@link import("./scan-assembly.ts").TOP_RULES_DEFAULT_LIMIT}
 * (10) entries at ~250 chars each, accounting for ~2.5KB on the wire
 * for one structured field. The slim path keeps the top-3 so the
 * agent still sees the dominant rules ("call explain_rule on the
 * top one") without paying the long-tail cost; the truncated count
 * lands in `warningsDetails.response_dropped_files_oversize.slimTruncations`
 * so the agent can see the original size at a glance.
 */
const SLIM_TOP_RULES_CAP = 3;

/**
 * Head-slice cap for `plan.findingsByFile` on the slim envelope. The
 * full rollup carries up to {@link import("./scan-assembly.ts").FINDINGS_BY_FILE_DEFAULT_LIMIT}
 * (20) entries at ~60–120 chars each, accounting for ~2.4KB on the wire.
 * The slim path keeps the top-3 so the agent still sees the dominant
 * file clusters ("scope down to this subtree") without paying the long-
 * tail cost; the truncated count lands in
 * `warningsDetails.response_dropped_files_oversize.slimTruncations`. The
 * `findingsByFileTruncated: true` companion flag — already stamped by
 * `withFindingsByFile` whenever the rollup clipped a longer error+
 * warning tail — is preserved on the slim plan; the slim path's further
 * head-slice is reported through `slimTruncations` rather than
 * overloading the same boolean.
 */
const SLIM_FINDINGS_BY_FILE_CAP = 3;

/**
 * Head-slice cap for `plan.topDirectories` on the slim envelope. The
 * full rollup carries up to {@link import("./scan-assembly.ts").TOP_DIRECTORIES_DEFAULT_LIMIT}
 * (10) entries at ~80–140 chars each, accounting for ~1.4KB on the
 * wire. The slim path keeps the top-3 so the agent still sees the
 * dominant sub-trees ("scope down to this project") without paying the
 * long-tail cost; the truncated count lands in
 * `warningsDetails.response_dropped_files_oversize.slimTruncations`. The
 * `topDirectoriesTruncated: true` companion flag — already stamped by
 * `withTopDirectories` whenever the full-rollup head-slice clipped a
 * longer tail — is preserved on the slim plan; the slim path's further
 * head-slice is reported through `slimTruncations` rather than
 * overloading the same boolean. Mirrors `SLIM_FINDINGS_BY_FILE_CAP` so
 * the rank-ordered headline rollups all trim symmetrically under the
 * slim regime.
 */
const SLIM_TOP_DIRECTORIES_CAP = 3;

/**
 * Head-slice cap for `warningsDetails.bulk_catalog_detected.suggestedExcludes`
 * on the slim envelope. The full list mirrors the top vendor basenames
 * the scan saw — typically 5–20 globs on a bulk-template corpus. Keeping
 * the top 5 preserves the agent's "paste-into-propose-config" path while
 * trimming the long tail; the original count lands in `slimTruncations`.
 */
const SLIM_SUGGESTED_EXCLUDES_CAP = 5;

/**
 * Head-slice cap for verbose-string-list payloads on warning details
 * (e.g. `scanned_minified_file.files`, `scss_unresolved_variables.files`)
 * on the slim envelope. These arrays grow linearly with input — one
 * entry per qualifying file — and cross the slim budget on the same
 * bulk-vendor corpora that triggered the slim path in the first place.
 * The top 3 paths give the agent a deterministic head-slice as a
 * pivot ("scope the next call around these files") while the
 * `slimTruncations` payload names the original size.
 */
const SLIM_FILE_LIST_CAP = 3;

interface SlimTruncationEntry {
  readonly fieldPath: string;
  readonly shown: number;
  readonly total: number;
}

/**
 * Head-slices verbose arrays on the `plan` block that survive the slim
 * envelope's drop of `files[]` and the meta-key trim. Three `plan`
 * fields grow linearly with input fan-out today:
 *
 *   - `plan.topRules` — one entry per distinct rule that fired (rule
 *     fan-out axis).
 *   - `plan.findingsByFile` — one entry per file with at least one
 *     error/warning finding (file fan-out axis).
 *   - `plan.topDirectories` — one entry per first-child-dir bucket
 *     with at least one error/warning finding (sub-tree fan-out axis;
 *     the headline that exposes the dominant project on a mono-repo).
 *
 * Each gets its own cap; the truncations array reports each field
 * independently so `slimTruncations` carries the per-field shown/total
 * pair the agent can act on. Returns a `{ plan, truncations }` pair so
 * the caller threads the truncation summary into the warnings-channel
 * payload.
 *
 * Pure: never mutates the input. When no array crosses its cap, the
 * input plan reference rides through unchanged and `truncations` is
 * empty — the conditional spread at the call site keeps the wire
 * shape stable for small-corpus slim paths that didn't need to trim.
 */
function slimPlanForSlimEnvelope(plan: Record<string, unknown>): {
  readonly plan: Record<string, unknown>;
  readonly truncations: readonly SlimTruncationEntry[];
} {
  let next: Record<string, unknown> = plan;
  const truncations: SlimTruncationEntry[] = [];
  const slimField = (key: string, cap: number): void => {
    const value = plan[key];
    if (!Array.isArray(value) || value.length <= cap) return;
    const trimmed = value.slice(0, cap);
    next = { ...next, [key]: trimmed };
    truncations.push({ fieldPath: `plan.${key}`, shown: trimmed.length, total: value.length });
  };
  slimField("topRules", SLIM_TOP_RULES_CAP);
  slimField("findingsByFile", SLIM_FINDINGS_BY_FILE_CAP);
  slimField("topDirectories", SLIM_TOP_DIRECTORIES_CAP);
  return { plan: next, truncations };
}

/**
 * Head-slices verbose string arrays on `warningsDetails` payloads. The
 * three known offenders today —
 * `bulk_catalog_detected.suggestedExcludes`,
 * `scanned_minified_file.files`,
 * `scss_unresolved_variables.files` — all carry one entry per
 * qualifying file/glob and grow linearly with input on bulk-vendor
 * corpora. Each gets head-sliced to a small deterministic prefix; the
 * original length lands in the returned `truncations` so the agent
 * sees the gap.
 *
 * Pure: returns a new details object only when at least one array was
 * trimmed; otherwise the input reference rides through and
 * `truncations` is empty. The caller conditional-spreads the
 * `slimTruncations` field to keep the wire shape stable when nothing
 * was trimmed.
 */
function slimWarningsDetailsForSlimEnvelope(details: ScanWarningDetails | undefined): {
  readonly details: ScanWarningDetails | undefined;
  readonly truncations: readonly SlimTruncationEntry[];
} {
  if (details === undefined) return { details: undefined, truncations: [] };
  const truncations: SlimTruncationEntry[] = [];
  const next: Record<string, unknown> = { ...details };
  for (const slot of SLIM_DETAIL_SLOTS) {
    const trimmed = trimStringArrayOnDetailSlot(next, slot);
    if (trimmed !== undefined) {
      truncations.push(trimmed);
    }
  }
  if (truncations.length === 0) {
    return { details, truncations: [] };
  }
  return { details: next as ScanWarningDetails, truncations };
}

interface DetailArraySlot {
  readonly code: string;
  readonly arrayKey: string;
  readonly cap: number;
  readonly fieldPath: string;
  /**
   * When `true`, the slim trim embeds an inline truncation sentinel
   * (`truncated: true`, `totalCount`, `shownCount`) at the same depth as
   * the trimmed array so an agent reading the payload directly sees the
   * absence-of-rest without cross-referencing the envelope-level
   * `slimTruncations` channel. Pairs with the canonical `slimTruncations`
   * reporter rather than replacing it (per the AI-first doctrine
   * "Truncation reporters must reconcile across warnings"). The two
   * channels reconcile by reference: `slimTruncations.shown/total`
   * mirror the inline `shownCount/totalCount` for the same field path.
   *
   * Today set only on `scanned_minified_file` — the canonical regression
   * the inline sentinel was added to close (a bulk-vendor scan shipping
   * 3 of 767 minified file paths under `files` with no inline marker).
   * `bulk_catalog_detected.suggestedExcludes` and
   * `scss_unresolved_variables.files` keep envelope-level reporting only
   * pending separate doctrine review — opt-in rather than blanket
   * rollout to keep the wire shape change narrow.
   */
  readonly embedInlineSentinel?: true;
}

/**
 * Map of `(warning code, array key)` pairs the slim envelope head-
 * slices. Keep additions to this list in lockstep with new
 * verbose-array payload slots on `ScanWarningDetails` — each entry
 * names the dotted `fieldPath` that lands in `slimTruncations` so the
 * agent reading the warning channel can find the trimmed array
 * unambiguously.
 */
const SLIM_DETAIL_SLOTS: readonly DetailArraySlot[] = [
  {
    code: "bulk_catalog_detected",
    arrayKey: "suggestedExcludes",
    cap: SLIM_SUGGESTED_EXCLUDES_CAP,
    fieldPath: "warningsDetails.bulk_catalog_detected.suggestedExcludes",
  },
  {
    code: "scanned_minified_file",
    arrayKey: "files",
    cap: SLIM_FILE_LIST_CAP,
    fieldPath: "warningsDetails.scanned_minified_file.files",
    embedInlineSentinel: true,
  },
  {
    code: "scss_unresolved_variables",
    arrayKey: "files",
    cap: SLIM_FILE_LIST_CAP,
    fieldPath: "warningsDetails.scss_unresolved_variables.files",
  },
];

/**
 * Trims a string-array payload on a `warningsDetails[<code>][<arrayKey>]`
 * slot in-place on the caller's `next` object. Returns the truncation
 * summary when the cap fired, `undefined` when the array was absent or
 * already under-cap. Defensive narrowing on every step — the input
 * payload shapes are union-typed and may legitimately omit either the
 * outer code or the inner array.
 *
 * When `slot.embedInlineSentinel === true`, the trimmed payload also
 * carries `truncated: true` + `totalCount` + `shownCount` at the same
 * depth as the trimmed array — see {@link DetailArraySlot.embedInlineSentinel}
 * for the rationale. Sentinel fields ride alongside the existing
 * `slimTruncations` envelope-level summary; the two channels reconcile
 * by reference (same shown/total pair).
 */
function trimStringArrayOnDetailSlot(
  next: Record<string, unknown>,
  slot: DetailArraySlot,
): SlimTruncationEntry | undefined {
  const payload = next[slot.code];
  if (payload === undefined || payload === null || typeof payload !== "object") return undefined;
  const arr = (payload as Record<string, unknown>)[slot.arrayKey];
  if (!Array.isArray(arr) || arr.length <= slot.cap) return undefined;
  const trimmed = arr.slice(0, slot.cap);
  const trimmedPayload: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
    [slot.arrayKey]: trimmed,
    ...(slot.embedInlineSentinel === true
      ? { truncated: true as const, totalCount: arr.length, shownCount: trimmed.length }
      : {}),
  };
  next[slot.code] = trimmedPayload;
  return { fieldPath: slot.fieldPath, shown: trimmed.length, total: arr.length };
}

/**
 * Walks the response's `files[]` (full pre-drop list) and the vendor-
 * path set derived from `meta.scannedBuildArtifacts`, returning the
 * top-level directory with the most non-vendor findings. Returns
 * `undefined` when no non-vendor file exists or the whole inventory
 * resolves to a single root directory equal to `.` (no subtree to
 * narrow into — the agent must pick a different scope dimension).
 *
 * "Top-level directory" means the first path segment of the file's
 * relative POSIX path (e.g. `src` for `src/foo/bar.tsx`). Files that
 * sit at the root (no slash) are excluded — narrowing to `.` is the
 * same as no narrowing.
 *
 * The directory tally favors breadth (most non-vendor findings under
 * one top-level), not the *file* with the most findings — narrowing to
 * a dir captures every authored file in that subtree on the next call,
 * whereas narrowing to a single file would force the agent into the
 * pagination loop the slim envelope is trying to escape.
 */
export function pickNonVendorNarrowingDir(
  files: readonly ScanFormatted["files"][number][],
  isVendor: (path: string) => boolean,
): string | undefined {
  const dirCounts = new Map<string, number>();
  for (const file of files) {
    if (isVendor(file.path)) continue;
    const topDir = topLevelDir(file.path);
    if (topDir === undefined) continue;
    const findingsCount = file.findings.length;
    // Count one per file even on zero findings — a file with no
    // findings still indicates the directory carries authored work
    // worth narrowing into. Falls back to 1 so the tally never under-
    // weights authored sub-trees on quiet rules.
    const weight = Math.max(findingsCount, 1);
    dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + weight);
  }
  if (dirCounts.size === 0) return undefined;
  let topDir: string | undefined;
  let topCount = 0;
  let tie = false;
  for (const [dir, count] of dirCounts) {
    if (count > topCount) {
      topDir = dir;
      topCount = count;
      tie = false;
    } else if (count === topCount) {
      tie = true;
    }
  }
  // On a clean tie at the top, fall back to `undefined` per the same
  // honesty principle as `pickTopRuleByCount` — naming an alphabetical
  // winner would route to a dir that doesn't actually dominate. The
  // caller ships empty args and the agent picks.
  if (tie || topDir === undefined) return undefined;
  return topDir;
}

/**
 * Returns the first path segment of a relative POSIX path (e.g. `src`
 * for `src/foo/bar.tsx`), or `undefined` when the path has no slash
 * (root file — narrowing to `.` would be a no-op) or is empty.
 */
function topLevelDir(relPath: string): string | undefined {
  if (relPath.length === 0) return undefined;
  // Reject absolute paths — `formatted.files[].path` is root-relative
  // POSIX by convention, but a defensive guard keeps the helper honest
  // if a future caller threads through an absolute path.
  if (relPath.startsWith("/")) return undefined;
  const dir = posix.dirname(relPath);
  if (dir === "." || dir === "") return undefined;
  // Take the first segment: `src/foo/bar` → `src`.
  const slash = dir.indexOf("/");
  return slash === -1 ? dir : dir.slice(0, slash);
}

/**
 * Builds the `(path: string) => boolean` vendor predicate from
 * `meta.scannedBuildArtifacts`. Combines `classified[].path` exact
 * matches (sub-threshold artifact + banner-detected entries) with a
 * directory-prefix match against `grouped[].pathHint` (basename
 * clusters with a shared parent dir) — a `formatted.files[].path` is
 * considered vendor when (a) it appears in `classified[]`, OR (b)
 * some `grouped[].pathHint` is a directory ancestor of the file, OR
 * (c) it equals a `pathHint` directory exactly (unlikely on file
 * inputs, kept for defensive symmetry).
 *
 * Q12: previously walked the parallel `ungrouped[]` and
 * `vendorLibraries[]` surfaces; the merged `classified[]` shape
 * carries every path either predicate identified, so the union now
 * happens upstream and this helper reads the single field.
 *
 * Returns a predicate that always returns `false` when
 * `scannedBuildArtifacts` is absent or shaped unexpectedly — defensive
 * narrowing matches the rest of this module's `Record<string, unknown>`
 * defensive reads on the `fullMeta` object. The predicate shape (rather
 * than a `ReadonlySet<string>`) lets the prefix-match arm participate
 * without enumerating the full vendor file set up-front; the grouped
 * pathHints are O(rules) and the file list is O(N), so per-file
 * predicate calls beat a fan-out into a flat set.
 */
export function buildVendorPredicate(fullMeta: Record<string, unknown>): (path: string) => boolean {
  const sba = fullMeta["scannedBuildArtifacts"];
  if (sba === undefined || sba === null || typeof sba !== "object") {
    return () => false;
  }
  const sbaObj = sba as Record<string, unknown>;
  const exact = collectClassifiedArtifactPaths(sbaObj["classified"]);
  const groupedPrefixes = collectGroupedPathHints(sbaObj["grouped"]);
  if (exact.size === 0 && groupedPrefixes.length === 0) {
    return () => false;
  }
  return (path: string): boolean => matchesVendorPath(path, exact, groupedPrefixes);
}

/**
 * Walks `meta.scannedBuildArtifacts.classified[]` and collects each
 * entry's `path` into a Set for O(1) exact-match lookups. Skips entries
 * that aren't object-shaped or whose `path` is missing/empty —
 * defensive narrowing matches the rest of this module's `Record<string,
 * unknown>` reads on the fullMeta object.
 */
function collectClassifiedArtifactPaths(classified: unknown): Set<string> {
  const exact = new Set<string>();
  if (!Array.isArray(classified)) return exact;
  for (const entry of classified) {
    if (!entry || typeof entry !== "object") continue;
    const path = (entry as Record<string, unknown>)["path"];
    if (typeof path === "string" && path.length > 0) {
      exact.add(path);
    }
  }
  return exact;
}

/**
 * Walks `meta.scannedBuildArtifacts.grouped[]` and collects each
 * group's `pathHint` (normalized with a trailing slash) for prefix-
 * match lookups. The trailing slash ensures `vendor/bootstrap` matches
 * `vendor/bootstrap/foo.css` but not `vendor/bootstrap-extras/foo.css`.
 */
function collectGroupedPathHints(grouped: unknown): string[] {
  const prefixes: string[] = [];
  if (!Array.isArray(grouped)) return prefixes;
  for (const group of grouped) {
    if (!group || typeof group !== "object") continue;
    const pathHint = (group as Record<string, unknown>)["pathHint"];
    if (typeof pathHint === "string" && pathHint.length > 0) {
      prefixes.push(pathHint.endsWith("/") ? pathHint : `${pathHint}/`);
    }
  }
  return prefixes;
}

/**
 * Tests whether `path` matches the vendor classification: exact match
 * in `exact`, prefix match against any normalized `groupedPrefixes`
 * (with trailing slash), OR exact match against a pathHint directory
 * (the `prefix.slice(0, -1)` form, kept for defensive symmetry on the
 * unlikely case where a file path equals a pathHint directory).
 */
function matchesVendorPath(
  path: string,
  exact: ReadonlySet<string>,
  groupedPrefixes: readonly string[],
): boolean {
  if (exact.has(path)) return true;
  for (const prefix of groupedPrefixes) {
    if (path.startsWith(prefix)) return true;
    if (path === prefix.slice(0, -1)) return true;
  }
  return false;
}
