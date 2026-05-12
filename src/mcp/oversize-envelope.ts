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
 * — it's true iff the slim builder ran. `narrowed` is true iff the
 * post-fallback re-measure determined the first-pass slim envelope
 * was itself still over the host ceiling and the second-pass narrow
 * dropped further sub-fields to fit.
 */
export interface OversizeEnvelopeResult {
  readonly response: Record<string, unknown>;
  readonly triggered: boolean;
  readonly preDropBytes: number;
  readonly narrowed?: boolean;
}

/**
 * Measures the original response. If under the ceiling, returns it
 * unchanged. If over, calls the caller's slim builder with the
 * byte-arithmetic reason. The post-slim envelope is RE-MEASURED
 * against the same ceiling — when the first-pass slim is itself still
 * over (bulk-vendor catalogs where the surviving `warningsDetails`
 * payloads, `slimTruncations` array, `metaFieldsDropped` list, or plan
 * rollups continue to inflate beyond the host wall), a second-pass
 * narrow drops progressively more disposable fields until the envelope
 * clears or no further trim path remains. Per AI-first doctrine
 * "Oversize-success is ambiguous failure": the slim envelope is the
 * canonical recovery; if IT transport-fails too, the caller gets an
 * even-slimmer payload rather than the host dropping the response
 * entirely.
 *
 * Pure function: never mutates `input.original`. The slim builder
 * owns its own response shape — this helper does not enforce a slim
 * skeleton (the `scan_project` slim shape may differ from any future
 * `scan` slim shape). The second-pass narrow operates on the slim
 * builder's output via generic disposability heuristics that target
 * common-shape fields shared across all slim envelopes (`warningsDetails`
 * payload sub-arrays, `slimTruncations`, `metaFieldsDropped`).
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
  // Post-fallback re-measure. The slim builder is responsible for
  // staying under `MINIMUM_ENVELOPE_TARGET_CHARS` on the typical case,
  // but bulk-vendor catalogs have produced first-pass slim envelopes
  // 1.6x-2x over `hardCeilingBytes` (canonical regression: 161645 chars
  // on a 4966-file vendor catalog where `hardCeilingBytes` was 96000).
  // Per "Oversize-success is ambiguous failure" the slim path's own
  // transport-fail is the same silent-miss as the original envelope's
  // — the agent gets no `plan`, no `warnings`, no routable response.
  // Narrow further if needed; if narrowing can't get under, ship the
  // smallest honest envelope anyway (failing loud beats failing silent).
  const slimMeasured = serializeLength(slim);
  if (slimMeasured <= ceiling) {
    return { response: slim, triggered: true, preDropBytes: measured };
  }
  const narrowed = narrowSlimEnvelopeIfStillOver(slim, ceiling);
  return { response: narrowed, triggered: true, preDropBytes: measured, narrowed: true };
}

/**
 * Disposable-surface heuristics for the second-pass narrow. Each
 * heuristic targets a common-shape field shared across all slim
 * envelopes shipped by the scan-family + checklist + coverage tools;
 * the helper applies them in priority order (cheapest signal loss
 * first) and re-measures after each, exiting as soon as the envelope
 * fits under the ceiling. The order matches the doctrine's "Surface,
 * don't suppress" preference for keeping load-bearing routing channels
 * (plan, nextStep, warnings codes) intact for as long as possible.
 *
 * Tier 1 — strip array detail to a count sentinel:
 *   - `warningsDetails.response_dropped_files_oversize.slimTruncations`
 *     (envelope-level per-field truncation breakdown). Each entry
 *     carries ~80 chars; on a slim envelope that head-sliced 5-10
 *     fields the array alone is ~500-800 chars. Stripped to a count
 *     sentinel `slimTruncationsCount` so the agent still knows trims
 *     happened.
 *   - `warningsDetails.response_dropped_files_oversize.metaFieldsDropped`
 *     (envelope-level meta-key drop list). On bulk corpora can list
 *     20+ keys at ~30 chars each. Stripped to `metaFieldsDroppedCount`.
 *
 * Tier 2 — trim verbose payload sub-arrays:
 *   - Any `files: string[]` inside a `warningsDetails.<code>` payload
 *     that survived the first-pass head-slice. Truncated to a
 *     deterministic prefix length + `truncated: true` sentinel.
 *
 * Tier 3 — drop verbose `warningsDetails` payloads:
 *   - Sort payloads by serialized size descending; drop the largest
 *     payloads until the envelope fits OR only a single code's payload
 *     remains. The bare `warnings[]` array preserves every code name
 *     so an agent reading the slim envelope still sees the full clip
 *     chain.
 *
 * Tier 4 — drop verbose meta sub-fields:
 *   - `meta.perRuleCoverage[]` and `meta.scannedBuildArtifacts.*`
 *     (these are normally dropped by the first-pass slim, but defensive
 *     for callers whose first-pass slim retained them).
 *
 * Tier 5 — drop plan rollups:
 *   - `plan.topRules`, `plan.findingsByFile`, `plan.topDirectories`,
 *     `plan.findingsByRule`. Each kept by the first-pass slim at a
 *     small head-slice; the second pass drops them so the headline
 *     counters in `plan.summary` / `plan.fixesByClass` are all that
 *     survive.
 *
 * Each tier sets sentinel fields on the response indicating the
 * second-pass narrow fired (`postFallbackNarrowed: true`,
 * `postFallbackNarrowSteps: string[]`) so an agent reading the
 * envelope can distinguish "first-pass slim was enough" from "even
 * the slim envelope had to be narrowed further" — same doctrine as
 * `truncated: true` distinguishing density-cap clipped from clean.
 */
type NarrowStep = (response: Record<string, unknown>) => Record<string, unknown> | undefined;

/**
 * Cap on the number of `<code>.files[]` entries that survive the
 * tier-2 sub-array trim. Each path averages ~50 chars; 3 entries
 * leaves the agent a deterministic head-slice without paying the
 * full long-tail cost.
 */
const NARROW_DETAIL_FILES_CAP = 3;

/**
 * Cap on the number of `warningsDetails.<code>` payloads that survive
 * the tier-3 large-payload drop. The bare warning codes still ship in
 * `warnings[]` so an agent reading the channel sees the full chain;
 * only the verbose per-code payloads beyond the cap drop.
 */
const NARROW_DETAIL_PAYLOADS_CAP = 5;

/**
 * Progressive second-pass narrow over a first-pass slim envelope that
 * itself crossed the host ceiling. Pure: returns a fresh response;
 * never mutates the input. Sentinel fields on the returned response
 * (`postFallbackNarrowed: true`, `postFallbackNarrowSteps: string[]`)
 * surface which tiers fired so an agent reading the slim envelope can
 * tell first-pass-was-enough from second-pass-was-needed.
 *
 * Exported so the call sites (`scan-project-budget.ts`,
 * `checklist-budget.ts`, etc.) can drive the helper directly when
 * their slim shape includes pre-known bloat surfaces the generic
 * heuristics would miss.
 *
 * @param slim - The first-pass slim envelope the builder returned.
 *   Must be a serializable object; this helper does not validate
 *   shape beyond what the per-tier heuristics target.
 * @param hardCeilingChars - Ceiling the envelope must clear. The
 *   helper stops trimming as soon as the serialized length is <=
 *   ceiling, even if subsequent tiers would have further reduced size.
 * @returns A fresh response object stamped with the
 *   `postFallbackNarrowed` / `postFallbackNarrowSteps` sentinel pair.
 *   When no tier had anything to trim, returns the input unchanged
 *   except for the sentinel fields (still informative for downstream
 *   triage: the slim itself was over but no disposable surface
 *   matched, signal for future heuristic additions).
 */
export function narrowSlimEnvelopeIfStillOver(
  slim: Record<string, unknown>,
  hardCeilingChars: number,
): Record<string, unknown> {
  // Defensive early-out: when the input is already under the ceiling,
  // there's nothing to narrow. Return the input unchanged (no
  // `postFallbackNarrowed` sentinel — narrow didn't fire). This guard
  // exists for direct callers; the canonical entry via
  // `guardOversizeEnvelope` only reaches here when the slim already
  // crossed the ceiling.
  if (serializeLength(slim) <= hardCeilingChars) {
    return slim;
  }
  let current: Record<string, unknown> = { ...slim };
  const steps: string[] = [];
  // `measure` reflects the FINAL wire shape (current + the sentinel
  // fields `stampSentinel` will add). Without the sentinel headroom,
  // tryStep can declare "fits" mid-narrow when the post-stamp envelope
  // still crosses the ceiling — observed regression: post-step-3
  // current was 970 chars (~30 under a 1000 ceiling), but the stamped
  // response landed at 1121 (~120 over) because the `postFallbackNarrowSteps`
  // array (3 labels x ~30 chars) plus `postFallbackNarrowed: true`
  // added ~150 chars on serialization. Measuring against the
  // already-stamped shape keeps the narrow honest under the ceiling
  // it advertises.
  const measure = (): number => serializeLength(stampSentinel(current, steps));
  const tryStep = (label: string, step: NarrowStep): boolean => {
    const next = step(current);
    if (next === undefined) return false;
    current = next;
    steps.push(label);
    return measure() <= hardCeilingChars;
  };
  // Tier 1: strip slimTruncations and metaFieldsDropped detail to counts.
  if (tryStep("slimTruncations_to_count", stripSlimTruncationsDetail)) {
    return stampSentinel(current, steps);
  }
  if (tryStep("metaFieldsDropped_to_count", stripMetaFieldsDroppedDetail)) {
    return stampSentinel(current, steps);
  }
  // Tier 2: trim per-payload `files[]` sub-arrays.
  if (tryStep("warningsDetails_files_arrays_trimmed", trimWarningsDetailsFileArrays)) {
    return stampSentinel(current, steps);
  }
  // Tier 3: drop verbose warningsDetails payloads beyond top-N.
  if (tryStep("warningsDetails_payloads_dropped_beyond_top_n", dropLargestWarningsDetailsPayloads)) {
    return stampSentinel(current, steps);
  }
  // Tier 4: drop verbose meta sub-fields.
  if (tryStep("meta_perRuleCoverage_dropped", dropMetaSubField("perRuleCoverage"))) {
    return stampSentinel(current, steps);
  }
  if (tryStep("meta_scannedBuildArtifacts_dropped", dropMetaSubField("scannedBuildArtifacts"))) {
    return stampSentinel(current, steps);
  }
  // Tier 5: drop plan rollups.
  if (tryStep("plan_rollups_dropped", dropPlanRollups)) {
    return stampSentinel(current, steps);
  }
  // Out of tiers. Ship what we have — failing loud (over-budget slim)
  // beats failing silent (no envelope reaches the agent). Per the
  // OversizeEnvelopeInput.buildSlim doctrine.
  return stampSentinel(current, steps);
}

/**
 * Stamps the second-pass sentinel onto the narrowed response so an
 * agent reading the envelope sees the chain of trims the helper
 * applied. Mirrors the `truncated: true` / `filesArrayDropped: true`
 * sentinels the first-pass slim already emits.
 */
function stampSentinel(
  response: Record<string, unknown>,
  steps: readonly string[],
): Record<string, unknown> {
  return {
    ...response,
    postFallbackNarrowed: true as const,
    postFallbackNarrowSteps: steps,
  };
}

function stripSlimTruncationsDetail(
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details = response["warningsDetails"];
  if (details === undefined || details === null || typeof details !== "object") return undefined;
  const detailsObj = details as Record<string, unknown>;
  const payload = detailsObj["response_dropped_files_oversize"];
  if (payload === undefined || payload === null || typeof payload !== "object") return undefined;
  const payloadObj = payload as Record<string, unknown>;
  const arr = payloadObj["slimTruncations"];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const { slimTruncations: _dropped, ...payloadRest } = payloadObj;
  return {
    ...response,
    warningsDetails: {
      ...detailsObj,
      response_dropped_files_oversize: {
        ...payloadRest,
        slimTruncationsCount: arr.length,
      },
    },
  };
}

function stripMetaFieldsDroppedDetail(
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details = response["warningsDetails"];
  if (details === undefined || details === null || typeof details !== "object") return undefined;
  const detailsObj = details as Record<string, unknown>;
  const payload = detailsObj["response_dropped_files_oversize"];
  if (payload === undefined || payload === null || typeof payload !== "object") return undefined;
  const payloadObj = payload as Record<string, unknown>;
  const arr = payloadObj["metaFieldsDropped"];
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const { metaFieldsDropped: _dropped, ...payloadRest } = payloadObj;
  return {
    ...response,
    warningsDetails: {
      ...detailsObj,
      response_dropped_files_oversize: {
        ...payloadRest,
        metaFieldsDroppedCount: arr.length,
      },
    },
  };
}

/**
 * Walks every `warningsDetails[<code>]` payload and head-slices any
 * `files: string[]` sub-array beyond {@link NARROW_DETAIL_FILES_CAP}.
 * Stamps `truncated: true` + `totalCount` / `shownCount` on the
 * trimmed payload so the agent sees the absence-of-rest in-payload
 * (mirrors `DetailArraySlot.embedInlineSentinel` on the first-pass
 * slim path in `scan-project-budget.ts`).
 *
 * Returns `undefined` when no payload carried a `files[]` over-cap —
 * the tier has nothing to do.
 */
function trimWarningsDetailsFileArrays(
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details = response["warningsDetails"];
  if (details === undefined || details === null || typeof details !== "object") return undefined;
  const detailsObj = details as Record<string, unknown>;
  let trimmedAny = false;
  const nextDetails: Record<string, unknown> = {};
  for (const [code, payload] of Object.entries(detailsObj)) {
    if (payload === undefined || payload === null || typeof payload !== "object") {
      nextDetails[code] = payload;
      continue;
    }
    const payloadObj = payload as Record<string, unknown>;
    const files = payloadObj["files"];
    if (!Array.isArray(files) || files.length <= NARROW_DETAIL_FILES_CAP) {
      nextDetails[code] = payload;
      continue;
    }
    const trimmed = files.slice(0, NARROW_DETAIL_FILES_CAP);
    nextDetails[code] = {
      ...payloadObj,
      files: trimmed,
      truncated: true as const,
      totalCount: files.length,
      shownCount: trimmed.length,
    };
    trimmedAny = true;
  }
  if (!trimmedAny) return undefined;
  return { ...response, warningsDetails: nextDetails };
}

/**
 * Sorts `warningsDetails` entries by serialized size ascending and
 * keeps the smallest cap-N payloads (always preserving
 * `response_dropped_files_oversize`, the load-bearing channel for
 * this fallback's byte arithmetic). The bare warning codes still
 * ship in `warnings[]` (callers need not touch that field — only the
 * per-code payload entries on `warningsDetails` drop).
 *
 * Returns `undefined` when `warningsDetails` has <= cap entries —
 * the tier has nothing to do.
 */
function dropLargestWarningsDetailsPayloads(
  response: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const details = response["warningsDetails"];
  if (details === undefined || details === null || typeof details !== "object") return undefined;
  const detailsObj = details as Record<string, unknown>;
  const entries = Object.entries(detailsObj);
  if (entries.length <= NARROW_DETAIL_PAYLOADS_CAP) return undefined;
  const sized = entries.map(([k, v]) => ({ code: k, value: v, size: serializeLength(v) }));
  sized.sort((a, b) => a.size - b.size);
  const keptCodes = new Set<string>();
  for (const entry of sized) {
    if (keptCodes.size >= NARROW_DETAIL_PAYLOADS_CAP) break;
    keptCodes.add(entry.code);
  }
  keptCodes.add("response_dropped_files_oversize");
  const nextDetails: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    if (keptCodes.has(k)) nextDetails[k] = v;
  }
  // Stamp the count of dropped payloads on the oversize warning so
  // the agent reading the channel sees the gap.
  const oversize = nextDetails["response_dropped_files_oversize"];
  if (oversize !== undefined && oversize !== null && typeof oversize === "object") {
    nextDetails["response_dropped_files_oversize"] = {
      ...(oversize as Record<string, unknown>),
      warningsDetailsPayloadsDroppedCount: entries.length - keptCodes.size,
    };
  }
  return { ...response, warningsDetails: nextDetails };
}

/**
 * Drops a named sub-field off `response.meta`. Returns `undefined`
 * when the field is absent (tier has nothing to do).
 */
function dropMetaSubField(subFieldName: string): NarrowStep {
  return (response) => {
    const meta = response["meta"];
    if (meta === undefined || meta === null || typeof meta !== "object") return undefined;
    const metaObj = meta as Record<string, unknown>;
    if (!(subFieldName in metaObj)) return undefined;
    const { [subFieldName]: _dropped, ...metaRest } = metaObj;
    return { ...response, meta: metaRest };
  };
}

/**
 * Drops the verbose plan rollups (`topRules`, `findingsByFile`,
 * `topDirectories`, `findingsByRule`) off `response.plan`. Leaves the
 * scalar counters / summary intact — those are load-bearing routing
 * channels the agent budgets against. Stamps an inline sentinel so
 * the agent sees the discard.
 *
 * Returns `undefined` when none of the named rollups are present
 * (tier has nothing to do).
 */
function dropPlanRollups(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const plan = response["plan"];
  if (plan === undefined || plan === null || typeof plan !== "object") return undefined;
  const planObj = plan as Record<string, unknown>;
  const rollups = ["topRules", "findingsByFile", "topDirectories", "findingsByRule"];
  const present = rollups.filter((k) => k in planObj);
  if (present.length === 0) return undefined;
  const nextPlan: Record<string, unknown> = { ...planObj };
  for (const k of present) {
    delete nextPlan[k];
  }
  nextPlan["rollupsDroppedByPostFallbackNarrow"] = present;
  return { ...response, plan: nextPlan };
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
