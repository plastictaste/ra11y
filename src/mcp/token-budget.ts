/**
 * Secondary token-density budget for MCP scan-family responses.
 *
 * Per ADR 0021's 2026-04-20 amendment, the file-count `limit` cap is
 * the primary guard on `scan_project`; this helper is a secondary
 * guard that fires only when per-file density pushes the response
 * past the ~25k-token MCP host ceiling even after the file-count cap
 * has been applied. The motivating fixture was `/tmp/bootstrap`: 18
 * files / 131 findings / ~107 KB after the `fix.description`
 * hoist, still over the ceiling because `18 < 25` meant the file-
 * count cap never engaged.
 *
 * Wired into `scan`, `scan_project`, and `scan_diff` (both baseline
 * and hunks modes). `scan_file` is a single-file shape and does not
 * carry a trailing-file axis this helper can trim, so it's not wired
 * through.
 */

/**
 * Characters-per-token proxy used by {@link applyTokenBudget}. The
 * zero-dependency invariant (CLAUDE.md §3) blocks a real tokenizer;
 * `Math.ceil(bytes / 4)` is the standard rough estimate across
 * mainstream BPE tokenizers for English-heavy structured JSON. The
 * constant is exported so tests and reviewers can see the choice
 * without reading the helper body.
 */
export const CHARS_PER_TOKEN_PROXY = 4;

/**
 * Default soft ceiling for a scan-family response, in serialized-JSON
 * characters. Calibrated to leave headroom under the ~25k token MCP
 * host ceiling: at the empirical ~3.4 chars/token rate for dense JSON
 * (see the docblock on
 * {@link import("./oversize-envelope.ts").RESPONSE_OVERSIZE_HARD_CEILING_CHARS}),
 * 72000 chars / 3.4 ≈ 21176 tokens, about 4k below the host limit so
 * final-pass serialization overhead and host-side envelope growth
 * don't push the response past the ceiling. Secondary cap: the file-
 * count `limit` remains the primary guard; this triggers only when
 * per-file density pushes the response above the threshold after
 * `limit` has been applied. Sits 8000 chars below the hard ceiling
 * ({@link import("./oversize-envelope.ts").RESPONSE_OVERSIZE_HARD_CEILING_CHARS},
 * 80000) so the density helper has room to settle the response below
 * the hard ceiling before the oversize guard fallback fires.
 */
export const DEFAULT_TOKEN_BUDGET_CHARS = 72000;

/**
 * Descriptor handed to {@link applyTokenBudget} naming the mutable
 * fields the helper may rewrite. The shape is response-tool-specific
 * (scan_project uses `files` + `truncated` + `nextOffset`; scan_diff
 * uses `newViolations` + `newCount`; scan uses `files`), so the call
 * site wires each to the helper rather than the helper introspecting
 * a tagged union.
 */
export interface TokenBudgetInput<TFile> {
  /** The full response body being measured + potentially rewritten. */
  readonly response: Record<string, unknown>;
  /** Key under `response` whose array-of-file-entries gets trimmed. */
  readonly filesKey: string;
  /** The file-entries array itself (typed so callers keep narrow types). */
  readonly files: readonly TFile[];
  /**
   * Offset into the pre-paging list this page started at. `nextOffset`
   * = `offset + keptFileCount`. Pass 0 for tools that don't paginate.
   */
  readonly offset: number;
  /** Soft character ceiling. Defaults to {@link DEFAULT_TOKEN_BUDGET_CHARS}. */
  readonly budgetChars?: number;
}

/** Return value from {@link applyTokenBudget}. */
export interface TokenBudgetResult<TFile> {
  /** The (possibly trimmed) file-entries array. */
  readonly files: readonly TFile[];
  /** True when files were dropped to fit under the budget. */
  readonly truncated: boolean;
  /** Dropped file count (0 when under budget). */
  readonly droppedCount: number;
  /** `offset + keptFileCount` when truncated; undefined otherwise. */
  readonly nextOffset?: number;
  /** Final measured char length after trimming. */
  readonly bytesMeasured: number;
}

/**
 * Secondary response-size guard per ADR 0021's 2026-04-20 amendment.
 * Measures the serialized response; if over budget, drops trailing
 * file entries one at a time until the re-serialized shape fits. The
 * primary guard is the tool's file-count `limit`; this helper handles
 * the density case (few files, many per-file bytes) that a file-count
 * cap alone cannot bound.
 *
 * Progress guarantee: when a single file exceeds the budget the
 * helper still returns that one entry (the alternative — empty
 * `files` with `truncated: true` — produces a response an agent
 * cannot paginate past). Over-budget-with-one-file is surfaced
 * honestly through `truncated: true`; the caller's `nextOffset`
 * advances past the dropped files so the next call picks them up.
 *
 * The caller owns flipping `response[filesKey]` to the trimmed array
 * and spreading `{ truncated: true, nextOffset }` into its response —
 * this helper returns the decision, not the rewrite, so each scan
 * tool keeps ownership of its own pagination field names
 * (`scan_project` uses `truncated` + `nextOffset`; `scan_diff` uses
 * different counters per mode).
 *
 * Composes with a file-count `limit`: call this AFTER the file-count
 * cap has already been applied. `truncated` is `true` if either cap
 * fired; the caller distinguishes density-vs-count truncation by
 * emitting the `response_token_budget_truncated` warning code when
 * this helper's `droppedCount` is non-zero.
 */
export function applyTokenBudget<TFile>(input: TokenBudgetInput<TFile>): TokenBudgetResult<TFile> {
  const budget = input.budgetChars ?? DEFAULT_TOKEN_BUDGET_CHARS;
  const initial = serializeLength(input.response);
  if (initial <= budget) {
    return {
      files: input.files,
      truncated: false,
      droppedCount: 0,
      bytesMeasured: initial,
    };
  }
  // Greedy trim from the tail until we fit, but always keep at least
  // one file so the caller can paginate forward. Re-measure each step
  // because dropping a file also drops its contribution to the
  // serialized shape; we can't shortcut this because a single trim may
  // overshoot the budget.
  const trimmed = [...input.files];
  let dropped = 0;
  while (trimmed.length > 1) {
    trimmed.pop();
    dropped += 1;
    const measured = serializeLength({ ...input.response, [input.filesKey]: trimmed });
    if (measured <= budget) {
      return {
        files: trimmed,
        truncated: true,
        droppedCount: dropped,
        nextOffset: input.offset + trimmed.length,
        bytesMeasured: measured,
      };
    }
  }
  // Single file still over budget — return it anyway. Progress
  // guarantee: the alternative is a zero-file response with
  // `truncated: true`, which the caller cannot paginate past.
  const finalMeasured = serializeLength({ ...input.response, [input.filesKey]: trimmed });
  return {
    files: trimmed,
    truncated: dropped > 0,
    droppedCount: dropped,
    ...(dropped > 0 ? { nextOffset: input.offset + trimmed.length } : {}),
    bytesMeasured: finalMeasured,
  };
}

function serializeLength(value: unknown): number {
  return JSON.stringify(value).length;
}
