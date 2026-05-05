/**
 * Shared scanner runner for the project-rooted derivative tools
 * (`coverage`, `checklist`). Threads `nativeWrapperElements` and
 * `processes` from `projectConfig` onto {@link runScan} so the
 * `result.violations` / `report.candidates` outputs match the shape
 * `scan_project` produces on identical input.
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
  const { result, report, perRuleCoverage, filesWithAnyRuleEvaluated } = runScan({
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
