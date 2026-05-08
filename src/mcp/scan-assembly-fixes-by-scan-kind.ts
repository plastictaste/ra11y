/**
 * Re-derive `plan.fixesByClass` per-scan-kind from per-file finding
 * buckets and the build-artifact path set. Mirrors
 * `splitViolationsByScanKind` on the per-remediation-lane axis —
 * each lane gets its own `{ source, buildArtifact }` pair, and
 * `sum(*.source) === splitViolationsByScanKind(...).source` (and
 * same for `buildArtifact`).
 *
 * Lives in its own file so `scan-assembly.ts` stays under the
 * 500-line file budget enforced by `scripts/check-limits.ts`.
 *
 * Pure functions, no I/O.
 */

/** Per-scan-kind tally for one remediation lane. */
interface ScanKindPair {
  readonly source: number;
  readonly buildArtifact: number;
}

/** Output shape: one pair per remediation lane plus suppress-recommended. */
export interface FixesByClassByScanKindResult {
  readonly mechanical: ScanKindPair;
  readonly guidance: ScanKindPair;
  readonly runtimeOnly: ScanKindPair;
  readonly verifyInSource: ScanKindPair;
  readonly suppressRecommended: ScanKindPair;
}

/** Per-file finding shape consumed by the splitter. */
export interface FindingForLaneSplit {
  readonly severity: string;
  readonly fixClass?: string;
}

/**
 * Splits the per-file findings into per-lane × per-scan-kind tallies.
 *
 * `vendorPaths` is the build-artifact path set; findings whose file
 * path is in the set route into each lane's `buildArtifact` half.
 * Reads the per-finding `fixClass` directly — `buildAgentFinding`
 * already reroutes suppression-flavored emissions to the
 * `"suppress-recommended"` lane via the shared
 * `isSuppressionFlavoredSuggestion` predicate, so this splitter
 * consumes the post-route value as the single source of truth (per
 * `docs/kb/architecture/ai-first-consumer.md` "Per-call shape must
 * agree with per-class plan tally" — the per-finding lane label and
 * the plan-tally lane partition share one predicate). Severity-info
 * findings are excluded so the per-lane axis stays aligned with
 * `splitViolationsByScanKind`'s error+warning slice.
 */
export function splitFixesByClassByScanKind(
  files: readonly {
    readonly path: string;
    readonly findings: readonly FindingForLaneSplit[];
  }[],
  vendorPaths: ReadonlySet<string>,
): FixesByClassByScanKindResult {
  const lanes = {
    mechanical: { source: 0, buildArtifact: 0 },
    guidance: { source: 0, buildArtifact: 0 },
    runtimeOnly: { source: 0, buildArtifact: 0 },
    verifyInSource: { source: 0, buildArtifact: 0 },
    suppressRecommended: { source: 0, buildArtifact: 0 },
  };
  for (const f of files) {
    const isBuildArtifact = vendorPaths.has(f.path);
    const kind: "source" | "buildArtifact" = isBuildArtifact ? "buildArtifact" : "source";
    for (const finding of f.findings) {
      if (finding.severity === "info") continue;
      const lane = laneKeyFor(finding.fixClass);
      if (lane === null) continue;
      lanes[lane][kind] += 1;
    }
  }
  return lanes;
}

function laneKeyFor(
  fixClass: string | undefined,
): "mechanical" | "guidance" | "runtimeOnly" | "verifyInSource" | "suppressRecommended" | null {
  switch (fixClass) {
    case "mechanical":
      return "mechanical";
    case "guidance":
      return "guidance";
    case "runtime-only":
      return "runtimeOnly";
    case "verify-in-source":
      return "verifyInSource";
    case "suppress-recommended":
      return "suppressRecommended";
    default:
      return null;
  }
}
