/**
 * Per-rule coverage confidence — derived from the evaluation tracker
 * the rule runner filled during a scan loop, produces one
 * {@link PerRuleCoverage} entry per active rule whose
 * `appliesTo.fileExtensions` could fail to match any scanned file.
 *
 * Lives next to the scanner (not under `src/mcp/`) because the shape is
 * engine-owned — the MCP response layer pivots off the same array the
 * scanner returns as `ScanProducts.perRuleCoverage`.
 *
 * The canonical acute case motivating this module is Tailwind pre-build:
 * `contrast/minimum` targets `.css`, a Tailwind project's source tree
 * has 0 eligible CSS files, the rule reports 0 findings — and the agent
 * reads "0 findings" as "clean" when the truth is "the rule never had
 * anything to evaluate." Surfacing `coverageConfidence: "low"` with a
 * reason + remediation gives the agent the signal it needs to call
 * `scan_project` again with `additionalPaths: ["dist/assets"]`.
 */

import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import type { RuleEvaluationTracker } from "./rule-runner.ts";
import type { StandardFilter } from "./standard-filter.ts";

/**
 * Minimum evaluated-file count for a rule's coverage to register as
 * `"high"` confidence. At the floor (1) a single-file match is enough
 * to vouch for the rule on this scan — the threshold guards against
 * the Tailwind-pre-build acute case (rule targets `.css`, scan sees 0
 * eligible sources) without demanding a saturating evaluation count
 * no real project would hit. Deliberately not user-configurable to
 * start — see `docs/kb/architecture/ai-first-consumer.md` on numeric
 * thresholds.
 */
const MIN_FILES_FOR_HIGH_CONFIDENCE = 1;

/**
 * Minimum total-findings-per-rule before a per-file concentration hint
 * is worth stamping on a {@link PerRuleCoverage} row. Below this floor
 * the "one file dominates" observation is statistical noise — a rule
 * with 3 findings, all on one file, tells the agent nothing it can't
 * see from the underlying `files[].findings` listing. Surface-don't-
 * suppress: the findings themselves are always present; this gates
 * only the additive hint (V1-NOISE-RULE-PER-FILE-ROLLUP).
 */
const RULE_CONCENTRATION_MIN_TOTAL = 10;

/**
 * Minimum share of a rule's findings that must land on a single file
 * for the concentration hint to fire. Strictly greater than the
 * threshold — an exact 50/50 split is not concentrated. Paired with
 * {@link RULE_CONCENTRATION_MIN_TOTAL}, these threshold choices are
 * deliberately honest about what the hint names: "one file is where
 * the idiom lives" is only true when the file holds a clear majority
 * of the rule's findings, not just a plurality
 * (V1-NOISE-RULE-PER-FILE-ROLLUP).
 */
const RULE_CONCENTRATION_MIN_SHARE = 0.5;

/**
 * Derives {@link PerRuleCoverage} entries from the tracker the rule
 * runner filled during the scan loop. One entry per active rule that
 * passes the standard/level filter — no silent absences. Extension-
 * gated rules get counts from the tracker; project-scoped rules (their
 * only lifecycle is `afterProject`, so per-file tracking doesn't apply)
 * get an entry synthesized from the scan-wide file count so every
 * evaluated rule is visible to the consumer
 * (V1-META-RULES-EVALUATED-COVERAGE-DRIFT). Invariant: every rule in
 * the "was evaluated" set — the same set that drives `rulesEvaluated`
 * — gets exactly one row. An agent reading `perRuleCoverage.length`
 * must get the same count as `rulesEvaluated`, so "didn't run" vs.
 * "ran with zero eligible files" is never collapsed into silent
 * absence.
 *
 * Sort is alphabetical by rule ID so cross-run diff is stable; each
 * {@link PerRuleCoverage} is assembled with conditional spread on
 * `reason` / `remediation` per CLAUDE.md §1 "Ambiguous field shapes
 * are dishonest" — the fields are present only on low-confidence
 * entries. `findingsEmitted` is computed from `violations` (a single
 * pass tally per rule ID) and ALWAYS populated — including zero, which
 * is the load-bearing "rule ran and found nothing" signal that pairs
 * with `coverageConfidence` (V1-SHAPE-RULECOV-COUNT). Pre-filter
 * violations are the right input here: per-rule coverage describes
 * what the engine itself observed, not the post-severity / post-skip
 * view a particular consumer sees.
 *
 * `concentration` (V1-NOISE-RULE-PER-FILE-ROLLUP) is computed in the
 * same linear pass over violations. It is stamped on the row only when
 * both thresholds clear ({@link RULE_CONCENTRATION_MIN_TOTAL} and
 * {@link RULE_CONCENTRATION_MIN_SHARE}); otherwise omitted via
 * conditional spread. The hint never hides or groups findings — every
 * violation continues to ship in `files[].findings`; this is additive
 * telemetry pointing the agent at the densest file so one read triages
 * many candidates.
 */
export function buildPerRuleCoverage(
  tracker: RuleEvaluationTracker,
  rules: readonly Rule[],
  filter: StandardFilter,
  violations: readonly Violation[],
  filesScanned: number,
): readonly PerRuleCoverage[] {
  const findingsByRule = countFindingsByRule(violations);
  const densestByRule = densestFileByRule(violations);
  const out: PerRuleCoverage[] = [];
  const sortedRules = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  for (const rule of sortedRules) {
    if (!filter.isRuleActive(rule)) continue;
    const findingsEmitted = findingsByRule.get(rule.id) ?? 0;
    const concentration = computeConcentration(findingsEmitted, densestByRule.get(rule.id));
    const counts = tracker.counts.get(rule.id);
    const extensions = rule.appliesTo?.fileExtensions;
    // Per-file rules with an extension gate: tracker.counts carries
    // the real eligibility tally (bumped by `bumpTracker` for every
    // file the rule was considered against). The builder uses that
    // tally verbatim — including the honest zero-eligible case where
    // the scan saw no files matching the gate (canonical Tailwind
    // pre-build shape). A missing tracker entry on an extension-gated
    // rule means zero files flowed through the per-file loop (the
    // whole scan had 0 files) — treat that as zero eligible so the
    // extension-gated reason text still fires instead of misrouting
    // into the project-scoped branch.
    if (extensions && extensions.length > 0) {
      const eligible = counts?.eligible ?? 0;
      const evaluated = counts?.evaluated ?? 0;
      out.push(
        buildExtensionGatedEntry(
          rule.id,
          eligible,
          evaluated,
          findingsEmitted,
          extensions,
          concentration,
        ),
      );
      continue;
    }
    // Project-scoped rules (`afterProject` only) don't flow through
    // the per-file tracker — the rule runner never sees them in the
    // per-file loop. Emit an entry with `filesScanned` as both
    // eligible and evaluated so the invariant
    // `perRuleCoverage.length === rulesEvaluated` holds. When
    // `filesScanned === 0`, the entry honestly surfaces "no files
    // scanned" rather than going silently absent, because "scan never
    // ran against the project" is the exact signal the consumer
    // needs (V1-META-RULES-EVALUATED-COVERAGE-DRIFT).
    out.push(buildProjectScopedEntry(rule.id, filesScanned, findingsEmitted, concentration));
  }
  return out;
}

/**
 * One linear pass over the post-scan violation stream tallying per-rule
 * counts. Cheaper than re-walking `files[].findings[]` at the consumer,
 * and lets the response-assembly layer drop the derivation entirely
 * (V1-SHAPE-RULECOV-COUNT). `internal/rule-crash` records still tally
 * under their synthetic ruleId — they don't surface in
 * {@link buildPerRuleCoverage}'s output (no extension gate), so the
 * count is harmless and the helper stays general.
 */
function countFindingsByRule(violations: readonly Violation[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.ruleId, (counts.get(v.ruleId) ?? 0) + 1);
  return counts;
}

/**
 * Densest file per rule — one linear pass tallying
 * (ruleId, filePath) pairs, then picking the winner per rule. Ties on
 * max count are broken by lexicographic smallest filePath so cross-run
 * output is deterministic even when two files share the peak. Used
 * only for the optional `concentration` hint — the map is built
 * regardless of thresholds; {@link computeConcentration} decides
 * whether to stamp the row (V1-NOISE-RULE-PER-FILE-ROLLUP).
 */
function densestFileByRule(
  violations: readonly Violation[],
): ReadonlyMap<string, { file: string; count: number }> {
  // Per-(rule, file) tallies built in one pass over the violation
  // stream — cheaper than re-walking `files[].findings[]` at the
  // consumer, and reuses the same input {@link countFindingsByRule}
  // already scans.
  const perRule = new Map<string, Map<string, number>>();
  for (const v of violations) {
    let byFile = perRule.get(v.ruleId);
    if (!byFile) {
      byFile = new Map<string, number>();
      perRule.set(v.ruleId, byFile);
    }
    const file = v.location.filePath;
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  const out = new Map<string, { file: string; count: number }>();
  for (const [ruleId, byFile] of perRule.entries()) {
    const best = pickDensest(byFile);
    if (best !== undefined) out.set(ruleId, best);
  }
  return out;
}

/**
 * Picks the densest (file, count) entry from a per-file count map.
 * Larger count wins; ties break by lexicographic smallest path so the
 * result is deterministic across runs. Extracted from
 * {@link densestFileByRule} to keep the caller's cognitive complexity
 * under Biome's noExcessiveCognitiveComplexity threshold.
 */
function pickDensest(
  byFile: ReadonlyMap<string, number>,
): { file: string; count: number } | undefined {
  let best: { file: string; count: number } | undefined;
  for (const [file, count] of byFile.entries()) {
    if (best === undefined) {
      best = { file, count };
    } else if (count > best.count || (count === best.count && file < best.file)) {
      best = { file, count };
    }
  }
  return best;
}

/**
 * Decides whether to emit the `concentration` hint for a rule given
 * its total finding count and densest file. Returns `undefined` when
 * either threshold fails, so the caller spreads conditionally and the
 * field is absent (not `null`, not an empty object) per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest"
 * (V1-NOISE-RULE-PER-FILE-ROLLUP).
 *
 * Thresholds:
 *   - total findings > {@link RULE_CONCENTRATION_MIN_TOTAL} (strict)
 *   - densest / total > {@link RULE_CONCENTRATION_MIN_SHARE} (strict —
 *     an exact 50/50 split is not concentrated)
 */
function computeConcentration(
  findingsEmitted: number,
  densest: { file: string; count: number } | undefined,
): { file: string; count: number } | undefined {
  if (findingsEmitted <= RULE_CONCENTRATION_MIN_TOTAL) return undefined;
  if (densest === undefined) return undefined;
  const share = densest.count / findingsEmitted;
  if (share <= RULE_CONCENTRATION_MIN_SHARE) return undefined;
  return { file: densest.file, count: densest.count };
}

/**
 * Assembles one {@link PerRuleCoverage} record for an extension-gated
 * per-file rule. Low-confidence branches name the condition (`"no
 * files matching …"` vs `"all eligible files were excluded or
 * empty"`) and supply a one-line remediation the agent can act on
 * without docs — e.g. "add built CSS via additionalPaths."
 * High-confidence entries omit both reason and remediation — the
 * fields are present-when-meaningful (CLAUDE.md §1 "Ambiguous field
 * shapes are dishonest"). `findingsEmitted` is always populated
 * (including zero) per V1-SHAPE-RULECOV-COUNT. `concentration` is
 * spread conditionally on every branch — omitted (never `null`, never
 * empty-object) when thresholds don't clear
 * (V1-NOISE-RULE-PER-FILE-ROLLUP).
 */
function buildExtensionGatedEntry(
  ruleId: string,
  eligible: number,
  evaluated: number,
  findingsEmitted: number,
  extensions: readonly string[],
  concentration: { file: string; count: number } | undefined,
): PerRuleCoverage {
  const concentrationSpread = concentration ? { concentration } : {};
  if (eligible === 0) {
    return {
      ruleId,
      filesEvaluated: evaluated,
      filesEligible: eligible,
      findingsEmitted,
      coverageConfidence: "low",
      reason: `no files matching ${extensions.join(", ")} were scanned`,
      remediation: `add ${primaryExtension(extensions)} source files to the scan path, or pass \`additionalPaths\` when the content is compiled output (e.g. \`additionalPaths: ["dist/assets"]\` for Tailwind)`,
      ...concentrationSpread,
    };
  }
  if (evaluated < MIN_FILES_FOR_HIGH_CONFIDENCE) {
    return {
      ruleId,
      filesEvaluated: evaluated,
      filesEligible: eligible,
      findingsEmitted,
      coverageConfidence: "low",
      reason: "all eligible files were excluded or empty",
      remediation: "check exclude patterns and file contents",
      ...concentrationSpread,
    };
  }
  return {
    ruleId,
    filesEvaluated: evaluated,
    filesEligible: eligible,
    findingsEmitted,
    coverageConfidence: "high",
    ...concentrationSpread,
  };
}

/**
 * Assembles one {@link PerRuleCoverage} record for a project-scoped
 * rule — one whose only lifecycle hook is `afterProject`, so the
 * per-file tracker never sees it. The rule evaluates against the full
 * scanned-file set in one shot, so `filesEligible` and `filesEvaluated`
 * are both the scan's `filesScanned` count. When `filesScanned === 0`
 * the entry honestly reads as low-confidence ("no files scanned") —
 * the same silent-miss failure mode {@link buildExtensionGatedEntry}
 * guards against at the per-rule level, now also closed for
 * project-scoped rules (V1-META-RULES-EVALUATED-COVERAGE-DRIFT). The
 * concentration hint still applies when a project-scoped rule's
 * findings cluster on one file, so it spreads in on both branches.
 */
function buildProjectScopedEntry(
  ruleId: string,
  filesScanned: number,
  findingsEmitted: number,
  concentration: { file: string; count: number } | undefined,
): PerRuleCoverage {
  const concentrationSpread = concentration ? { concentration } : {};
  if (filesScanned === 0) {
    return {
      ruleId,
      filesEvaluated: 0,
      filesEligible: 0,
      findingsEmitted,
      coverageConfidence: "low",
      reason: "no files were scanned; project-scoped rule had nothing to evaluate",
      remediation:
        "check the scan root and include patterns — the project matched zero parseable files",
      ...concentrationSpread,
    };
  }
  return {
    ruleId,
    filesEvaluated: filesScanned,
    filesEligible: filesScanned,
    findingsEmitted,
    coverageConfidence: "high",
    ...concentrationSpread,
  };
}

/**
 * Names a representative extension for the remediation string —
 * `.css`-targeted rules get "CSS", `.html/.htm` → "HTML", etc.
 * Purely cosmetic; falls back to the raw list when the first entry
 * is unfamiliar.
 */
function primaryExtension(extensions: readonly string[]): string {
  const head = extensions[0]?.toLowerCase() ?? "";
  if (head === ".css") return "CSS";
  if (head === ".scss") return "SCSS";
  if (head === ".html" || head === ".htm") return "HTML";
  if (head === ".mdx") return "MDX";
  if (head === ".astro") return "Astro";
  if (head === ".tsx" || head === ".jsx" || head === ".ts" || head === ".js") {
    return "JSX/TSX";
  }
  return extensions.join(", ");
}
