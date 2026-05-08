/**
 * Per-rule-coverage parser-bail-route adjuster — Q15 closure for
 * "Parser-failure invalidates per-file confidence" extended to the
 * silent-bail routing-mismatch case.
 *
 * Doctrine source: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Parser-failure invalidates per-file confidence"
 *   - "Routing skips that drop content are the symmetric twin of
 *     suppression"
 *
 * Bug shape this closes: `scan_file` on a plain-JS file (e.g.
 * `webpack.config.js`) routes through the TSX parser per
 * `src/mcp/session.ts::parseSourceForFile`. The TSX parser may bail
 * silently on relational expressions read as JSX (`r.length<b.length`)
 * — `ast.errors.length === 0` even though the recovered AST is empty
 * of rule-relevant evidence. The response carries
 * `warning: scan_file_parser_bail_no_findings` with payload
 * `{parserAttempted: "tsx", naturalParser: "js", evidence: "non_jsx_in_tsx_route"}`,
 * but every `perRuleCoverage` row crediting that file ships at
 * `coverageConfidence: "high"`. The per-rule label claims the rule
 * observed full evidence; the warning channel says the parser may have
 * silenced findings.
 *
 * The existing {@link import("./parse-error-adjustment.ts").applyParseErrorAdjustment}
 * adjuster handles the `errors.length > 0` case (parse-error /
 * partial-parse split). It does NOT handle the silent-bail case where
 * the parser succeeded but the routing decision is suspect — the
 * predicate `ast.errors.length === 0` skips these files entirely. This
 * adjuster fills the gap by keying on the routing-mismatch evidence
 * the warning predicate already detects:
 *
 *   - file's natural parser (per `naturalParserFor`) is NOT `"tsx"`,
 *     yet the AST language is `"tsx"` (the dispatcher aliased it
 *     through the TSX parser);
 *   - the file produced zero rule-side findings (otherwise the
 *     recovered AST clearly carried evidence — no silent-bail to
 *     surface).
 *
 * Per-rule downgrade: every rule whose `appliesTo.fileExtensions` gate
 * matches a bailed-route file gets its row downgraded with
 * `coverageConfidenceReason: "parse-bailed-non-jsx-in-tsx-route"` and
 * a per-file `byFile[]` entry naming the file. The aggregate fold
 * mirrors the parse-error adjuster: stays `"high"` when the rule has
 * at least one cleanly-evaluated file outside the bailed set; drops to
 * `"low"` when every eligible file is bailed.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { extensionMatches, naturalParserFor } from "../utils/path.ts";

/**
 * Minimum cleanly-evaluated file count for the aggregate fold to stay
 * `"high"` when at least one of the rule's eligible files is in the
 * bailed-route set. Mirrors {@link import("./parse-error-adjustment.ts").MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH}
 * floor (1) — at the floor, a single cleanly-routed file is enough to
 * vouch for the rule on this scan.
 */
const MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH = 1;

/**
 * Detects files where the parser routing decision is the silent-bail-
 * suspect case: the file's natural parser is NOT `"tsx"`, the AST was
 * produced by the TSX parser, AND the file produced zero rule-side
 * findings. The `findingFilePaths` set lets the predicate exclude
 * files where the recovered AST clearly carried evidence — those are
 * not silent-bail hazards.
 *
 * Files with `ast.errors.length > 0` are intentionally INCLUDED in
 * this list when they meet the routing-mismatch predicate — the
 * parse-error adjuster's per-row reason takes precedence at row
 * construction time (parse-error is the stronger signal: file
 * partially or totally invisible to rules), so the same file
 * surfacing here too is harmless. The downstream adjuster's row-level
 * precedence guard ensures only one reason ships per row.
 *
 * Pure over its inputs; sorted output for deterministic wire shape.
 */
export function collectParserBailedRouteFiles(
  parsedFiles: readonly ParsedFile[],
  findingFilePaths: ReadonlySet<string>,
): readonly string[] {
  const out: string[] = [];
  for (const file of parsedFiles) {
    if (file.ast.language !== "tsx") continue;
    const natural = naturalParserFor(file.filePath);
    if (natural === null) continue;
    if (natural === "tsx") continue;
    if (findingFilePaths.has(file.filePath)) continue;
    out.push(file.filePath);
  }
  out.sort();
  return out;
}

/**
 * Adjusts {@link PerRuleCoverage} rows so files that took a silent-
 * bail-suspect parser route are honest about whether the rule actually
 * had a chance to evaluate their content.
 *
 * Two parallel adjustments fire (mirrors the parse-error adjuster
 * shape so the per-file degradation rules stay symmetric):
 *
 *   - **Per-file degradation** rides on {@link PerRuleCoverage.byFile}.
 *     One entry per file in the bailed-route intersection with the
 *     rule's gate, each carrying `confidence: "low"` +
 *     `reason: "parse-bailed-non-jsx-in-tsx-route"`.
 *   - **Aggregate fold** stays `"high"` when the rule has at least
 *     {@link MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH} cleanly-evaluated
 *     files outside the bailed set. Otherwise (the rule's only
 *     eligible files all routed through the silent-bail-suspect path)
 *     the aggregate drops to `"low"` with
 *     `coverageConfidenceReason: "parse-bailed-non-jsx-in-tsx-route"`.
 *
 * Precedence: when a row already carries a stronger reason
 * (`file-parse-error`, `partial-parse`, or
 * `corpus-parse-error-rate-above-threshold` from upstream adjusters),
 * the existing reason wins — parse-error is a stronger signal (file
 * invisible / partially invisible to rules) than routing-mismatch
 * (file routed through suspect parser but no recorded errors). The
 * per-file `byFile[]` entries this adjuster contributes still ride
 * alongside the existing reason so an agent reading the per-file
 * detail sees both signals.
 *
 * No-op fast path: when {@link bailedRouteFiles} is empty, returns the
 * input array unchanged so the common case stays cheap. Exported so
 * the wiring layer (`per-rule-coverage-shared.ts`) can run all
 * adjusters in series and feed the per-rule meta + the top-level
 * `ruleCoverage` derivative the same adjusted view.
 */
export function applyParserBailRouteAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  bailedRouteFiles: ReadonlySet<string>,
): readonly PerRuleCoverage[] {
  if (bailedRouteFiles.size === 0) return rows;
  const bailedFiles = files.filter((f) => bailedRouteFiles.has(f.filePath));
  if (bailedFiles.length === 0) return rows;
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  return rows.map((row) => adjustRowForParserBailRoute(row, ruleById.get(row.ruleId), bailedFiles));
}

/**
 * Per-row adjustment helper for {@link applyParserBailRouteAdjustment}.
 * Returns the input row unchanged when no bailed-route files match the
 * rule's gate. When matches exist, appends per-file `byFile[]` entries
 * naming each bailed file, and folds the aggregate to `"low"` if the
 * rule has no cleanly-evaluated files outside the bailed set. The
 * existing optional fields (`concentration`, `classPatternConcentration`)
 * survive via the spread so the adjustment never strips additive
 * telemetry.
 */
function adjustRowForParserBailRoute(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  bailedFiles: readonly ParsedFile[],
): PerRuleCoverage {
  if (row.skipReason === "gated_by_level") return row;
  const matches = selectMatchingFiles(rule, bailedFiles);
  if (matches.length === 0) return row;
  // Subtract bailed matches from `filesEvaluated` — the rule did not
  // honestly evaluate these files even though the engine's tracker
  // bumped the count on extension match. Floor at 0 so an off-by-one
  // never produces a negative wire value.
  const adjustedEvaluated = Math.max(0, row.filesEvaluated - matches.length);
  // Append per-file degradation entries — sorted by path for
  // deterministic wire output. Parse-error / partial-parse adjuster
  // entries (if any) ride at the row's pre-existing `byFile` slot;
  // we extend that list rather than overwriting so both signals
  // surface when both apply.
  const newByFileEntries = matches.map((f) => ({
    path: f.filePath,
    confidence: "low" as const,
    reason: "parse-bailed-non-jsx-in-tsx-route" as const,
  }));
  const existingByFile = row.byFile ?? [];
  const existingPaths = new Set(existingByFile.map((entry) => entry.path));
  const merged = [
    ...existingByFile,
    ...newByFileEntries.filter((entry) => !existingPaths.has(entry.path)),
  ];
  merged.sort((a, b) => a.path.localeCompare(b.path));
  // Precedence guard for the aggregate scalar: a stronger upstream
  // reason (`file-parse-error`, `partial-parse`,
  // `corpus-parse-error-rate-above-threshold`) wins. Stays
  // `"low"` / pre-existing reason; we only contribute the per-file
  // degradation list. Per the doctrine bullet "Parser-failure
  // invalidates per-file confidence," the per-file detail is the
  // load-bearing surface — the aggregate fold is a derived scalar.
  if (
    row.coverageConfidenceReason !== undefined &&
    row.coverageConfidenceReason !== "parse-bailed-non-jsx-in-tsx-route"
  ) {
    return {
      ...row,
      filesEvaluated: adjustedEvaluated,
      byFile: merged,
    };
  }
  // Aggregate fold: stay `"high"` when the rule has at least
  // {@link MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH} cleanly-evaluated files
  // outside the bailed set. The bailed files were subtracted from
  // `filesEvaluated` above, so `adjustedEvaluated` is the post-
  // subtraction clean count.
  if (
    adjustedEvaluated >= MIN_CLEAN_FILES_FOR_AGGREGATE_HIGH &&
    row.coverageConfidence === "high"
  ) {
    return {
      ...row,
      filesEvaluated: adjustedEvaluated,
      byFile: merged,
    };
  }
  return {
    ...row,
    filesEvaluated: adjustedEvaluated,
    coverageConfidence: "low",
    coverageConfidenceReason: "parse-bailed-non-jsx-in-tsx-route",
    byFile: merged,
  };
}

/**
 * Returns the subset of `pool` whose paths match the rule's
 * `appliesTo.fileExtensions` gate. Mirrors the helper in
 * `parse-error-adjustment.ts` so the per-row matching predicate is
 * identical across adjusters. Project-scoped rules (no extension gate)
 * match every file in the pool.
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
