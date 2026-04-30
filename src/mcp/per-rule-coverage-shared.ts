/**
 * Shared per-rule-coverage assembly helper consumed by both the
 * scan-family response assembler ({@link assembleScanFamilyResponse},
 * which fans out to `scan_project` / `scan_file` / `scan` /
 * `scan_diff`) and the project-rooted derivative `coverage` tool.
 *
 * Doctrine source: `docs/kb/architecture/ai-first-consumer.md`
 * "Cross-surface count invariant." The same scan basis (parsed files +
 * raw `perRuleCoverage` rows + active rules + violations) must produce
 * the same `meta.perRuleCoverage[]` row set on every project-rooted MCP
 * tool consuming it. Before this helper, `coverage` advertised
 * `verboseMeta: true` would expand `perRuleCoverage[]` rows but never
 * actually emitted them — `scan_file` on the same input shipped ~95
 * rows while `coverage` shipped an empty array. The agent reading
 * per-rule-coverage as scan-confidence telemetry got contradictory
 * mental models from two surfaces designed to agree.
 *
 * The helper runs the full adjustment cascade in the canonical order
 * (parse-error → SCSS-unresolved-variables → fragment-input →
 * SCSS-partial → extension-presence-subkind), then formats the
 * `meta.perRuleCoverage` / `meta.perRuleCoverageSummary` /
 * `meta.rulesNotEvaluatedDueToInputType` fragment under
 * {@link verboseMeta} discipline. Returns the adjusted rows alongside
 * the formatted fragment so callers that need both (the scan-family
 * assembler hands the adjusted rows to
 * {@link buildRuleCoverageDerivative} and the per-finding-confidence
 * parity pass) don't run the cascade twice.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import { applyCorpusParseErrorRateAdjustment } from "./corpus-parse-error-rate-adjustment.ts";
import { applyExtensionPresentSubkindAdjustment } from "./extension-subkind.ts";
import { applyParseErrorAdjustment } from "./parse-error-adjustment.ts";
import {
  applyFragmentInputAdjustment,
  applyScssUnresolvedVariablesAdjustment,
  detectFragmentFiles,
  detectScssUnresolvedVariableFiles,
  type PerRuleCoverageMetaFragment,
  perRuleCoverageMetaFragment,
} from "./scan-assembly.ts";
import {
  applyScssPartialInputAdjustment,
  detectScssPartialFiles,
} from "./scss-partial-adjustment.ts";

/**
 * Inputs to {@link buildSharedPerRuleCoverageMeta}. Every project-rooted
 * scan-family / coverage tool already has each of these in scope at the
 * point it would call the assembler — pure passthrough so callers can't
 * accidentally drop one and re-introduce drift.
 */
export interface SharedPerRuleCoverageMetaArgs {
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  /**
   * The set of file paths that emitted at least one rule-side violation.
   * Drives {@link applyParseErrorAdjustment}: a per-rule coverage row's
   * confidence is downgraded based on whether the rule's eligible files
   * include parse-error / partial-parse paths. Rule-side only — finder-
   * emitted candidates would unfoundedly downgrade rule rows so they
   * stay out of this set.
   */
  readonly violationFilePaths: ReadonlySet<string>;
  /**
   * Result of the cwd-rooted directory walk that probes whether a rule's
   * gated extensions exist anywhere under the project root. Drives the
   * {@link applyExtensionPresentSubkindAdjustment} pass that stamps a
   * `subkind: "extension-absent" | "extension-present-but-out-of-scope"`
   * discriminator on `eligible === 0` extension-gated rows. Omit on
   * surfaces without a cwd-rooted scope (`scan_file` explicit paths);
   * rows then ship without the `subkind` discriminator.
   */
  readonly extensionsPresentAtRoot?: ReadonlySet<string>;
  /** When `true`, emits the full `perRuleCoverage[]` array; otherwise emits the compact summary. */
  readonly verboseMeta: boolean;
}

/**
 * Output of {@link buildSharedPerRuleCoverageMeta}: the materialized meta
 * fragment ready to spread into the response's `meta` block, plus the
 * adjusted rows for callers that need them downstream.
 */
export interface SharedPerRuleCoverageMetaResult {
  /**
   * Meta-fragment object — spreadable into `meta`. Carries
   * `perRuleCoverage` (verbose) OR `perRuleCoverageSummary` (default),
   * the optional `perRuleCoverageTruncated` sibling, and the
   * unconditional `rulesNotEvaluatedDueToInputType` counter.
   */
  readonly fragment: PerRuleCoverageMetaFragment;
  /**
   * Per-rule coverage rows after the full adjustment cascade ran.
   * Sibling consumers of the same row set (e.g.
   * {@link buildRuleCoverageDerivative}, the per-finding parity pass)
   * read from this array so the per-rule and per-finding layers don't
   * disagree on the same response.
   */
  readonly adjustedPerRuleCoverage: readonly PerRuleCoverage[];
}

/**
 * Runs the full per-rule-coverage adjustment cascade and produces the
 * meta fragment every project-rooted scan-family / coverage tool emits.
 *
 * Cascade order (load-bearing — each adjuster honors the precedence
 * established by the prior one):
 *
 *  1. {@link applyParseErrorAdjustment} — drops rows to `"low"` when the
 *     rule's eligible files include a parse-error / partial-parse path
 *     (per-file axis; populates `byFile[]` for the corpus-aggregation
 *     adjuster below).
 *  2. {@link applyCorpusParseErrorRateAdjustment} — drops rows whose
 *     corpus-level parse-error rate (`byFile.length / filesEligible`)
 *     exceeds the medium (10%) / low (25%) thresholds. Sibling of #1
 *     on the orthogonal corpus-aggregate axis: #1 honestly keeps the
 *     aggregate `"high"` when one clean file survives, but on bulk-
 *     vendor corpora (12% parse-error rate across 4000 files) the
 *     aggregate scalar is the field an agent budgets against and
 *     hundreds of invisible files would otherwise read as "high."
 *  3. {@link applyScssUnresolvedVariablesAdjustment} — drops rows to
 *     `"medium"` when at least one of the rule's eligible `.scss` files
 *     declares top-level `$variable: …` decls but produced no literal
 *     color usages.
 *  4. {@link applyFragmentInputAdjustment} — drops document-shaped rules
 *     to `"medium"` when at least one of their eligible HTML files
 *     classifies as a fragment.
 *  5. {@link applyScssPartialInputAdjustment} — drops rows to `"medium"`
 *     when at least one of the rule's eligible `.scss` files is a
 *     `_partial.scss` declaring top-level `&` parent-references.
 *  6. {@link applyExtensionPresentSubkindAdjustment} — stamps
 *     `subkind: "extension-absent" | "extension-present-but-out-of-scope"`
 *     on `eligible === 0` extension-gated rows when the caller probed.
 *
 * Pure over its inputs (no I/O — the cwd-rooted directory walk
 * happens upstream in {@link probeExtensionsAtRoot}; the result is
 * threaded in via {@link extensionsPresentAtRoot}).
 */
export function buildSharedPerRuleCoverageMeta(
  args: SharedPerRuleCoverageMetaArgs,
): SharedPerRuleCoverageMetaResult {
  const {
    perRuleCoverage,
    parsedFiles,
    activeRules,
    violationFilePaths,
    extensionsPresentAtRoot,
    verboseMeta,
  } = args;
  const scssUnresolvedFiles = detectScssUnresolvedVariableFiles(parsedFiles);
  const fragmentFiles = detectFragmentFiles(parsedFiles);
  const scssPartialFiles = detectScssPartialFiles(parsedFiles);
  const parseErrorAdjusted = applyParseErrorAdjustment(
    perRuleCoverage,
    parsedFiles,
    activeRules,
    violationFilePaths,
  );
  // Corpus-aggregation pass — drops rows whose corpus parse-error
  // rate (`byFile.length / filesEligible`) exceeds the medium (10%) /
  // low (25%) thresholds. Reads the `byFile[]` array the parse-error
  // pass populated; sequencing is load-bearing.
  const corpusRateAdjusted = applyCorpusParseErrorRateAdjustment(parseErrorAdjusted);
  const scssAdjusted = applyScssUnresolvedVariablesAdjustment(
    corpusRateAdjusted,
    parsedFiles,
    activeRules,
    new Set(scssUnresolvedFiles),
  );
  const fragmentInputAdjusted = applyFragmentInputAdjustment(
    scssAdjusted,
    parsedFiles,
    activeRules,
    new Set(fragmentFiles),
  );
  const scssPartialAdjusted = applyScssPartialInputAdjustment(
    fragmentInputAdjusted,
    parsedFiles,
    activeRules,
    new Set(scssPartialFiles),
  );
  const adjustedPerRuleCoverage = applyExtensionPresentSubkindAdjustment(
    scssPartialAdjusted,
    activeRules,
    extensionsPresentAtRoot,
  );
  const fragment = perRuleCoverageMetaFragment(adjustedPerRuleCoverage, activeRules, verboseMeta);
  return { fragment, adjustedPerRuleCoverage };
}

/**
 * Convenience helper for callers that only have the violations array
 * (not a pre-computed `violationFilePaths` set). Wraps
 * {@link buildSharedPerRuleCoverageMeta} after deriving the set in the
 * canonical way (rules-only — review candidates go through the separate
 * `outputFilePathSet` for `analysisCoverage`'s parse-error split).
 */
export function buildSharedPerRuleCoverageMetaFromViolations(args: {
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly parsedFiles: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly violations: readonly Violation[];
  readonly extensionsPresentAtRoot?: ReadonlySet<string>;
  readonly verboseMeta: boolean;
}): SharedPerRuleCoverageMetaResult {
  const violationFilePaths = new Set<string>();
  for (const v of args.violations) violationFilePaths.add(v.location.filePath);
  return buildSharedPerRuleCoverageMeta({
    perRuleCoverage: args.perRuleCoverage,
    parsedFiles: args.parsedFiles,
    activeRules: args.activeRules,
    violationFilePaths,
    ...(args.extensionsPresentAtRoot === undefined
      ? {}
      : { extensionsPresentAtRoot: args.extensionsPresentAtRoot }),
    verboseMeta: args.verboseMeta,
  });
}
