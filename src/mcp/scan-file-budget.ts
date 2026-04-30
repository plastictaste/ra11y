/**
 * `scan_file` token-density + oversize-envelope wiring.
 *
 * Mirrors the scan_project pair (`applyTokenBudget` density cap +
 * `guardOversizeEnvelope` minimum-honest fallback) for the flat
 * single-file response shape. Extracted from `tool-scan-file.ts` so
 * that file stays under the 500-effective-line budget enforced by
 * `scripts/check-limits.ts` and so the doctrine bullets each helper
 * closes (Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION) live
 * next to the wiring that closes them.
 *
 * Two regimes the guard catches:
 *
 *   1. **Findings-density pathology.** A single dense HTML page
 *      produces 60–100 KB of flat findings on bulk-component repros
 *      (the motivating field report). `scan_project` paginates
 *      `files[]`; `scan_file` ships a flat `findings[]` and has no
 *      paging axis, so density alone can blow past the host ceiling.
 *      The `limit` / `offset` parameters give the agent an explicit
 *      paging axis on the findings list.
 *
 *   2. **Verbose-meta dominance.** Even with `findings: []`, the
 *      surviving `meta` block (perRuleCoverage, scannedBuildArtifacts,
 *      analysisCoverage with per-extension maps) can inflate the
 *      envelope independent of the findings axis. The slim envelope
 *      drops `findings[]` AND slims `meta` to the scan-confidence
 *      keys the doctrine names load-bearing.
 *
 * Doctrine-aligned per `docs/kb/architecture/ai-first-consumer.md`
 * "Oversize-success is ambiguous failure": when the post-paging
 * envelope still crosses the host ceiling, fall back to a minimum-
 * honest envelope rather than letting the host transport drop the
 * full response. The agent gets `plan + meta + warnings + nextStep`
 * (the load-bearing routing channel) instead of a transport error
 * indistinguishable from "tool never ran."
 *
 * Cross-surface invariant per the same doctrine bullet "Per-tool lane
 * and warning-set classification must agree": the
 * `response_dropped_files_oversize` warning code rides on `scan_file`
 * exactly the way it rides on `scan_project`. Same code, same payload
 * shape, different scoping (per-call findings vs per-call file fan).
 */

import {
  guardOversizeEnvelope,
  type OversizeEnvelopeReason,
  oversizeEnvelopeWarningsField,
} from "./oversize-envelope.ts";
import type { ScanWarningCode, ScanWarningDetails } from "./warnings.ts";

/**
 * Default page size when the caller passes no `limit`. Sized so the
 * common single-file scan keeps every finding (typical pages produce
 * < 50 findings; 200 leaves headroom). The cap exists for the
 * pathological dense-HTML repro that produced 600+ findings on a
 * single page; without a default, the host transport would drop the
 * envelope before our oversize guard ran. Callers iterating the
 * fix-verify loop on a normal page pay no cost — the slice is a no-op
 * when `findings.length <= limit`.
 */
export const DEFAULT_SCAN_FILE_LIMIT = 200;

/**
 * Top-level meta keys the slim envelope keeps on the wire. Same
 * doctrine as `scan-project-budget.ts`'s `SLIM_META_KEYS`: drop the
 * verbose per-rule / per-extension fans, keep the load-bearing
 * scan-confidence telemetry the agent reads to verify the scan ran
 * for real.
 *
 * Order is presentation-stable: identity (tool/version/standards/
 * level) first, then top-line scan completeness (filesScanned/
 * durationMs), then config-resolution (configSource/configSearchedFrom),
 * then scope envelope (scanned). Agents reading the slim block in
 * this order can tell "the scan ran on this file under this config"
 * without descending into the per-rule fans the slim path discards.
 */
export const SLIM_SCAN_FILE_META_KEYS: readonly string[] = [
  "tool",
  "version",
  "standards",
  "level",
  "filesScanned",
  "durationMs",
  "configSource",
  "configSearchedFrom",
  "scanned",
];

interface ApplyScanFileBudgetArgs {
  /** Caller's `limit` param. Undefined → no cap (default behavior). */
  readonly limit: number | undefined;
  /** Caller's `offset` param. Undefined → 0 (start of list). */
  readonly offset: number | undefined;
  /** Caller's `maxBytes` param. Undefined → host ceiling. */
  readonly maxBytes: number | undefined;
  /** The full response, post-everything-else. */
  readonly response: Record<string, unknown>;
}

/**
 * Result of the scan-file budget pass — either the original response
 * (under all caps) or a paged / slimmed replacement.
 */
export interface ApplyScanFileBudgetResult {
  readonly response: Record<string, unknown>;
  /** True when EITHER the page cap OR the slim guard fired. */
  readonly truncated: boolean;
}

/**
 * Applies the `limit` / `offset` page primitive AND the oversize-
 * envelope guard to a `scan_file` response. The page primitive runs
 * first (cheap, deterministic) so the slim guard sees the smaller
 * post-page response and fires only when the response is dense
 * enough to still overflow.
 *
 * Page-primitive shape — when `findings.length > limit + offset`:
 *
 *   - `findings` slices to `[offset, offset + limit)`.
 *   - `truncated: true`, `nextOffset: offset + limit`.
 *   - `totalFindings`: the pre-paging count so the agent knows the
 *     real inventory.
 *   - `requestedLimit` / `effectiveLimit`: the paging settlement.
 *   - `pageClipReason: "limit_offset"` — distinct from the density
 *     regime `scan_project` carries (`token_density`).
 *
 * Slim-envelope shape — when the post-page response still serializes
 * over the host ceiling:
 *
 *   - `findings: []`, `findingsArrayDropped: true`.
 *   - `truncated: true`, `totalFindings`: pre-paging count.
 *   - `meta` slimmed to {@link SLIM_SCAN_FILE_META_KEYS}.
 *   - `warnings` extends with `response_dropped_files_oversize`;
 *     `warningsDetails.response_dropped_files_oversize` carries the
 *     byte arithmetic (per the same payload shape `scan_project` ships).
 *   - `reviewCandidates` and `referenceGuide` dropped — only
 *     `findings`-relevant context the agent recovers via re-scoping.
 *   - `nextStep` rewritten to recommend narrowing.
 *
 * Pure: never mutates the input `response`. The slim builder owns
 * its own response shape.
 */
export function applyScanFileBudget(args: ApplyScanFileBudgetArgs): ApplyScanFileBudgetResult {
  const { limit, offset, maxBytes, response } = args;
  // ---- Step 1: limit/offset paging on the flat findings array. ----
  const paged = applyFindingsPaging({ limit, offset, response });
  // ---- Step 2: oversize-envelope guard on the post-paging shape. ----
  const totalFindings = paged.totalFindings;
  const guarded = guardOversizeEnvelope({
    original: paged.response,
    arrayKey: "findings",
    totalFilesWithFindings: totalFindings,
    ...(maxBytes === undefined ? {} : { hardCeilingChars: maxBytes }),
    buildSlim: (reason) =>
      buildSlimScanFileEnvelope({
        original: paged.response,
        reason,
        totalFindings,
      }),
  });
  return {
    response: guarded.response,
    truncated: paged.truncated || guarded.triggered,
  };
}

interface PagingResult {
  readonly response: Record<string, unknown>;
  readonly truncated: boolean;
  readonly totalFindings: number;
}

/**
 * Slices the flat `findings` array per the caller's `limit` / `offset`
 * and stamps the paging-state fields when the slice was actually narrower
 * than the inventory. Returns the original response unchanged when the
 * slice would be a no-op (no `findings` array, both bounds default and
 * inventory under default cap, etc.) so the under-paging-cap response
 * stays byte-identical to the pre-Q10 shape.
 *
 * The default `limit` is {@link DEFAULT_SCAN_FILE_LIMIT}; callers can
 * pass `0` to disable paging entirely (useful for tests + non-MCP
 * consumers that don't feed into a host token wall — symmetric to the
 * assembler's `tokenBudget: 0` knob).
 */
function applyFindingsPaging(args: {
  readonly limit: number | undefined;
  readonly offset: number | undefined;
  readonly response: Record<string, unknown>;
}): PagingResult {
  const findingsField = args.response["findings"];
  if (!Array.isArray(findingsField)) {
    return { response: args.response, truncated: false, totalFindings: 0 };
  }
  const findings = findingsField as readonly unknown[];
  const totalFindings = findings.length;
  // `limit: 0` disables paging entirely — same convention as the
  // assembler's `tokenBudget: 0`. Pass-through unchanged.
  if (args.limit === 0) {
    return { response: args.response, truncated: false, totalFindings };
  }
  const limit = args.limit ?? DEFAULT_SCAN_FILE_LIMIT;
  const offset = args.offset ?? 0;
  // No-op when the inventory fits under the requested page AND the
  // caller didn't ask for an offset slice. Keeps the under-cap shape
  // byte-identical to the pre-Q10 response.
  if (offset === 0 && totalFindings <= limit) {
    return { response: args.response, truncated: false, totalFindings };
  }
  const sliced = findings.slice(offset, offset + limit);
  const droppedTail = totalFindings - (offset + sliced.length);
  const droppedHead = offset;
  const truncated = droppedTail > 0 || droppedHead > 0;
  // Exact-page or last-page request — surviving slice is everything
  // remaining. No `nextOffset` because there's nothing past the page.
  const hasNextPage = droppedTail > 0;
  const next: Record<string, unknown> = {
    ...args.response,
    findings: sliced,
    truncated,
    totalFindings,
    requestedLimit: limit,
    effectiveLimit: sliced.length,
    pageClipReason: "limit_offset" as const,
    ...(hasNextPage ? { nextOffset: offset + sliced.length } : {}),
  };
  return { response: next, truncated, totalFindings };
}

/**
 * Builds the minimum-honest envelope when the post-paging `scan_file`
 * response is still over the host ceiling. The shape is the smallest
 * set of load-bearing fields the agent needs to route once: `plan` (so
 * the agent sees the per-lane `fixesByClass` tally), slimmed `meta`
 * (scan-confidence telemetry), `nextStep` rerouted to recommend
 * narrower scope, and the warnings channel with the byte arithmetic.
 *
 * Drops `findings[]` entirely (`[]`), drops `reviewCandidates`,
 * drops `referenceGuide`. Symmetric to scan_project's
 * `buildSlimScanProjectEnvelope` — the per-finding detail comes back
 * on the recovery call (re-scope to a narrower file or page through).
 *
 * The agent's recovery path is to re-call `scan_file` with `offset:
 * <effectiveLimit>` to page forward, OR to re-scan against a different
 * (smaller) file. We don't recommend `maxBytes: <smaller>` because
 * shrinking the budget without slimming the inventory just retriggers
 * the slim guard — the agent's lever is to scope down the input, not
 * the output budget.
 */
function buildSlimScanFileEnvelope(args: {
  readonly original: Record<string, unknown>;
  readonly reason: OversizeEnvelopeReason;
  readonly totalFindings: number;
}): Record<string, unknown> {
  const { original, reason, totalFindings } = args;
  const slimMeta = buildSlimScanFileMeta(original);
  // Names of top-level meta sub-fields the slim builder discarded.
  // Threaded into the warnings payload so an agent reading the
  // surviving slim `meta` block can distinguish "no scan-confidence
  // concerns" from "block was clipped to fit." Per the
  // "Truncated containers must rename or sentinel" doctrine bullet.
  const originalMeta = readMeta(original);
  const metaFieldsDropped =
    originalMeta === undefined ? [] : Object.keys(originalMeta).filter((k) => !(k in slimMeta));
  // Original `warnings` / `warningsDetails` may exist (the scan-time
  // warnings overlay in `tool-scan-file.ts` runs before this guard).
  // Read them off `original` so we preserve the full clip chain on
  // the wire.
  const baseWarnings = readWarnings(original);
  const baseWarningsDetails = readWarningsDetails(original);
  const merged = oversizeEnvelopeWarningsField({
    reason,
    ...(baseWarnings === undefined ? {} : { baseWarnings }),
    ...(baseWarningsDetails === undefined ? {} : { baseWarningsDetails }),
    ...(metaFieldsDropped.length > 0 ? { metaFieldsDropped } : {}),
  });
  // Pass-through every top-level field that survives the slim — the
  // historical scan_file shape carries `nextStep` / `scanned` /
  // `configSource` at the top level, plus the assembler's `plan`.
  // Spread the original first to keep those, then overwrite the
  // slim-relevant fields. Drop `findings`, `reviewCandidates`,
  // `referenceGuide`, `limitations`, and the paging-state fields the
  // page primitive may have stamped (the slim path supersedes them).
  const slim: Record<string, unknown> = {
    ...original,
    findings: [],
    findingsArrayDropped: true as const,
    truncated: true as const,
    totalFindings,
    nextStep: SLIM_NEXT_STEP_PROSE,
    nextStepStructured: buildSlimNextStepStructured({
      original,
      reason,
      totalFindings,
    }),
    warnings: merged.warnings,
    warningsDetails: merged.warningsDetails,
    meta: slimMeta,
  };
  // Drop fields whose contents are now stale relative to the slim
  // shape: reviewCandidates + referenceGuide + limitations all
  // referenced findings the slim path just discarded.
  delete slim["reviewCandidates"];
  delete slim["referenceGuide"];
  delete slim["limitations"];
  // Paging-state fields from the page primitive don't apply on the
  // slim envelope (the slim path drops EVERY finding, not just a
  // paging tail) — drop them so the agent doesn't try to resume from
  // a page boundary that no longer exists.
  delete slim["nextOffset"];
  delete slim["requestedLimit"];
  delete slim["effectiveLimit"];
  delete slim["pageClipReason"];
  return slim;
}

/**
 * Slims the full meta block down to the keys in
 * {@link SLIM_SCAN_FILE_META_KEYS}. Returns a fresh object so the
 * caller's `metaFieldsDropped` derivation can compare keys without
 * worrying about prototype chain effects.
 */
function buildSlimScanFileMeta(response: Record<string, unknown>): Record<string, unknown> {
  const fullMeta = readMeta(response);
  if (fullMeta === undefined) return {};
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_SCAN_FILE_META_KEYS) {
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

/**
 * Prose for the slim envelope's nextStep. Names the recovery the
 * agent needs to perform: the response shape itself signals "I had
 * to drop the per-finding detail to fit." Concrete options: page
 * forward via `offset`, or scope the next call to a different file.
 */
const SLIM_NEXT_STEP_PROSE =
  "The full response was over the MCP host's token ceiling, so per-finding details were dropped to keep the envelope routable. " +
  "Re-call `scan_file` with `offset: <effectiveLimit>` to page forward through the findings, or with `limit: <smaller>` " +
  "to shrink the page size. For dense pages with many cross-cutting findings, prefer scoping to a specific component file " +
  "rather than the full page entry-point.";

/**
 * Structured nextStep for the slim envelope. Points back at
 * `scan_file` itself — the agent's recovery path is the same tool
 * with paged args. The structured args carry a byte-derived `limit`
 * cap so the next call is a strictly narrower page than the failing
 * call.
 *
 * Symmetric to scan_project's `buildSlimNextStepStructured`: empty
 * `args: {}` retention is the canonical "Ambiguous field shapes are
 * dishonest" failure for the structured next-call slot, so the
 * fallback always ships at least a `path` echo + a derived `limit`
 * even when no other narrowing knob is available.
 */
function buildSlimNextStepStructured(args: {
  readonly original: Record<string, unknown>;
  readonly reason: OversizeEnvelopeReason;
  readonly totalFindings: number;
}): { readonly tool: string; readonly args: Record<string, unknown> } {
  const { original, reason, totalFindings } = args;
  // `path` is required on every scan_file call — read it off the
  // original `meta.scanned.file` when present (the assembler stamps
  // `scanned` with the absolute path). Fall back to the original
  // `params.path` if needed via the `scanned.file` field on `meta`.
  const path = readScannedFilePath(original);
  // Derive a per-page `limit` cap from the byte arithmetic. The
  // caller's previous page (after applyFindingsPaging) has known
  // length; the byte-derived limit divides the host ceiling by the
  // observed per-finding rate, scaled by a 0.7 safety factor.
  const derivedLimit = deriveSlimFindingsLimit(reason, totalFindings);
  // No `path` recovered from meta → fall back to `limit` only and
  // let the agent re-pass the path verbatim. Empty-args retention is
  // the canonical "Ambiguous field shapes are dishonest" failure;
  // ship at least the limit knob.
  if (path === undefined) {
    return { tool: "scan_file", args: { limit: derivedLimit } };
  }
  return { tool: "scan_file", args: { path, limit: derivedLimit } };
}

/**
 * Reads the absolute path of the scanned file off `meta.scanned.file`.
 * Returns `undefined` when the field is absent or shaped unexpectedly
 * — defensive narrowing matches the rest of this module's
 * `Record<string, unknown>` reads.
 */
function readScannedFilePath(response: Record<string, unknown>): string | undefined {
  const meta = readMeta(response);
  if (meta === undefined) return undefined;
  const scanned = meta["scanned"];
  if (scanned === undefined || scanned === null || typeof scanned !== "object") return undefined;
  const file = (scanned as Record<string, unknown>)["file"];
  return typeof file === "string" && file.length > 0 ? file : undefined;
}

/**
 * Conservative multiplier on the byte-ratio derivation. 70% leaves
 * headroom for per-finding payloads that bloat beyond the average
 * observed on the failing scan (the rules that fired densely on this
 * page may fire densely again on the recovery call). Mirrors the
 * `SLIM_LIMIT_SAFETY_FACTOR` constant in `oversize-envelope.ts`.
 */
const SLIM_FINDINGS_LIMIT_SAFETY_FACTOR = 0.7;

/**
 * Derives a per-page findings `limit` from the slim envelope's byte
 * arithmetic. Returns `floor(droppedFindings * (ceiling / preDrop) *
 * 0.7)`, clamped to ≥ 1. When the byte inputs are degenerate
 * (preDrop=0, ceiling=0, dropped=0), falls back to 1 — the smallest
 * honest forward-progress arg, never `0` (which would hang).
 *
 * Identical derivation shape to `deriveSlimLimitFromBytes` in
 * `oversize-envelope.ts`, but operating on the findings axis rather
 * than the file axis. Inlined here rather than reused because the
 * `OversizeEnvelopeReason` field is named `droppedFileCountFromRequestedLimit`
 * regardless of the array being measured (the helper is agnostic per
 * the `arrayKey` parameter), and importing the same function would
 * obscure that we're computing on findings.
 */
function deriveSlimFindingsLimit(reason: OversizeEnvelopeReason, totalFindings: number): number {
  const { preDropBytes, hardCeilingBytes, droppedFileCountFromRequestedLimit } = reason;
  if (preDropBytes <= 0) return 1;
  if (hardCeilingBytes <= 0) return 1;
  if (droppedFileCountFromRequestedLimit <= 0) return 1;
  const ratio = hardCeilingBytes / preDropBytes;
  const derived = Math.floor(
    droppedFileCountFromRequestedLimit * ratio * SLIM_FINDINGS_LIMIT_SAFETY_FACTOR,
  );
  // Clamp to ≥ 1 (never `0` — would hang the recovery call) and
  // ≤ totalFindings (no point recommending a page wider than the
  // inventory). The slim path only fires when preDrop > ceiling, so
  // ratio < 1 guarantees `derived < droppedCount`, and
  // `droppedCount <= totalFindings` keeps the upper bound honest
  // without an explicit clamp — this `min` is defense-in-depth for
  // any future callsite that passes inflated reason inputs.
  return Math.max(1, Math.min(derived, totalFindings));
}
