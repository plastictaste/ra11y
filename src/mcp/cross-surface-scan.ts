/**
 * Shared scanner runner for the project-rooted derivative tools
 * (`coverage`, `checklist`). Threads `nativeWrapperElements` and
 * `processes` from `projectConfig` onto {@link runScan} so the
 * `result.violations` / `report.candidates` outputs match the shape
 * `scan_project` produces on identical input, and runs the same
 * {@link coupleSeverityToVerifyTokens} pass that `scan-collect.ts` /
 * `tools-helpers.ts` apply on the scan-family path so the
 * coupled-severity stream is the single canonical view every project-
 * rooted assembler tallies against.
 *
 * Without this seam, `coverage` and `checklist` previously called
 * {@link runScan} with neither input wired up — a real-corpus scan
 * with `nativeWrappers` configured (or `processes` declared) produced
 * different `result.violations` than `scan_project`'s, and the
 * `outputFilePathSet` derivation downstream silently drifted. The
 * `parseErrorFiles` vs `partialParseFiles` per-bucket assignment
 * fed by that set then disagreed across surfaces (totals matched
 * because the parse-error entries are derived from `files` not from
 * scan output, but bucket assignment depends on `findingFilePaths`).
 * The verify-token severity coupling is the same shape one rung
 * deeper: a finding emitted at `warning` with a
 * {@link VERIFY_IN_SOURCE_TOKENS} entry on `couldBeWrongBecause`
 * (canonical case: `semantics/landmark-main` emitting
 * `partial_or_layout_file_requires_composed_check` on a layout-partial
 * HTML page) sat at `warning` on coverage/checklist while
 * `scan_project` saw it at `info` — coverage's `indexFailingCriteria`
 * then routed the criterion into `failingCriteria` and dropped it from
 * the manual-actionable union, producing a silent 1-count drift on
 * every fixture exercising that branch.
 *
 * Doctrine: see `docs/kb/architecture/ai-first-consumer.md`
 * "Cross-surface count invariant" — every shared cross-tool counter
 * must derive from one shared helper, including the per-bucket
 * decomposition of a counter whose total agrees.
 */

import { type ParsedFile, runScan } from "../engine/scanner.ts";
import type { LoadedConfig } from "../types/config.ts";
import type { AttestationRecord } from "../types/evidence.ts";
import type { Rule } from "../types/rule.ts";
import { outputFilePathSet } from "./scan-assembly.ts";
import type { McpSession } from "./session.ts";
import { coupleSeverityToVerifyTokens } from "./violation-severity-coupling.ts";

/**
 * Inputs every project-rooted derivative tool already has at the
 * point it would call {@link runScan}. Pure passthrough — the helper
 * threads each onto the correct {@link runScan} argument so callers
 * can't accidentally drop one and re-introduce drift.
 */
export interface RunScanForCrossSurfaceParityArgs {
  readonly files: readonly ParsedFile[];
  readonly session: McpSession;
  readonly enabled: readonly string[];
  readonly level: "A" | "AA" | "AAA";
  readonly activeRules: readonly Rule[];
  readonly attestations: readonly AttestationRecord[];
  readonly projectConfig: LoadedConfig;
  /**
   * Caller-supplied scan root (typically the explicit `cwd` the agent
   * passed). Plumbed into the engine's per-emission `findingId` hash
   * so `checklist` / `coverage` and the scan-family tools produce the
   * same id on the same conceptual rule emission. Per
   * `docs/kb/architecture/ai-first-consumer.md` "Per-finding
   * identifiers must be addressable, not collision-prone."
   */
  readonly scanRoot?: string;
}

/**
 * Calls {@link runScan} with the project-config-derived
 * `nativeWrapperElements` and `processes` threaded in, mirroring the
 * options scan_project passes through {@link runScanAndFormat}.
 * Returns the scan output plus the materialized
 * `outputFilePaths` set so callers don't recompute it (and don't get
 * a chance to compute it from a different stream than the bucket
 * assembler).
 *
 * `nativeWrapperElements` is conditional-spread onto the runScan
 * options when non-empty, matching {@link buildRunScanOptions}'s
 * presence rule. `processes` is conditional-spread on length so an
 * empty array still routes through the same code path (no-op).
 */
export function runScanForCrossSurfaceParity(args: RunScanForCrossSurfaceParityArgs): {
  readonly result: ReturnType<typeof runScan>["result"];
  readonly report: ReturnType<typeof runScan>["report"];
  readonly perRuleCoverage: ReturnType<typeof runScan>["perRuleCoverage"];
  readonly filesWithAnyRuleEvaluated: number;
  readonly outputFilePaths: ReadonlySet<string>;
} {
  const { files, session, enabled, level, activeRules, attestations, projectConfig, scanRoot } =
    args;
  const wrapperElements = projectConfig.nativeWrapperElements;
  const processes = projectConfig.processes;
  const {
    result: rawResult,
    report,
    perRuleCoverage,
    filesWithAnyRuleEvaluated,
  } = runScan({
    standards: session.registry.standards,
    rules: activeRules,
    enabled,
    files,
    finders: session.registry.finders,
    level,
    ...(attestations.length > 0 && { attestations }),
    ...(Object.keys(wrapperElements).length > 0 && { nativeWrapperElements: wrapperElements }),
    ...(processes.length > 0 && { processes }),
    ...(scanRoot === undefined ? {} : { scanRoot }),
  });
  // Couple severity to verify-in-source tokens BEFORE returning the
  // result, mirroring the same pass `scan-collect.ts` and
  // `tools-helpers.ts` apply on the scan-family path. Without this,
  // `coverage` / `checklist` consume a raw violation stream where a
  // verify-token finding (e.g. `landmark-main` emitting
  // `couldBeWrongBecause: ["partial_or_layout_file_requires_composed_check"]`)
  // still rides at severity `warning`, so:
  //   - `buildCoverageReport`'s `indexFailingCriteria` (which only
  //     excludes `info`-severity) routes the criterion into
  //     `failingCriteria` and removes it from `manualCriteria`; and
  //   - `collectVerifyTokenViolationCriteria` (gated on severity
  //     `info`) never picks the criterion up via the verify-token
  //     branch.
  // The cross-surface count invariant
  // (`docs/kb/architecture/ai-first-consumer.md`) requires every
  // project-rooted tool to tally off the same coupled stream — pinned
  // by the warning-severity verify-token case in
  // `tests/integration/mcp-counts-agree.test.ts`.
  const result = { ...rawResult, violations: coupleSeverityToVerifyTokens(rawResult.violations) };
  // Derived from the SAME `result.violations` / `report.candidates`
  // the caller will route into other consumers. Per the
  // "Cross-surface count invariant" doctrine: when the helper owns
  // both the scan call AND the `outputFilePaths` derivation, the
  // bucket-assignment input can't drift between callers. The
  // `findingFilePaths` argument to {@link buildAnalysisCoverage}
  // must be threaded from this seam so the
  // `parseErrorFiles` / `partialParseFiles` per-bucket assignment
  // agrees with `scan_project` on identical cwd.
  const outputFilePaths = outputFilePathSet(result.violations, report.candidates ?? []);
  return { result, report, perRuleCoverage, filesWithAnyRuleEvaluated, outputFilePaths };
}
