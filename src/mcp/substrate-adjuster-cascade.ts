/**
 * Composed substrate adjuster cascade for legacy callers (the
 * `runScanAndFormat` path in `tools-helpers.ts`) that thread the
 * partial result through an async outer pass
 * (`applyExtensionSubkindFromRoot`'s cwd-rooted directory walk) and
 * therefore can't use the all-in-one
 * {@link import("./per-rule-coverage-shared.ts").buildSharedPerRuleCoverageMeta}
 * assembler.
 *
 * Mirrors the same cascade order:
 * parse-error/corpus-rate → scss-unresolved → fragment-input →
 * astro-island. Each adjuster's no-op fast path is preserved (when
 * its corresponding substrate file set is empty, the input passes
 * through unchanged).
 *
 * Pulled out of `tools-helpers.ts` to keep that file under the
 * limits-guard effective-line budget — the helper itself is
 * load-bearing for cross-tool agreement (per the AI-first
 * "Cross-surface count invariant" doctrine extended to per-rule
 * downgrade reasons).
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import { applyParseErrorAndCorpusRate } from "./corpus-parse-error-rate-adjustment.ts";
import { applyAstroIslandUnrenderedAdjustment } from "./scan-assembly-astro-islands.ts";
import {
  applyFragmentInputAdjustment,
  applyScssUnresolvedVariablesAdjustment,
} from "./scan-assembly.ts";
import { applyScssPartialInputAdjustment } from "./scss-partial-adjustment.ts";

export interface SubstrateAdjusterCascadeArgs {
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly files: readonly ParsedFile[];
  readonly activeRules: readonly Rule[];
  readonly violationFilePaths: ReadonlySet<string>;
  readonly scssUnresolvedFiles: readonly string[];
  readonly fragmentFiles: readonly string[];
  readonly astroIslandUnrenderedFiles: readonly string[];
  readonly scssPartialFiles?: readonly string[];
}

export function runSubstrateAdjusterCascade(
  args: SubstrateAdjusterCascadeArgs,
): readonly PerRuleCoverage[] {
  const parseErrorAdjusted = applyParseErrorAndCorpusRate(
    args.perRuleCoverage,
    args.files,
    args.activeRules,
    args.violationFilePaths,
  );
  const scssAdjusted = applyScssUnresolvedVariablesAdjustment(
    parseErrorAdjusted,
    args.files,
    args.activeRules,
    new Set(args.scssUnresolvedFiles),
  );
  const fragmentAdjusted = applyFragmentInputAdjustment(
    scssAdjusted,
    args.files,
    args.activeRules,
    new Set(args.fragmentFiles),
  );
  const astroAdjusted = applyAstroIslandUnrenderedAdjustment(
    fragmentAdjusted,
    args.files,
    args.activeRules,
    new Set(args.astroIslandUnrenderedFiles),
  );
  if (args.scssPartialFiles === undefined) return astroAdjusted;
  return applyScssPartialInputAdjustment(
    astroAdjusted,
    args.files,
    args.activeRules,
    new Set(args.scssPartialFiles),
  );
}
