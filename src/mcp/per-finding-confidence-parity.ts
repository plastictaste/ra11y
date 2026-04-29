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
 *     `file-parse-error`, `partial-parse`, `scss-unresolved-variables`,
 *     `fragment-input-no-document-envelope`) wins when present — it
 *     names a substrate-level cause stronger than the rule-family code.
 *   - `reason` (rule-family snake_case code:
 *     `cross_file_listener_resolution_not_attempted_by_rule`,
 *     `cross_file_idref_resolution_not_attempted_by_rule`, …) is used
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
 * Two routes contribute an entry:
 *
 *   1. Aggregate-degraded rules — `coverageConfidence !== "high"` AND
 *      a non-empty reason source. Substrate-level codes
 *      (`coverageConfidenceReason`) win over rule-family codes
 *      (`reason`) when both are present.
 *   2. Aggregate-clean rules with per-file degradation — `byFile` is
 *      non-empty. The aggregate scalar stays `"high"` because the
 *      rule has clean evidence horizon at the corpus level (Q9
 *      doctrine), but per-finding emissions on the bounded files
 *      still need the file-scoped substrate code propagated. The map
 *      entry uses the most-severe `byFile.reason` as the code source
 *      — `file-parse-error` wins over `partial-parse` (the same
 *      precedence the aggregate adjuster uses when both apply on the
 *      same row). The downstream
 *      {@link FILE_SCOPED_PARSE_STATE_CODES} gate then attaches the
 *      code only to findings whose path is in the parse-state sets,
 *      so clean-file findings on the same rule stay unannotated —
 *      matching the per-file-not-corpus-wide invariant.
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
    if (row.coverageConfidence !== "high") {
      const code = resolveReasonCode(row);
      if (code !== undefined) out.set(row.ruleId, code);
      continue;
    }
    // Aggregate stays high — but the rule may carry per-file
    // degradation in `byFile` that still needs propagating. Use the
    // most-severe per-file reason: file-parse-error > partial-parse.
    if (row.byFile === undefined || row.byFile.length === 0) continue;
    const hasParseError = row.byFile.some((e) => e.reason === "file-parse-error");
    const code = hasParseError ? "file_parse_error" : "partial_parse";
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
 * File-scoped substrate codes whose propagation must gate on the
 * finding's own file-path membership in the corresponding parse-state
 * set. Other reason codes (rule-family
 * `cross_file_*_not_attempted_by_rule` variants,
 * `scss_unresolved_variables`, `fragment_input_no_document_envelope`)
 * describe a corpus-level limitation on the rule's evidence model and
 * propagate to every finding the rule emitted on this scan; these two
 * describe a per-file parse failure and only apply to findings on the
 * specific file that failed to parse.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Per-finding confidence must reflect per-rule coverage limitations."
 *
 * Without the gate, a rule whose gate matched both a clean file and a
 * parse-errored file (and emitted findings on both) would attach the
 * substrate code to every finding from the rule, including the one on
 * the cleanly-parsed file — corpus-wide rather than file-scoped. The
 * clean-file finding would then read as "low-confidence because the
 * parser failed" when the parser actually cleared on its file.
 */
const FILE_SCOPED_PARSE_STATE_CODES = new Set<string>(["file_parse_error", "partial_parse"]);

/**
 * Optional file-path sets the propagation helper consults to gate the
 * `file_parse_error` / `partial_parse` substrate codes on file
 * membership. Both sets are populated by
 * {@link import("./scan-assembly.ts").partitionParseStateFiles} so the
 * per-rule adjuster and the per-finding propagation share the same
 * predicate.
 *
 * Caller passes `undefined` (or omits the argument) to keep the
 * pre-gate behavior — the helper then propagates every code corpus-
 * wide, matching the legacy shape. Used by call sites that don't have
 * the parsed-file inputs in scope (no current production caller, but
 * the optional shape keeps the seam additive for tests / fixtures).
 */
export interface ParseStateFiles {
  readonly parseError: ReadonlySet<string>;
  readonly partialParse: ReadonlySet<string>;
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
 * File-scoped gate: when the propagated code is in
 * {@link FILE_SCOPED_PARSE_STATE_CODES} AND `parseStateFiles` is
 * supplied, the helper attaches the code only to findings whose file
 * path is in `parseError ∪ partialParse`. Other codes (rule-family
 * cross-file limitations, scss-unresolved-variables, fragment-input)
 * describe a corpus-level evidence limitation and propagate to every
 * finding the rule emitted, regardless of file.
 *
 * Returns a fresh top-level array when any finding was rewritten;
 * unchanged buckets ride the original reference.
 */
export function enrichFindingsWithPerRuleLimitations<T extends FindingBucket>(
  fileEntries: readonly T[],
  perRuleLimitations: ReadonlyMap<string, string>,
  parseStateFiles?: ParseStateFiles,
): readonly T[] {
  if (perRuleLimitations.size === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    const fileScopedParseStateCodeAllowed = isFileInParseStateSets(file.path, parseStateFiles);
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      const code = perRuleLimitations.get(finding.ruleId);
      if (code === undefined) return finding;
      // File-scoped gate: parse-state codes only attach to findings on
      // files in `parseError ∪ partialParse`. Other codes (corpus-level
      // evidence limitations) propagate unconditionally.
      if (FILE_SCOPED_PARSE_STATE_CODES.has(code) && !fileScopedParseStateCodeAllowed) {
        return finding;
      }
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

/**
 * Returns whether the given file path is in either parse-state set.
 * When the caller didn't supply `parseStateFiles` (legacy / fixture
 * test paths that don't thread the parsed-file partition through),
 * returns `true` so the helper falls back to the pre-gate corpus-wide
 * propagation — additive over the existing call shape.
 */
function isFileInParseStateSets(
  path: string,
  parseStateFiles: ParseStateFiles | undefined,
): boolean {
  if (parseStateFiles === undefined) return true;
  return parseStateFiles.parseError.has(path) || parseStateFiles.partialParse.has(path);
}
