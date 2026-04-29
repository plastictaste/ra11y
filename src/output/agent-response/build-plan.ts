/**
 * buildAgentPlan — violations + pre-built findings → AgentPlan headline.
 *
 * Emits the honest per-lane fix tally on the plan:
 *
 *   - `fixesByClass` — a structured tally keyed by the rule-level
 *     `fixClass`: `{ mechanical, guidance, runtimeOnly, verifyInSource }`.
 *     Each key counts one kind of thing. Callers that need the
 *     apply-now editable lanes read `fixesByClass.mechanical +
 *     fixesByClass.verifyInSource`; callers that need the
 *     round-trip-prose lane read `fixesByClass.guidance`; the
 *     runtime-only lane has no remediation the scanner can action.
 *
 * The former `safeEditsAvailable` headline counted
 * "violations that ship an inline `fixPaths.primary.edit`" across the
 * mechanical + verify-in-source lanes. Field reports surfaced
 * `plan.safeEditsAvailable: 14` sitting next to
 * `plan.fixesByClass.mechanical: 266` on the same response — two
 * sibling counters framed as "how many fixes an agent can apply"
 * disagreed because they counted different slices (payload-availability
 * vs. rule-demanded lane) under confusingly overlapping names. Per
 * CLAUDE.md §1 "Composite headline counts are dishonest," the composite
 * was dropped; the per-lane `fixesByClass` keys already carry the honest
 * signal, and agents that want the "can apply-fix locally now" subset
 * sum the two editable lanes themselves (`mechanical + verifyInSource`)
 * rather than consume a composite whose name doesn't describe its
 * coverage.
 *
 * The older `guidanceFixesAvailable` counter — which summed four
 * categorically different `fixClass` lanes under one label — was
 * replaced earlier by the structured `fixesByClass` sibling for the
 * same reason.
 *
 * Effort is computed from the combined count of violations that carry
 * any actionable remediation (inline edit or prose-only guidance), via
 * the internal {@link countFixes} helper which keeps its two-field
 * return shape ({@link FixCounts}) so the effort math and the
 * `violationsWithoutAnyFix` derivation stay centralised — these are
 * internal signals, not headline counters.
 *
 * `buildSummary` breaks the violations parenthetical down by the
 * rule-level `fixClass` lane via the shared helper in
 * `./fix-class-breakdown.ts` so MCP and CLI emit the same format.
 */

import type { FixClass } from "../../types/rule.ts";
import type { Violation } from "../../types/violation.ts";
import { buildFixClassBreakdown, type FixClassCounts } from "./fix-class-breakdown.ts";
import type {
  AgentFile,
  AgentPlan,
  Effort,
  FixesByClass,
  FixesByClassLane,
} from "./types.ts";

const MODERATE_THRESHOLD = 5;
const TOP_RULES_COUNT = 3;

function computeEffort(total: number, fixCount: number): Effort {
  if (total === 0) return "trivial";
  if (fixCount === 0) return "trivial"; // all notes/review — nothing to fix
  if (fixCount > MODERATE_THRESHOLD) return "moderate";
  return "trivial";
}

function topN(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function buildSummary(
  total: number,
  fixClassCounts: FixClassCounts,
  reviewNeeded: number,
  manualOnly: number,
  ruleCounts: Map<string, number>,
): string {
  if (total === 0) return "No accessibility violations found.";

  // Per the prose drops the leading
  // composite "N findings" headline that summed across the four
  // `fixClass` lanes. The honest shape is the per-lane breakdown
  // emitted directly: "31 mechanical, 6 verify-in-source. Most
  // common: …". Callers that want the flat count sum the four
  // lanes themselves; the summary string consumers read first
  // shouldn't promise one kind of work and deliver four.
  const laneBreakdown = buildFixClassBreakdown(fixClassCounts);
  // `buildFixClassBreakdown` returns a space-prefixed parenthetical
  // ("(31 mechanical, …)"); strip the wrapper so the lane list reads
  // as a flat fragment. Defensive: an empty breakdown (no rule with
  // a `fixClass` produced a violation — should never happen on real
  // scans) drops the lane fragment entirely; downstream pieces
  // (manual review, top-rules) still ride.
  const lanesFragment = stripParenWrapper(laneBreakdown);

  const trailingParts: string[] = [];
  if (reviewNeeded > 0) trailingParts.push(`${reviewNeeded} need review`);
  if (manualOnly > 0) trailingParts.push(`${manualOnly} manual`);

  const sentences: string[] = [];
  // Lane fragment + manual-review fragment ride as one sentence so
  // they read as a single inventory line. Trailing parts have
  // historically been comma-glued onto the lane breakdown; keep
  // that shape so existing field-format expectations don't drift.
  let leadFragment = lanesFragment;
  if (trailingParts.length > 0) {
    leadFragment =
      leadFragment.length > 0
        ? `${leadFragment}, ${trailingParts.join(", ")}`
        : trailingParts.join(", ");
  }
  if (leadFragment.length > 0) {
    sentences.push(`${leadFragment}.`);
  }

  const topRules = topN(ruleCounts, TOP_RULES_COUNT);
  if (topRules.length > 0) {
    const ruleList = topRules.map(([id, n]) => `${id} (${n})`).join(", ");
    sentences.push(`Most common: ${ruleList}.`);
  }

  return sentences.join(" ");
}

/**
 * Strips the leading " (" and trailing ")" from a parenthetical
 * fragment produced by {@link buildFixClassBreakdown}. Tolerant of
 * missing wrappers (returns the trimmed input) so the summary never
 * emits malformed prose on an unexpected input.
 */
function stripParenWrapper(parenthetical: string): string {
  const trimmed = parenthetical.trimStart();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export interface FixCounts {
  /**
   * Count of violations with an inline `fixPaths.primary.edit`. Covers
   * both the `mechanical` and `verify-in-source` rule lanes — the two
   * remediation lanes whose edit lands in source. Internal to
   * {@link buildAgentPlan}'s effort computation and to
   * `violationsWithoutAnyFix` derivation — NOT exposed on the plan
   * (Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT): the former
   * `plan.safeEditsAvailable` headline disagreed with
   * `plan.fixesByClass.mechanical` by up to 18× because the two
   * counters measured different slices under confusingly overlapping
   * names. Callers that need per-lane budgeting read `fixesByClass`
   * on the plan; callers that want the "apply-fix can run this now"
   * subset sum `fixesByClass.mechanical + fixesByClass.verifyInSource`.
   */
  readonly editsWithInlineFixPath: number;
  /**
   * Count of violations that ship a prose `suggestion` but no inline
   * edit. Internal to {@link buildAgentPlan}'s effort computation — NOT
   * exposed on the plan because the count conflates four `fixClass` lanes.
   * Callers that need per-lane budgeting should read `fixesByClass` on
   * the plan instead.
   */
  readonly proseOnlySuggestions: number;
}

/**
 * Count the violations with an inline source edit vs. prose-only suggestion.
 *
 * Exported so the MCP layer can reuse the same accounting for effort
 * math and `violationsWithoutAnyFix` derivation without rebuilding a
 * full {@link AgentPlan} — its plan wrapper carries MCP-specific fields
 * (actionableManualItems, untargetedCriteria, limitations, etc.) that
 * the CLI plan deliberately doesn't.
 *
 * Both returned fields are internal signals — neither is surfaced on
 * the plan. `editsWithInlineFixPath` counts violations whose
 * `fixPaths.primary.edit` is populated (across the mechanical +
 * verify-in-source lanes); `proseOnlySuggestions` counts violations
 * that ship only a prose `suggestion`. The former used to be exposed
 * as `plan.safeEditsAvailable`, but per CLAUDE.md §1 "Composite
 * headline counts are dishonest" that field was dropped — it summed
 * two categorically different lanes under a name that sounded like
 * "mechanical only," and disagreed with the per-lane
 * `fixesByClass.mechanical` counter by up to 18× on real field-report
 * responses. For per-lane budgeting agents consume `plan.fixesByClass`
 * (keyed by `fixClass`, one-kind-per-key); for the "apply-fix can
 * action this now" subset they sum
 * `fixesByClass.mechanical + fixesByClass.verifyInSource`.
 */
export function countFixes(violations: readonly Violation[]): FixCounts {
  let editsWithInlineFixPath = 0;
  let proseOnlySuggestions = 0;
  for (const v of violations) {
    const hasInlineEdit = v.fixPaths?.primary.edit !== undefined;
    if (hasInlineEdit) {
      editsWithInlineFixPath += 1;
    } else if (typeof v.suggestion === "string" && v.suggestion.length > 0) {
      proseOnlySuggestions += 1;
    }
  }
  return { editsWithInlineFixPath, proseOnlySuggestions };
}

/**
 * Tally violations by their rule-level {@link FixClass} lane,
 * additionally split per scan-kind ({@link FixesByClassLane#source}
 * vs. {@link FixesByClassLane#buildArtifact}).
 *
 * Returns the `{ mechanical, guidance, runtimeOnly, verifyInSource }`
 * shape consumed by `plan.fixesByClass` — one key per lane, each
 * carrying its own `{ source, buildArtifact }` pair. Distinct axis
 * from {@link FixCounts#editsWithInlineFixPath}: that internal
 * counter answers "does this violation ship a ready-to-apply edit?"
 * (mechanical or verify-in-source lane); this one answers "which
 * remediation lane does the rule route into?" with the same
 * per-scan-kind axis `plan.violationsByScanKind` carries at the
 * cross-lane aggregate level.
 *
 * `vendorPaths` is the build-artifact path set produced by
 * `collectBuildArtifacts` / `vendorPathSet`. Findings whose
 * `location.filePath` is in the set route to the `buildArtifact`
 * sub-key; everything else routes to `source`. Empty / omitted
 * (default) routes every finding to `source` — matching
 * {@link ../../mcp/scan-assembly#splitViolationsByScanKind}'s
 * empty-vendorPaths semantics so scopes that don't run the
 * classifier (CLI agent format, scan, scan_file, scan_diff) emit a
 * uniform `{ source: N, buildArtifact: 0 }` per lane without a
 * shape divergence.
 *
 * Cross-surface invariant pinned at the integration layer: for each
 * scan-kind X, `sum(fixesByClass[*].X) === violationsByScanKind[X]`.
 * Both surfaces filter info-severity findings out (caller passes
 * `nonNote`); the per-kind classification is the same path-set
 * membership check, so the equality holds regardless of how the
 * lanes distribute. See
 * `tests/integration/mcp-scan-project-fixes-by-class-by-scan-kind.test.ts`.
 */
export function countFixesByClass(
  violations: readonly Violation[],
  vendorPaths: ReadonlySet<string> = new Set(),
): FixesByClass {
  const counts: Record<FixClass, FixesByClassLane> = {
    mechanical: { source: 0, buildArtifact: 0 },
    guidance: { source: 0, buildArtifact: 0 },
    "runtime-only": { source: 0, buildArtifact: 0 },
    "verify-in-source": { source: 0, buildArtifact: 0 },
  };
  for (const v of violations) {
    const lane = counts[v.fixClass];
    const isBuildArtifact = vendorPaths.has(v.location.filePath);
    counts[v.fixClass] = {
      source: lane.source + (isBuildArtifact ? 0 : 1),
      buildArtifact: lane.buildArtifact + (isBuildArtifact ? 1 : 0),
    };
  }
  return {
    mechanical: counts.mechanical,
    guidance: counts.guidance,
    runtimeOnly: counts["runtime-only"],
    verifyInSource: counts["verify-in-source"],
  };
}

/**
 * Sums one {@link FixesByClassLane}'s per-scan-kind sub-tally into the
 * flat lane count. Internal helper for sites that want the
 * per-remediation-lane number (effort math, summary prose, the
 * `fixClassBreakdown` parenthetical) without forcing every consumer to
 * spell out the addition. Pure over its input.
 */
export function laneTotal(lane: FixesByClassLane): number {
  return lane.source + lane.buildArtifact;
}

interface CategoryCounts {
  readonly reviewNeeded: number;
  readonly manualOnly: number;
  readonly ruleCounts: Map<string, number>;
}

/** Tally review/manual categories and per-rule counts from pre-built findings. */
function countCategories(files: readonly AgentFile[]): CategoryCounts {
  let reviewNeeded = 0;
  let manualOnly = 0;
  const ruleCounts = new Map<string, number>();
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.category === "review") reviewNeeded += 1;
      else if (finding.category === "manual") manualOnly += 1;
      ruleCounts.set(finding.ruleId, (ruleCounts.get(finding.ruleId) ?? 0) + 1);
    }
  }
  return { reviewNeeded, manualOnly, ruleCounts };
}

/**
 * Build the {@link AgentPlan} headline from source violations and their
 * pre-built {@link AgentFile} representations.
 *
 * Splits the input violations array by `severity` into the honest
 * `violations` (error/warning) and `notes` (info) counters per CLAUDE.md
 * §1 "Composite headline counts are dishonest" — the former
 * `totalFindings` summed both lanes under one label, which inflated the
 * work agents budgeted against (a real-world scan returned
 * `totalFindings: 24772` while only `23693` were error/warning
 * violations and `1079` were info-severity notes). Effort and
 * `fixesByClass` continue to derive from the violations slice only —
 * notes carry no remediation.
 *
 * @param violations - The source violations (severity-mixed; the helper
 *   splits internally into violation/note lanes for the headline counters,
 *   then derives `fixesByClass` and effort from the error+warning slice
 *   via `fixPaths.primary.edit` / `suggestion` / `fixClass`).
 * @param files - Pre-built AgentFile array (used for per-rule counts and
 *   category tallies that derive from the finding shape).
 */
export function buildAgentPlan(
  violations: readonly Violation[],
  files: readonly AgentFile[],
): AgentPlan {
  // Split severity lanes the same way `src/mcp/tools-helpers.ts` does so
  // the agent-formatter and MCP `buildScanPlan` emit aligned headline
  // counters — agents reading either surface get one shape to budget.
  const violationsList = violations.filter((v) => v.severity !== "info");
  const notesList = violations.filter((v) => v.severity === "info");
  const violationsCount = violationsList.length;
  const notesCount = notesList.length;

  // Remediation tallies derive from the violations slice only — notes
  // are additive context and carry no fix payload.
  const { editsWithInlineFixPath, proseOnlySuggestions } = countFixes(violationsList);
  const fixesByClass = countFixesByClass(violationsList);
  const { reviewNeeded, manualOnly, ruleCounts } = countCategories(files);
  const fixCount = editsWithInlineFixPath + proseOnlySuggestions;
  const effort = computeEffort(violationsCount, fixCount);

  // The `fixClass` tally drives the summary parenthetical. It's a
  // separate axis from the internal `editsWithInlineFixPath` — that
  // one counts "what the Violation ships" (inline edit present, across
  // the mechanical and verify-in-source lanes), this one counts "what
  // the rule demands" (remediation lane). Only `fixesByClass` is
  // surfaced on the plan (the former composite headline
  // `safeEditsAvailable` was dropped per
  // Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT); the
  // `editsWithInlineFixPath` count remains internal to effort math.
  // Flatten the per-scan-kind sub-tallies for the summary parenthetical
  // — the prose breakdown describes the per-remediation-lane axis, not
  // the per-scan-kind axis (that lives in `plan.violationsByScanKind`
  // separately so the prose stays focused on one axis at a time).
  const fixClassCounts: FixClassCounts = {
    mechanical: laneTotal(fixesByClass.mechanical),
    guidance: laneTotal(fixesByClass.guidance),
    "runtime-only": laneTotal(fixesByClass.runtimeOnly),
    "verify-in-source": laneTotal(fixesByClass.verifyInSource),
  };

  const summary = buildSummary(
    violationsCount,
    fixClassCounts,
    reviewNeeded,
    manualOnly,
    ruleCounts,
  );

  // `violations` (the flat error+warning count) was dropped per
  // it summed across the four
  // `fixesByClass` lanes under a single headline, the dishonest-
  // composite pattern. Callers that want the flat count sum the
  // per-lane tally themselves.
  void violationsCount;
  return {
    notes: notesCount,
    fixesByClass,
    reviewNeeded,
    manualOnly,
    estimatedEffort: effort,
    summary,
  };
}
