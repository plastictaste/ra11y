/**
 * Cap for path-list meta arrays that grow linearly with scanner
 * inputs — `meta.scannedBuildArtifacts.ungrouped`,
 * `meta.analysisCoverage.parseErrorFiles`,
 * `meta.analysisCoverage.partialParseFiles`,
 * `meta.analysisCoverage.fragmentFiles`, and any future cousin.
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
 *   - `parseErrorFiles` / `partialParseFiles` entries are
 *     `{ path, parser, reason }` triples averaging ~220 chars each
 *     (path ≈ 100, parser ≈ 8, reason ≤ 200). 50 entries ≈ 11KB.
 *     Two arrays at the same cap ≈ 22KB.
 *   - `scannedBuildArtifacts.ungrouped` entries are `{ path, reason }`
 *     pairs averaging ~110 chars. 50 entries ≈ 5.5KB.
 *   - `fragmentFiles` is a string[] averaging ~60 chars/entry.
 *     50 entries ≈ 3KB.
 *
 * Aggregate worst-case ≈ 30KB of meta — roughly 10% of the former
 * 315KB response — while preserving the top of each list
 * (alphabetical sort means the first 50 are a stable, deterministic
 * sample rather than random). Paired counts (`parseErrorFileCount`,
 * `partialParseFileCount`, `fragmentFileCount`, plus the summary
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
 * Known keys that carry a {@link MetaArrayTruncationSummary} when the
 * corresponding sibling array was trimmed. Used by
 * {@link hasMetaArrayTruncation} to derive the `metaArrayTruncated`
 * warning-input boolean from a materialized scan-meta block without
 * forcing every cap callsite to thread a separate boolean up the
 * assembly chain. Add new entries here whenever a fresh meta array
 * enters the cap regime.
 */
const META_ARRAY_TRUNCATION_KEYS = [
  // `meta.analysisCoverage.*`
  "parseErrorFilesTruncated",
  "partialParseFilesTruncated",
  "fragmentFilesTruncated",
  // `meta.scannedBuildArtifacts.ungroupedTruncated`
  "ungroupedTruncated",
] as const;

/**
 * Scans a materialized `meta` block for any of the known
 * {@link MetaArrayTruncationSummary}-carrying sibling keys. Returns
 * `true` the first time it finds one on `meta.analysisCoverage` or
 * `meta.scannedBuildArtifacts`. Pure over its input; callers feed the
 * post-assembly meta record so the boolean reflects exactly what
 * shipped on the wire.
 *
 * Extracted here (rather than in `warnings.ts`) so the cap helper
 * co-locates with the predicate that consumes the per-array
 * `*Truncated` signals it emits — moving one requires touching the
 * other.
 */
export function hasMetaArrayTruncation(meta: Record<string, unknown>): boolean {
  const coverage = meta["analysisCoverage"];
  if (coverage !== null && typeof coverage === "object") {
    for (const key of META_ARRAY_TRUNCATION_KEYS) {
      if (key in (coverage as Record<string, unknown>)) return true;
    }
  }
  const buildArtifacts = meta["scannedBuildArtifacts"];
  if (buildArtifacts !== null && typeof buildArtifacts === "object") {
    for (const key of META_ARRAY_TRUNCATION_KEYS) {
      if (key in (buildArtifacts as Record<string, unknown>)) return true;
    }
  }
  return false;
}
