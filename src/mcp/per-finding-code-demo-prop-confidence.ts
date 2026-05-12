/**
 * Per-finding `couldBeWrongBecause` propagation and attention-budget
 * downgrade for findings emitted inside MDX code-demo prop bodies.
 *
 * Sibling of {@link import("./per-finding-build-artifact-confidence.ts")},
 * {@link import("./per-finding-confidence-parity.ts")}, and
 * {@link import("./per-finding-beyond-parse-boundary.ts")} — same
 * write-through shape, different evidence axis. Where the build-
 * artifact pass keys on per-FILE classification (the file is generated
 * bytes), and the per-rule-limitations pass keys on per-RULE coverage
 * degradation, and the beyond-parse-boundary pass keys on a per-LINE
 * physical fact about parser reach, this pass keys on per-LOCATION
 * evidence: a specific `(filePath, line)` falls inside an MDX docs-
 * component code-demo prop's template-literal body the parser
 * descended into.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Reason text and severity must agree." When a rule emits inside an
 *   MDX docs-component code-demo prop's template-literal body, the
 *   parser descended into rhetorical-preview substrate — the markup is
 *   structurally what the rule names, but the framing is "documentation
 *   shows a pattern, please verify before fixing." Two rules
 *   (`navigation/href-empty-fragment`, `navigation/href-javascript-scheme`)
 *   already hedge their per-finding `suggestion` prose with `inside …
 *   — likely demonstration code, verify the anchor renders for real
 *   users before fixing`; every other rule firing inside the same
 *   substrate ships at `severity: error, confidence: high` with no
 *   hedge — rule-family-uniformity drift the closure resolves at the
 *   assembly site (one predicate, every rule family) rather than per-
 *   rule guards.
 *
 *   Closure: when a finding's `(filePath, line)` falls inside a recorded
 *   code-demo prop body line range, downgrade `severity` to `"info"`
 *   AND `confidence` to `"low"` so the attention-budget signal matches
 *   the conceded uncertainty captured in the `couldBeWrongBecause`
 *   token. The token (`template_literal_in_code_demo_prop`) is added to
 *   the curated {@link import("./manual-criteria-tally.ts").VERIFY_IN_SOURCE_TOKENS}
 *   set so the verify-in-source slice of the `actionableManualItems`
 *   counter picks up these downgraded findings and the cross-surface
 *   actionable invariant stays honest. The finding stays on the wire
 *   (no suppression) — per AI-first doctrine "Surface, don't suppress":
 *   the markup IS structurally what the rule's predicate names; the
 *   downgrade only moves attention-budget signal so the agent reads
 *   "please verify in source" rather than "deterministic failure."
 *
 * Predicate strength: deterministic. The MDX adapter has already
 * descended (synthesized JSX elements pinned to MDX-source positions);
 * the `(bodyStartLine, bodyEndLine)` range is a proven fact about
 * THIS scan, not a heuristic guess. No `severity` / `confidence`
 * downgrade fires on findings outside any recorded body range — the
 * per-FILE corpus-warning pass ({@link import("./per-finding-corpus-warning-files.ts")})
 * handles the file-wide confidence-only step on findings outside the
 * body but on the same MDX file.
 */

import { CODE_DEMO_PROP_REASON_CODE } from "../input/parsers/mdx-example-extractor.ts";
import type { AgentFinding, Confidence } from "../output/agent-response/types.ts";
import type { Severity } from "../types/violation.ts";
import type { FindingBucket } from "./per-finding-confidence-parity.ts";
import type { WarningInputs } from "./warnings.ts";

/**
 * Walks per-file findings and, for any finding whose `(filePath, line)`
 * falls inside one of the recorded code-demo prop body line ranges:
 *
 *   1. Appends {@link CODE_DEMO_PROP_REASON_CODE} to `couldBeWrongBecause`
 *      (dedup-stable — never duplicates).
 *   2. Downgrades `severity` to `"info"` when the current value outranks
 *      it (`"error"` / `"warning"` slide down).
 *   3. Downgrades `confidence` to `"low"` when the current value outranks
 *      it (`"high"` / `"medium"` slide down).
 *
 * Returns the input array reference unchanged when the matches map is
 * empty (no-op fast path) — the common case on non-MDX repos pays no
 * walk.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": a finding
 * already carrying every targeted change (code present, severity at-or-
 * below `"info"`, confidence at-or-below `"low"`) is returned unchanged;
 * the per-finding shape stays dedup-stable across multiple enrichment
 * passes.
 *
 * Returns a fresh top-level array when any finding was rewritten;
 * unchanged buckets ride the original reference. Same shape contract
 * as {@link import("./per-finding-beyond-parse-boundary.ts").enrichFindingsBeyondPartialParseBoundary}
 * so the response-assembler seam can chain enrichment passes.
 */
export function enrichFindingsWithCodeDemoPropMatch<T extends FindingBucket>(
  fileEntries: readonly T[],
  matches: WarningInputs["codeDemoPropMatches"],
): readonly T[] {
  if (matches === undefined || matches.size === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    const perFile = matches.get(file.path);
    if (perFile === undefined || perFile.length === 0) return file;
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      if (!findingFallsInsideAnyMatch(finding.line, perFile)) return finding;
      const next = applyCodeDemoPropToFinding(finding);
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
 * Per-finding adjuster. Returns the input `finding` reference unchanged
 * when the propagated code is already present AND severity is already
 * at-or-below `"info"` AND confidence is already at-or-below `"low"` —
 * idempotent re-application is safe and the array shape stays dedup-
 * stable.
 *
 * Both `severity` and `confidence` downgrade together with the reason-
 * code append because the AI-first doctrine "Reason text and severity
 * must agree" requires the attention-budget signal (`severity`), the
 * trust label (`confidence`), and the reason text to point the same
 * direction. A finding emitted inside an MDX code-demo prop's template
 * literal lives in rhetorical-preview substrate; surfacing it at
 * `severity: "error", confidence: "high"` while the same finding ships
 * a `couldBeWrongBecause` tag asking the agent to verify the substrate
 * is the canonical contradiction the doctrine names.
 */
function applyCodeDemoPropToFinding(finding: AgentFinding): AgentFinding {
  const existing = finding.couldBeWrongBecause;
  const codeAlreadyPresent = existing?.includes(CODE_DEMO_PROP_REASON_CODE) === true;
  const needsSeverityDowngrade = severityRank(finding.severity) > severityRank("info");
  const needsConfidenceDowngrade = confidenceRank(finding.confidence) > confidenceRank("low");
  if (codeAlreadyPresent && !needsSeverityDowngrade && !needsConfidenceDowngrade) return finding;
  const nextCouldBeWrongBecause = codeAlreadyPresent
    ? existing
    : existing === undefined || existing.length === 0
      ? [CODE_DEMO_PROP_REASON_CODE]
      : [...existing, CODE_DEMO_PROP_REASON_CODE];
  return {
    ...finding,
    ...(nextCouldBeWrongBecause === undefined
      ? {}
      : { couldBeWrongBecause: nextCouldBeWrongBecause }),
    ...(needsSeverityDowngrade ? { severity: "info" as const } : {}),
    ...(needsConfidenceDowngrade ? { confidence: "low" as const } : {}),
  };
}

/**
 * True when `line` falls inside the inclusive `[bodyStartLine,
 * bodyEndLine]` range of any recorded match. Linear scan over the
 * per-file matches; `perFile.length` is bounded by the number of
 * `<Example|Demo|Playground>` elements in the file (typically <10 on
 * real-world docs), so the cost is acceptable per finding.
 */
function findingFallsInsideAnyMatch(
  line: number,
  perFile: readonly {
    readonly bodyStartLine: number;
    readonly bodyEndLine: number;
  }[],
): boolean {
  for (const match of perFile) {
    if (line >= match.bodyStartLine && line <= match.bodyEndLine) return true;
  }
  return false;
}

/**
 * Numeric rank for `Severity` values along the attention-budget axis.
 * Higher rank = more urgent. The downgrade gate fires when a finding's
 * current severity outranks `"info"`, sliding `"error"` (rank 3) and
 * `"warning"` (rank 2) down to `"info"` (rank 1) so the surfacing
 * pressure matches the conceded uncertainty the code-demo substrate
 * carries.
 */
function severityRank(s: Severity): number {
  if (s === "error") return 3;
  if (s === "warning") return 2;
  return 1;
}

/**
 * Numeric rank for `Confidence` values along the trust axis. Higher
 * rank = more trust — `"high"` is `3`. Mirrors the rank function in
 * `per-finding-confidence-parity.ts` / `per-finding-beyond-parse-boundary.ts`;
 * redefining locally keeps the helper dependency-free without import
 * noise. `"inherited"` (ADR 0012) returns `0` so the gate never
 * targets it for downgrade — its wrapper-derived semantics are out of
 * scope for this propagation.
 */
function confidenceRank(c: Confidence): number {
  if (c === "high") return 3;
  if (c === "medium") return 2;
  if (c === "low") return 1;
  return 0;
}
