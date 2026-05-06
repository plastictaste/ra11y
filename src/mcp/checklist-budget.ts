/**
 * `checklist` oversize-envelope wiring.
 *
 * Mirrors the `scan_project` and `scan_file` slim-envelope guards
 * (`guardOversizeEnvelope` minimum-honest fallback) for the checklist
 * response shape. Closes Q14-CHECKLIST-COVERAGE-LACK-MINIMUM-HONEST-ENVELOPE.
 *
 * Why this surface needs the same guard:
 *
 *   - `checklist` ships an `items[]` per actionable manual criterion
 *     with grounded candidates carrying file:line + reason + snippet
 *     payloads. On bulk-vendor / large-corpus inputs the post-paging
 *     response routinely lands in the 77–199 KB range — well past the
 *     MCP host's ~25 k-token (~100 k-char) ceiling.
 *   - The existing per-page `limit` / `maxCandidatesPerCriterion`
 *     primitives trim the candidate fan but don't bound the surviving
 *     `items[]` * `meta.analysisCoverage` * `analysisCoverage.fragmentFiles`
 *     envelope when the corpus inflates every secondary surface at once.
 *   - Without a slim guard, the host transport drops the full envelope
 *     and the agent gets a transport error indistinguishable from "tool
 *     never ran" — the silent-miss failure mode the doctrine names under
 *     "Oversize-success is ambiguous failure" and "Per-tool lane and
 *     warning-set classification must agree" (cross-surface drift between
 *     `scan_project` succeeding and `checklist` evaporating on identical
 *     cwd).
 *
 * Cross-surface invariant: the same warning vocabulary
 * (`response_dropped_files_oversize`) and the same byte-arithmetic
 * payload shape (`oversizeEnvelopeWarningsField`) ride here as on
 * `scan_project` / `scan_file`. Per AI-first doctrine:
 *
 *   "When the same file or cwd is observed by `scan_project`,
 *    `scan_file`, `checklist`, and `coverage`, the lane classification,
 *    warning-set, and minimum-honest-envelope behavior must agree across
 *    all four."
 *
 * Slim envelope shape — when the assembled response serializes over the
 * host ceiling:
 *
 *   - `itemsTruncated: []` (RENAMED from `items` so the field name
 *     itself signals the contents were stripped — per the AI-first
 *     doctrine bullet "Truncated containers must rename or sentinel,
 *     not retain"). Mirrors the `meta.perRuleCoverageTruncated` /
 *     `analysisCoverage.fragmentFilesTruncated` precedent in
 *     `meta-array-cap.ts`. The original `items` key is absent from the
 *     wire so an agent reading `response.items` (the populated path)
 *     gets `undefined` rather than the misleading `[]` it used to.
 *   - `truncated: true`, `totalCandidates`: pre-drop inventory size.
 *   - `truncationReason: "response_dropped_files_oversize"` — names the
 *     warning code that owns the byte-arithmetic payload, so an agent
 *     reading the per-field sentinel can cross-reference
 *     `warningsDetails.<reason>` for `preDropBytes` /
 *     `hardCeilingBytes` / `metaFieldsDropped` without parsing the
 *     `warnings[]` channel separately.
 *   - `summary` retained — the actionable / candidates rollups are the
 *     load-bearing routing channel the agent budgets against.
 *   - `meta` slimmed to scan-confidence telemetry (matches
 *     `SLIM_CHECKLIST_META_KEYS` below).
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
 * doctrine as `scan-project-budget.ts`'s `SLIM_META_KEYS` and
 * `scan-file-budget.ts`'s `SLIM_SCAN_FILE_META_KEYS`: drop the verbose
 * per-rule / per-extension fans, keep the load-bearing scan-confidence
 * telemetry the agent reads to verify the scan ran for real.
 *
 * `cwd` is checklist-specific (the response stamps it on `meta`
 * directly); the rest mirrors the cross-tool slim shape.
 */
export const SLIM_CHECKLIST_META_KEYS: readonly string[] = [
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
  "cwd",
];

interface ApplyChecklistBudgetArgs {
  /** The full assembled response, post-paging. */
  readonly response: Record<string, unknown>;
  /** Optional override for the hard ceiling — tests pass a smaller cap. */
  readonly hardCeilingChars?: number;
}

export interface ApplyChecklistBudgetResult {
  readonly response: Record<string, unknown>;
  /** True when the slim guard fired. */
  readonly truncated: boolean;
}

/**
 * Applies the oversize-envelope guard to a `checklist` response. Pure:
 * never mutates `args.response`. The slim builder owns its own response
 * shape — this helper only routes between pass-through and slim.
 *
 * Pass-through is byte-identical to the input when the response fits
 * under the host ceiling — the under-cap path is reference-stable so
 * downstream consumers see no churn on common-case responses.
 */
export function applyChecklistBudget(args: ApplyChecklistBudgetArgs): ApplyChecklistBudgetResult {
  const { response, hardCeilingChars } = args;
  const totalCandidates = readNumber(response, "totalCandidates") ?? 0;
  const guarded = guardOversizeEnvelope({
    original: response,
    arrayKey: "items",
    totalFilesWithFindings: totalCandidates,
    ...(hardCeilingChars === undefined ? {} : { hardCeilingChars }),
    buildSlim: (reason) =>
      buildSlimChecklistEnvelope({
        original: response,
        reason,
        totalCandidates,
      }),
  });
  return { response: guarded.response, truncated: guarded.triggered };
}

/**
 * Builds the minimum-honest envelope when the assembled `checklist`
 * response is still over the host ceiling. The shape is the smallest
 * set of load-bearing fields the agent needs to route once.
 *
 * Replaces `items[]` with `itemsTruncated: []` — the field name swap
 * signals "the contents were stripped" at the field level, so an agent
 * reading just `response.items` sees `undefined` rather than the
 * misleading empty array the prior shape shipped. The verbose
 * per-criterion candidate fan is the canonical bloat source on
 * bulk-vendor corpora, and the agent's recovery path is to re-call
 * with narrower scope (a smaller `cwd`, a `paths` slice, or a tighter
 * `standard` / `level`). Symmetric to scan_project's
 * `buildSlimScanProjectEnvelope` and scan_file's
 * `buildSlimScanFileEnvelope`; the field-rename pattern follows the
 * `meta.perRuleCoverageTruncated` /
 * `meta.analysisCoverage.fragmentFilesTruncated` precedent established
 * in `meta-array-cap.ts`. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Truncated containers
 * must rename or sentinel, not retain."
 *
 * Retains `summary` (the actionable / candidate rollups), `nextStep`,
 * the slimmed `meta` block, and the warnings channel. Drops
 * `analysisCoverage` (verbose per-rule fans) and `untargetedCriteriaList`
 * / `likelyIrrelevant` (large-corpus recovery routes through scan_project,
 * not checklist's secondary surfaces).
 */
function buildSlimChecklistEnvelope(args: {
  readonly original: Record<string, unknown>;
  readonly reason: OversizeEnvelopeReason;
  readonly totalCandidates: number;
}): Record<string, unknown> {
  const { original, reason, totalCandidates } = args;
  const slimMeta = buildSlimChecklistMeta(original);
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
  // Pass through the small load-bearing top-level fields by reading
  // them off `original` rather than spreading the whole object — the
  // verbose secondary surfaces (`analysisCoverage`, `untargetedCriteriaList`,
  // `likelyIrrelevant`, `nextCursor` / pagination state) drop on the
  // slim path because the agent's recovery is "scope down and re-call,"
  // not "page deeper into the same too-large response."
  const summary = original["summary"];
  const nextStep = SLIM_NEXT_STEP_PROSE;
  const nextStepStructured = buildSlimNextStepStructured(original);
  const slim: Record<string, unknown> = {
    ...(summary === undefined ? {} : { summary }),
    itemsTruncated: [] as readonly unknown[],
    truncated: true as const,
    truncationReason: "response_dropped_files_oversize" as const,
    totalCandidates,
    nextStep,
    nextStepStructured,
    warnings: merged.warnings,
    warningsDetails: merged.warningsDetails,
    meta: slimMeta,
  };
  return slim;
}

/**
 * Slims the full meta block to {@link SLIM_CHECKLIST_META_KEYS}.
 * Returns a fresh object so the caller's `metaFieldsDropped` derivation
 * compares keys without prototype chain effects.
 */
function buildSlimChecklistMeta(response: Record<string, unknown>): Record<string, unknown> {
  const fullMeta = readMeta(response);
  if (fullMeta === undefined) return {};
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_CHECKLIST_META_KEYS) {
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

function readNumber(response: Record<string, unknown>, key: string): number | undefined {
  const v = response[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Prose for the slim envelope's nextStep. Names the recovery the
 * agent needs to perform: the response shape itself signals "I had
 * to drop the per-criterion items to fit."
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
 * must terminate at a narrowing tool, never form a cycle between
 * transport-failing siblings": when this surface's slim guard fires
 * on a bulk-vendor / oversize corpus, `coverage` on the same cwd is
 * the OTHER project-rooted tool the doctrine warns against pointing
 * at — the cross-corpus sweep observed `checklist.nextStep → coverage`
 * AND `coverage.nextStep → checklist` both transport-failing on the
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
  "The full response was over the MCP host's token ceiling, so the per-criterion `items[]` was dropped to keep the envelope routable. " +
  "Call `propose_config` to emit an `exclude` block from the build-artifact classifier, then re-run `scan_project` (or `checklist`) over the narrowed file set. " +
  "Alternatively re-call `checklist` directly with a narrower scope: pass a tighter `cwd` (a single subdirectory), " +
  "`paths` to scope to a specific file set, or restrict by `standard` / `level`. " +
  'Do NOT re-call `coverage` on the same cwd — that surface ships the same scope-classifier and will transport-fail the same way (per `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs must terminate at a narrowing tool").';

/**
 * Structured nextStep for the slim envelope. Routes to `propose_config`
 * — a deterministic scope-narrowing tool — instead of the sibling
 * project-rooted `coverage` tool. Per
 * `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs must
 * terminate at a narrowing tool, never form a cycle between
 * transport-failing siblings," routing the agent at `coverage` on the
 * same cwd would echo the parameters that just produced the
 * oversize envelope: `coverage` ships the same scope-classifier and
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
