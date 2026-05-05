/**
 * Cross-file repeated-candidate collapse for the `checklist` surface.
 *
 * Closes V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE.
 *
 * Background: a bulk catalog (canonical case: a website-templates corpus
 * with 74 sub-sites, each shipping its own copy of `fancybox.pack.js`)
 * surfaces N byte-identical candidates per criterion — every emission
 * comes from the same `<iframe id="fancybox-frame{rnd}"…>` template
 * literal at line 4, column X of N copies of the same vendor file. The
 * `likelyIrrelevant` bucket label is doctrine-correct (the deterministic
 * "no `<video>`/`<audio>` parsed" predicate fires honestly) but the row
 * *quantity* is not — the agent reads N copies of one underlying line,
 * each pointing at a sibling vendor file that copies the same upstream.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest" extended to per-row volume: when the same
 * conceptual evidence (same line, same column, same reason text) shows
 * up across N file paths, the honest shape is ONE row carrying
 * `occurrences: N` and `samplePaths: [up-to-5]` rather than N rows. The
 * agent gets the signal once + sample coverage + the total without
 * walking a flat list of identical entries.
 *
 * Mirrors the rule-surface precedent in `scan-project-collapse-by-group.ts`
 * (`(ruleId, groupKey)` collapse with an `occurrences[]` enumeration);
 * this module is the candidate-side analogue keyed off the deterministic
 * fingerprint a candidate's emission shape carries.
 *
 * Threshold: only collapse when the cohort size strictly exceeds
 * `MIN_OCCURRENCES_TO_COLLAPSE` (= 5). Two or three distinct vendor
 * copies of the same line stay as separate rows so the agent sees the
 * full evidence; collapse fires only when the row count is dishonest
 * by virtue of its volume. Per AI-first doctrine "Surface, don't
 * suppress" — the threshold protects the cheap-to-read non-redundant
 * evidence the agent needs.
 *
 * Sample-paths cap: at most 5 paths land on `samplePaths`, ordered by
 * the upstream sort (the engine emits in `(filePath, line, column)`
 * order, so the first sample is the lexicographically-earliest path).
 * The total count is on `occurrences`; the agent reads the cap as
 * "here are 5 instances; there are 74 total."
 */

/**
 * Minimum cohort size that triggers the collapse pass. Cohorts of 5 or
 * fewer remain expanded so the agent reads the full per-file enumeration.
 *
 * Why 5: the threshold is deliberately above 2-3 distinct vendor copies —
 * two siblings of the same template literal might ride at slightly
 * different content, and the agent benefits from reading both. Five
 * crosses into "this is clearly the same template fanned out N times,"
 * which is the regression `V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE`
 * names. Pairs with the canonical N=74 fancybox.pack.js corpus.
 */
export const MIN_OCCURRENCES_TO_COLLAPSE = 5;

/**
 * Maximum number of paths surfaced under `samplePaths`. The agent reads
 * up to 5 cited paths for spot-verification; the full count is on
 * `occurrences` so the cap never hides the total.
 */
export const SAMPLE_PATHS_CAP = 5;

/**
 * Minimum shape a candidate must satisfy to participate in the collapse
 * pass — the same fields {@link
 * import("./tool-checklist.ts").ChecklistCandidateOut} carries. Captured
 * structurally (rather than importing the public type) so the helper
 * stays decoupled from the response shape; the caller adapts whichever
 * shape is on its stack into this minimum view.
 */
export interface CollapseCandidateInput {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly snippet?: string;
}

/**
 * Output of the collapse pass — adds `occurrences` + `samplePaths` when
 * a cohort fired, otherwise the entry passes through verbatim. Generic
 * over the candidate shape so the caller's full type (with all
 * present-when-meaningful fields) survives the round-trip.
 */
export type CollapseCandidateOutput<T extends CollapseCandidateInput> = T & {
  readonly occurrences?: number;
  readonly samplePaths?: readonly string[];
};

/**
 * Collapses a per-criterion candidate list so cohorts of >
 * {@link MIN_OCCURRENCES_TO_COLLAPSE} candidates sharing the same
 * `(line, reason, snippet)` fingerprint fold to ONE canonical entry
 * (the first occurrence in input order) carrying `occurrences: N` and
 * `samplePaths: [up-to-{@link SAMPLE_PATHS_CAP}]` paths.
 *
 * Fingerprint axes:
 *   - `line`: same source line in N copies of the same file is the
 *     load-bearing positional signal.
 *   - `reason`: the candidate's prose reason — different framings
 *     (cross-finder coincidence at the same line, distinct evidence)
 *     keep distinct rows. A vendor file with two genuinely different
 *     candidates on line 4 (one for `<iframe>`, one for `<video>`)
 *     stays as two distinct cohorts.
 *   - `snippet`: when the finder threaded a snippet, byte-identical
 *     snippets across files prove the underlying line text matches.
 *     When absent, the `(line, reason)` axis suffices — the engine
 *     emits identical reasons only when its in-memory view of the line
 *     was identical.
 *
 * Note: `column` is intentionally NOT in the fingerprint. Two copies
 * of the same vendor file with one byte-identical line typically agree
 * on column too (the parser computes column from the same source), but
 * floating-point-style indentation drift across vendor packagings can
 * shift the column by a few bytes without changing the line shape.
 * Excluding column makes the collapse robust to that drift; the
 * `(line, reason)` axis already carries the load-bearing identity.
 *
 * Pure over its inputs. Returns a new array; the input is not mutated.
 *
 * Stability: the canonical entry is the FIRST occurrence in input order,
 * so the upstream `compareCandidates` sort (path-asc, line-asc) survives
 * the collapse — the canonical path is the lexicographically-earliest
 * member of the cohort, and `samplePaths` lists members in encounter
 * order (matching that sort).
 *
 * Threshold guard: a cohort participates only when at least 2 DISTINCT
 * paths fire on the same fingerprint. A single file emitting N
 * candidates on the same line is a different shape (the finder's
 * per-file aggregation problem) and should not be collapsed here. The
 * canonical regression this module addresses is N copies of one line
 * across N sibling vendor files; that is the predicate the distinct-
 * paths gate protects.
 */
export function collapseRepeatedAcrossFiles<T extends CollapseCandidateInput>(
  candidates: readonly T[],
): CollapseCandidateOutput<T>[] {
  if (candidates.length === 0) return [];
  const cohortKeyToIndex = bucketByFingerprint(candidates);
  const { collapsedIndices, swallowedIndices } = resolveCohorts(candidates, cohortKeyToIndex);
  return materializeOutput(candidates, collapsedIndices, swallowedIndices);
}

/**
 * Pass 1 — buckets every candidate index by its fingerprint key. Returns
 * a map keyed on the `(line, reason, snippet)` fingerprint pointing at
 * the array of input indices that share the key. Encounter order is
 * preserved within each bucket so the canonical entry (later collapse
 * stage) is the lexicographically-earliest path.
 */
function bucketByFingerprint<T extends CollapseCandidateInput>(
  candidates: readonly T[],
): Map<string, number[]> {
  const cohortKeyToIndex = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (c === undefined) continue;
    const key = fingerprint(c);
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
 *   (a) cohort size > {@link MIN_OCCURRENCES_TO_COLLAPSE} (5), AND
 *   (b) at least 2 distinct paths in the cohort.
 *
 * Buckets that pass produce a `(canonical-index → cohort-meta)` entry
 * and tag every non-canonical sibling for elision.
 */
function resolveCohorts<T extends CollapseCandidateInput>(
  candidates: readonly T[],
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
 * Pass 3 — materializes the output array in input order. Skips swallowed
 * indices entirely; emits canonical entries with the cohort meta spread
 * onto them; passes through non-cohort entries verbatim.
 */
function materializeOutput<T extends CollapseCandidateInput>(
  candidates: readonly T[],
  collapsedIndices: ReadonlyMap<number, { count: number; samplePaths: string[] }>,
  swallowedIndices: ReadonlySet<number>,
): CollapseCandidateOutput<T>[] {
  const out: CollapseCandidateOutput<T>[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    if (swallowedIndices.has(i)) continue;
    const c = candidates[i];
    if (c === undefined) continue;
    const collapsed = collapsedIndices.get(i);
    if (collapsed === undefined) {
      out.push(c as CollapseCandidateOutput<T>);
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
 * Computes the `(line, reason, snippet)` fingerprint for cohort
 * bucketing. NUL-byte separators avoid pathological collisions when a
 * reason or snippet contains the boundary token verbatim. Snippet is
 * folded in only when populated — an absent snippet pairs identically
 * with another absent snippet, which is the honest equivalence on
 * candidates whose finder didn't materialize one.
 */
function fingerprint(c: CollapseCandidateInput): string {
  const snippetPart = c.snippet ?? "";
  return `${c.line}\x00${c.reason}\x00${snippetPart}`;
}

/**
 * Collects the distinct paths from the indices participating in one
 * cohort, preserving encounter order (so the canonical entry's path is
 * the first listed sample). De-duplicates so a vendor file that emits
 * the same line twice doesn't double-count toward the threshold's
 * "≥2 distinct paths" check.
 */
function collectDistinctPaths<T extends CollapseCandidateInput>(
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
