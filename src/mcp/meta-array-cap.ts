/**
 * Cap for path-list meta arrays that grow linearly with scanner
 * inputs — `meta.scannedBuildArtifacts.ungrouped` and
 * `meta.analysisCoverage.fragmentFiles` (the path-identity arrays
 * that don't aggregate cleanly into a reason rollup). The
 * `parseErrorFiles` / `partialParseFiles` arrays were moved out of
 * the cap regime in — at
 * default verbosity their bulk-template wire-size cost is now
 * absorbed by the inline-vs-rollup gate in
 * {@link assembleParseErrorBlocks}, and under `verboseMeta: true`
 * the full path list ships uncapped (the opt-in is the agent's
 * acknowledgment that the wire-size cost is justified for triage).
 *
 * Q-SHARED-META-ARRAY-BUDGET-CAP: a full-root website-templates scan
 * returned 315KB where 281KB (89%) was `meta`, split almost entirely
 * between ~148KB of `scannedBuildArtifacts.ungrouped` entries and
 * ~121KB of `parseErrorFiles` / `partialParseFiles`. Both arrays grow
 * linearly with input, so a large-site scan overruns the MCP host
 * token ceiling even at `limit: 1` / `minSeverity: error` — the
 * agent-facing response became unusable on the exact codebases where
 * scan-confidence telemetry matters most.
 *
 * Cap value picked at {@link META_ARRAY_CAP}=50 by working backward
 * from the wire-size budget the agent host tolerates (~100KB total
 * response) against the observed per-entry density:
 *
 *   - `scannedBuildArtifacts.ungrouped` entries are `{ path, reason }`
 *     pairs averaging ~110 chars. 50 entries ≈ 5.5KB.
 *   - `fragmentFiles` is a string[] averaging ~60 chars/entry.
 *     50 entries ≈ 3KB.
 *
 * Paired counts (`fragmentFileCount`, plus the summary
 * field on `*Truncated`) stay full so no telemetry is lost — only
 * the trailing entries drop.
 *
 * This is NOT suppression: the count + deterministic head stays
 * surfaced, the `response_meta_truncated` warning fires so the
 * agent knows trimming happened, and the `truncated: true` flag +
 * `shown` / `total` pair on the sibling field mirror the same
 * idiom the `plan` / `files` pagination contract already uses. Per
 * "Verbose meta is signal, not clutter" (doctrine): we don't delete
 * the telemetry — we cap with an honest truncation signal.
 */
export const META_ARRAY_CAP = 50;

/**
 * Summary descriptor attached as a sibling field (e.g.
 * `parseErrorFilesTruncated`) when {@link capMetaArray} actually
 * trimmed the input. `shown` is the head-slice length (always
 * equal to {@link META_ARRAY_CAP} when truncated), `total` is the
 * pre-cap length so the agent can reconstruct the gap.
 */
export interface MetaArrayTruncationSummary {
  readonly shown: number;
  readonly total: number;
}

/**
 * Result of capping a meta path-array. `values` is the (possibly
 * unchanged) head slice. `truncated` is present iff the cap actually
 * trimmed something; callers conditional-spread it as a sibling
 * field so the wire shape stays present-when-meaningful per
 * CLAUDE.md §1 "Ambiguous field shapes are dishonest." `wasTruncated`
 * is the bare boolean for warnings-channel plumbing — callers OR
 * these together across every capped array on a response to decide
 * whether to emit the `response_meta_truncated` warning code.
 */
export interface CappedMetaArray<T> {
  readonly values: readonly T[];
  readonly truncated?: MetaArrayTruncationSummary;
  readonly wasTruncated: boolean;
}

/**
 * Cap `values` to at most `cap` entries. When the input fits, the
 * original array is returned unchanged (no truncation signal). When
 * the input overflows, `values` becomes the first `cap` entries and
 * `truncated` carries `{ shown, total }`.
 *
 * Deterministic: takes the array prefix, so callers that sort their
 * inputs (alphabetical-by-path, count-descending, etc.) get a stable
 * head-slice across runs. The cap does NOT re-sort or re-rank — the
 * caller owns ordering discipline.
 *
 * @param values - The array to cap. Must already be sorted or
 *   ordered by the caller's preferred criterion; this helper takes
 *   the prefix as-is.
 * @param cap - Optional override for the default cap. Defaults to
 *   {@link META_ARRAY_CAP}. Callers with a different size-vs-signal
 *   tradeoff (e.g. a domain-specific array where entries are
 *   larger / smaller) can pass a custom cap.
 */
export function capMetaArray<T>(
  values: readonly T[],
  cap: number = META_ARRAY_CAP,
): CappedMetaArray<T> {
  if (values.length <= cap) {
    return { values, wasTruncated: false };
  }
  return {
    values: values.slice(0, cap),
    truncated: { shown: cap, total: values.length },
    wasTruncated: true,
  };
}

/**
 * Map of `{ container, truncationKey, fieldPath }` for every meta
 * sibling array that participates in the cap regime. The
 * `truncationKey` is the wire field stamped on `meta.<container>` when
 * the sibling array was head-sliced; the `fieldPath` is the dotted
 * path the `warningsDetails.response_meta_truncated.fields` payload
 * surfaces so an agent reading the warning can name the array to
 * re-fetch under `verboseMeta: true` (or scope down) without descending
 * into `meta` to figure out which array trimmed.
 *
 * Add new entries here whenever a fresh meta array enters the cap
 * regime — the {@link getTruncatedMetaArrayFields} predicate, its
 * {@link hasMetaArrayTruncation} boolean shim, and the
 * `warningsDetails.response_meta_truncated.fields` summarizer all read
 * from the same table so additions can't silently miss any of the
 * downstream consumers.
 */
const META_ARRAY_TRUNCATION_ENTRIES: ReadonlyArray<{
  readonly container: string;
  readonly truncationKey: string;
  readonly fieldPath: string;
}> = [
  // `meta.analysisCoverage.*`. `parseErrorFilesTruncated` and
  // `partialParseFilesTruncated` were removed in-
  // ERROR-FILES-UNCAPPED — those two arrays now switch to the
  // `parseErrorTopReasons` / `partialParseTopReasons` rollup at the
  // inline-threshold rather than head-slicing under {@link META_ARRAY_CAP},
  // so no `*Truncated` sibling can fire on either field. `fragmentFiles`
  // keeps the cap regime because its signal is the path identity
  // (`_includes/footer.html` etc.), not a reason rollup that would
  // aggregate cleanly.
  {
    container: "analysisCoverage",
    truncationKey: "fragmentFilesTruncated",
    fieldPath: "analysisCoverage.fragmentFiles",
  },
  // `meta.scannedBuildArtifacts.ungroupedTruncated`
  {
    container: "scannedBuildArtifacts",
    truncationKey: "ungroupedTruncated",
    fieldPath: "scannedBuildArtifacts.ungrouped",
  },
];

/**
 * Scans a materialized `meta` block and returns the dotted field paths
 * of every sibling meta array whose head-slice cap actually trimmed
 * something. Pure over its input; callers feed the post-assembly meta
 * record so the result reflects exactly what shipped on the wire.
 *
 * Drives both the binary `metaArrayTruncatedFields` warning-input slot
 * and the structured
 * `warningsDetails.response_meta_truncated.fields` payload — agents
 * branching on the bare `warnings[]` channel still see
 * `response_meta_truncated`, but a payload-bearing entry now names
 * which structured fields were elided so the agent can decide which
 * arrays to re-fetch under `verboseMeta: true` instead of probing each
 * possible array blind. Per "Verbose meta is signal" (doctrine) the
 * fields list rides at default verbosity.
 *
 * Extracted here (rather than in `warnings.ts`) so the cap helper
 * co-locates with the predicate that consumes the per-array
 * `*Truncated` signals it emits — moving one requires touching the
 * other. Returns paths in the table-declared order so the wire shape
 * is deterministic across runs.
 */
export function getTruncatedMetaArrayFields(meta: Record<string, unknown>): readonly string[] {
  const out: string[] = [];
  for (const entry of META_ARRAY_TRUNCATION_ENTRIES) {
    const container = meta[entry.container];
    if (container === null || typeof container !== "object") continue;
    if (entry.truncationKey in (container as Record<string, unknown>)) {
      out.push(entry.fieldPath);
    }
  }
  return out;
}

/**
 * Boolean shim over {@link getTruncatedMetaArrayFields} for callers
 * that only need the presence bit (legacy seam — most call sites have
 * migrated to the field-paths form so the agent can branch on which
 * array trimmed). Returns `true` iff at least one capped array was
 * head-sliced. Kept as a thin wrapper so the membership table lives in
 * one place.
 */
export function hasMetaArrayTruncation(meta: Record<string, unknown>): boolean {
  return getTruncatedMetaArrayFields(meta).length > 0;
}
