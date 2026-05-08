/**
 * Last-resort response-envelope guard for `scan_project`.
 *
 * Per the AI-first consumer doctrine ("Oversize-success is ambiguous
 * failure" — see `docs/kb/architecture/ai-first-consumer.md`), even
 * after the per-file density cap (`applyTokenBudget`,
 * {@link import("./token-budget.ts").DEFAULT_TOKEN_BUDGET_CHARS})
 * trims trailing files, the assembled response can still exceed the
 * MCP host token ceiling. Two regimes drive this:
 *
 *   1. Single-file pathology: the density cap's progress guarantee
 *      keeps at least one file even when that file's payload alone
 *      exceeds the budget.
 *   2. Verbose-meta dominance: bulk-corpus scans inflate
 *      `meta.perRuleCoverage` / `meta.scannedBuildArtifacts` /
 *      `meta.scope.files` past the ceiling regardless of how many
 *      files survive the per-file trim.
 *
 * In either regime the host transport drops the full envelope and the
 * agent gets a transport error indistinguishable from "tool never ran"
 * — the silent-miss failure mode the doctrine names. This module's
 * fallback degrades the response to a minimum-honest envelope (`plan`
 * + slimmed `meta` + `nextStep` recommending narrower scope +
 * `warnings: ["response_dropped_files_oversize"]`) instead. The agent
 * still gets a routable response.
 *
 * Wired into `scan_project` only today: `scan` / `scan_diff` /
 * `scan_file` carry different shapes (no per-file `meta` fans, no
 * pagination over a multi-file `files[]`) and have not exhibited the
 * post-clip oversize regime in field reports. If they do, the same
 * helper applies — the slimming knobs are response-shape-aware via the
 * `slim` callback the caller passes in.
 */

import {
  fillMissingWarningDetails,
  type ScanWarningCode,
  type ScanWarningDetails,
} from "./warnings.ts";

/**
 * Hard ceiling on the assembled response, in serialized-JSON
 * characters. The MCP host's token wall is ~25k tokens; using the
 * standard `Math.ceil(bytes / 4)` proxy (see
 * {@link import("./token-budget.ts").CHARS_PER_TOKEN_PROXY}) that's
 * ~100,000 characters. We sit a hair under at 96000 chars so envelope
 * growth between this measurement and the final wire serialization
 * (host-side wrapping, JSON-RPC framing) doesn't spill the response
 * past the wall.
 *
 * Distinct from {@link import("./token-budget.ts").DEFAULT_TOKEN_BUDGET_CHARS}
 * (88000): that's the SOFT cap the density helper aims for as it
 * trims trailing files; this is the HARD ceiling the post-trim
 * envelope must clear or be replaced. The 8000-char gap is
 * deliberate — the soft cap leaves the density helper room to
 * settle below this ceiling without bouncing into the fallback.
 *
 * Constant is exported so unit tests pin the ceiling and can detect
 * silent drift if it ever moves.
 */
export const RESPONSE_OVERSIZE_HARD_CEILING_CHARS = 96000;

/**
 * Target for the minimum-honest envelope itself. The doctrine names
 * "~24KB" as the working size for the fallback shape: small enough
 * to leave host-envelope headroom even on hosts running a tighter
 * token wall than 25k, large enough to carry `plan` + slimmed `meta`
 * + `nextStep` + the `warnings`/`warningsDetails` channel without
 * dropping the load-bearing fields. Exported so tests can assert the
 * fallback shape stays within the budgeted size as it accretes.
 */
export const MINIMUM_ENVELOPE_TARGET_CHARS = 24000;

/**
 * Descriptor handed to {@link guardOversizeEnvelope}. Caller owns the
 * shape of `original` (the full assembled response) and the shape of
 * `slim` (a function that returns the minimum-honest replacement
 * envelope when the fallback fires). Keeping the slim shape on the
 * caller side avoids encoding `scan_project`-specific field choices
 * in this generic helper — `scan` / `scan_diff` would pass different
 * slim builders.
 */
export interface OversizeEnvelopeInput {
  /** The full assembled response, post-density-cap. */
  readonly original: Record<string, unknown>;
  /**
   * Builds the minimum-honest envelope when the original exceeds the
   * hard ceiling. Receives the `OversizeEnvelopeReason` so the slim
   * builder can stamp the matching warning + payload at construction
   * time, and returns the replacement response object that ships in
   * place of `original`.
   *
   * The slim builder is responsible for keeping the replacement under
   * {@link MINIMUM_ENVELOPE_TARGET_CHARS} — this helper does NOT
   * re-measure the slim envelope (no recursion / second fallback).
   * If the slim envelope itself is over the ceiling, the helper
   * returns it anyway: the caller already lost the full response, and
   * dropping the slim too would leave the agent with literally
   * nothing. Failing loud (returning over-budget) beats failing silent
   * (returning empty) on the last-resort path.
   */
  readonly buildSlim: (info: OversizeEnvelopeReason) => Record<string, unknown>;
  /**
   * Optional override for the hard ceiling. Defaults to
   * {@link RESPONSE_OVERSIZE_HARD_CEILING_CHARS}. Tests pass a smaller
   * ceiling so the fallback can be triggered on tractable fixtures
   * without building 100KB-of-findings inputs.
   */
  readonly hardCeilingChars?: number;
  /**
   * Full pre-pagination, pre-density-cap inventory size — the count
   * of files-with-findings the scan produced before any clip pass
   * trimmed the wire shape. Threaded through to the slim builder so
   * the warningsDetails payload can ship `totalFilesWithFindings`
   * alongside `droppedFileCountFromRequestedLimit`. Without this, an
   * agent reading the warning sees only the post-density count being
   * dropped now (e.g. "1 dropped" on a corpus with 4936 files-with-
   * findings) and concludes the corpus was nearly empty — the silent
   * underreport this counter exists to defeat. Required so the
   * minimum-honest envelope is honest about the inventory it could
   * not fit.
   */
  readonly totalFilesWithFindings: number;
  /**
   * Top-level array key the helper reads off `original` to count the
   * entries the slim builder is being asked to drop. Defaults to
   * `"files"` for the scan_project / scan / scan_diff family whose
   * wire shape carries grouped per-file buckets. `scan_file` ships a
   * flat `findings[]` instead of the per-file fan, so it passes
   * `arrayKey: "findings"` and the `droppedFileCountFromRequestedLimit`
   * payload field then counts findings rather than file buckets — the
   * doctrine semantics are identical (entries the slim path discarded
   * to fit under the ceiling), only the unit changes.
   */
  readonly arrayKey?: string;
}

/**
 * Reason the fallback fired, threaded into the slim-builder so the
 * `warningsDetails.response_dropped_files_oversize` payload carries
 * the byte arithmetic.
 *
 * Two file counters travel side by side because they answer different
 * questions and the agent needs both:
 *
 *   - `droppedFileCountFromRequestedLimit` — files in the response at
 *     the moment the slim path fires. The earlier requested-limit /
 *     density-cap pass may have ALREADY trimmed the inventory before
 *     the oversize guard ran (e.g. caller asked for `limit: 25`, the
 *     density cap clipped to `effectiveLimit: 1`, so this counter is
 *     1). It honestly answers "how many file entries did the slim
 *     path discard from `files[]` to fit under the ceiling," not
 *     "how many files have findings."
 *   - `totalFilesWithFindings` — the full pre-pagination, pre-density
 *     inventory size. On a 4936-files-with-findings corpus where the
 *     density cap clipped to 1, the per-pass counter above reports 1
 *     and this counter reports 4936 so the agent reading the warning
 *     can size the actual recovery work (narrower scope, scoped
 *     rerun) against the real inventory rather than the trimmed
 *     post-cap remnant.
 *
 * Both counters ship together — the renamed `droppedFileCountFromRequestedLimit`
 * makes the per-pass framing explicit, and the sibling `totalFilesWithFindings`
 * carries the underreport-defeating denominator. Per the AI-first
 * doctrine ("Composite headline counts are dishonest"), splitting one
 * counter into two named for what they each measure is the durable
 * shape; a single fused number that summed pre-cap + post-cap drops
 * would silently misclassify recovery work.
 */
export interface OversizeEnvelopeReason {
  readonly preDropBytes: number;
  readonly hardCeilingBytes: number;
  readonly droppedFileCountFromRequestedLimit: number;
  readonly totalFilesWithFindings: number;
}

/**
 * Return value: either the original response (under ceiling, no
 * fallback) or the slim replacement (over ceiling, fallback fired).
 * `triggered` lets the call site decide whether to surface telemetry
 * — it's true iff the slim builder ran.
 */
export interface OversizeEnvelopeResult {
  readonly response: Record<string, unknown>;
  readonly triggered: boolean;
  readonly preDropBytes: number;
}

/**
 * Measures the original response. If under the ceiling, returns it
 * unchanged. If over, calls the caller's slim builder with the
 * byte-arithmetic reason and returns the replacement envelope.
 *
 * Pure function: never mutates `input.original`. The slim builder
 * owns its own response shape — this helper does not enforce a slim
 * skeleton (the `scan_project` slim shape may differ from any future
 * `scan` slim shape).
 */
export function guardOversizeEnvelope(input: OversizeEnvelopeInput): OversizeEnvelopeResult {
  const ceiling = input.hardCeilingChars ?? RESPONSE_OVERSIZE_HARD_CEILING_CHARS;
  const measured = serializeLength(input.original);
  if (measured <= ceiling) {
    return { response: input.original, triggered: false, preDropBytes: measured };
  }
  // Over ceiling: count the entries the slim builder is being
  // asked to drop so the warningsDetails payload carries the honest
  // arithmetic. Defaults to 0 if the named array isn't present (the
  // slim builder still runs — the slim shape is owned by the caller,
  // not this helper). This is the post-density-cap remnant — the
  // `totalFilesWithFindings` field carries the pre-cap denominator
  // so the agent can size the actual inventory. `arrayKey` is the
  // wire field the helper reads — `files` for the scan-family fan,
  // `findings` for `scan_file`'s flat shape (see the field's docblock
  // on `OversizeEnvelopeInput.arrayKey`).
  const arrayKey = input.arrayKey ?? "files";
  const arrayField = input.original[arrayKey];
  const droppedFileCountFromRequestedLimit = Array.isArray(arrayField) ? arrayField.length : 0;
  const reason: OversizeEnvelopeReason = {
    preDropBytes: measured,
    hardCeilingBytes: ceiling,
    droppedFileCountFromRequestedLimit,
    totalFilesWithFindings: input.totalFilesWithFindings,
  };
  const slim = input.buildSlim(reason);
  return { response: slim, triggered: true, preDropBytes: measured };
}

/**
 * Builds the spreadable `warnings` + `warningsDetails` fragment for
 * the minimum-honest envelope. Keeps the byte-arithmetic payload
 * shape co-located with the helper that produced it — slim builders
 * spread this into their response to keep the warning channel
 * consistent across callers.
 *
 * `baseWarnings` carries any warning codes the original response had
 * already accumulated (e.g. `response_token_budget_truncated` from
 * the density cap, `parse_errors_present` from the scan-meta channel).
 * This helper merges `response_dropped_files_oversize` onto the end
 * of the list so consumers reading `warnings[]` see the full clip
 * chain in temporal order: density-cap fired first, oversize-envelope
 * fired second. Same merge pattern as
 * `warningsWithDensityCode` in `scan-project-budget.ts`.
 *
 * `baseWarningsDetails` is similarly merged — keys never overlap with
 * the new code's payload, so an object spread is safe.
 */
export function oversizeEnvelopeWarningsField(args: {
  readonly reason: OversizeEnvelopeReason;
  readonly baseWarnings?: readonly ScanWarningCode[];
  readonly baseWarningsDetails?: ScanWarningDetails;
  /**
   * Top-level `meta` sub-fields the slim builder discarded. Threaded
   * through here (rather than computed in this helper) because the
   * slim shape is owned by the caller — only the caller knows which
   * keys it kept and which it dropped. Surfaces on the wire as
   * `warningsDetails.response_dropped_files_oversize.metaFieldsDropped`
   * so an agent reading the surviving slim `meta` block can
   * distinguish "this codebase has no scan-confidence concerns" from
   * "the meta block was clipped to fit the envelope" per the
   * "Truncated containers must rename or sentinel, not retain"
   * doctrine bullet. Present-when-meaningful: omit when no meta keys
   * were dropped.
   */
  readonly metaFieldsDropped?: readonly string[];
  /**
   * Per-field truncation summaries for verbose arrays the slim builder
   * head-sliced (e.g. `plan.topRules` from 10 entries to 3). Threaded
   * through here rather than computed in this helper because the slim
   * shape is owned by the caller — only the caller knows which arrays
   * it trimmed and to what depth. Surfaces on the wire as
   * `warningsDetails.response_dropped_files_oversize.slimTruncations`
   * so an agent reading the slim envelope can tell "this field was
   * trimmed" from "this field was always small." Present-when-
   * meaningful: omit when no array was trimmed.
   */
  readonly slimTruncations?: readonly {
    readonly fieldPath: string;
    readonly shown: number;
    readonly total: number;
  }[];
}): {
  readonly warnings: readonly ScanWarningCode[];
  readonly warningsDetails: ScanWarningDetails;
} {
  const { reason, baseWarnings, baseWarningsDetails, metaFieldsDropped, slimTruncations } = args;
  const warnings: ScanWarningCode[] = baseWarnings === undefined ? [] : [...baseWarnings];
  if (!warnings.includes("response_dropped_files_oversize")) {
    warnings.push("response_dropped_files_oversize");
  }
  // Per the AI-first doctrine "Truncation reporters must reconcile
  // across warnings": when the meta-array cap fired earlier in the
  // pipeline (`response_meta_truncated` already in `baseWarnings`) AND
  // the slim envelope is now dropping top-level meta keys, both
  // reporters carry truncation evidence on disjoint scopes. The cross-
  // links point each reporter at the other so an agent reading either
  // side discovers the second channel without enumerating every
  // warning code blind. Both `seeAlso` strings are dotted payload
  // paths, deterministic across runs.
  const metaArrayReporterCofires =
    warnings.includes("response_meta_truncated") &&
    metaFieldsDropped !== undefined &&
    metaFieldsDropped.length > 0;
  // Patch `response_meta_truncated.seeAlso` onto the carried base
  // payload when both reporters co-fire. The base details are spread
  // first into the new details object, so we materialize a fresh
  // payload value rather than mutating the input — preserves purity.
  const patchedBaseDetails: Record<string, unknown> = { ...(baseWarningsDetails ?? {}) };
  if (metaArrayReporterCofires) {
    const existingMetaTruncated = patchedBaseDetails["response_meta_truncated"];
    if (
      existingMetaTruncated !== undefined &&
      existingMetaTruncated !== null &&
      typeof existingMetaTruncated === "object"
    ) {
      patchedBaseDetails["response_meta_truncated"] = {
        ...(existingMetaTruncated as Record<string, unknown>),
        seeAlso: "warningsDetails.response_dropped_files_oversize.metaFieldsDropped",
      };
    }
  }
  // Warnings-details schema discipline: stamp the rich payload for
  // `response_dropped_files_oversize` first, then run
  // `fillMissingWarningDetails` to ensure every other code carried in
  // from `baseWarnings` (binary-presence codes that the caller's
  // base channel built without keys, defensively) also has a key.
  const warningsDetails = fillMissingWarningDetails(warnings, {
    ...patchedBaseDetails,
    response_dropped_files_oversize: {
      preDropBytes: reason.preDropBytes,
      hardCeilingBytes: reason.hardCeilingBytes,
      droppedFileCountFromRequestedLimit: reason.droppedFileCountFromRequestedLimit,
      totalFilesWithFindings: reason.totalFilesWithFindings,
      ...(metaFieldsDropped !== undefined && metaFieldsDropped.length > 0
        ? { metaFieldsDropped }
        : {}),
      ...(metaArrayReporterCofires
        ? { metaTruncationSeeAlso: "warningsDetails.response_meta_truncated.fields" }
        : {}),
      ...(slimTruncations !== undefined && slimTruncations.length > 0 ? { slimTruncations } : {}),
    },
  });
  return { warnings, warningsDetails };
}

function serializeLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Derives a per-page `limit` cap from the slim envelope's byte
 * arithmetic. Returns `floor(droppedFileCountFromRequestedLimit *
 * (hardCeilingBytes / preDropBytes) * SLIM_LIMIT_SAFETY_FACTOR)`,
 * clamped to ≥ 1, OR `undefined` when the inputs are degenerate
 * (`preDropBytes === 0`, `hardCeilingBytes === 0`, or
 * `droppedFileCountFromRequestedLimit === 0` — the slim path
 * normally measures non-zero bytes, but the helper stays defensive
 * because the byte sources upstream are also defensive on
 * malformed inputs).
 *
 * Used by the slim envelope's `nextStepStructured` builder to
 * populate `args.limit` when no honest non-vendor narrowing dir can
 * be derived from the file inventory. Without this fallback, the
 * structured next-call would ship `args: {}` while the prose
 * recommends three concrete narrowing knobs — the canonical
 * "Ambiguous field shapes are dishonest" failure for the structured
 * slot.
 *
 * The safety factor is a presentation choice (per-file payload may
 * bloat on the next call), not a suppression — the full inventory
 * still ships on the recovery call, just with smaller pages. Exported
 * so unit tests pin the derivation under wire fixtures.
 */
export function deriveSlimLimitFromBytes(reason: OversizeEnvelopeReason): number | undefined {
  const { preDropBytes, hardCeilingBytes, droppedFileCountFromRequestedLimit } = reason;
  if (preDropBytes <= 0) return undefined;
  if (hardCeilingBytes <= 0) return undefined;
  if (droppedFileCountFromRequestedLimit <= 0) return undefined;
  const ratio = hardCeilingBytes / preDropBytes;
  const derived = Math.floor(droppedFileCountFromRequestedLimit * ratio * SLIM_LIMIT_SAFETY_FACTOR);
  return Math.max(1, derived);
}

/**
 * Conservative multiplier on the byte-ratio slim-limit derivation.
 * 70% leaves headroom for per-file payloads that bloat beyond the
 * average observed on the failing scan (the rules that fired densely
 * on this scan may fire densely again on the recovery call), so the
 * next envelope is unlikely to re-trip the slim guard. Looser than
 * 0.5 (which would over-shrink and force the agent into a per-page
 * pagination loop on responses that would have fit at 0.6) and
 * tighter than 0.9 (which would risk re-tripping the slim guard on
 * the recovery call).
 */
const SLIM_LIMIT_SAFETY_FACTOR = 0.7;
