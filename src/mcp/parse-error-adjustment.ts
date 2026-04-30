/**
 * Per-rule-coverage parse-error adjuster — extracted from
 * `scan-assembly.ts` so the orchestrator stays under the file-size
 * budget and the per-file-not-corpus-wide degradation rules
 * (Q9 doctrine: "Parser-failure invalidates per-file confidence")
 * live next to the shape they describe.
 *
 * Doctrine source: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Parser-failure invalidates per-file confidence"
 *   - "Per-finding confidence must reflect per-rule coverage limitations"
 *
 * Two exports drive the adjustment + downstream parity:
 *
 *   - {@link applyParseErrorAdjustment} — walks the per-rule coverage
 *     rows produced by the engine and adjusts each row's
 *     `filesEvaluated`, `byFile`, and (when the rule has no clean
 *     evidence to fold from) the aggregate `coverageConfidence` /
 *     `coverageConfidenceReason`.
 *   - {@link partitionParseStateFiles} — partitions parsed files into
 *     `parseError` / `partialParse` sets. Consumed by the per-finding
 *     parity helper to gate the file-scoped substrate codes
 *     (`file_parse_error`, `partial_parse`) on file-path membership.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import { isScssPartialSource } from "../input/parsers/scss-internals.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
import { isBuildArtifact } from "./build-artifacts.ts";

/**
 * Minimum cleanly-evaluated file count the per-row aggregator requires
 * before keeping `coverageConfidence: "high"` when at least one of the
 * rule's eligible files is in the parse-error / partial-parse buckets.
 * Mirrors the engine's `MIN_FILES_FOR_HIGH_CONFIDENCE` floor (1) — at
 * the floor a single cleanly-parsed file is enough to vouch for the
 * rule on this scan. Per the AI-first doctrine "Parser-failure
 * invalidates per-file confidence," the per-file degradation rides on
 * the new `byFile` channel below; the aggregate scalar folds from
 * those per-file entries rather than blanket-degrading on any single
 * parse-error file.
 */
const MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH = 1;

/**
 * Adjusts {@link PerRuleCoverage} rows so files that failed to parse
 * are honest about whether the rule actually evaluated their content.
 *
 * The engine's evaluation tracker bumps `eligible` and `evaluated` per
 * (rule, file) pair purely on extension match — a file in
 * `parseErrorFiles` (parser totally failed, AST is empty) still
 * contributes the same +1 as a clean-parsing file, even though the
 * rule never saw the content. Without correction, an extension-gated
 * rule whose only matching files all failed to parse surfaces as
 * `findingsEmitted: 0, coverageConfidence: "high"` — the canonical
 * silent-miss the doctrine "zero-output success is ambiguous failure"
 * names at per-rule granularity.
 *
 * Two parallel adjustments fire (Q9 doctrine: per-rule per-file, NOT
 * corpus-wide):
 *
 *   - **Per-file degradation** rides on the new
 *     {@link PerRuleCoverage.byFile} list. One entry per file in the
 *     parse-error / partial-parse intersection with the rule's gate,
 *     each carrying its own `confidence` + structured `reason`. Files
 *     outside those sets are NOT enumerated (their per-file confidence
 *     equals the aggregate); only the degraded subset rides.
 *   - **Aggregate fold** stays `"high"` when the rule has at least
 *     {@link MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH} cleanly-evaluated
 *     files outside the degraded set. Otherwise (the rule's only
 *     eligible files all ended up in parse-error / partial-parse) the
 *     aggregate drops to `"low"` with the file-scoped reason — matching
 *     the pre-Q9 behavior on the fully-degraded edge case.
 *
 * Project-scoped rules use `filesScanned` as their evaluated count;
 * the same adjustment applies for parse-error files since a project
 * rule running over an empty AST cannot detect anything in that file
 * either.
 *
 * No-op fast path: when no parse-error / partial-parse files matched
 * any rule's gate, the function returns the input array unchanged so
 * the common case stays cheap. Exported so the wiring layer (which
 * also passes `perRuleCoverage` to `buildRuleCoverageDerivative`)
 * can adjust the rows once and feed both consumers, avoiding cross-
 * surface drift between `meta.perRuleCoverage` and the top-level
 * `ruleCoverage` headline.
 */
export function applyParseErrorAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  findingFilePaths: ReadonlySet<string> | undefined,
): readonly PerRuleCoverage[] {
  const partition = partitionParseStateFiles(files, findingFilePaths);
  if (partition.parseError.size === 0 && partition.partialParse.size === 0) return rows;
  // Re-bind to ParsedFile arrays for the per-row matcher, which gates
  // on `appliesTo.fileExtensions`.
  const parseErrorFiles = files.filter((f) => partition.parseError.has(f.filePath));
  const partialParseFiles = files.filter((f) => partition.partialParse.has(f.filePath));
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  return rows.map((row) =>
    adjustRowForParseErrors(row, ruleById.get(row.ruleId), parseErrorFiles, partialParseFiles),
  );
}

/**
 * Partitions the scan's parsed files into the two parse-state buckets
 * the per-rule confidence adjuster and the per-finding propagation
 * helper both need:
 *
 *   - `parseError` — files where the parser errored AND no rule / finder
 *     emitted any output. These contribute to the `file-parse-error`
 *     reason on the per-rule coverage row.
 *   - `partialParse` — files where the parser errored AND at least one
 *     rule / finder emitted output (the recovered AST was usable).
 *     These contribute to the `partial-parse` reason.
 *
 * Build-artifact files are excluded from both buckets — their phantom
 * parse errors are suppressed from `meta.analysisCoverage.parseErrorFiles[]`
 * elsewhere, so any per-rule / per-finding confidence downgrade keyed
 * off the same predicate must agree.
 *
 * Exported so the per-finding propagation helper can gate
 * `file_parse_error` / `partial_parse` codes on file membership: a
 * substrate code attached to a finding whose file is NOT in either
 * bucket reads as "the file's parser failed" when the finding's file
 * actually parsed cleanly — the silent-miss failure mode the doctrine
 * "Per-finding confidence must reflect per-rule coverage limitations"
 * names at the per-finding layer.
 */
export function partitionParseStateFiles(
  files: readonly ParsedFile[],
  findingFilePaths: ReadonlySet<string> | undefined,
): { readonly parseError: ReadonlySet<string>; readonly partialParse: ReadonlySet<string> } {
  const parseError = new Set<string>();
  const partialParse = new Set<string>();
  for (const f of files) {
    if (f.ast.errors.length === 0) continue;
    if (isBuildArtifact(f.filePath, f.source)) continue;
    // SCSS partials (Q10): a `_*.scss` file declaring top-level `&`
    // parent-references is intentionally a fragment of another file,
    // not a hard parse error. The dangling-`&` verdict is correct in
    // isolation but mislabels authorial intent — and the lookahead
    // routes the per-rule confidence downgrade through
    // `applyScssPartialInputAdjustment` rather than through this
    // partition. Excluding here keeps the file out of `parseErrorFiles`
    // / `partialParseFiles` (so the agent doesn't read "fix the parse
    // error" framing) while preserving the substrate-level signal on
    // the per-rule layer.
    if (isScssPartialSource(f.filePath, f.source)) continue;
    if (findingFilePaths?.has(f.filePath)) partialParse.add(f.filePath);
    else parseError.add(f.filePath);
  }
  return { parseError, partialParse };
}

/**
 * Per-row adjustment helper for {@link applyParseErrorAdjustment}.
 * Returns the input row unchanged when neither parse-error nor
 * partial-parse files matched the rule's gate; otherwise returns a
 * fresh row with `filesEvaluated`, `byFile`, and (when the rule's
 * cleanly-evaluated count is below {@link MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH})
 * the aggregate `coverageConfidence` / `coverageConfidenceReason`
 * updated. The original row's optional fields (`concentration`,
 * `classPatternConcentration`, etc.) survive via the spread so the
 * adjustment never strips additive telemetry.
 *
 * Cross-surface contract: when the aggregate stays `"high"` but
 * `byFile` is non-empty, the per-finding propagation helper
 * (`src/mcp/per-finding-confidence-parity.ts`) still attaches the
 * file-scoped substrate code to findings whose path appears in
 * `byFile` — see its `buildPerRuleLimitationMap` for the seam.
 */
function adjustRowForParseErrors(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  parseErrorFiles: readonly ParsedFile[],
  partialParseFiles: readonly ParsedFile[],
): PerRuleCoverage {
  // Level-gated rows were never evaluated against any file (the
  // standard filter excluded the rule before per-file dispatch), so
  // stamping `coverageConfidenceReason: "partial-parse"` on a
  // gated row would lie about why its `filesEvaluated` is zero —
  // the cause is level gating, not parse error. Pass through
  // unchanged.
  if (row.skipReason === "gated_by_level") return row;
  const parseErrorMatches = selectMatchingFiles(rule, parseErrorFiles);
  const partialParseMatches = selectMatchingFiles(rule, partialParseFiles);
  if (parseErrorMatches.length === 0 && partialParseMatches.length === 0) return row;
  // Subtract parse-error matches from `filesEvaluated`. Floor at 0 so
  // an off-by-one in match counting never produces a negative count
  // on the wire — defensive for callers that pre-trim rows.
  const adjustedEvaluated = Math.max(0, row.filesEvaluated - parseErrorMatches.length);
  // Build per-file degradation list — sorted by path for deterministic
  // wire output. Parse-error files claim `reason: "file-parse-error"`;
  // partial-parse files claim `reason: "partial-parse"`. Both ride at
  // `confidence: "low"` (matching the pre-Q9 aggregate behavior on the
  // file-scoped axis — what changes is the SCOPE of the degradation,
  // not the strength).
  const byFile: {
    path: string;
    confidence: "low";
    reason: "file-parse-error" | "partial-parse";
  }[] = [];
  for (const f of parseErrorMatches) {
    byFile.push({ path: f.filePath, confidence: "low", reason: "file-parse-error" });
  }
  for (const f of partialParseMatches) {
    byFile.push({ path: f.filePath, confidence: "low", reason: "partial-parse" });
  }
  byFile.sort((a, b) => a.path.localeCompare(b.path));
  // Aggregate fold: stay `"high"` when the rule has at least
  // {@link MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH} cleanly-evaluated files.
  // Partial-parse files are counted as cleanly-evaluated for the fold
  // (the rule DID run on the recovered AST and emitted findings — see
  // `partitionParseStateFiles`), but they still ride in `byFile` so
  // an agent reading the per-file detail sees the partial-parse caveat
  // on its specific files. Parse-error files are subtracted from
  // `filesEvaluated` above, so `adjustedEvaluated` is the post-
  // subtraction clean-plus-partial count.
  const cleanEvaluated = adjustedEvaluated;
  if (cleanEvaluated >= MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH && row.coverageConfidence === "high") {
    // Aggregate stays high; per-file detail names the bounded files.
    // No aggregate `coverageConfidenceReason` — the rule has clean
    // evidence horizon at the corpus level. Per-finding parity helper
    // attaches the file-scoped substrate code to findings on `byFile`
    // paths via the `byFile`-aware seam in `buildPerRuleLimitationMap`.
    return {
      ...row,
      filesEvaluated: adjustedEvaluated,
      byFile,
    };
  }
  // Aggregate drops — the rule's only evidence was on degraded files
  // (or it was already at non-high confidence from an earlier
  // adjuster). Reason mirrors the historical precedence: parse-error
  // is the stronger signal (file invisible) and wins over partial-
  // parse when both apply.
  const reason = parseErrorMatches.length > 0 ? "file-parse-error" : "partial-parse";
  return {
    ...row,
    filesEvaluated: adjustedEvaluated,
    coverageConfidence: "low",
    coverageConfidenceReason: reason,
    byFile,
  };
}

/**
 * Returns the subset of `pool` whose paths match the rule's
 * `appliesTo.fileExtensions` gate. Path-bearing twin of the
 * `countMatchingFiles` helper in `scan-assembly.ts` consumed by
 * {@link adjustRowForParseErrors} to populate the per-file `byFile`
 * list (each entry needs its `path`, not just the count). Project-
 * scoped rules (no extension gate) match every file.
 *
 * Returns an empty array when the rule is unknown to the active set
 * — defensive for the rare path where a `perRuleCoverage` row
 * references a rule that was filtered out between scanner-emit and
 * meta-assembly. The returned array is a fresh allocation so callers
 * can sort / mutate without aliasing the input pool.
 */
function selectMatchingFiles(
  rule: Rule | undefined,
  pool: readonly ParsedFile[],
): readonly ParsedFile[] {
  if (rule === undefined) return [];
  const extensions = rule.appliesTo?.fileExtensions;
  if (!extensions || extensions.length === 0) return [...pool];
  const out: ParsedFile[] = [];
  for (const f of pool) {
    const dot = f.filePath.lastIndexOf(".");
    const ext = dot === -1 ? "" : f.filePath.slice(dot);
    if (extensionMatches(ext, extensions)) out.push(f);
  }
  return out;
}
