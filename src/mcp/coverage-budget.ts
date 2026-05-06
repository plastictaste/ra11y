/**
 * `coverage` oversize-envelope wiring.
 *
 * Mirrors the `scan_project` / `scan_file` / `checklist` slim-envelope
 * guards (`guardOversizeEnvelope` minimum-honest fallback) for the
 * coverage response shape. Closes Q14-CHECKLIST-COVERAGE-LACK-MINIMUM-HONEST-ENVELOPE.
 *
 * Why this surface needs the same guard:
 *
 *   - `coverage` ships `meta.perRuleCoverage[]` (shared cascade rows
 *     for every loaded rule), `analysisCoverage` with per-extension
 *     fans, plus the standard-entry's `manualWithCandidates` /
 *     `untargetedCriteriaList` / `untestableCriteria` arrays. On
 *     bulk-vendor / large-corpus inputs the post-build response routinely
 *     lands in the 76–528 KB range — well past the MCP host's
 *     ~25 k-token (~100 k-char) ceiling.
 *   - The existing per-rule-coverage cap and meta-array head-slice
 *     trim individual surfaces but don't bound the assembled envelope
 *     when the corpus inflates every secondary surface at once.
 *   - Without a slim guard, the host transport drops the full envelope
 *     and the agent gets a transport error indistinguishable from "tool
 *     never ran" — the silent-miss failure mode the doctrine names under
 *     "Oversize-success is ambiguous failure" and "Per-tool lane and
 *     warning-set classification must agree" (cross-surface drift between
 *     `scan_project` succeeding and `coverage` evaporating on identical
 *     cwd).
 *
 * Cross-surface invariant: the same warning vocabulary
 * (`response_dropped_files_oversize`) and the same byte-arithmetic
 * payload shape (`oversizeEnvelopeWarningsField`) ride here as on
 * `scan_project` / `scan_file` / `checklist`. Per AI-first doctrine:
 *
 *   "When the same file or cwd is observed by `scan_project`,
 *    `scan_file`, `checklist`, and `coverage`, the lane classification,
 *    warning-set, and minimum-honest-envelope behavior must agree across
 *    all four."
 *
 * Slim envelope shape — when the assembled response serializes over the
 * host ceiling:
 *
 *   - `meta.perRuleCoverage` dropped (the canonical bloat surface for
 *     this tool); `meta` slimmed to scan-confidence telemetry.
 *   - `analysisCoverage` dropped (verbose per-extension fans).
 *   - `untargetedCriteriaList`, `manualWithCandidates`, `untestableCriteria`,
 *     `likelyIrrelevantCriteria`, `failingAutomatedCriteria`,
 *     `warningAutomatedCriteria` dropped (the canonical-criterion lists
 *     the agent gets back via `checklist` on a narrower scope).
 *   - Counter scalars retained (`untargetedCriteria`,
 *     `criteriaAutomatable`, `criteriaEvaluated`, `criteriaClean`,
 *     `criteriaWithFindings`, `criteriaTotalForProfile`, `criteriaByLevel`,
 *     `automatedCriteriaPassRate`, `summary`) — the load-bearing routing
 *     channel the agent budgets against. The criteria-axis count for
 *     manual-review items rides under `summary.actionable.criteria`;
 *     the untestable count rides under
 *     `summary.automatedCoverage.criteriaWithoutEligibleInputs`. The
 *     legacy top-level `actionableManualItems` and `criteriaUntestable`
 *     scalars were deleted in the full envelope per
 *     "Sibling fields naming the same concept must use one shape" —
 *     agents derive them from the structured `summary` block here,
 *     identical to how `checklist.summary.actionable.criteria` already
 *     exposes the same count.
 *   - `nextStep` rewritten to recommend narrower scope.
 *   - `warnings[]` extends with `response_dropped_files_oversize`;
 *     `warningsDetails.response_dropped_files_oversize` carries the
 *     byte arithmetic + `metaFieldsDropped`.
 */

import {
  guardOversizeEnvelope,
  type OversizeEnvelopeReason,
  oversizeEnvelopeWarningsField,
} from "./oversize-envelope.ts";
import type { ScanWarningCode, ScanWarningDetails } from "./warnings.ts";

/**
 * Top-level meta keys the slim envelope keeps on the wire. Same
 * doctrine as the sibling slim helpers: drop the verbose per-rule
 * fans, keep the load-bearing scan-confidence telemetry the agent
 * reads to verify the scan ran for real.
 *
 * `cwd` rides on the `coverage` meta block via `buildCoverageMetaField`,
 * so it's kept here too — it's the single field the slim nextStep
 * reads to advertise a narrower-scope recovery call.
 */
export const SLIM_COVERAGE_META_KEYS: readonly string[] = [
  "tool",
  "version",
  "standards",
  "level",
  "filesScanned",
  "filesWithAnyRuleEvaluated",
  "filesWithZeroRuleEvaluation",
  "durationMs",
  "configSource",
  "scanned",
  "rulesEvaluated",
  "cwd",
];

/**
 * Top-level fields outside `meta` that the slim envelope drops because
 * they carry per-criterion or per-rule fan-out that grows linearly with
 * the corpus. Listed explicitly so the slim builder's discard set is
 * inspectable and the contract stays stable across refactors.
 *
 * The corresponding scalar counters (`untargetedCriteria`,
 * `criteriaEvaluated`, `criteriaClean`, `criteriaWithFindings`, etc.)
 * ride alongside in the un-dropped fields — the agent still sees how
 * many criteria are in each bucket, just not the per-criterion
 * identifier list. The criteria-axis manual-review count and the
 * untestable count come back through the structured `summary` block
 * (`summary.actionable.criteria` /
 * `summary.automatedCoverage.criteriaWithoutEligibleInputs`); the
 * standalone top-level `actionableManualItems` and `criteriaUntestable`
 * scalars no longer ship on the full envelope and therefore can't be
 * "retained" here.
 */
export const SLIM_COVERAGE_DROPPED_TOP_KEYS: readonly string[] = [
  "untargetedCriteriaList",
  "manualWithCandidates",
  "untestableCriteria",
  "likelyIrrelevantCriteria",
  "failingAutomatedCriteria",
  "warningAutomatedCriteria",
  "analysisCoverage",
];

interface ApplyCoverageBudgetArgs {
  /** The full assembled response, post-build. */
  readonly response: Record<string, unknown>;
  /** Optional override for the hard ceiling — tests pass a smaller cap. */
  readonly hardCeilingChars?: number;
}

export interface ApplyCoverageBudgetResult {
  readonly response: Record<string, unknown>;
  /** True when the slim guard fired. */
  readonly truncated: boolean;
}

/**
 * Applies the oversize-envelope guard to a `coverage` response. Pure:
 * never mutates `args.response`. The slim builder owns its own
 * response shape — this helper only routes between pass-through and
 * slim. Pass-through is byte-identical to the input when the response
 * fits under the host ceiling.
 *
 * Single-standard responses (the common case — coverage's response
 * shape is an object when one standard is enabled) are the only path
 * that goes through the guard. Multi-standard responses ship as an
 * array shape and have not exhibited the post-build oversize regime in
 * field reports; if they do, this guard's input contract widens with
 * the same `arrayKey` knob `oversize-envelope.ts` exposes.
 */
export function applyCoverageBudget(args: ApplyCoverageBudgetArgs): ApplyCoverageBudgetResult {
  const { response, hardCeilingChars } = args;
  // Per-rule-coverage rows are the canonical bloat surface — count
  // them as the "files dropped" denominator so the warning payload
  // stays comparable to scan_project's counter framing on bulk
  // vendor scans.
  const perRuleCoverageCount = readPerRuleCoverageCount(response);
  const guarded = guardOversizeEnvelope({
    original: response,
    // The slim path drops `perRuleCoverage` entries off `meta`, not a
    // top-level array. The `arrayKey` knob is unused on this surface;
    // pass an unlikely key so the helper's defensive `Array.isArray`
    // returns the inventory size we computed off `meta` instead.
    arrayKey: "__coverage_no_top_array__",
    totalFilesWithFindings: perRuleCoverageCount,
    ...(hardCeilingChars === undefined ? {} : { hardCeilingChars }),
    buildSlim: (reason) =>
      buildSlimCoverageEnvelope({
        original: response,
        reason,
        perRuleCoverageCount,
      }),
  });
  // The helper's `droppedFileCountFromRequestedLimit` field reads off
  // the top-level array which doesn't exist here, so it'll report 0.
  // We fix the wire payload by re-stamping it with the per-rule count
  // when the slim path fired — the pre-cap inventory denominator
  // (`totalFilesWithFindings`) carries the same value, so both ride.
  if (guarded.triggered) {
    const fixed = fixupOversizeDropCounter(guarded.response, perRuleCoverageCount);
    return { response: fixed, truncated: true };
  }
  return { response: guarded.response, truncated: false };
}

/**
 * Builds the minimum-honest envelope when the assembled `coverage`
 * response is still over the host ceiling. The shape is the smallest
 * set of load-bearing fields the agent needs to route once.
 *
 * Drops `meta.perRuleCoverage` (the canonical bloat surface) along
 * with the per-criterion / per-rule fans listed in
 * {@link SLIM_COVERAGE_DROPPED_TOP_KEYS}. The agent's recovery path is
 * to re-call with narrower scope — the per-criterion / per-rule detail
 * comes back on that call.
 *
 * Retains every scalar counter (`actionableManualItems`,
 * `untargetedCriteria`, `criteriaEvaluated` …), the `summary` prose,
 * `nextStep`, the slimmed `meta` block, and the warnings channel.
 */
function buildSlimCoverageEnvelope(args: {
  readonly original: Record<string, unknown>;
  readonly reason: OversizeEnvelopeReason;
  readonly perRuleCoverageCount: number;
}): Record<string, unknown> {
  const { original, reason } = args;
  const slimMeta = buildSlimCoverageMeta(original);
  const originalMeta = readMeta(original);
  const metaFieldsDropped =
    originalMeta === undefined ? [] : Object.keys(originalMeta).filter((k) => !(k in slimMeta));
  const baseWarnings = readWarnings(original);
  const baseWarningsDetails = readWarningsDetails(original);
  const merged = oversizeEnvelopeWarningsField({
    reason,
    ...(baseWarnings === undefined ? {} : { baseWarnings }),
    ...(baseWarningsDetails === undefined ? {} : { baseWarningsDetails }),
    ...(metaFieldsDropped.length > 0 ? { metaFieldsDropped } : {}),
  });
  // Pass-through every top-level field that survives the slim. Spread
  // the original first so the scalar counters + `summary` + `scanned`
  // ride through, then overwrite the slim-relevant fields.
  //
  // Per `docs/kb/architecture/ai-first-consumer.md` "Truncation reporters
  // must reconcile across warnings": no third top-level scalar reporter
  // for the slim's meta drop. The canonical reporter is
  // `warningsDetails.response_dropped_files_oversize.metaFieldsDropped[]`
  // — it ALREADY enumerates exactly which top-level meta keys the slim
  // builder discarded. A sibling boolean (the previous
  // `metaFieldDropped: true`) that named the same event with no
  // companion enumeration forced an agent reading the response to
  // reconcile two reporters silently — the silent-miss failure mode the
  // doctrine bullet calls out. The `truncated: true` flag still rides
  // (it's the canonical `files: []` / per-rule-fans dropped sentinel
  // shared with `scan_project` slim), and the warning channel owns the
  // per-field detail.
  const slim: Record<string, unknown> = {
    ...original,
    nextStep: SLIM_NEXT_STEP_PROSE,
    nextStepStructured: buildSlimNextStepStructured(original),
    warnings: merged.warnings,
    warningsDetails: merged.warningsDetails,
    meta: slimMeta,
    truncated: true as const,
  };
  // Drop the verbose per-criterion / per-rule fans the slim path
  // discards. Each `delete` is independent — no field is load-bearing
  // here once the agent commits to re-calling with a narrower scope.
  for (const key of SLIM_COVERAGE_DROPPED_TOP_KEYS) {
    delete slim[key];
  }
  return slim;
}

/**
 * Slims the full meta block to {@link SLIM_COVERAGE_META_KEYS}. The
 * `perRuleCoverage` array — the canonical bloat surface for this tool
 * — drops here along with `perRuleCoverageSummary` and any other
 * verbose secondary surface the meta builder may add in the future.
 *
 * Returns a fresh object so the caller's `metaFieldsDropped` derivation
 * compares keys without prototype chain effects.
 */
function buildSlimCoverageMeta(response: Record<string, unknown>): Record<string, unknown> {
  const fullMeta = readMeta(response);
  if (fullMeta === undefined) return {};
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_COVERAGE_META_KEYS) {
    if (key in fullMeta) {
      slim[key] = fullMeta[key];
    }
  }
  return slim;
}

function readMeta(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const m = response["meta"];
  if (m === undefined || m === null || typeof m !== "object") return undefined;
  return m as Record<string, unknown>;
}

function readWarnings(response: Record<string, unknown>): readonly ScanWarningCode[] | undefined {
  const w = response["warnings"];
  if (!Array.isArray(w)) return undefined;
  return w as readonly ScanWarningCode[];
}

function readWarningsDetails(response: Record<string, unknown>): ScanWarningDetails | undefined {
  const d = response["warningsDetails"];
  if (d === undefined || d === null || typeof d !== "object") return undefined;
  return d as ScanWarningDetails;
}

function readPerRuleCoverageCount(response: Record<string, unknown>): number {
  const meta = readMeta(response);
  if (meta === undefined) return 0;
  const rows = meta["perRuleCoverage"];
  if (Array.isArray(rows)) return rows.length;
  // `perRuleCoverageSummary: { ruleCount, ruleIds }` — the compact
  // form the meta builder ships when `verboseMeta: false`. Use
  // `ruleCount` as the canonical count when the verbose array is
  // absent.
  const summary = meta["perRuleCoverageSummary"];
  if (summary !== null && typeof summary === "object") {
    const ruleCount = (summary as Record<string, unknown>)["ruleCount"];
    return typeof ruleCount === "number" && Number.isFinite(ruleCount) ? ruleCount : 0;
  }
  return 0;
}

/**
 * Re-stamps `warningsDetails.response_dropped_files_oversize.droppedFileCountFromRequestedLimit`
 * with the per-rule-coverage count, replacing the helper's default
 * (which read 0 off the absent top-level array key). Symmetric to the
 * `totalFilesWithFindings` value that already rides — both name the
 * per-rule-coverage cardinality on this tool.
 */
function fixupOversizeDropCounter(
  response: Record<string, unknown>,
  perRuleCoverageCount: number,
): Record<string, unknown> {
  const details = response["warningsDetails"];
  if (details === undefined || details === null || typeof details !== "object") return response;
  const payload = (details as Record<string, unknown>)["response_dropped_files_oversize"];
  if (payload === undefined || payload === null || typeof payload !== "object") return response;
  const fixed: Record<string, unknown> = {
    ...response,
    warningsDetails: {
      ...(details as Record<string, unknown>),
      response_dropped_files_oversize: {
        ...(payload as Record<string, unknown>),
        droppedFileCountFromRequestedLimit: perRuleCoverageCount,
      },
    },
  };
  return fixed;
}

/**
 * Prose for the slim envelope's nextStep. Names the recovery the
 * agent needs to perform: the response shape itself signals "I had
 * to drop the per-rule coverage detail to fit."
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
 * must terminate at a narrowing tool, never form a cycle between
 * transport-failing siblings": when this surface's slim guard fires
 * on a bulk-vendor / oversize corpus, `checklist` on the same cwd is
 * the OTHER project-rooted tool the doctrine warns against pointing
 * at — the cross-corpus sweep observed `coverage.nextStep → checklist`
 * AND `checklist.nextStep → coverage` both transport-failing on the
 * same input, leaving the agent in a circular handoff with no
 * narrowing path in the cycle. The recovery now points at
 * `propose_config` — a deterministic narrowing tool that emits an
 * `exclude` block from the same `scannedBuildArtifacts` evidence the
 * over-cap envelope carries. The next `scan_project` call after the
 * agent applies the proposed excludes traverses a narrower file set
 * by construction. Concrete narrowing knobs (`cwd`, `paths`,
 * `standard` / `level`) are still named in the prose for callers
 * that want to skip the round-trip.
 */
const SLIM_NEXT_STEP_PROSE =
  "The full response was over the MCP host's token ceiling, so the per-rule and per-criterion detail surfaces were dropped to keep the envelope routable. " +
  "Call `propose_config` to emit an `exclude` block from the build-artifact classifier, then re-run `scan_project` (or `coverage`) over the narrowed file set. " +
  "Alternatively re-call `coverage` directly with a narrower scope: pass a tighter `cwd` (a single subdirectory), " +
  "`paths` to scope to a specific file set, or restrict by `standard` / `level`. " +
  "Do NOT re-call `checklist` on the same cwd — that surface ships the same scope-classifier and will transport-fail the same way (per `docs/kb/architecture/ai-first-consumer.md` \"NextStep handoffs must terminate at a narrowing tool\").";

/**
 * Structured nextStep for the slim envelope. Routes to `propose_config`
 * — a deterministic scope-narrowing tool — instead of the sibling
 * project-rooted `checklist` tool. Per
 * `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs must
 * terminate at a narrowing tool, never form a cycle between
 * transport-failing siblings," routing the agent at `checklist` on
 * the same cwd would echo the parameters that just produced the
 * oversize envelope: `checklist` ships the same scope-classifier and
 * its own slim guard fires on the same corpus. `propose_config`
 * consumes the `scannedBuildArtifacts` evidence to emit an `exclude`
 * block — the next call after the agent applies that block runs over
 * a narrower file set by construction. Args ship empty per
 * "Ambiguous field shapes are dishonest" — `propose_config` resolves
 * its own scan root, and fabricating a `cwd` here would lock the
 * agent into the same too-large scope.
 */
function buildSlimNextStepStructured(_original: Record<string, unknown>): {
  readonly tool: string;
  readonly args: Record<string, unknown>;
} {
  return {
    tool: "propose_config",
    args: {},
  };
}
