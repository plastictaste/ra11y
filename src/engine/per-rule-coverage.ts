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
 *
 * Companion case (ADR 0026,
 *): a rule whose
 * *spec* spans cross-file wiring but whose *implementation* is
 * bounded to the current file (canonical: `keyboard/handler-missing`
 * can't see a click listener wired from a sibling `.js`; `navigation/
 * skip-link` can't see an `#main` target that lives in a layout
 * partial). These rules declare `crossFileCapable: false`; a clean
 * tally on any substrate then reports `coverageConfidence: "medium"`
 * with a structured `reason` code naming the cross-file thing the
 * rule can't see — honest "the rule ran but its evidence was
 * bounded" instead of a silent-miss `"high"`.
 */

import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
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
 * Per-rule reason codes emitted when a `crossFileCapable: false` rule
 * is downgraded from `"high"` to `"medium"` coverage because its
 * evidence horizon is bounded to the current file (ADR 0026, follow-up
 *).
 *
 * Each entry is a stable snake_case identifier
 * (`cross_file_<kind>_resolution_not_attempted_by_rule`) naming the
 * specific cross-file thing the rule can't see — `listener` for click
 * handlers wired in a sibling `.js`, `idref` for ARIA / anchor target
 * ids that may live in a layout partial, `click_alternative` for a
 * drag-rule's alternative-pointer pathway that may live in a parent
 * component.
 *
 * Suffix framing — `_not_attempted_by_rule` (per
 * docs/kb/architecture/ai-first-consumer.md "Heuristic-mislabeled
 * meta sub-fields are dishonest"): every current emission gates on
 * `crossFileCapable: false`, which declares "the rule's design does
 * not attempt cross-file resolution at all." The earlier
 * `_limited_on_this_input` framing read as "we tried this input and
 * were limited," which agents could mis-interpret as "maybe a different
 * input would resolve it" and waste a re-scan. The actual situation is
 * a permanent rule-design limitation, not an input-specific hiccup —
 * the suffix names that honestly. (`_inherent_to_rule` was an earlier
 * peer suffix used in the project-scoped branch where there is no
 * per-input candidate-token signal to gate on; both branches collapse
 * to `_not_attempted_by_rule` because they describe the same fact:
 * the rule never tries.)
 *
 * Reserved for the future case (b) where a rule actually attempts
 * cross-file resolution but the input was incomplete (partial-parse,
 * file-set-limited): `cross_file_<kind>_resolution_limited_on_this_input`
 * stays available as the honest framing for "we tried and were
 * limited by this input." No current producer is in that case, so the
 * suffix is not emitted today.
 *
 * Agents read the code + the cited file and decide. The per-family
 * distinction stays triage-useful: "the listener lives in a sibling
 * `.js`" and "the `#main` target lives in a partial" route to
 * different follow-up reads. One flat code would flatten that signal.
 *
 * The fallback (`cross_file_evidence_bounded_not_attempted_by_rule`)
 * catches rules that declare `crossFileCapable: false` but aren't yet
 * in the per-family mapping — honest default, surfaces the downgrade
 * without inventing specifics the per-family codes earn.
 */
const CROSS_FILE_BOUND_REASONS: Readonly<Record<string, string>> = {
  "keyboard/handler-missing": "cross_file_listener_resolution_not_attempted_by_rule",
  "aria/labelledby-target-exists": "cross_file_idref_resolution_not_attempted_by_rule",
  "navigation/skip-link": "cross_file_idref_resolution_not_attempted_by_rule",
  "forms/error-message-not-associated": "cross_file_idref_resolution_not_attempted_by_rule",
  "pointer/drag-alternative": "cross_file_click_alternative_resolution_not_attempted_by_rule",
  // `contrast/minimum` resolves `:root { --name }` custom properties
  // same-file only; design-system CSS routinely declares tokens in a
  // separate `tokens.css` stylesheet, so a clean tally on any single-
  // file CSS substrate is bounded. Named explicitly so the agent's
  // next-read triage routes to "check for a tokens.css the consumer
  // stylesheet `var(--fg)`s against" rather than a generic "ran but
  // bounded" message.
  "contrast/minimum": "cross_file_custom_property_resolution_not_attempted_by_rule",
  // `aria/live-region-missing-on-innerhtml-target` is project-scoped and
  // walks both halves (HTML host element + sibling JS innerHTML
  // mutation site) when both are present in `ctx.files`. Single-file
  // substrates (`scan_file` on HTML alone or JS alone) render the rule
  // structurally unable to fire — silent-miss when the rule reports
  // `coverageConfidence: "high"` on a half-input scan. Named so the
  // agent's next-read triage routes to "check whether the JS file
  // mutating innerHTML on the host element is in the scan path" rather
  // than a generic "ran but bounded" message.
  "aria/live-region-missing-on-innerhtml-target":
    "cross_file_innerhtml_target_resolution_not_attempted_by_rule",
};

const CROSS_FILE_BOUND_REASON_FALLBACK = "cross_file_evidence_bounded_not_attempted_by_rule";

/**
 * Minimum total-findings-per-rule before a per-file concentration hint
 * is worth stamping on a {@link PerRuleCoverage} row. Below this floor
 * the "one file dominates" observation is statistical noise — a rule
 * with 3 findings, all on one file, tells the agent nothing it can't
 * see from the underlying `files[].findings` listing. Surface-don't-
 * suppress: the findings themselves are always present; this gates
 * only the additive hint.
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
 */
const RULE_CONCENTRATION_MIN_SHARE = 0.5;

/**
 * Minimum (file, class-pattern) cluster size before the per-file-per-
 * class-pattern rollup stamps a
 * {@link PerRuleCoverage.classPatternConcentration} entry. Below this
 * floor the cluster is statistical noise — "three findings with the
 * same class shape in one file" tells the agent nothing it can't see
 * from the `files[].findings` listing. Surface-don't-suppress: the
 * findings themselves are always present; this gates only the
 * additive rollup hint.
 *
 * Threshold direction: `>=` (inclusive at 10). The singular
 * {@link RULE_CONCENTRATION_MIN_TOTAL} uses strict `>` because it's
 * asking "does one file dominate the whole rule?" — a volume
 * question; this threshold is asking "is this cluster big enough to
 * be worth naming?" — a cluster-size question with no direction bias
 * either way, so the natural `>=` sits fine.
 */
const CLASS_PATTERN_MIN_COUNT = 10;

/**
 * Minimum share of the rule's findings on a given file that must
 * belong to one class pattern for the rollup to stamp an entry. Uses
 * inclusive `>=` so a cluster that exactly matches the threshold
 * still reads as "this pattern is the dominant idiom here." Pairs
 * with {@link CLASS_PATTERN_MIN_COUNT} — both must clear.
 */
const CLASS_PATTERN_MIN_SHARE = 0.8;

/**
 * Upper bound on `samples` array length per cluster. Honest cap — the
 * rollup is a triage hint, not a replacement for the full findings
 * listing. Three samples is enough to convey "the pattern covers
 * diverse glyphs" without mirroring the underlying stream.
 */
const CLASS_PATTERN_MAX_SAMPLES = 3;

/**
 * Rules whose detection keys off a class attribute and that populate
 * {@link Violation.classEvidence} at emit time. The aggregator uses
 * this set as the gate for per-file-per-class-pattern rollup — other
 * rules skip the work regardless of finding volume, so adding a rule
 * to the rollup is an explicit opt-in (the rule must populate
 * `classEvidence` AND have its ID listed here).
 *
 * Start narrow: `aria/icon-font-hidden` is the canonical case. When
 * `navigation/link-descriptive-text` (or another rule with the same
 * class-pattern failure mode) wants in, add the rule ID here and
 * populate `classEvidence` in that rule.
 */
const CLASS_PATTERN_RULES: ReadonlySet<string> = new Set(["aria/icon-font-hidden"]);

/**
 * Derives {@link PerRuleCoverage} entries from the tracker the rule
 * runner filled during the scan loop. One entry per active rule that
 * passes the standard/level filter — no silent absences. Extension-
 * gated rules get counts from the tracker; project-scoped rules (their
 * only lifecycle is `afterProject`, so per-file tracking doesn't apply)
 * get an entry synthesized from the scan-wide file count so every
 * evaluated rule is visible to the consumer.
 * Invariant: every rule in
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
 * with `coverageConfidence`. Pre-filter
 * violations are the right input here: per-rule coverage describes
 * what the engine itself observed, not the post-severity / post-skip
 * view a particular consumer sees.
 *
 * `concentration` is computed in the
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
  const classPatternByRule = classPatternConcentrationByRule(violations);
  const out: PerRuleCoverage[] = [];
  const sortedRules = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  for (const rule of sortedRules) {
    if (!filter.isRuleActive(rule)) {
      // Surface, don't suppress. A
      // rule pre-filtered by the active conformance level would
      // otherwise vanish from the response — the agent reading
      // `perRuleCoverage` cannot then distinguish "the rule isn't
      // loaded" from "the rule is loaded but level filtering excluded
      // it." Emit a structured `skipReason: "gated_by_level"` row
      // (with `requiredLevel` + `requestedLevel`) so the agent has the
      // exact remediation. Rules inactive for the orthogonal "no
      // enabled-standard criterion" reason still skip — there is no
      // honest level-gate row for them, and surfacing them as `loaded`
      // is also a lie (they aren't reachable under the current
      // standards).
      const gate = filter.levelGateForInactiveRule(rule);
      if (gate) out.push(buildLevelGatedEntry(rule.id, gate));
      continue;
    }
    const findingsEmitted = findingsByRule.get(rule.id) ?? 0;
    const concentration = computeConcentration(findingsEmitted, densestByRule.get(rule.id));
    const classPatternConcentration = classPatternByRule.get(rule.id);
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
      const crossFileCandidates = counts?.crossFileCandidates ?? 0;
      out.push(
        buildExtensionGatedEntry(
          rule.id,
          eligible,
          evaluated,
          findingsEmitted,
          extensions,
          concentration,
          classPatternConcentration,
          rule.crossFileCapable,
          crossFileCandidates,
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
    // needs.
    out.push(
      buildProjectScopedEntry(
        rule.id,
        filesScanned,
        findingsEmitted,
        concentration,
        classPatternConcentration,
        rule.crossFileCapable,
      ),
    );
  }
  return out;
}

/**
 * One linear pass over the post-scan violation stream tallying per-rule
 * counts. Cheaper than re-walking `files[].findings[]` at the consumer,
 * and lets the response-assembly layer drop the derivation entirely.
 * `internal/rule-crash` records still tally
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
 * whether to stamp the row.
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
 * (including zero) per. `concentration` is
 * spread conditionally on every branch — omitted (never `null`, never
 * empty-object) when thresholds don't clear
 */
function buildExtensionGatedEntry(
  ruleId: string,
  eligible: number,
  evaluated: number,
  findingsEmitted: number,
  extensions: readonly string[],
  concentration: { file: string; count: number } | undefined,
  classPatternConcentration:
    | readonly { file: string; count: number; classPattern: string; samples: readonly string[] }[]
    | undefined,
  crossFileCapable: boolean | undefined,
  crossFileCandidates: number,
): PerRuleCoverage {
  const concentrationSpread = concentration ? { concentration } : {};
  const classPatternSpread =
    classPatternConcentration && classPatternConcentration.length > 0
      ? { classPatternConcentration }
      : {};
  // `fired` is `findingsEmitted > 0` at every construction branch — see
  // the field doc on `PerRuleCoverage`. Inlined per-return so the
  // derivation lives on the same literal as `findingsEmitted` itself.
  if (eligible === 0) {
    return {
      ruleId,
      filesEvaluated: evaluated,
      filesEligible: eligible,
      findingsEmitted,
      fired: findingsEmitted > 0,
      coverageConfidence: "low",
      reason: `no files matching ${extensions.join(", ")} were scanned`,
      remediation: `add ${primaryExtension(extensions)} source files to the scan path, or pass \`additionalPaths\` when the content is compiled output (e.g. \`additionalPaths: ["dist/assets"]\` for Tailwind)`,
      ...concentrationSpread,
      ...classPatternSpread,
    };
  }
  if (evaluated < MIN_FILES_FOR_HIGH_CONFIDENCE) {
    return {
      ruleId,
      filesEvaluated: evaluated,
      filesEligible: eligible,
      findingsEmitted,
      fired: findingsEmitted > 0,
      coverageConfidence: "low",
      reason: "all eligible files were excluded or empty",
      remediation: "check exclude patterns and file contents",
      ...concentrationSpread,
      ...classPatternSpread,
    };
  }
  // Cross-file downgrade (ADR 0026): the rule ran on eligible inputs —
  // normally `"high"` — but its `crossFileCapable` flag declares the
  // spec *could* require cross-file evidence while the implementation
  // is bounded to the current file. Reporting `"high"` on a clean tally
  // here is the same silent-miss shape as reporting `"high"` on a rule
  // that never found its target extension. The conservative-honest
  // answer is to downgrade to `"medium"` with a structured reason —
  // the rule *ran*, its evidence *was bounded*, and the agent reads
  // the cited code to decide.
  //
  // Predicate-strength gate: only downgrade when the rule actually
  // observed at least one candidate token whose resolution may extend
  // beyond the file. With zero candidates the substrate carries no
  // cross-file question for the rule to have missed — the row stays
  // `"high"` (`reason` "stays unset, `confidence` honest about the
  // evidence the rule had access to). The default-pessimism `"medium"`
  // on a token-free file is the same dishonesty as a `reason` text that
  // concedes "the predicate is satisfied, but I'm still emitting" —
  // the agent reads `medium` as scan-confidence telemetry it should
  // budget against, and there's nothing to budget for. See
  // docs/kb/architecture/ai-first-consumer.md "Reason text and
  // severity must agree."
  if (crossFileCapable === false && crossFileCandidates > 0) {
    return {
      ruleId,
      filesEvaluated: evaluated,
      filesEligible: eligible,
      findingsEmitted,
      fired: findingsEmitted > 0,
      coverageConfidence: "medium",
      // The `crossFileCandidates > 0` gate confirms the rule observed
      // at least one candidate token whose resolution would require
      // cross-file lookup — but `crossFileCapable: false` declares the
      // rule's design does not attempt that lookup at all. The
      // `_not_attempted_by_rule` suffix names the permanent rule-design
      // limitation honestly, instead of the earlier `_on_this_input`
      // framing that read as "we tried this input and were limited"
      // (and could mislead an agent into a fruitless re-scan).
      reason: crossFileBoundReason(ruleId),
      ...concentrationSpread,
      ...classPatternSpread,
    };
  }
  return {
    ruleId,
    filesEvaluated: evaluated,
    filesEligible: eligible,
    findingsEmitted,
    fired: findingsEmitted > 0,
    coverageConfidence: "high",
    ...concentrationSpread,
    ...classPatternSpread,
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
 * project-scoped rules. The
 * concentration hint still applies when a project-scoped rule's
 * findings cluster on one file, so it spreads in on both branches.
 */
function buildProjectScopedEntry(
  ruleId: string,
  filesScanned: number,
  findingsEmitted: number,
  concentration: { file: string; count: number } | undefined,
  classPatternConcentration:
    | readonly { file: string; count: number; classPattern: string; samples: readonly string[] }[]
    | undefined,
  crossFileCapable: boolean | undefined,
): PerRuleCoverage {
  const concentrationSpread = concentration ? { concentration } : {};
  const classPatternSpread =
    classPatternConcentration && classPatternConcentration.length > 0
      ? { classPatternConcentration }
      : {};
  // `fired` is `findingsEmitted > 0` at every construction branch — see
  // the field doc on `PerRuleCoverage`. Inlined per-return so the
  // derivation lives on the same literal as `findingsEmitted` itself.
  if (filesScanned === 0) {
    return {
      ruleId,
      filesEvaluated: 0,
      filesEligible: 0,
      findingsEmitted,
      fired: findingsEmitted > 0,
      coverageConfidence: "low",
      reason: "no files were scanned; project-scoped rule had nothing to evaluate",
      remediation:
        "check the scan root and include patterns — the project matched zero parseable files",
      ...concentrationSpread,
      ...classPatternSpread,
    };
  }
  // Cross-file downgrade — see the counterpart in
  // `buildExtensionGatedEntry`. Project-scoped rules are almost always
  // `crossFileCapable: true` (walking every file's AST in one shot is
  // the whole point of `afterProject`), but the path exists so a
  // project-scoped rule that authors its own cross-file gate
  // incorrectly — or that inherits from a per-file predecessor —
  // still honors the downgrade. When unset or `true`, confidence
  // stays `"high"`. The candidate-token gate the extension-gated
  // branch carries does NOT apply here: project-scoped rules walk the
  // whole file set in `afterProject`, so the question of "did the
  // rule observe a candidate token" is collapsed at the file-set
  // level, not per-file. The lone in-tree case is `contrast/minimum`
  // resolving `:root { --name }` same-file only — the substrate-level
  // bound is structural, not predicate-strength dependent.
  if (crossFileCapable === false) {
    return {
      ruleId,
      filesEvaluated: filesScanned,
      filesEligible: filesScanned,
      findingsEmitted,
      fired: findingsEmitted > 0,
      coverageConfidence: "medium",
      // Project-scoped rules with `crossFileCapable: false` describe a
      // structural rule-design limitation — the rule's whole design is
      // bounded to a single substrate. The `_not_attempted_by_rule`
      // suffix names that fact, the same way it does in the
      // extension-gated branch — both emission contexts collapse to the
      // same honest framing because both describe a rule whose design
      // never attempts cross-file resolution.
      reason: crossFileBoundReason(ruleId),
      ...concentrationSpread,
      ...classPatternSpread,
    };
  }
  return {
    ruleId,
    filesEvaluated: filesScanned,
    filesEligible: filesScanned,
    findingsEmitted,
    fired: findingsEmitted > 0,
    coverageConfidence: "high",
    ...concentrationSpread,
    ...classPatternSpread,
  };
}

/**
 * Assembles one {@link PerRuleCoverage} record for a rule that the
 * level filter excluded before any per-file evaluation could happen.
 * The row carries `findingsEmitted: 0`, `filesEvaluated: 0`,
 * `filesEligible: 0`, and `coverageConfidence: "low"`; the orthogonal
 * `skipReason: "gated_by_level"` discriminator (plus
 * `requiredLevel` / `requestedLevel`) tells the agent exactly what
 * unlocks the rule. The `reason`
 * field carries human prose for parity with low-confidence rows.
 *
 * `coverageConfidence: "low"` is the honest classifier here — the
 * tally IS zero across the board, and the agent SHOULD NOT trust that
 * as evidence the rule's pattern is absent from the codebase.
 * `skipReason` answers the question `coverageConfidence` cannot:
 * "the row reads zero because the rule never ran, not because it
 * ran cleanly." The two fields name orthogonal axes; both must be
 * present for the row to be honest.
 */
function buildLevelGatedEntry(
  ruleId: string,
  gate: { requiredLevel: "A" | "AA" | "AAA"; requestedLevel: "A" | "AA" | "AAA" },
): PerRuleCoverage {
  return {
    ruleId,
    filesEvaluated: 0,
    filesEligible: 0,
    findingsEmitted: 0,
    // `fired === false` is structurally guaranteed for level-gated rows
    // — the engine never invoked the rule, so it cannot have emitted
    // findings. Spelled out alongside the explicit zeros above so the
    // wire shape stays consistent across every construction branch.
    fired: false,
    coverageConfidence: "low",
    reason: `gated_by_level: rule requires level ${gate.requiredLevel}; scan requested level ${gate.requestedLevel}`,
    remediation: `re-run with \`level: '${gate.requiredLevel}'\` to evaluate this rule`,
    skipReason: "gated_by_level",
    requiredLevel: gate.requiredLevel,
    requestedLevel: gate.requestedLevel,
  };
}

/**
 * Resolves the structured reason code for a `crossFileCapable: false`
 * rule whose coverage downgraded from `"high"` to `"medium"`. Looks up
 * the rule ID in the per-family mapping; falls back to the generic
 * `cross_file_evidence_bounded_not_attempted_by_rule` code for rules
 * that opted in but aren't in the per-family mapping yet.
 *
 * Both emission contexts (extension-gated branch with
 * `crossFileCandidates > 0`, project-scoped branch with no per-input
 * signal) route through this single helper because both describe the
 * same fact: the rule's design declares it does not attempt cross-file
 * resolution. The `_not_attempted_by_rule` suffix names that honestly
 * regardless of how the downgrade was gated — see
 * docs/kb/architecture/ai-first-consumer.md "Heuristic-mislabeled meta
 * sub-fields are dishonest" for the framing rationale (the earlier
 * `_on_this_input` / `_inherent_to_rule` split read as a per-input
 * verdict in the first variant; both branches collapse here because
 * both describe a permanent rule-design limitation).
 *
 * The fallback is an honest default, not a suppression — the agent
 * still sees the downgrade and re-reads the rule's docs. Rule authors
 * adding `crossFileCapable: false` should also add the per-family
 * code here so the downstream triage signal stays sharp.
 */
function crossFileBoundReason(ruleId: string): string {
  return CROSS_FILE_BOUND_REASONS[ruleId] ?? CROSS_FILE_BOUND_REASON_FALLBACK;
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
  if (head === ".less") return "Less";
  if (head === ".html" || head === ".htm") return "HTML";
  if (head === ".erb") return "ERB";
  if (head === ".mdx") return "MDX";
  if (head === ".astro") return "Astro";
  if (head === ".tsx" || head === ".jsx" || head === ".ts" || head === ".js") {
    return "JSX/TSX";
  }
  return extensions.join(", ");
}

// ---------------------------------------------------------------------------
// Class-pattern concentration (per-rule, per-file, per-class-pattern rollup)
// ---------------------------------------------------------------------------

/** Shape of one cluster entry on {@link PerRuleCoverage.classPatternConcentration}. */
type ClassPatternCluster = {
  readonly file: string;
  readonly count: number;
  readonly classPattern: string;
  readonly samples: readonly string[];
};

/**
 * Rolls up per-file-per-class-pattern clusters for rules listed in
 * {@link CLASS_PATTERN_RULES}. One linear pass over the violation stream
 * keyed on `(ruleId, filePath, classPattern)` — the canonical acute
 * case is `aria/icon-font-hidden` firing dozens of times across sibling
 * buttons in one file, all sharing the same `fa fa-*` idiom. The hint
 * names that cluster so a single file read triages many candidates
 * instead of N.
 *
 * Returns a map keyed by rule ID. A rule whose clusters all fall below
 * the {@link CLASS_PATTERN_MIN_COUNT} / {@link CLASS_PATTERN_MIN_SHARE}
 * thresholds ends up with an empty array in the map, which the caller
 * treats as "no concentration" (conditional spread at the assembly
 * site omits the field entirely). Rules not in
 * {@link CLASS_PATTERN_RULES} never enter this map — they pay zero
 * cost for the rollup.
 *
 * Zero information loss — every finding stays in `files[].findings`;
 * this is additive scan-confidence telemetry pointing at the densest
 * (file, pattern) home.
 */
function classPatternConcentrationByRule(
  violations: readonly Violation[],
): ReadonlyMap<string, readonly ClassPatternCluster[]> {
  const perRuleFile = collectClassPatternTallies(violations);
  const out = new Map<string, readonly ClassPatternCluster[]>();
  for (const [ruleId, byFile] of perRuleFile.entries()) {
    const clusters = selectClassPatternClusters(byFile);
    out.set(ruleId, clusters);
  }
  return out;
}

/**
 * Per-class-pattern tally for one file: total count, samples seen so
 * far (capped at {@link CLASS_PATTERN_MAX_SAMPLES} unique values, in
 * insertion order — the first N distinct classEvidence values a file
 * contributes survive). The `samplesSet` side-table keeps the inner
 * sample-add check O(1) without re-scanning the array.
 */
type PatternTally = {
  count: number;
  readonly samplesSet: Set<string>;
  readonly samples: string[];
};

/**
 * Tallies per `(ruleId, filePath, classPattern)` in one linear pass.
 * Only runs for rules in {@link CLASS_PATTERN_RULES} — other rules are
 * skipped before the inner maps are touched. Violations without
 * `classEvidence` are skipped (honest — no evidence, no cluster
 * membership; the finding still ships in `files[].findings`).
 */
function collectClassPatternTallies(
  violations: readonly Violation[],
): Map<string, Map<string, Map<string, PatternTally>>> {
  const perRuleFile = new Map<string, Map<string, Map<string, PatternTally>>>();
  for (const v of violations) {
    if (!CLASS_PATTERN_RULES.has(v.ruleId)) continue;
    const evidence = v.classEvidence;
    if (typeof evidence !== "string" || evidence.length === 0) continue;
    const pattern = deriveClassPattern(evidence);
    if (pattern === null) continue;
    bumpPatternTally(perRuleFile, v.ruleId, v.location.filePath, pattern, evidence);
  }
  return perRuleFile;
}

/**
 * Adds one (rule, file, pattern, evidence) observation to the tally
 * tree. Extracted from the violation loop to keep the caller's
 * cognitive complexity under Biome's `noExcessiveCognitiveComplexity`
 * ceiling — four nested map lookups + sample-dedup is its own concern.
 */
function bumpPatternTally(
  perRuleFile: Map<string, Map<string, Map<string, PatternTally>>>,
  ruleId: string,
  filePath: string,
  pattern: string,
  evidence: string,
): void {
  let byFile = perRuleFile.get(ruleId);
  if (!byFile) {
    byFile = new Map();
    perRuleFile.set(ruleId, byFile);
  }
  let byPattern = byFile.get(filePath);
  if (!byPattern) {
    byPattern = new Map();
    byFile.set(filePath, byPattern);
  }
  let tally = byPattern.get(pattern);
  if (!tally) {
    tally = { count: 0, samplesSet: new Set(), samples: [] };
    byPattern.set(pattern, tally);
  }
  tally.count += 1;
  if (tally.samples.length < CLASS_PATTERN_MAX_SAMPLES && !tally.samplesSet.has(evidence)) {
    tally.samplesSet.add(evidence);
    tally.samples.push(evidence);
  }
}

/**
 * Given one rule's per-file-per-pattern tally, returns every cluster
 * that clears both thresholds. Sorted by count descending, then by
 * `(file, classPattern)` ascending for deterministic cross-run output
 * — the share-sort is meaningful (the agent wants the densest cluster
 * first), the tie-break is stability-only.
 */
function selectClassPatternClusters(
  byFile: ReadonlyMap<string, ReadonlyMap<string, PatternTally>>,
): readonly ClassPatternCluster[] {
  const clusters: ClassPatternCluster[] = [];
  for (const [file, byPattern] of byFile.entries()) {
    const total = totalFindingsOnFile(byPattern);
    for (const [classPattern, tally] of byPattern.entries()) {
      if (tally.count < CLASS_PATTERN_MIN_COUNT) continue;
      const share = tally.count / total;
      if (share < CLASS_PATTERN_MIN_SHARE) continue;
      clusters.push({
        file,
        count: tally.count,
        classPattern,
        samples: [...tally.samples].sort(),
      });
    }
  }
  clusters.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.classPattern < b.classPattern ? -1 : 1;
  });
  return clusters;
}

/**
 * Sum of all class-pattern tallies on one file. Fuels the share
 * computation — "this pattern is N of M findings on this file." Only
 * counts findings with non-null `classEvidence` (findings without
 * evidence never enter the tally tree, so they're implicitly excluded
 * from the denominator too — consistent: the share names "dominance
 * among evidenced clusters," not "dominance among all findings").
 */
function totalFindingsOnFile(byPattern: ReadonlyMap<string, PatternTally>): number {
  let total = 0;
  for (const tally of byPattern.values()) total += tally.count;
  return total;
}

/**
 * Derives the canonical class pattern for a given `class` attribute
 * value. Splits on whitespace, matches each token against the known
 * icon-font family markers + glyph-slug prefixes, and reassembles a
 * stable canonical form the rollup keys on.
 *
 * Return values are rule-family aware:
 *   - Font Awesome tokens (`fa`, `fas`, `fa-*`) → `"<style> fa-*"`
 *     where `<style>` is the first style token seen (`fa`, `fas`,
 *     `far`, `fab`, …) so an author who mixes `fas` and `far` across
 *     buttons still collapses to two clusters (one per style), not
 *     dozens keyed on glyph names. Bare `fa` with no glyph → `"fa"`.
 *   - Material Icons (`material-icons`, `material-symbols-*`) → the
 *     raw base class (`material-icons`, `material-symbols-rounded`, …)
 *     — each family is its own cluster.
 *   - Bootstrap Icons → `"bi bi-*"` when both base and glyph are
 *     present, else the base (`"bi"`).
 *   - Glyphicons / Icofont / bare `ionicon` token → mirror the same
 *     shape.
 *
 * Returns `null` when no recognized icon-font token is present —
 * defensive: the rule's gate should mean `classEvidence` always
 * contains at least one icon-font token, but class attributes can
 * drift (e.g. a rename mid-flight) and null-on-unrecognized is safer
 * than invented pattern text.
 */
function deriveClassPattern(classValue: string): string | null {
  const tokens = classValue.split(/\s+/u).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const lower = tokens.map((t) => t.toLowerCase());
  return (
    matchFaPattern(lower) ??
    matchMaterialPattern(lower) ??
    matchBasePlusGlyphPattern(lower, "bi") ??
    matchBasePlusGlyphPattern(lower, "glyphicon") ??
    matchBasePlusGlyphPattern(lower, "icofont") ??
    (lower.includes("ionicon") ? "ionicon" : null)
  );
}

/**
 * Font Awesome pattern: the style token (`fa`, `fas`, `far`, …) is
 * load-bearing so an author mixing `fas` and `far` across buttons
 * collapses to two clusters, not dozens keyed on glyph names. Returns
 * `"<style> fa-*"` when both style + glyph are present, else the
 * style token alone, else `"fa-*"` when only a glyph is present.
 * Null when neither is present.
 */
function matchFaPattern(lower: readonly string[]): string | null {
  const faStyle = lower.find((t) => FA_STYLE_PATTERN_TOKENS.has(t));
  const hasFaGlyph = lower.some((t) => t.startsWith("fa-"));
  if (faStyle !== undefined && hasFaGlyph) return `${faStyle} fa-*`;
  if (faStyle !== undefined) return faStyle;
  if (hasFaGlyph) return "fa-*";
  return null;
}

/**
 * Material Icons + Material Symbols pattern — each family is its own
 * cluster. Base class tokens (`material-icons`, `material-icons-round`,
 * …) win over a generic slug prefix so authors mixing families don't
 * collapse into one bucket.
 */
function matchMaterialPattern(lower: readonly string[]): string | null {
  const material = lower.find((t) => MATERIAL_EXACT_PATTERN_TOKENS.has(t));
  if (material !== undefined) return material;
  const materialSymbols = lower.find((t) => t.startsWith("material-symbols-"));
  return materialSymbols ?? null;
}

/**
 * Generic "base class + glyph slug" pattern shared by Bootstrap Icons,
 * Glyphicons, and Icofont. Returns `"<base> <base>-*"` when both are
 * present, `"<base>-*"` when only the glyph is present. Extracted so
 * adding a new family is one call line in `deriveClassPattern`, not
 * another triplet of local variables.
 */
function matchBasePlusGlyphPattern(lower: readonly string[], base: string): string | null {
  const prefix = `${base}-`;
  const hasBase = lower.includes(base);
  const hasGlyph = lower.some((t) => t.startsWith(prefix));
  if (hasBase && hasGlyph) return `${base} ${prefix}*`;
  if (hasGlyph) return `${prefix}*`;
  return null;
}

/**
 * Font Awesome style tokens (v4/v5/v6 weights + pro variants). Mirrors
 * the set in `src/rules/aria/icon-font-hidden.ts` — duplicated here
 * because the aggregation module must not import from rules (engine
 * invariant: engine never imports from rules/standards). Kept in sync
 * manually; the list is stable (the FA style vocabulary hasn't
 * grown since v6).
 */
const FA_STYLE_PATTERN_TOKENS: ReadonlySet<string> = new Set([
  "fa",
  "fas",
  "far",
  "fab",
  "fal",
  "fad",
  "fat",
  "fass",
]);

/**
 * Material Icons base class tokens. Duplicated from the rule for the
 * same engine-invariant reason as {@link FA_STYLE_PATTERN_TOKENS}.
 */
const MATERIAL_EXACT_PATTERN_TOKENS: ReadonlySet<string> = new Set([
  "material-icons",
  "material-icons-outlined",
  "material-icons-round",
  "material-icons-rounded",
  "material-icons-sharp",
  "material-icons-two-tone",
]);

// ---------------------------------------------------------------------------
// Boilerplate-collapse partition
// ---------------------------------------------------------------------------

/**
 * Aggregate descriptor surfaced as `meta.rulesNotEvaluatedDueToInputType`
 * on the MCP wire. Rolls up extension-gated rules whose inputs the scan
 * never saw — `filesEvaluated === 0` AND `filesEligible === 0` — into a
 * single counter keyed by the rule's first eligible extension. The agent
 * reads `byExtension` once and decides whether to widen scope (e.g.
 * pass `additionalPaths: ["dist/assets"]` when the project ships built
 * CSS) instead of paging through ~30 boilerplate per-rule rows that
 * each carry the same "no files matching .css were scanned" remediation.
 *
 * Doctrine balance — verbose meta is signal, but boilerplate repeated
 * across rules with zero eligible inputs is not telemetry, it's noise
 * (the canonical 347KB single-subdir scan response had ~30 of ~70
 * `perRuleCoverage` entries fitting this shape, each ~200 chars). The
 * collapsed counter preserves the actionable signal (which extensions
 * the scan failed to see) without the per-rule repetition. Level-gated
 * rows (`skipReason: "gated_by_level"` from
 *) are NEVER folded in — they are an
 * orthogonal axis the agent can act on directly (re-run with
 * `level: 'AAA'`), and collapsing them would hide the exact remediation
 * a per-rule row carries.
 *
 * `count` is `0`, `byExtension` is `{}`, and `ruleIds` is `[]` when
 * nothing collapses — always-present so the agent has a deterministic
 * field to read instead of disambiguating "absent" from "zero"
 * (CLAUDE.md §1 "Ambiguous field shapes are dishonest" inverted at the
 * field-presence level: a scan-confidence telemetry field stays present
 * even at zero so the agent can branch on it without re-checking).
 *
 * `ruleIds` lists every rule rolled up into the counter, sorted in
 * codepoint order for determinism. Without this field, an agent reading
 * `meta.perRuleCoverage[]` cannot distinguish "rule did not load" from
 * "rule loaded but had zero eligible inputs and was rolled up" — the
 * collapsed rules vanish from the per-rule array, and the headline
 * `byExtension` counter only carries the extension key. The `ruleIds`
 * sibling makes the rolled-up identity visible so an agent can verify
 * whether a specific rule (e.g. `navigation/link-target-blank-announcement`)
 * was loaded and short-circuited on input-type, vs. simply never
 * registered.
 */
export interface RulesNotEvaluatedDueToInputType {
  readonly count: number;
  readonly byExtension: Readonly<Record<string, number>>;
  readonly ruleIds: readonly string[];
}

/**
 * Result of partitioning a `perRuleCoverage` array into the rows the MCP
 * wire surfaces verbatim and the rolled-up counter for the boilerplate
 * tail. Returned by {@link partitionPerRuleCoverage}; consumed at meta-
 * assembly time so the engine output stays full (other consumers —
 * `buildRuleCoverageDerivative`, `buildRulesEvaluated`,
 * `testable-criteria` — still see every row).
 */
export interface PerRuleCoveragePartition {
  readonly retained: readonly PerRuleCoverage[];
  readonly notEvaluatedDueToInputType: RulesNotEvaluatedDueToInputType;
}

/**
 * Splits a `perRuleCoverage` array into:
 *   - `retained`: rows the MCP `meta.perRuleCoverage` surface keeps
 *     verbatim — every row with at least one eligible file (`filesEligible
 *     > 0`), every level-gated row (`skipReason: "gated_by_level"`,
 * surfaced for), every
 *     project-scoped row (no `appliesTo.fileExtensions` — the
 *     `filesScanned === 0` zero-file case carries `"no files were
 *     scanned"` remediation that names a different gap than "wrong input
 *     type"), and every row whose rule isn't in the lookup map (defensive
 *     — collapsing on absent metadata would hide signal).
 *   - `notEvaluatedDueToInputType`: a single rolled-up counter
 *     `{ count, byExtension }` for the extension-gated tail where
 *     `filesEvaluated === 0 && filesEligible === 0`. Each rule
 *     contributes `+1` to `byExtension[<first extension in its
 *     appliesTo.fileExtensions set>]` — the heuristic the dispatch named
 *     so an HTML-only scan over a Tailwind project sees
 *     `{ ".css": 12, ".tsx": 8, … }` and routes to one read instead of N.
 *
 * `count` and `byExtension` are always present (zero / empty when no
 * rows collapse) so the agent has a deterministic field to read on every
 * scan shape — see {@link RulesNotEvaluatedDueToInputType} for the
 * presence-on-zero rationale.
 *
 * Pure over its inputs; returns the same `retained` array reference when
 * nothing collapses so downstream identity checks (e.g. vendor-
 * concentration enrichment's `if (enriched === rows) return meta`) keep
 * working without an unconditional rebuild.
 */
export function partitionPerRuleCoverage(
  rows: readonly PerRuleCoverage[],
  rules: readonly Rule[],
): PerRuleCoveragePartition {
  const ruleById = new Map<string, Rule>();
  for (const r of rules) ruleById.set(r.id, r);
  const retained: PerRuleCoverage[] = [];
  const byExtension: Record<string, number> = {};
  const collapsedRuleIds: string[] = [];
  let count = 0;
  let collapsedAny = false;
  for (const row of rows) {
    const rule = ruleById.get(row.ruleId);
    const extensions = rule?.appliesTo?.fileExtensions;
    const isExtensionGated = extensions !== undefined && extensions.length > 0;
    const isEmptyEligible = row.filesEvaluated === 0 && row.filesEligible === 0;
    const isLevelGated = row.skipReason === "gated_by_level";
    if (isExtensionGated && isEmptyEligible && !isLevelGated) {
      const head = extensions[0];
      if (head !== undefined) {
        byExtension[head] = (byExtension[head] ?? 0) + 1;
        collapsedRuleIds.push(row.ruleId);
        count += 1;
        collapsedAny = true;
        continue;
      }
    }
    retained.push(row);
  }
  // Sort the rolled-up rule IDs in codepoint order so the wire shape is
  // deterministic across runs — agents diffing scan responses across
  // sessions cannot distinguish a real registry change from accidental
  // ordering drift.
  collapsedRuleIds.sort();
  return {
    retained: collapsedAny ? retained : rows,
    notEvaluatedDueToInputType: { count, byExtension, ruleIds: collapsedRuleIds },
  };
}

// ---------------------------------------------------------------------------
// Single-file scope filter (scan_file)
// ---------------------------------------------------------------------------

/**
 * Result of {@link filterPerRuleCoverageForSingleFile}: the rows that
 * could plausibly apply to the scanned file's extension, plus a count
 * of the rows whose extension gate excluded them outright.
 */
export interface PerRuleCoverageSingleFileFilter {
  readonly retained: readonly PerRuleCoverage[];
  readonly skippedExtensionMismatch: number;
}

/**
 * Filters `perRuleCoverage` rows to only those whose owning rule could
 * plausibly apply to the scanned file's extension. The companion to
 * {@link partitionPerRuleCoverage}, scoped specifically to the
 * single-file `scan_file` surface.
 *
 * Why this exists alongside the partition: `partitionPerRuleCoverage`
 * is reactive — it inspects each row's `filesEvaluated` /
 * `filesEligible` tally and collapses the zero-eligibility tail. That
 * works on multi-file scans where the tally honestly reflects each
 * rule's eligibility against the scanned set. On `scan_file` the input
 * is one file, so the question "could this rule apply at all?" is
 * answerable from the rule's static `appliesTo.fileExtensions`
 * metadata directly — no need to wait for the runner's tracker output.
 *
 * Doctrine balance per `docs/kb/architecture/ai-first-consumer.md`:
 * "Verbose meta is signal" cuts both ways. A row reporting
 * `coverageConfidence: "low"` because the rule's CSS extension gate
 * never matched a `.tsx` file is informational noise — the rule
 * produced no signal AT ALL on this file, by definition. Reporting it
 * with a "no files matching .css were scanned" reason inflates the
 * `perRuleCoverage` array (~half the rows on a single-file scan of
 * any one extension) without telling the agent anything actionable
 * the simpler `rulesSkippedExtensionMismatch: N` counter doesn't
 * already carry. This is the surface-don't-suppress rule's symmetric
 * opposite: surfacing rows the rule never even looked at would
 * mis-budget agent attention against scan-confidence telemetry that
 * was structurally inapplicable.
 *
 * Behavior:
 *   - Extension-gated rules (`appliesTo.fileExtensions !== undefined`)
 *     whose gate does not match `fileExtension` (via
 *     {@link extensionMatches}, which honors the alias table —
 *     `.scss → .css`, `.md → .html`, etc.) are dropped from
 *     `retained` and counted in `skippedExtensionMismatch`.
 *   - Project-scoped rules (no `appliesTo.fileExtensions`, lifecycle
 *     is `afterProject` only) are retained unchanged — they walk the
 *     full file set in one shot and the substrate-level question
 *     "did the file match an extension gate?" doesn't apply.
 *   - Rows whose owning rule isn't in the lookup map are retained
 *     verbatim (defensive — silently dropping an unknown row would
 *     hide signal).
 *
 * Pure over its inputs.
 */
export function filterPerRuleCoverageForSingleFile(
  rows: readonly PerRuleCoverage[],
  rules: readonly Rule[],
  fileExtension: string,
): PerRuleCoverageSingleFileFilter {
  const ruleById = new Map<string, Rule>();
  for (const r of rules) ruleById.set(r.id, r);
  const retained: PerRuleCoverage[] = [];
  let skippedExtensionMismatch = 0;
  for (const row of rows) {
    const rule = ruleById.get(row.ruleId);
    const extensions = rule?.appliesTo?.fileExtensions;
    if (extensions !== undefined && extensions.length > 0) {
      if (!extensionMatches(fileExtension, extensions)) {
        skippedExtensionMismatch += 1;
        continue;
      }
    }
    retained.push(row);
  }
  return { retained, skippedExtensionMismatch };
}
