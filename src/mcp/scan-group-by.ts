/**
 * `plan.byGroup` rollup — aggregates per-file findings into a per-group
 * summary keyed off the caller's `groupBy` choice. Bulk-template repos
 * (sub-project subdirectories at the top level) had no first-class
 * workflow for "scan all sub-projects but aggregate per-sub-project."
 * The flat `files[]` list conflates findings across templates; N
 * hand-scoped `scan_project` calls with `additionalPaths` cost N round
 * trips and N separate result blobs. `groupBy: "firstChildDir"` lets
 * one whole-tree scan answer the per-sub-project question in a single
 * response.
 *
 * Three group-key strategies:
 *   - `firstChildDir`: relative-to-`root` first path segment (e.g.
 *     `templates/foo/index.html` → `templates`). The high-leverage
 *     case for catalog repos.
 *   - `directory`: relative-to-`root` parent directory of each file
 *     (e.g. `templates/foo/index.html` → `templates/foo`). Granular
 *     per-folder rollup.
 *   - `extension`: file extension without the leading dot (e.g.
 *     `index.tsx` → `tsx`). Cross-cutting view by file type.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Composite headline
 * counts are dishonest," each per-group entry names exactly one kind
 * of thing — the error+warning violation count for that group, plus
 * the densest rule + criterion + the count of files-with-findings in
 * that group. Info-severity findings are excluded from the count axis
 * so the rollup splits the same surface `plan.fixesByClass` tallies
 * (consistent with {@link computeTopRules} in `scan-assembly.ts`).
 *
 * Per "Surface, don't suppress," findings still ship in the flat
 * `files[]` list — `byGroup` is an additive aggregator on top, not a
 * replacement.
 */

import { extname, relative, sep } from "node:path";

/**
 * Canonical {@link GroupBy} param values. Schema-enforced at the
 * tool-handler seam; this list is the authority for spelling.
 */
export const GROUP_BY_VALUES = ["directory", "firstChildDir", "extension"] as const;
export type GroupBy = (typeof GROUP_BY_VALUES)[number];

/**
 * Per-group summary entry. Each field names exactly one kind of thing
 * — total error+warning violation count for the group, the densest
 * rule + criterion the group emitted, and the count of files-with-
 * findings in that group. `mostCommonRule` and `mostCommonCriterion`
 * are present-when-meaningful: omitted when the group emitted zero
 * error/warning findings (e.g. an info-only group), so a downstream
 * consumer never has to disambiguate "absent" from "tied with
 * nothing."
 */
export interface ByGroupEntry {
  readonly violations: number;
  readonly filesWithFindings: number;
  readonly mostCommonRule?: string;
  readonly mostCommonCriterion?: string;
}

/** A finding-shaped record the rollup walks over. */
interface FindingShape {
  readonly ruleId: string;
  readonly severity: string;
  readonly criterionIds?: readonly string[];
}

interface FileShape {
  readonly path: string;
  readonly findings: readonly FindingShape[];
}

/**
 * Validates a caller-supplied `groupBy` value against the canonical
 * {@link GROUP_BY_VALUES}. Returns the value when it's a known
 * strategy, `undefined` otherwise — caller treats `undefined` as
 * "rollup not requested" and emits the response without `plan.byGroup`.
 */
export function readGroupByParam(raw: unknown): GroupBy | undefined {
  if (typeof raw !== "string") return undefined;
  return (GROUP_BY_VALUES as readonly string[]).includes(raw) ? (raw as GroupBy) : undefined;
}

/**
 * Maps a file path to its group key under the requested strategy.
 *
 *   - `firstChildDir`: relative-to-`root` first segment. Files at the
 *     repo root (no subdirectory) bucket under `"."` so the rollup is
 *     total over all files (no silent drops).
 *   - `directory`: relative-to-`root` parent directory. Repo-root
 *     files bucket under `"."` for the same reason.
 *   - `extension`: lower-cased extension without the leading dot.
 *     Files without an extension bucket under `""` (the empty-string
 *     key is honest — it names the no-extension case explicitly
 *     rather than dropping those files).
 *
 * Returns the empty string only on the `extension` no-extension
 * branch; callers should NOT skip empty-string keys (silent-drop
 * is the failure mode the AI-first doctrine warns against).
 */
export function groupKeyFor(path: string, root: string, strategy: GroupBy): string {
  if (strategy === "extension") {
    const ext = extname(path).toLowerCase();
    return ext.startsWith(".") ? ext.slice(1) : ext;
  }
  const rel = relative(root, path);
  // Path lay outside `root` — `relative()` produced a `..`-prefixed
  // path. `additionalPaths` may contribute files outside the project
  // root; bucketing them under `..` would lose information, so name
  // the regime explicitly.
  if (rel.startsWith("..")) return "<external>";
  if (rel === "" || rel === ".") return ".";
  const segments = rel.split(sep).filter((s) => s.length > 0);
  if (segments.length === 0) return ".";
  if (strategy === "firstChildDir") {
    // Single-segment paths (file directly at root) bucket under "."
    // so the same group-membership rule applies to every file. A
    // repo-root file like `index.html` belongs to no firstChildDir
    // — the explicit "." key names that case.
    return segments.length === 1 ? "." : segments[0]!;
  }
  // strategy === "directory"
  if (segments.length === 1) return ".";
  return segments.slice(0, -1).join("/");
}

interface GroupBucket {
  violations: number;
  filesWithFindings: number;
  ruleCounts: Map<string, number>;
  criterionCounts: Map<string, number>;
}

/**
 * Single-pass tally builder for {@link computeByGroup}. Walks every
 * file once, dispatches to {@link absorbFinding} for each
 * non-info-severity finding, and returns the per-group bucket map.
 * Pure over its inputs.
 */
function tallyByGroup(
  files: readonly FileShape[],
  root: string,
  strategy: GroupBy,
): Map<string, GroupBucket> {
  const tally = new Map<string, GroupBucket>();
  for (const file of files) {
    if (file.findings.length === 0) continue;
    const key = groupKeyFor(file.path, root, strategy);
    const bucket = ensureBucket(tally, key);
    bucket.filesWithFindings += 1;
    for (const finding of file.findings) {
      absorbFinding(bucket, finding);
    }
  }
  return tally;
}

function ensureBucket(tally: Map<string, GroupBucket>, key: string): GroupBucket {
  const existing = tally.get(key);
  if (existing !== undefined) return existing;
  const fresh: GroupBucket = {
    violations: 0,
    filesWithFindings: 0,
    ruleCounts: new Map(),
    criterionCounts: new Map(),
  };
  tally.set(key, fresh);
  return fresh;
}

/**
 * Stamps one finding into a group bucket. Info-severity findings are
 * excluded from the violation count and rule/criterion frequency so
 * the rollup splits the same error+warning surface
 * `plan.fixesByClass` tallies. Pure over its arguments.
 */
function absorbFinding(bucket: GroupBucket, finding: FindingShape): void {
  if (finding.severity === "info") return;
  bucket.violations += 1;
  bucket.ruleCounts.set(finding.ruleId, (bucket.ruleCounts.get(finding.ruleId) ?? 0) + 1);
  const crits = finding.criterionIds ?? [];
  for (const c of crits) {
    bucket.criterionCounts.set(c, (bucket.criterionCounts.get(c) ?? 0) + 1);
  }
}

/**
 * Computes the {@link ByGroupEntry} map for the given files under the
 * caller's `groupBy` strategy. Returns an empty record when no group
 * has any error/warning findings — caller conditional-spreads the
 * `byGroup` field off the wire on a clean scan (CLAUDE.md §1
 * "Ambiguous field shapes are dishonest").
 *
 * Severity filter: info-severity findings are excluded from
 * `violations` and from the rule/criterion frequency counts so the
 * rollup splits the same error+warning surface `plan.fixesByClass`
 * tallies. Files that emit only info findings still count in
 * `filesWithFindings` for their group (the file IS in `files[]` and
 * the agent can read why) — but a group whose total error+warning
 * count is zero across the strategy doesn't earn a row.
 *
 * `mostCommonRule` / `mostCommonCriterion` ties break alphabetically
 * for deterministic ordering across runs.
 */
export function computeByGroup(
  files: readonly FileShape[],
  root: string,
  strategy: GroupBy,
): Record<string, ByGroupEntry> {
  const tally = tallyByGroup(files, root, strategy);
  const out: Record<string, ByGroupEntry> = {};
  for (const [key, bucket] of tally) {
    if (bucket.violations === 0) continue;
    const mostCommonRule = pickTopByCount(bucket.ruleCounts);
    const mostCommonCriterion = pickTopByCount(bucket.criterionCounts);
    out[key] = {
      violations: bucket.violations,
      filesWithFindings: bucket.filesWithFindings,
      ...(mostCommonRule === undefined ? {} : { mostCommonRule }),
      ...(mostCommonCriterion === undefined ? {} : { mostCommonCriterion }),
    };
  }
  return out;
}

/**
 * Picks the highest-count key from a tally map; ties break
 * alphabetically for stable ordering across runs. Returns `undefined`
 * when the map is empty so callers can omit the field via conditional
 * spread (no sentinel-empty string).
 */
function pickTopByCount(counts: ReadonlyMap<string, number>): string | undefined {
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
 * Stamps `plan.byGroup` onto a `plan` record produced by
 * `buildScanPlan` (and possibly already enriched with `topRules` /
 * `violationsByScanKind`). Identity-stable when no group has any
 * error/warning findings — the common clean-scan path pays no
 * shallow-copy cost. Caller passes `strategy: undefined` to short-
 * circuit the rollup entirely (the standard non-`groupBy` request).
 *
 * Designed to run on the FULL pre-pagination `files` list so the
 * rollup describes the whole scan regardless of which page the caller
 * fetched — same framing as `withTopRules`.
 */
export function withByGroup(
  plan: Record<string, unknown>,
  files: readonly FileShape[],
  root: string,
  strategy: GroupBy | undefined,
): Record<string, unknown> {
  if (strategy === undefined) return plan;
  const byGroup = computeByGroup(files, root, strategy);
  if (Object.keys(byGroup).length === 0) return plan;
  return { ...plan, byGroup };
}
