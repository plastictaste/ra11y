/**
 * Cross-file same-reason candidate collapse for the `checklist` surface.
 *
 * Sibling pass to {@link import("./checklist-vendor-collapse.ts").
 * collapseRepeatedAcrossFiles} — that helper folds cohorts sharing the
 * SAME `(line, reason, snippet)` fingerprint across distinct files
 * (canonical case: 74 byte-identical copies of `fancybox.pack.js:4`
 * across vendor sub-sites). This helper covers the symmetric
 * regression: the SAME `reason` text fires across N distinct files at
 * varying lines, so the line-keyed predicate misses entirely.
 *
 * Canonical regression: a website-templates corpus with 528 sub-sites
 * triggers the same `wcag22:2.4.5` candidate with byte-identical reason
 * text "Likely root layout has no search/sitemap/breadcrumb" on each
 * `index.html`. Each file owns a different layout, so the line number
 * differs across copies — the `(line, reason, snippet)` fingerprint
 * partitions every candidate into its own cohort and the existing pass
 * never fires. The agent reads 528 near-identical rows.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest" extended to per-row volume: when the same
 * conceptual question (one reason text, one criterion) shows up across
 * N file paths, the honest shape is ONE row carrying `occurrences: N`
 * and `samplePaths: [up-to-5]` rather than N rows. The agent reads the
 * signal once + sample coverage + the total without walking a flat
 * list of identical entries.
 *
 * Doctrine bar — "Labeled buckets are suppression too": the bucket
 * label here is "same-reason pattern fires on N>{@link
 * MIN_OCCURRENCES_TO_COLLAPSE} distinct files." That predicate is
 * provable from the code (the helper hashes the reason string and
 * counts distinct paths — both deterministic facts). It is NOT a
 * heuristic suppression; it is honest collapsing of redundant rows
 * whose evidence the agent reads once.
 *
 * Threshold rationale (N > 20): the existing line-keyed pass uses
 * threshold > 5 because a `(line, reason, snippet)`-identical cohort
 * across two or three vendor copies is a strong honesty signal — those
 * are clearly the same upstream library. This pass uses a stricter
 * threshold > 20 because the predicate is strictly weaker: identical
 * reason on different lines might still represent two genuinely
 * distinct authored sites that happen to share a prose template. Above
 * 20 distinct files, the "this is the same root question fanned across
 * a templated corpus" reading dominates. Both thresholds are chosen
 * such that the cheap-to-read non-redundant evidence the agent needs
 * (the per-file detail of small cohorts) stays expanded; collapse
 * fires only when the row count is dishonest by virtue of its volume.
 *
 * Sample-paths cap: at most {@link SAMPLE_PATHS_CAP} paths land on
 * `samplePaths`, in the upstream emit order. The total count is on
 * `occurrences`; the agent reads the cap as "here are 5 instances;
 * there are 528 total."
 *
 * Pass ordering: this helper runs AFTER the line-keyed collapse so any
 * cohort already folded by the tighter `(line, reason, snippet)` pass
 * stays folded — the canonical row from that pass enters this one
 * carrying the `(line, reason)` it picked, and survives unchanged
 * unless an even broader cross-line cohort exists. Composing the two
 * passes is order-independent in the no-cohort case (both helpers are
 * pure and idempotent on already-collapsed input).
 *
 * Per-finding addressability per AI-first doctrine "Per-finding
 * identifiers must be addressable, not collision-prone": the canonical
 * row keeps its `findingId`. Sibling rows whose `findingId` differs
 * are summarized via `samplePaths` (the upstream consumer can dispatch
 * a narrower scope — `scan_project({ restrictToPaths: [...] })`,
 * `findings_by_rule({ ruleId })` — to recover them). Collapsing N
 * rows into one trades per-row addressability of the elided siblings
 * for one-shot signal — the swap doctrine endorses for cohorts above
 * the volume threshold.
 */

/**
 * Minimum cohort size that triggers the collapse pass. Cohorts of 20 or
 * fewer DISTINCT FILES remain expanded so the agent reads the full
 * per-file enumeration.
 *
 * Why 20: deliberately above the line-keyed pass's threshold (5) — see
 * the file-header rationale. The line-keyed pass catches the strong
 * "same upstream library copied N times" signal at low N because its
 * predicate is tighter (line numbers must agree); this looser
 * predicate (any line, same reason) needs more files before the
 * "templated fan-out" reading is the load-bearing one.
 */
export const MIN_OCCURRENCES_TO_COLLAPSE = 20;

/**
 * Maximum number of paths surfaced under `samplePaths`. The agent reads
 * up to 5 cited paths for spot-verification; the full count is on
 * `occurrences` so the cap never hides the total. Same value as the
 * sibling line-keyed pass so collapsed-row shapes look identical
 * regardless of which pass produced them.
 */
export const SAMPLE_PATHS_CAP = 5;

/**
 * Minimum shape a candidate must satisfy to participate in the
 * collapse pass. Captured structurally (rather than importing the
 * checklist-specific public type) so the helper stays decoupled from
 * the response shape; the caller adapts whichever shape is on its
 * stack into this minimum view. Mirrors the sibling helper's
 * {@link import("./checklist-vendor-collapse.ts").CollapseCandidateInput}
 * for cross-helper compositional consistency.
 *
 * Note: `line` is intentionally part of the input shape (so callers
 * can pass through their existing candidate without trimming) but is
 * NOT part of the fingerprint — see the file-header rationale.
 */
export interface CrossFileReasonCollapseInput {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * Output of the collapse pass — adds `occurrences` + `samplePaths` when
 * a cohort fired, otherwise the entry passes through verbatim. Generic
 * over the candidate shape so the caller's full type (with all
 * present-when-meaningful fields and any earlier `occurrences` /
 * `samplePaths` from the line-keyed pass) survives the round-trip.
 *
 * When a candidate enters this pass already carrying `occurrences`
 * from the line-keyed sibling pass, the entry passes through verbatim
 * (it cannot participate in further collapsing — its row already
 * represents a folded cohort). The two passes therefore compose
 * without double-counting.
 */
export type CrossFileReasonCollapseOutput<T extends CrossFileReasonCollapseInput> = T & {
  readonly occurrences?: number;
  readonly samplePaths?: readonly string[];
};

/**
 * Collapses a per-criterion candidate list so cohorts of >
 * {@link MIN_OCCURRENCES_TO_COLLAPSE} candidates sharing the same
 * `reason` fingerprint across distinct file paths fold to ONE
 * canonical entry (the first occurrence in input order) carrying
 * `occurrences: N` and `samplePaths: [up-to-{@link SAMPLE_PATHS_CAP}]`
 * paths.
 *
 * Fingerprint: `reason` text only — line-agnostic. Two copies of the
 * same reason on different files at different lines fold together.
 * This is the symmetric pass to the line-keyed
 * {@link import("./checklist-vendor-collapse.ts").
 * collapseRepeatedAcrossFiles}; that pass keys on `(line, reason,
 * snippet)` and catches repeated vendor-file copies; this pass catches
 * templated reason fan-outs whose lines vary.
 *
 * Pure over its inputs. Returns a new array; the input is not mutated.
 *
 * Stability: the canonical entry is the FIRST occurrence in input
 * order, so an upstream sort survives the collapse. `samplePaths`
 * lists distinct cohort paths in encounter order (matching the
 * upstream sort).
 *
 * Threshold guard: a cohort participates only when at least 2 DISTINCT
 * paths fire on the same fingerprint AND the cohort exceeds the
 * threshold strictly. The distinct-paths gate prevents a single file
 * emitting N candidates with the same reason from collapsing alone
 * (that's the per-file aggregation problem; not this helper's
 * concern). The strict-greater-than threshold preserves smaller
 * cohorts as full evidence.
 *
 * Already-collapsed bypass: when an input candidate already carries
 * `occurrences` (from the upstream line-keyed pass), it is treated as
 * non-participating — its row already summarizes a folded cohort, and
 * collapsing it further would lose the line/reason precision the
 * earlier pass earned. Such rows pass through verbatim.
 */
export function collapseAcrossFilesByReason<T extends CrossFileReasonCollapseInput>(
  candidates: readonly (T & { readonly occurrences?: number })[],
): CrossFileReasonCollapseOutput<T>[] {
  if (candidates.length === 0) return [];
  const cohortKeyToIndex = bucketByReason(candidates);
  const { collapsedIndices, swallowedIndices } = resolveCohorts(candidates, cohortKeyToIndex);
  return materializeOutput(candidates, collapsedIndices, swallowedIndices);
}

/**
 * Pass 1 — buckets every non-pre-collapsed candidate index by its
 * `reason` fingerprint. Returns a map keyed on the reason pointing at
 * the array of input indices that share the key. Encounter order is
 * preserved within each bucket so the canonical entry (later collapse
 * stage) is the first-seen path.
 *
 * Pre-collapsed candidates (those carrying `occurrences` already) are
 * skipped — they cannot participate in further collapse without
 * losing the line/reason precision the earlier pass already earned.
 */
function bucketByReason<T extends CrossFileReasonCollapseInput>(
  candidates: readonly (T & { readonly occurrences?: number })[],
): Map<string, number[]> {
  const cohortKeyToIndex = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (c === undefined) continue;
    if (c.occurrences !== undefined) continue;
    const key = c.reason;
    const arr = cohortKeyToIndex.get(key);
    if (arr === undefined) {
      cohortKeyToIndex.set(key, [i]);
    } else {
      arr.push(i);
    }
  }
  return cohortKeyToIndex;
}

/**
 * Pass 2 — examines each bucket and decides whether it qualifies for
 * collapse. The qualification gate is a conjunction:
 *   (a) cohort size > {@link MIN_OCCURRENCES_TO_COLLAPSE} (20), AND
 *   (b) at least 2 distinct paths in the cohort.
 *
 * Buckets that pass produce a `(canonical-index → cohort-meta)` entry
 * and tag every non-canonical sibling for elision.
 */
function resolveCohorts<T extends CrossFileReasonCollapseInput>(
  candidates: readonly (T & { readonly occurrences?: number })[],
  cohortKeyToIndex: ReadonlyMap<string, readonly number[]>,
): {
  collapsedIndices: Map<number, { count: number; samplePaths: string[] }>;
  swallowedIndices: Set<number>;
} {
  const collapsedIndices = new Map<number, { count: number; samplePaths: string[] }>();
  const swallowedIndices = new Set<number>();
  for (const indices of cohortKeyToIndex.values()) {
    if (indices.length <= MIN_OCCURRENCES_TO_COLLAPSE) continue;
    const distinctPaths = collectDistinctPaths(candidates, indices);
    if (distinctPaths.length < 2) continue;
    const canonical = indices[0];
    if (canonical === undefined) continue;
    const samplePaths = distinctPaths.slice(0, SAMPLE_PATHS_CAP);
    collapsedIndices.set(canonical, { count: indices.length, samplePaths });
    for (let j = 1; j < indices.length; j += 1) {
      const swallowed = indices[j];
      if (swallowed !== undefined) swallowedIndices.add(swallowed);
    }
  }
  return { collapsedIndices, swallowedIndices };
}

/**
 * Pass 3 — materializes the output array in input order. Skips
 * swallowed indices entirely; emits canonical entries with the cohort
 * meta spread onto them; passes through non-cohort entries (and
 * already-pre-collapsed entries from the upstream pass) verbatim.
 */
function materializeOutput<T extends CrossFileReasonCollapseInput>(
  candidates: readonly (T & { readonly occurrences?: number })[],
  collapsedIndices: ReadonlyMap<number, { count: number; samplePaths: string[] }>,
  swallowedIndices: ReadonlySet<number>,
): CrossFileReasonCollapseOutput<T>[] {
  const out: CrossFileReasonCollapseOutput<T>[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (swallowedIndices.has(i)) continue;
    const c = candidates[i];
    if (c === undefined) continue;
    const collapsed = collapsedIndices.get(i);
    if (collapsed === undefined) {
      out.push(c as CrossFileReasonCollapseOutput<T>);
      continue;
    }
    out.push({
      ...c,
      occurrences: collapsed.count,
      samplePaths: collapsed.samplePaths,
    });
  }
  return out;
}

/**
 * Collects the distinct paths from the indices participating in one
 * cohort, preserving encounter order (so the canonical entry's path
 * is the first listed sample). De-duplicates so a single file emitting
 * the same reason twice doesn't double-count toward the threshold's
 * "≥2 distinct paths" check.
 */
function collectDistinctPaths<T extends CrossFileReasonCollapseInput>(
  candidates: readonly T[],
  indices: readonly number[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const idx of indices) {
    const c = candidates[idx];
    if (c === undefined) continue;
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    out.push(c.path);
  }
  return out;
}
