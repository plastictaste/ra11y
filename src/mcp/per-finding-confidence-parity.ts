/**
 * Per-finding confidence parity with per-rule coverage limitations.
 *
 * When `meta.perRuleCoverage[ruleId].coverageConfidence !== "high"`, the
 * agent reading scan-confidence telemetry sees one signal: "this rule's
 * evidence horizon was bounded on this corpus." When that same rule's
 * per-finding emissions ship at `confidence: "high"` in `files[]`, the
 * agent reads the opposite signal per finding — the per-rule label and
 * the per-finding label contradict each other in the same response, the
 * same shape as "Reason text and severity must agree" but at a different
 * layer of the response.
 *
 * Closure path (option b — additive, smaller blast radius): when a rule
 * is degraded at the per-rule level, propagate the degradation reason
 * into each finding's `couldBeWrongBecause` array. Per-finding
 * `confidence` stays whatever the rule emitted; the cross-file caveat
 * the agent needs to triage with is now present at every layer it might
 * read. Conditional spread on emission so empty `couldBeWrongBecause`
 * arrays never reach the wire (CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest").
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Per-finding confidence must reflect per-rule coverage limitations."
 *
 * The reason code propagated comes from one of two per-rule fields:
 *   - `coverageConfidenceReason` (parser/substrate-level enum:
 *     `file-parse-error`, `partial-parse`, `scss-unresolved-variables`)
 *     wins when present — it names a substrate-level cause stronger than
 *     the rule-family code.
 *   - `reason` (rule-family snake_case code:
 *     `cross_file_listener_resolution_limited_on_this_input`,
 *     `cross_file_idref_resolution_limited_on_this_input`, …) is used
 *     otherwise.
 *
 * Both are normalized to a snake_case axis the agent can pattern-match
 * on. Substrate codes use kebab-case in the underlying field; this helper
 * snake_cases them for emission so the wire shape is uniform across the
 * `couldBeWrongBecause` axis.
 *
 * No-op fast path: when no rule in the input is degraded, returns the
 * input array reference unchanged. When a rule is degraded but a given
 * finding's existing `couldBeWrongBecause` already contains the
 * propagated code, the finding is returned unchanged — agents that
 * search the array for a code don't see duplicates.
 */

import type { AgentFinding } from "../output/agent-response/types.ts";
import type { PerRuleCoverage } from "../types/violation.ts";

/**
 * Minimal per-file bucket shape the helper writes through. Covers both
 * `AssembledFile` (response-assembler seam) and the structural-equivalent
 * shape carried on `ScanFormatted.files` (legacy `tools-helpers.ts`
 * path), so both wiring sites can route through the same enrichment
 * without an adapter.
 */
export interface FindingBucket {
  readonly path: string;
  readonly findings: readonly AgentFinding[];
}

/**
 * Builds the rule-ID → reason-code map from per-rule coverage rows.
 * Only rules whose `coverageConfidence !== "high"` AND that carry a
 * non-empty reason source contribute an entry. Substrate-level codes
 * (`coverageConfidenceReason`) win over rule-family codes (`reason`)
 * when both are present — substrate is the stronger signal.
 *
 * Substrate codes are snake_cased on the way out so callers don't have
 * to mix kebab and snake conventions when emitting on the
 * `couldBeWrongBecause` axis.
 */
export function buildPerRuleLimitationMap(
  rows: readonly PerRuleCoverage[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.coverageConfidence === "high") continue;
    const code = resolveReasonCode(row);
    if (code === undefined) continue;
    out.set(row.ruleId, code);
  }
  return out;
}

/**
 * Picks the reason code to propagate from a single per-rule row.
 * `coverageConfidenceReason` wins (substrate-level), otherwise the
 * rule-family `reason` is used as-is when it's already snake_case
 * (rules emit codes via `crossFileBoundReason`); free-form prose
 * `reason` strings (e.g. the level-gated `"gated_by_level: rule
 * requires …"`) skip — they're agent-readable on `meta.perRuleCoverage`
 * already, and propagating a long sentence into per-finding
 * `couldBeWrongBecause` would dilute the structured-code axis the
 * field exists to surface.
 */
function resolveReasonCode(row: PerRuleCoverage): string | undefined {
  if (row.coverageConfidenceReason !== undefined) {
    return snakeCase(row.coverageConfidenceReason);
  }
  if (row.reason === undefined) return undefined;
  // Heuristic: structured codes are snake_case (no spaces, no colons,
  // no leading capital). Anything else is human prose and stays out of
  // the per-finding wire — agents that want it read `meta.perRuleCoverage`.
  if (isStructuredCode(row.reason)) return row.reason;
  return undefined;
}

/**
 * Predicate for a structured snake_case code — no whitespace, no
 * colons (which would smuggle prose like `gated_by_level: rule …`
 * through), and at least one underscore (free-standing single tokens
 * like a rule ID could pass otherwise). Defensive — the rule-family
 * codes the producer emits all clear this bar.
 */
function isStructuredCode(s: string): boolean {
  if (/\s/u.test(s)) return false;
  if (s.includes(":")) return false;
  if (!s.includes("_")) return false;
  return true;
}

/**
 * Normalizes a kebab-case substrate code (`file-parse-error`) to
 * snake_case (`file_parse_error`) so the `couldBeWrongBecause` axis
 * stays uniform. Idempotent on already-snake codes.
 */
function snakeCase(code: string): string {
  return code.replaceAll("-", "_");
}

/**
 * Walks per-file findings and propagates per-rule degradation reason
 * codes into each finding's `couldBeWrongBecause` array. Returns the
 * input array reference unchanged when no rule is degraded
 * (no-op fast path) — common case stays cheap.
 *
 * Per CLAUDE.md §1 "Ambiguous field shapes are dishonest": when a
 * finding has no existing `couldBeWrongBecause` AND no reason to
 * propagate, the field stays absent. When a finding already carries
 * the propagated code, the finding is returned unchanged — duplicate
 * codes would force the agent to dedupe on read.
 *
 * Returns a fresh top-level array when any finding was rewritten;
 * unchanged buckets ride the original reference.
 */
export function enrichFindingsWithPerRuleLimitations<T extends FindingBucket>(
  fileEntries: readonly T[],
  perRuleLimitations: ReadonlyMap<string, string>,
): readonly T[] {
  if (perRuleLimitations.size === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      const code = perRuleLimitations.get(finding.ruleId);
      if (code === undefined) return finding;
      const existing = finding.couldBeWrongBecause;
      if (existing?.includes(code)) return finding;
      bucketMutated = true;
      const next: AgentFinding = {
        ...finding,
        couldBeWrongBecause:
          existing === undefined || existing.length === 0 ? [code] : [...existing, code],
      };
      return next;
    });
    if (!bucketMutated) return file;
    mutatedAny = true;
    return { ...file, findings };
  });
  return mutatedAny ? out : fileEntries;
}
