/**
 * Per-rule-coverage SCSS-partial-input adjuster — companion of
 * `applyParseErrorAdjustment` on the SCSS-partial-classification axis.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   - "Heuristic-mislabeled meta sub-fields are dishonest" — the
 *     two-signal AND predicate (basename + dangling `&`) clears the
 *     "provable from the code" bar.
 *   - "Parser-failure invalidates per-file confidence" — the per-rule
 *     degradation propagates as `scss-partial-input` rather than as a
 *     hard `file-parse-error` because the file's authorial intent is
 *     "fragment," not "broken."
 *
 * Backlog closure: `Q10-SCSS-PARTIALS-MISLABELED-AS-PARSE-ERROR-NOT-FRAGMENT`.
 *
 * Two exports drive the adjustment + the file-list collection:
 *
 *   - {@link detectScssPartialFiles} — walks the parsed file set and
 *     returns the subset of `.scss` files that classify as Sass
 *     partials per the shared `isScssPartialSource` predicate.
 *   - {@link applyScssPartialInputAdjustment} — walks per-rule
 *     coverage rows and downgrades `coverageConfidence` to `"medium"`
 *     with `coverageConfidenceReason: "scss-partial-input"` when at
 *     least one of the rule's eligible files is in the partial set.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import { isScssPartialSource } from "../input/parsers/scss-internals.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { countMatchingFiles } from "./scan-assembly.ts";

/**
 * Returns the subset of scanned `.scss` files that classify as Sass
 * partials per the shared {@link isScssPartialSource} predicate —
 * basename starts with `_` AND the source declares a top-level `&`
 * parent-reference selector (the canonical "fragment of another file"
 * shape the SCSS preprocessor's dangling-`&` verdict mislabels as a
 * hard parse error).
 *
 * The returned file list drives the per-rule
 * `coverageConfidenceReason: "scss-partial-input"` downgrade
 * ({@link applyScssPartialInputAdjustment}) and pairs with the
 * companion gate in `partitionParseStateFiles` /
 * `recordParseErrorEntry` that excludes the same files from
 * `parseErrorFiles[]`. Same shared predicate, same evidence — no
 * cross-surface drift between the parse-error suppression and the
 * per-rule confidence downgrade.
 *
 * Returns paths in sorted order so wire output is deterministic across
 * runs. Empty array (not `undefined`) when no partial files are
 * present — callers conditional-spread on `length > 0`.
 */
export function detectScssPartialFiles(files: readonly ParsedFile[]): readonly string[] {
  const out: string[] = [];
  for (const file of files) {
    if (!file.filePath.toLowerCase().endsWith(".scss")) continue;
    if (isScssPartialSource(file.filePath, file.source)) out.push(file.filePath);
  }
  out.sort();
  return out;
}

/**
 * Per-rule-coverage row adjuster — companion of
 * `applyParseErrorAdjustment` on the SCSS-partial-classification axis.
 * Downgrades a rule's `coverageConfidence` to `"medium"` with
 * `coverageConfidenceReason: "scss-partial-input"` when at least one
 * of its eligible files is in the SCSS partial set
 * ({@link detectScssPartialFiles}).
 *
 * Why `"medium"` and not `"low"`: the file's preprocessor pass DID
 * produce a partial recovered AST (the parser's drop-on-error policy
 * means the `&`-rooted block is gone but other blocks survive); the
 * substrate's "fragment of another file" classification is a peer of
 * the HTML fragment-input case (`fragment-input-no-document-envelope`).
 * A `"low"` downgrade would conflate this case with the hard
 * parse-error case (file invisible to rules), which is a stronger
 * statement than the substrate warrants — the file IS a partial, the
 * rule DID run on what could be parsed, but the parent SCSS file's
 * selector chain is unobservable and bounds the evidence horizon.
 *
 * Precedence: when `applyParseErrorAdjustment` or
 * `applyScssUnresolvedVariablesAdjustment` or
 * `applyFragmentInputAdjustment` already stamped a non-partial
 * `coverageConfidenceReason`, this adjuster passes the row through
 * unchanged — those reasons name a stronger or peer substrate-level
 * signal and the four reasons never share a row. Note: in practice
 * the parse-error adjuster never matches an SCSS partial (the
 * `partitionParseStateFiles` gate excludes them via the same shared
 * predicate), but the precedence guard stays for defensive symmetry.
 *
 * No-op fast path: when {@link partialFilePaths} is empty, returns the
 * input array unchanged. Exported so the wiring layer
 * (response-assembler) can run all four adjusters in series and feed
 * the per-rule meta + the top-level `ruleCoverage` derivative the same
 * adjusted view.
 */
export function applyScssPartialInputAdjustment(
  rows: readonly PerRuleCoverage[],
  files: readonly ParsedFile[],
  activeRules: readonly Rule[],
  partialFilePaths: ReadonlySet<string>,
): readonly PerRuleCoverage[] {
  if (partialFilePaths.size === 0) return rows;
  const ruleById = new Map<string, Rule>();
  for (const r of activeRules) ruleById.set(r.id, r);
  const partialSet = new Set(partialFilePaths);
  const partialFiles = files.filter((f) => partialSet.has(f.filePath));
  return rows.map((row) =>
    adjustRowForScssPartialInput(row, ruleById.get(row.ruleId), partialFiles),
  );
}

/**
 * Per-row adjustment helper for {@link applyScssPartialInputAdjustment}.
 * Returns the input row unchanged when no partial files match the
 * rule's gate, when the row is already at `"low"` (parse-error
 * precedence), or when the row's existing `coverageConfidenceReason`
 * is set to a non-partial reason (substrate-level signals win over
 * partial classification — though partial files are excluded from
 * parse-error sets by construction, the precedence guard stays for
 * defensive symmetry with the other adjusters).
 */
function adjustRowForScssPartialInput(
  row: PerRuleCoverage,
  rule: Rule | undefined,
  partialFiles: readonly ParsedFile[],
): PerRuleCoverage {
  if (row.coverageConfidence === "low") return row;
  if (
    row.coverageConfidenceReason !== undefined &&
    row.coverageConfidenceReason !== "scss-partial-input"
  ) {
    return row;
  }
  const matches = countMatchingFiles(rule, partialFiles);
  if (matches === 0) return row;
  return {
    ...row,
    coverageConfidence: "medium",
    coverageConfidenceReason: "scss-partial-input",
    reason:
      row.reason ??
      "at least one matching file is an SCSS partial (`_*.scss` declaring top-level `&` parent-references); the parent SCSS file's selector chain is unobservable here and the rule's evidence horizon is bounded by the fragment-of-another-file shape",
  };
}
