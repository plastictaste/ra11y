/**
 * Per-directory finding-frequency rollup surfaced as
 * `plan.topDirectories` on `scan_project`. Lives in its own file so
 * `scan-assembly.ts` stays inside the file-line budget enforced by
 * `scripts/check-limits.ts`. Re-exported through `scan-assembly.ts` so
 * the stamping helpers (`withTopRules` / `withFindingsByFile` /
 * `withTopDirectories`) share one canonical entry point at the call
 * site.
 *
 * Why a third axis on top of `topRules` (per-rule) and `findingsByFile`
 * (per-file)? On mono-repos of independent mini-projects (50 demos
 * under one root, a website-template catalog with N parallel sub-sites),
 * `scan_project` treats the whole tree as one repo and merges findings.
 * The agent triaging the response needs to answer "which sub-tree
 * matters most?" — an axis that neither per-rule nor per-file rollups
 * answer directly. `findingsByFile` ranks individual files; for a 50-
 * project tree with a few hundred files per project, the rank-ordered
 * file list inflates with files that all belong to the same dominant
 * sub-project, and the agent has to walk the list and re-aggregate by
 * directory to learn which project to scope into next. Rolling up to
 * the first path segment exposes the project-level distribution
 * directly: one read, one `additionalPaths: [topDirectories[0].path]`
 * call, and the agent has scoped to the worst sub-project.
 *
 * Relationship to `plan.byGroup`: `byGroup` (in `./scan-group-by.ts`)
 * is the opt-in flexible aggregator — caller passes `groupBy:
 * "firstChildDir" | "directory" | "extension"` and gets a Record keyed
 * by group name, with `{ violations, filesWithFindings, mostCommonRule,
 * mostCommonCriterion }` per entry. `topDirectories` is the always-on
 * rank-ordered headline — same data, different shape, different reading
 * pattern. The agent reading `topDirectories[0]` immediately knows
 * "this is the next sub-tree to scope into"; the agent reading
 * `byGroup` has to know which group key to look up. Both ship to honor
 * the doctrine "one tool call should answer 'what next?'": the
 * always-on rank-ordered shape removes the friction of asking-then-
 * sorting.
 *
 * The orthogonal axes:
 *   - {@link import("./scan-assembly.ts").computeTopRules}: per-rule
 *     (cross-file rule-frequency) — "which rule dominates."
 *   - {@link import("./findings-by-file.ts").computeFindingsByFile}:
 *     per-file (cross-rule per-file-frequency) — "where the work
 *     clusters at the file level."
 *   - {@link computeTopDirectories} (this file): per-first-child-dir
 *     (cross-rule per-sub-tree-frequency) — "which sub-project
 *     dominates" on a mono-repo.
 *
 * All three share the same severity filter so their counts sum to the
 * same error+warning total — the cross-surface count invariant any
 * pair of sibling counters on the same response must honor (see
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant").
 */

import { relative, sep } from "node:path";

/**
 * Default head-slice cap for `plan.topDirectories`. Ten entries is the
 * published surface — wide enough that an agent triaging a 50-project
 * mono-repo sees the dominant sub-trees in one read, narrow enough
 * that the per-entry cost (`{ path, violationCount, fileCount, topRule }`
 * ≈ 80–140 chars) stays under ~1.4 KB on the wire. The slim-envelope
 * path (see `scan-project-budget.ts` `SLIM_TOP_DIRECTORIES_CAP`) trims
 * further when the bulk-vendor regime fires. Mirrors
 * {@link import("./scan-assembly.ts").TOP_RULES_DEFAULT_LIMIT} so the
 * rollup-axis caps stay aligned across surfaces.
 */
export const TOP_DIRECTORIES_DEFAULT_LIMIT = 10;

/**
 * One entry on `plan.topDirectories` — the per-first-child-dir
 * finding-frequency rollup surfaced at the response top level so an
 * agent reading the headline can pick the sub-tree that matters first
 * without paging through `files[]` and re-aggregating by directory.
 *
 *   - `path` — the first path segment relative to the scanned root
 *     (e.g. `templates/foo/index.html` → `templates`). Files at the
 *     repo root (no subdirectory) bucket under `"."` so the rollup is
 *     total over the input — no silent drops. Paths outside the root
 *     (contributed via `additionalPaths`) bucket under `"<external>"`
 *     so the regime is named explicitly. Same key shape as
 *     {@link import("./scan-group-by.ts").groupKeyFor} `firstChildDir`
 *     so `topDirectories[i].path` is a drop-in argument for the
 *     `additionalPaths` next-step the rollup enables.
 *   - `violationCount` — total error+warning findings the sub-tree
 *     emitted. Info-severity findings are excluded so the count
 *     matches the error+warning surface `plan.fixesByClass` tallies.
 *   - `fileCount` — number of files with at least one error+warning
 *     finding inside the sub-tree. Sums to roughly
 *     `plan.totalFilesWithFindings` (when the rollup isn't truncated
 *     and no files emit only info findings).
 *   - `topRule` — the densest rule in the sub-tree, ties broken
 *     alphabetically. Present-when-meaningful: omitted when the
 *     sub-tree emitted no error/warning rules (defensive — the call
 *     site only emits a row when violationCount > 0, so the bucket
 *     always carries at least one rule, but the optional shape
 *     mirrors `byGroup.mostCommonRule` for symmetry across surfaces).
 */
export interface TopDirectoryEntry {
  readonly path: string;
  readonly violationCount: number;
  readonly fileCount: number;
  readonly topRule?: string;
}

interface FindingShape {
  readonly ruleId: string;
  readonly severity: string;
}

interface FileShape {
  readonly path: string;
  readonly findings: readonly FindingShape[];
}

interface DirectoryBucket {
  violationCount: number;
  fileCount: number;
  ruleCounts: Map<string, number>;
}

/**
 * Maps a file path to its first-path-segment bucket relative to
 * `root`. Mirrors `groupKeyFor(path, root, "firstChildDir")` from
 * `./scan-group-by.ts` so the two aggregators key identically and the
 * cross-surface count invariant holds — but inlined here to keep this
 * file standalone (no import cycle through scan-assembly's re-export).
 *
 *   - Files inside `root` with at least one subdirectory bucket under
 *     the first segment (e.g. `templates/foo/x.html` → `templates`).
 *   - Files at the repo root with no subdirectory (e.g. `index.html`)
 *     bucket under `"."` so they participate in the rollup; dropping
 *     them would be a silent suppression per
 *     `docs/kb/architecture/ai-first-consumer.md` "Surface, don't
 *     suppress."
 *   - Paths outside `root` (contributed via `additionalPaths`) bucket
 *     under `"<external>"` so the regime is named explicitly rather
 *     than collapsed under a `..`-prefixed key the agent can't act on.
 */
function firstChildDirFor(path: string, root: string): string {
  const rel = relative(root, path);
  if (rel.startsWith("..")) return "<external>";
  if (rel === "" || rel === ".") return ".";
  const segments = rel.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) return ".";
  return segments.length === 1 ? "." : segments[0]!;
}

/**
 * Single-pass tally builder for {@link computeTopDirectories}. Walks
 * every file once, accumulates per-bucket violation counts and rule
 * frequency, and returns the per-bucket map. Pure over its inputs.
 *
 * Severity filter — info-severity findings are skipped so both the
 * count axis and the densest-rule selection stay aligned with the
 * error+warning surface `plan.fixesByClass` tallies.
 */
function tallyByDirectory(
  files: readonly FileShape[],
  root: string,
): Map<string, DirectoryBucket> {
  const tally = new Map<string, DirectoryBucket>();
  for (const file of files) {
    let fileViolationCount = 0;
    let bucket: DirectoryBucket | undefined;
    for (const finding of file.findings) {
      if (finding.severity === "info") continue;
      if (bucket === undefined) {
        const key = firstChildDirFor(file.path, root);
        bucket = tally.get(key);
        if (bucket === undefined) {
          bucket = { violationCount: 0, fileCount: 0, ruleCounts: new Map() };
          tally.set(key, bucket);
        }
      }
      bucket.violationCount += 1;
      bucket.ruleCounts.set(finding.ruleId, (bucket.ruleCounts.get(finding.ruleId) ?? 0) + 1);
      fileViolationCount += 1;
    }
    if (bucket !== undefined && fileViolationCount > 0) {
      bucket.fileCount += 1;
    }
  }
  return tally;
}

/**
 * Picks the densest rule from a per-rule count bucket — the single
 * ruleId with the highest finding count, ties broken alphabetically
 * for determinism. Returns `undefined` only when the bucket is empty
 * (defensive — call sites only retain buckets with at least one
 * error/warning finding). Same algorithm as
 * `pickTopByCount` in `./scan-group-by.ts` and `pickDensestFile` in
 * `./scan-assembly.ts`; inlined to avoid an import cycle.
 */
function pickTopRule(counts: ReadonlyMap<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Computes the rank-ordered top-{@link TOP_DIRECTORIES_DEFAULT_LIMIT}
 * per-first-child-dir finding rollup from a per-file findings list.
 * Pure over its inputs; designed for the `plan.topDirectories`
 * headline on `scan_project`.
 *
 * Sort: violationCount descending, then path ascending (alphabetical)
 * for deterministic ordering across runs. Slice to `limit` (default
 * {@link TOP_DIRECTORIES_DEFAULT_LIMIT}); when fewer than `limit`
 * sub-trees carry findings, returns all of them (no padding with
 * zero-count rows — those would be a noise-not-signal shape per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest").
 *
 * Severity filter — see {@link TopDirectoryEntry}'s docblock.
 * Info-severity findings are excluded from both the count axis and
 * the per-bucket top-rule selection so the rollup splits the same
 * error+warning surface `plan.fixesByClass` tallies. Without the
 * filter, an info-only sub-tree would appear in the rank-ordered
 * list with a non-actionable `topRule` like `wrappers/inferred`.
 */
export function computeTopDirectories(
  files: readonly FileShape[],
  root: string,
  limit: number = TOP_DIRECTORIES_DEFAULT_LIMIT,
): readonly TopDirectoryEntry[] {
  const tally = tallyByDirectory(files, root);
  const ranked: TopDirectoryEntry[] = [];
  for (const [path, bucket] of tally) {
    if (bucket.violationCount === 0) continue;
    const topRule = pickTopRule(bucket.ruleCounts);
    ranked.push({
      path,
      violationCount: bucket.violationCount,
      fileCount: bucket.fileCount,
      ...(topRule === undefined ? {} : { topRule }),
    });
  }
  // violationCount desc; path asc tiebreak so the wire shape stays
  // stable across runs even when the underlying scanner reorders
  // discovery.
  ranked.sort((a, b) => b.violationCount - a.violationCount || a.path.localeCompare(b.path));
  return ranked.slice(0, limit);
}

/**
 * Stamps `plan.topDirectories` onto a `plan` record produced by
 * `buildScanPlan`. Conditional-spread per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest": when no error/warning findings emerged on this scan,
 * the rollup would be `[]` — a sentinel that forces the agent to read
 * `plan.topDirectories` to learn it has nothing to read. Identity-
 * stable when no sub-tree carries findings, so `tool-scan-project.ts`
 * can route through this helper unconditionally without paying for a
 * shallow copy on the common no-violations path.
 *
 * Single-bucket short-circuit: when the rank-ordered output is exactly
 * one entry — i.e. every error/warning finding falls inside one
 * sub-tree — the rollup tells the agent nothing the existing surfaces
 * (`plan.findingsByFile`, `plan.topRules`, `scanned.root`) don't
 * already say. Per "Verbose meta is signal, not clutter" the doctrine
 * permits noisy fields when they carry signal; per "Sibling fields
 * naming the same concept must use one shape" duplicating a one-row
 * answer with no rank to expose isn't signal — it's redundancy. The
 * helper omits the field on the one-bucket case so the wire shape
 * stays honest. Multi-bucket rollups (the actual mono-repo case the
 * field exists for) ship as expected.
 *
 * When the rank-ordered output crossed the cap and dropped trailing
 * entries, `plan.topDirectoriesTruncated: true` rides alongside so the
 * agent can distinguish "this is the complete inventory" from "the
 * head-slice clipped a longer tail." Sibling boolean rather than
 * embedding the count in the array shape — keeps the array contract
 * (always a `{ path, violationCount, fileCount, topRule? }[]`) intact
 * for every consumer that already iterates it. Mirrors the
 * `findingsByFileTruncated` companion stamped by `withFindingsByFile`.
 *
 * Designed to run AFTER `buildScanPlan` produced the `plan` record but
 * BEFORE the `plan` reaches the wire — `tool-scan-project.ts` calls
 * this once on the full `formatted.files` list (NOT the paged subset)
 * so the rollup describes the whole scan, not the page the caller
 * happened to fetch. The whole-scan framing is what removes the per-
 * file paging cost the rollup exists to address.
 */
export function withTopDirectories(
  plan: Record<string, unknown>,
  files: readonly FileShape[],
  root: string,
  limit: number = TOP_DIRECTORIES_DEFAULT_LIMIT,
): Record<string, unknown> {
  const topDirectories = computeTopDirectories(files, root, limit);
  if (topDirectories.length === 0) return plan;
  if (topDirectories.length === 1) return plan;
  // Count buckets with at least one error/warning finding to tell
  // whether the rank-ordered slice clipped a tail. We can't compare to
  // input file count directly because the input includes files that
  // are info-only (excluded from the rollup) and files that may share
  // a bucket. The full-pass tally is the only honest denominator.
  const fullTally = tallyByDirectory(files, root);
  let totalBucketsWithFindings = 0;
  for (const bucket of fullTally.values()) {
    if (bucket.violationCount > 0) totalBucketsWithFindings += 1;
  }
  const truncated = topDirectories.length < totalBucketsWithFindings;
  return {
    ...plan,
    topDirectories,
    ...(truncated ? { topDirectoriesTruncated: true as const } : {}),
  };
}
