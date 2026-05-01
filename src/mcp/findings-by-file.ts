/**
 * Per-file finding-frequency rollup surfaced as `plan.findingsByFile`
 * on `scan_project`. Lives in its own file so `scan-assembly.ts` stays
 * inside the 500-effective-line budget enforced by
 * `scripts/check-limits.ts`. Re-exported through `scan-assembly.ts` so
 * the two stamping helpers (`withTopRules` / `withFindingsByFile`)
 * share one canonical entry point at the call site.
 *
 * The orthogonal axis to {@link import("./scan-assembly.ts").computeTopRules}:
 * that helper rolls up by ruleId (cross-file rule-frequency); this
 * helper rolls up by path (cross-rule per-file-frequency). Both share
 * the same severity filter so their counts sum to the same
 * error+warning total — the cross-surface count invariant any pair of
 * sibling counters on the same response must honor (see
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant").
 */

/**
 * Default head-slice cap for `plan.findingsByFile`. Twenty entries is
 * the published surface — wide enough that an agent paging by file on a
 * mid-size monorepo sees the dominant clusters in one read, narrow
 * enough that the per-entry cost (`{ path, count }` ≈ 60–120 chars) stays
 * under ~2.4 KB on the wire. The slim-envelope path (see
 * `scan-project-budget.ts` `SLIM_FINDINGS_BY_FILE_CAP`) trims further
 * when the bulk-vendor regime fires.
 */
export const FINDINGS_BY_FILE_DEFAULT_LIMIT = 20;

/**
 * One entry on `plan.findingsByFile` — the per-file finding-frequency
 * rollup orthogonal to `topRules`'s per-rule axis. Surfaces "where the
 * work clusters" at the response top level so an agent reading the
 * headline can route triage by file (the per-file analogue of
 * `topRules`'s "which rule dominates") without paging through `files[]`.
 * Pairs with `totalFilesWithFindings`: the scalar reports inventory
 * size; this array reports the rank-ordered top slice.
 *
 * Severity filter — info-severity findings are excluded from the count
 * axis the same way `computeTopRules` excludes them, so the per-file
 * rollup describes the same error+warning surface the
 * `plan.fixesByClass` headline tallies. Without the filter, an
 * info-only file (e.g. one that only fired `wrappers/inferred`) would
 * crowd the top of the list with non-actionable context.
 */
export interface FindingsByFileEntry {
  readonly path: string;
  readonly count: number;
}

interface FileShape {
  readonly path: string;
  readonly findings: readonly { readonly severity: string }[];
}

/**
 * Computes the rank-ordered top-{@link FINDINGS_BY_FILE_DEFAULT_LIMIT}
 * per-file finding rollup from a per-file findings list. Pure over its
 * inputs; designed for the `plan.findingsByFile` headline on
 * `scan_project`.
 *
 * Sort: count descending, then path ascending (alphabetical) for
 * deterministic ordering across runs. Slice to `limit` (default
 * {@link FINDINGS_BY_FILE_DEFAULT_LIMIT}); when fewer than `limit` files
 * carry findings, returns all of them (no padding with zero-count rows
 * — those would be a noise-not-signal shape per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest").
 */
export function computeFindingsByFile(
  files: readonly FileShape[],
  limit: number = FINDINGS_BY_FILE_DEFAULT_LIMIT,
): readonly FindingsByFileEntry[] {
  const ranked: FindingsByFileEntry[] = [];
  for (const file of files) {
    let count = 0;
    for (const finding of file.findings) {
      if (finding.severity === "info") continue;
      count += 1;
    }
    if (count > 0) ranked.push({ path: file.path, count });
  }
  // Count desc; path asc tiebreak so the wire shape stays stable across
  // runs even when the underlying scanner reorders discovery.
  ranked.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return ranked.slice(0, limit);
}

/**
 * Stamps `plan.findingsByFile` onto a `plan` record produced by
 * `buildScanPlan`. Conditional-spread per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest": when no error/warning findings emerged on this scan,
 * the rollup would be `[]` — a sentinel that forces the agent to read
 * `plan.findingsByFile` to learn it has nothing to read. Identity-stable
 * when no files carried findings, so `tool-scan-project.ts` can route
 * through this helper unconditionally without paying for a shallow copy
 * on the common no-violations path.
 *
 * When the rank-ordered output crossed the cap and dropped trailing
 * entries, `plan.findingsByFileTruncated: true` rides alongside so the
 * agent can distinguish "this is the complete inventory" from "the
 * head-slice clipped a longer tail." Sibling boolean rather than
 * embedding the count in the array shape — keeps the array contract
 * for `findingsByFile` (always a `{ path, count }` array) intact for
 * every consumer that already iterates it. The
 * `totalFilesWithFindings` scalar already on `scan_project` carries the
 * full pre-slice denominator; this flag is the present-when-meaningful
 * "did this slice clip" signal.
 *
 * Designed to run AFTER `buildScanPlan` produced the `plan` record but
 * BEFORE the `plan` reaches the wire — `tool-scan-project.ts` calls
 * this once on the full `formatted.files` list (NOT the paged subset)
 * so the rollup describes the whole scan, not the page the caller
 * happened to fetch. The whole-scan framing is what removes the per-
 * file paging cost the rollup exists to address.
 */
export function withFindingsByFile(
  plan: Record<string, unknown>,
  files: readonly FileShape[],
  limit: number = FINDINGS_BY_FILE_DEFAULT_LIMIT,
): Record<string, unknown> {
  const findingsByFile = computeFindingsByFile(files, limit);
  if (findingsByFile.length === 0) return plan;
  // Count files with at least one error/warning finding to tell whether
  // the rank-ordered slice clipped a tail. We can't compare to
  // `files.length` directly because the input includes files that are
  // info-only (excluded from the rollup but still in the input).
  let totalFilesWithErrorOrWarning = 0;
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.severity === "info") continue;
      totalFilesWithErrorOrWarning += 1;
      break;
    }
  }
  const truncated = findingsByFile.length < totalFilesWithErrorOrWarning;
  return {
    ...plan,
    findingsByFile,
    ...(truncated ? { findingsByFileTruncated: true as const } : {}),
  };
}
