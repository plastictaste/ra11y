/**
 * Per-finding confidence parity for findings emitted *beyond* the
 * recoverable parse boundary on a partial-parse file.
 *
 * Sibling of {@link import("./per-finding-confidence-parity.ts")} and
 * {@link import("./per-finding-build-artifact-confidence.ts")} — same
 * shape, narrower predicate. The companion partial-parse helper
 * already attaches `partial_parse` to every finding on a partial-
 * parsed file (file-scoped, file-wide). This helper adds one level
 * of granularity: when the parser stamps a 1-based head-error line
 * (`parsedThroughLine`) on a `partialParseFiles[]` entry, findings
 * whose `line > parsedThroughLine` were emitted from text the
 * structured parser could not reach. The static-analysis evidence
 * model is structurally bounded above the boundary; the agent
 * reading those findings deserves the additional caveat.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Parser-failure invalidates per-file confidence" — extended one
 *   level deeper. The per-rule layer downgrades because the file
 *   carries a parse error; this layer downgrades the per-finding
 *   slice that physically lives past the parser's reach. Agents
 *   that already trusted partial-parse findings get a second signal
 *   to scope their verification read short of the whole file: lines
 *   beyond `parsedThroughLine` are where the static evidence is
 *   weakest.
 *
 * Closure path picked: downgrade-not-drop. Per AI-first doctrine
 *   "Surface, don't suppress" the finding stays in the response with
 *   its full message + line + column — dropping would deny the agent
 *   the lookup point. The downgrade rides BOTH the `confidence` axis
 *   the per-rule and build-artifact passes already use AND the
 *   `severity` axis (downgrades to `"info"`) so the attention-budget
 *   signal matches the conceded uncertainty per AI-first doctrine
 *   "Reason text and severity must agree" — a finding shipping
 *   `confidence: "low"` while `severity: "error"` keeps the agent's
 *   attention budget pinned to the rule's pre-downgrade verdict,
 *   contradicting the hedged reason code on the same finding. The
 *   structured reason code joins the same `couldBeWrongBecause` axis
 *   so an agent pivoting on either field gets the consistent read.
 *
 * Scope is corpus-wide: any finding above any rule whose host file
 * has a non-zero `parsedThroughLine` AND whose `finding.line >
 * parsedThroughLine` qualifies. Unlike the build-artifact gate
 * (deliberately narrow because the predicate weakens specific rules),
 * the parse-boundary predicate names a file-physical fact — the
 * structured parser literally did not reach those lines — that
 * uniformly weakens any rule's static evidence on the recovered
 * slice. Agents reading raw-text-derived findings (regex finders that
 * emit despite the AST bail) still get the additive context as a
 * caveat to investigate; they are not forced to trust them.
 */

import type { ParsedFile } from "../engine/scanner.ts";
import type { AgentFinding, Confidence } from "../output/agent-response/types.ts";
import type { PerRuleCoverage, Severity } from "../types/violation.ts";
import { partitionParseStateFiles } from "./parse-error-adjustment.ts";
import {
  buildPerRuleLimitationMap,
  buildSubstrateFiles,
  enrichFindingsWithPerRuleLimitations,
  type FindingBucket,
} from "./per-finding-confidence-parity.ts";

/**
 * Structured `couldBeWrongBecause` token propagated when the finding's
 * line is past the parser's recovered slice. Snake_case to match the
 * existing `couldBeWrongBecause` axis vocabulary
 * (`partial_parse`, `file_parse_error`, `fragment_input_no_document_envelope`,
 * `parse_bailed_non_jsx_in_tsx_route`).
 */
const BEYOND_BOUNDARY_REASON_CODE = "beyond_partial_parse_boundary";

/**
 * Builds the per-file-path → `parsedThroughLine` map driving the
 * downgrade gate. Mirrors the predicate `recordParseErrorEntry` in
 * `src/mcp/analysis-coverage.ts` uses to populate
 * `partialParseFiles[].parsedThroughLine`:
 *
 *   - The file's parser recorded at least one error.
 *   - The head error's `position.line` is a meaningful 1-based number
 *     (`> 0`); zero or absent values are dropped per the AI-first
 *     consumer model's rule against ambiguous field shapes (no
 *     sentinel `0` for "unknown").
 *
 * No-op fast path: when no file in the input qualifies, returns an
 * empty map so the downstream walker can short-circuit. Exported as
 * a named helper so the response-assembler call site can pre-compute
 * the map once and feed both this enrichment pass and any future
 * surface that needs the same gate (e.g. a per-file scope filter).
 */
export function buildParsedThroughLineMap(
  files: readonly ParsedFile[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const f of files) {
    const headError = f.ast.errors[0];
    if (headError === undefined) continue;
    const line = headError.position.line;
    // Strict `> 0` gate — `0` is the parser's "unknown" sentinel and
    // the analysis-coverage emitter strips it before shipping
    // `parsedThroughLine` on the wire. Mirroring the same predicate
    // here keeps the per-finding downgrade aligned with what the
    // agent reads on `meta.analysisCoverage.partialParseFiles[]`:
    // when the bucket entry has no `parsedThroughLine`, the agent
    // sees no boundary value AND no per-finding `beyond_partial_parse_boundary`
    // tags — consistent shape across the surfaces.
    if (typeof line !== "number" || line <= 0) continue;
    out.set(f.filePath, line);
  }
  return out;
}

/**
 * Walks per-file findings and downgrades `confidence` to `"low"` plus
 * appends `beyond_partial_parse_boundary` to `couldBeWrongBecause` for
 * any finding whose host file is in `parsedThroughLines` AND whose
 * `line` is strictly greater than the file's `parsedThroughLine`.
 *
 * Returns the input array reference unchanged when `parsedThroughLines`
 * is empty (no-op fast path) — common case on authored-source repos
 * stays cheap. When at least one finding gets rewritten, returns a
 * fresh top-level array; unchanged buckets ride the original
 * reference.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": a finding
 * already carrying the propagated code is never duplicated — the
 * agent's `couldBeWrongBecause` array stays dedup-stable. A finding
 * already at `confidence: "low"` keeps its existing label; the
 * downgrade only fires on `"high"` / `"medium"` so we never bump
 * `"medium"` back up to `"low"` (rank-monotone).
 *
 * The boundary is strict-greater (`>`), not greater-or-equal: a
 * finding emitted exactly AT the recorded head-error line is in the
 * "parser stopped here" line itself — the structured parser visited
 * that line before failing, so the finding's evidence model is no
 * weaker than it is on lines `1..parsedThroughLine - 1`. Above the
 * boundary the parser bailed, and the predicate fires.
 */
export function enrichFindingsBeyondPartialParseBoundary<T extends FindingBucket>(
  fileEntries: readonly T[],
  parsedThroughLines: ReadonlyMap<string, number>,
): readonly T[] {
  if (parsedThroughLines.size === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    const boundary = parsedThroughLines.get(file.path);
    if (boundary === undefined) return file;
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      if (finding.line <= boundary) return finding;
      const next = applyBeyondBoundaryToFinding(finding);
      if (next !== finding) bucketMutated = true;
      return next;
    });
    if (!bucketMutated) return file;
    mutatedAny = true;
    return { ...file, findings };
  });
  return mutatedAny ? out : fileEntries;
}

/**
 * Per-finding adjuster. Returns the input `finding` reference
 * unchanged when the propagated code is already present AND the
 * confidence is already at-or-below `"low"` AND severity is already
 * at `"info"` — idempotent re-application is safe and the array
 * shape stays dedup-stable.
 *
 * Both axes downgrade together because the AI-first doctrine
 * "Reason text and severity must agree" requires the
 * attention-budget signal (`severity`) and the confidence label to
 * point the same direction. A finding emitted past the parser's
 * recovered slice has structurally weaker static evidence than the
 * rule's normal substrate; surfacing it at `severity: "error"` while
 * the same finding ships `confidence: "low"` and a `couldBeWrongBecause`
 * tag asking the agent to verify is the canonical contradiction the
 * doctrine names.
 */
function applyBeyondBoundaryToFinding(finding: AgentFinding): AgentFinding {
  const existing = finding.couldBeWrongBecause;
  const codeAlreadyPresent = existing?.includes(BEYOND_BOUNDARY_REASON_CODE) === true;
  const needsConfidenceDowngrade = confidenceRank(finding.confidence) > confidenceRank("low");
  const needsSeverityDowngrade = severityRank(finding.severity) > severityRank("info");
  if (codeAlreadyPresent && !needsConfidenceDowngrade && !needsSeverityDowngrade) return finding;
  const nextCouldBeWrongBecause = codeAlreadyPresent
    ? existing
    : existing === undefined || existing.length === 0
      ? [BEYOND_BOUNDARY_REASON_CODE]
      : [...existing, BEYOND_BOUNDARY_REASON_CODE];
  return {
    ...finding,
    ...(nextCouldBeWrongBecause === undefined
      ? {}
      : { couldBeWrongBecause: nextCouldBeWrongBecause }),
    ...(needsConfidenceDowngrade ? { confidence: "low" as const } : {}),
    ...(needsSeverityDowngrade ? { severity: "info" as const } : {}),
  };
}

/**
 * Numeric rank for `Confidence` values along the trust axis. Higher
 * rank = more trust — `"high"` is `3`. Mirrors the rank function in
 * `per-finding-confidence-parity.ts`; redefining locally keeps the
 * helper dependency-free without import noise. `"inherited"` (ADR
 * 0012) returns `0` so the gate never targets it for downgrade — its
 * wrapper-derived semantics are out of scope for this propagation.
 */
function confidenceRank(c: Confidence): number {
  if (c === "high") return 3;
  if (c === "medium") return 2;
  if (c === "low") return 1;
  return 0;
}

/**
 * Numeric rank for `Severity` values along the attention-budget axis.
 * Higher rank = more urgent. The downgrade gate fires when a finding's
 * current severity outranks `"info"`, sliding `"error"` (rank 3) and
 * `"warning"` (rank 2) down to `"info"` (rank 1) so the surfacing
 * pressure matches the conceded uncertainty captured in the
 * `couldBeWrongBecause` tag and the downgraded confidence label.
 */
function severityRank(s: Severity): number {
  if (s === "error") return 3;
  if (s === "warning") return 2;
  return 1;
}

/**
 * Composed per-finding enrichment: runs the per-rule limitation pass
 * and the per-line beyond-parse-boundary pass in order. Returns the
 * input array reference unchanged when neither pass mutates anything
 * (preserving the upstream no-op fast paths).
 *
 * Bundled here so the legacy `runScanAndFormat` call site in
 * `tools-helpers.ts` stays under the file-line budget; the
 * response-assembler call site already has the two passes inline
 * because it threads additional substrate sets (parser-bail-route,
 * code-demo-prop) between and after them.
 */
export function enrichFindingsWithFullPerFileSubstrate<T extends FindingBucket>(args: {
  readonly fileEntries: readonly T[];
  readonly adjustedPerRuleCoverage: readonly PerRuleCoverage[];
  readonly files: readonly ParsedFile[];
  readonly violationFilePaths: ReadonlySet<string>;
  readonly fragmentFiles: readonly string[];
  /**
   * Optional astro-island file list (typically from
   * {@link import("./scan-assembly-astro-islands.ts").detectAstroIslandsUnrenderedFiles}).
   * Default empty so legacy callers stay backward-compatible — the
   * per-finding gate then denies attaching the
   * `astro_islands_unrendered_static_only` substrate code (per the
   * safer half of the asymmetric failure modes).
   */
  readonly astroIslandUnrenderedFiles?: readonly string[];
}): readonly T[] {
  const {
    fileEntries,
    adjustedPerRuleCoverage,
    files,
    violationFilePaths,
    fragmentFiles,
    astroIslandUnrenderedFiles = [],
  } = args;
  const perRuleLimitations = buildPerRuleLimitationMap(adjustedPerRuleCoverage);
  const substrate = buildSubstrateFiles(
    partitionParseStateFiles(files, violationFilePaths),
    fragmentFiles,
    [],
    astroIslandUnrenderedFiles,
  );
  const perRuleEnriched = enrichFindingsWithPerRuleLimitations(
    fileEntries,
    perRuleLimitations,
    substrate,
  );
  return enrichFindingsBeyondPartialParseBoundary(
    perRuleEnriched,
    buildParsedThroughLineMap(files),
  );
}
