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

import type { ScanWarningCode, ScanWarningDetails } from "./warnings.ts";

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
}

/**
 * Reason the fallback fired, threaded into the slim-builder so the
 * `warningsDetails.response_dropped_files_oversize` payload carries
 * the byte arithmetic. `droppedFileCount` is the count the slim
 * builder is being asked to drop — not the post-density count, but
 * the per-file inventory the original response was about to ship.
 */
export interface OversizeEnvelopeReason {
  readonly preDropBytes: number;
  readonly hardCeilingBytes: number;
  readonly droppedFileCount: number;
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
  // Over ceiling: count the file entries the slim builder is being
  // asked to drop so the warningsDetails payload carries the honest
  // arithmetic. Defaults to 0 if `files` isn't an array (the slim
  // builder still runs — the slim shape is owned by the caller, not
  // this helper).
  const filesField = input.original["files"];
  const droppedFileCount = Array.isArray(filesField) ? filesField.length : 0;
  const reason: OversizeEnvelopeReason = {
    preDropBytes: measured,
    hardCeilingBytes: ceiling,
    droppedFileCount,
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
}): {
  readonly warnings: readonly ScanWarningCode[];
  readonly warningsDetails: ScanWarningDetails;
} {
  const { reason, baseWarnings, baseWarningsDetails } = args;
  const warnings: ScanWarningCode[] = baseWarnings === undefined ? [] : [...baseWarnings];
  if (!warnings.includes("response_dropped_files_oversize")) {
    warnings.push("response_dropped_files_oversize");
  }
  const warningsDetails: ScanWarningDetails = {
    ...(baseWarningsDetails ?? {}),
    response_dropped_files_oversize: {
      preDropBytes: reason.preDropBytes,
      hardCeilingBytes: reason.hardCeilingBytes,
      droppedFileCount: reason.droppedFileCount,
    },
  };
  return { warnings, warningsDetails };
}

function serializeLength(value: unknown): number {
  return JSON.stringify(value).length;
}
