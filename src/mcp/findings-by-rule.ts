/**
 * Per-rule full count map surfaced as `plan.findingsByRule` on
 * `scan_project`. Lives in its own file so `scan-assembly.ts` stays
 * inside the 500-effective-line budget enforced by
 * `scripts/check-limits.ts` (same split rationale as
 * `./findings-by-file.ts` and `./top-directories.ts`). Re-exported
 * through `scan-assembly.ts` so the rank-ordered headline rollups
 * (`withTopRules`, `withFindingsByFile`, `withTopDirectories`) and the
 * full per-rule map (`withFindingsByRule`) share one canonical entry
 * point at the call site.
 *
 * Distinct shape from {@link import("./scan-assembly.ts").computeTopRules}:
 * `topRules` is the rank-ordered top-N (10) list with per-rule extras
 * (`topFile`, `fixClass`); this map is the FULL per-rule count
 * `{[ruleId]: count}` covering every rule that emitted at least one
 * error/warning. The two surfaces describe the same per-rule axis at
 * different slices — `topRules` answers "which rules dominate" with
 * enriched metadata for triage routing; `findingsByRule` answers "what
 * is the full per-rule distribution" so an agent paginating by rule
 * (`scan_file({ruleId})` or per-rule fix batches) can budget the
 * round-trip cost without paging through `files[]`. The names reflect
 * the slice difference: `topRules` is the ranked head; `findingsByRule`
 * is the flat full map. A consumer that needs only the dominant rules
 * reads `topRules`; one that needs the long tail reads
 * `findingsByRule`. Both filter info-severity findings the same way
 * (excluded), so their per-rule counts agree on every overlapping
 * `ruleId` — the cross-surface count invariant any pair of sibling
 * counters on the same response must honor (see
 * `docs/kb/architecture/ai-first-consumer.md` "Cross-surface count
 * invariant").
 */

interface FileShape {
  readonly findings: readonly { readonly ruleId: string; readonly severity: string }[];
}

/**
 * Computes the full per-rule count map from a per-file findings list.
 * Pure over its inputs; designed for the `plan.findingsByRule`
 * headline on `scan_project`.
 *
 * One entry per rule that emitted at least one error/warning finding;
 * rules with zero error/warning findings are omitted (no
 * `{[ruleId]: 0}` padding — that would be a noise-not-signal shape per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest"; the loaded-but-zero-firing rule axis already lives
 * on `meta.perRuleCoverage` with structured `findingsEmitted: 0` rows
 * and per-rule reasons).
 *
 * Severity filter — info-severity findings are excluded from the
 * count axis the same way `computeTopRules` and `computeFindingsByFile`
 * exclude them, so the per-rule rollup describes the same
 * error+warning surface the `plan.fixesByClass` headline tallies.
 * Without the filter, an info-only rule (e.g. `wrappers/inferred`)
 * would surface here with non-actionable counts that disagree with
 * `topRules` (which already filters info).
 */
export function computeFindingsByRule(
  files: readonly FileShape[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.severity === "info") continue;
      counts[finding.ruleId] = (counts[finding.ruleId] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Stamps `plan.findingsByRule` onto a `plan` record produced by
 * `buildScanPlan`. Conditional-spread per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest": when no error/warning findings emerged on this scan,
 * the map would be `{}` — a sentinel that forces the agent to read
 * `plan.findingsByRule` to learn it has nothing to read. Identity-stable
 * when no rules fired, so `tool-scan-project.ts` can route through this
 * helper unconditionally without paying for a shallow copy on the
 * common no-violations path.
 *
 * Designed to run AFTER `buildScanPlan` produced the `plan` record but
 * BEFORE the `plan` reaches the wire — `tool-scan-project.ts` calls
 * this once on the full `formatted.files` list (NOT the paged subset)
 * so the rollup describes the whole scan, not the page the caller
 * happened to fetch. The whole-scan framing is what removes the
 * per-file paging cost the rollup exists to address.
 */
export function withFindingsByRule(
  plan: Record<string, unknown>,
  files: readonly FileShape[],
): Record<string, unknown> {
  const findingsByRule = computeFindingsByRule(files);
  if (Object.keys(findingsByRule).length === 0) return plan;
  return { ...plan, findingsByRule };
}
