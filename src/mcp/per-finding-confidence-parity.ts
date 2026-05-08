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
 * Closure: when a rule is degraded at the per-rule level, propagate the
 * degradation reason into each finding's `couldBeWrongBecause` array
 * (path b — additive, doesn't move attention-budget signal) AND
 * downgrade the per-finding `confidence` to match the per-rule label
 * (path a — keeps the attention-budget channel honest). Both paths
 * close the contradiction at different layers; doing both gives the
 * agent a uniform read regardless of whether it pivots on
 * `couldBeWrongBecause` or `confidence`. Conditional spread on emission
 * so empty `couldBeWrongBecause` arrays never reach the wire (CLAUDE.md
 * §1 "Ambiguous field shapes are dishonest").
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

import type { AgentFinding, Confidence } from "../output/agent-response/types.ts";
import type { PerRuleCoverage } from "../types/violation.ts";

/**
 * Per-rule limitation entry. The `code` is the snake_case reason
 * propagated into per-finding `couldBeWrongBecause`; the
 * `targetConfidence` is the per-rule scalar the per-finding
 * `confidence` should be downgraded to match (per the Q15 closure of
 * "Per-finding confidence must reflect per-rule coverage limitations").
 *
 * `targetConfidence` is `"medium" | "low"` only — never `"high"`,
 * because a rule whose aggregate stayed `"high"` does not need
 * downgrading at the per-finding layer. For aggregate-degraded rules
 * the value mirrors the per-rule scalar. For per-file-degraded rules
 * (aggregate stays `"high"`, `byFile` non-empty), the value is the
 * worst per-file confidence in `byFile`. The downstream
 * {@link FILE_SCOPED_SUBSTRATE_CODES} gate then attaches the
 * downgrade only to findings whose path is in the parse-state sets,
 * so clean-file findings on the same rule keep their original
 * confidence — matching the per-file-not-corpus-wide invariant.
 */
export interface PerRuleLimitation {
  readonly code: string;
  readonly targetConfidence: "medium" | "low";
}

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
): ReadonlyMap<string, PerRuleLimitation> {
  const out = new Map<string, PerRuleLimitation>();
  for (const row of rows) {
    if (row.coverageConfidence !== "high") {
      const code = resolveReasonCode(row);
      if (code !== undefined) {
        out.set(row.ruleId, {
          code,
          targetConfidence: row.coverageConfidence,
        });
      }
      continue;
    }
    // Aggregate stays high — but the rule may carry per-file
    // degradation in `byFile` that still needs propagating. Use the
    // most-severe per-file reason: file-parse-error > partial-parse >
    // parse-bailed-non-jsx-in-tsx-route. Parse-error is the strongest
    // signal (file invisible to rules); partial-parse next (recovered
    // AST but degraded); route-bail last (file routed through suspect
    // parser, no recorded errors).
    if (row.byFile === undefined || row.byFile.length === 0) continue;
    const hasParseError = row.byFile.some((e) => e.reason === "file-parse-error");
    const hasPartialParse = row.byFile.some((e) => e.reason === "partial-parse");
    const code = hasParseError
      ? "file_parse_error"
      : hasPartialParse
        ? "partial_parse"
        : "parse_bailed_non_jsx_in_tsx_route";
    // Worst per-file confidence in `byFile` — for aggregate-clean rules
    // with file-scoped degradation, findings on those files still need
    // to downgrade per-finding confidence to match the per-file label
    // the agent sees on `byFile[i].confidence`. The {@link
    // FILE_SCOPED_SUBSTRATE_CODES} gate ensures only findings on the
    // affected file get the downgrade; clean-file findings keep their
    // original confidence per the per-file-not-corpus-wide invariant.
    const worstByFile = pickWorstByFileConfidence(row.byFile);
    out.set(row.ruleId, { code, targetConfidence: worstByFile });
  }
  return out;
}

/**
 * Picks the worst (lowest-trust) confidence in a `byFile` list. The
 * type contract restricts entries to `"high" | "medium" | "low"` — but
 * a `byFile` entry would never carry `"high"` (the file is in the
 * degraded set), so this always returns `"medium"` or `"low"`. Defensive
 * fallback to `"medium"` if every entry's confidence is `"high"`
 * (degenerate but type-permissible).
 */
function pickWorstByFileConfidence(
  entries: readonly { readonly confidence: "high" | "medium" | "low" }[],
): "medium" | "low" {
  let worst: "medium" | "low" = "medium";
  for (const entry of entries) {
    if (entry.confidence === "low") return "low";
    if (entry.confidence === "medium") worst = "medium";
  }
  return worst;
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
 * Substrate sets on {@link ParseStateFiles} a file-scoped code can
 * gate against. Each entry in {@link FILE_SCOPED_SUBSTRATE_CODES}
 * names one of these so the helper looks up the right file set.
 */
type FileScopedSubstrateSet = "parseError" | "partialParse" | "fragment" | "parserBailRoute";

/**
 * File-scoped substrate codes whose propagation must gate on the
 * finding's own file-path membership in the corresponding substrate
 * set. Other reason codes (rule-family
 * `cross_file_*_not_attempted_by_rule` variants,
 * `scss_unresolved_variables`, `scss_partial_input`) describe a
 * corpus-level limitation on the rule's evidence model and propagate
 * to every finding the rule emitted on this scan; the codes named
 * here describe a per-file substrate property and only apply to
 * findings on files that carry it.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Per-finding confidence must reflect per-rule coverage limitations."
 *
 * Without the gate, a rule whose gate matched both a clean file and a
 * substrate-affected file (and emitted findings on both) would attach
 * the substrate code to every finding from the rule, including the
 * one on the unaffected file — corpus-wide rather than file-scoped.
 * The unaffected-file finding would then carry a substrate code that
 * contradicts the file's actual classification on
 * `meta.analysisCoverage` (the canonical Q13 case: a finding on a
 * full `.html` document carrying `fragment_input_no_document_envelope`
 * while `meta.analysisCoverage.fragmentFiles[]` lists only an
 * unrelated markdown-residue file). The shared classifier in
 * `src/engine/layout-partial.ts` is the single source of truth for
 * fragment classification; the `fragment` set passed in here is
 * `analysisCoverage.fragmentFiles`'s file list, so the per-rule
 * downgrade and the per-finding propagation see the same set.
 *
 * The map keys each file-scoped code to the substrate-set name on
 * {@link ParseStateFiles} that gates it. Codes not in this map
 * propagate corpus-wide.
 */
const FILE_SCOPED_SUBSTRATE_CODES: ReadonlyMap<string, FileScopedSubstrateSet> = new Map<
  string,
  FileScopedSubstrateSet
>([
  ["file_parse_error", "parseError"],
  ["partial_parse", "partialParse"],
  ["fragment_input_no_document_envelope", "fragment"],
  ["parse_bailed_non_jsx_in_tsx_route", "parserBailRoute"],
]);

/**
 * Optional file-path sets the propagation helper consults to gate
 * file-scoped substrate codes on file membership. The parse-state
 * sets are populated by
 * {@link import("./parse-error-adjustment.ts").partitionParseStateFiles}
 * and the fragment set by
 * {@link import("./scan-assembly.ts").detectFragmentFiles}, so the
 * per-rule adjuster and the per-finding propagation share the same
 * predicate via the shared classifier in
 * `src/engine/layout-partial.ts`.
 *
 * `fragment` is optional so legacy / fixture callers that don't
 * populate it stay backward-compatible — when absent, the helper
 * treats it as the empty set, so `fragment_input_no_document_envelope`
 * never re-attaches to a finding whose file isn't a known fragment
 * (the per-finding code stays as the rule emitted it; corpus-wide
 * propagation stops at this code).
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
  readonly fragment?: ReadonlySet<string>;
  /**
   * Optional file-path set the propagation helper consults to gate the
   * `parse_bailed_non_jsx_in_tsx_route` substrate code on file
   * membership. Populated by
   * {@link import("./parser-bail-route-adjustment.ts").collectParserBailedRouteFiles}
   * — the same evidence the per-rule adjuster used to populate
   * `byFile[]` entries with `reason: "parse-bailed-non-jsx-in-tsx-route"`.
   * When omitted, the gate denies attaching the code (safer half of
   * the asymmetric failure modes — no false attribution of a substrate
   * code to a file the predicate didn't fire on).
   */
  readonly parserBailRoute?: ReadonlySet<string>;
}

/**
 * Convenience constructor: combines a `partitionParseStateFiles`
 * result with a fragment file list (typically from
 * `detectFragmentFiles`) and a parser-bail-route file list (typically
 * from `collectParserBailedRouteFiles`) into a {@link ParseStateFiles}.
 * Lets call sites use a single line at the propagation seam without
 * inlining the spread + `new Set(...)` boilerplate.
 *
 * The bail-route argument is optional so legacy / fixture callers
 * stay backward-compatible — when omitted, the `parserBailRoute` set
 * is left undefined and the gate denies attaching the
 * `parse_bailed_non_jsx_in_tsx_route` code (per the safer half of
 * the asymmetric failure modes).
 */
export function buildSubstrateFiles(
  parsed: { readonly parseError: ReadonlySet<string>; readonly partialParse: ReadonlySet<string> },
  fragmentFiles: readonly string[],
  parserBailRouteFiles: readonly string[] = [],
): ParseStateFiles {
  return {
    ...parsed,
    fragment: new Set(fragmentFiles),
    ...(parserBailRouteFiles.length > 0 ? { parserBailRoute: new Set(parserBailRouteFiles) } : {}),
  };
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
 * {@link FILE_SCOPED_SUBSTRATE_CODES} AND `parseStateFiles` is
 * supplied, the helper attaches the code only to findings whose file
 * path is in the corresponding substrate set (`parseError` /
 * `partialParse` / `fragment`). Other codes (rule-family cross-file
 * limitations, scss-unresolved-variables, scss-partial-input)
 * describe a corpus-level evidence limitation and propagate to every
 * finding the rule emitted, regardless of file.
 *
 * Returns a fresh top-level array when any finding was rewritten;
 * unchanged buckets ride the original reference.
 */
export function enrichFindingsWithPerRuleLimitations<T extends FindingBucket>(
  fileEntries: readonly T[],
  perRuleLimitations: ReadonlyMap<string, PerRuleLimitation>,
  parseStateFiles?: ParseStateFiles,
): readonly T[] {
  if (perRuleLimitations.size === 0) return fileEntries;
  let mutatedAny = false;
  const out = fileEntries.map((file) => {
    let bucketMutated = false;
    const findings = file.findings.map((finding) => {
      const next = applyPerRuleLimitationToFinding(
        finding,
        file.path,
        perRuleLimitations,
        parseStateFiles,
      );
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
 * Per-finding adjuster — extracts the limitation-propagation logic into a
 * dedicated helper so the per-bucket walker stays under Biome's cognitive-
 * complexity ceiling. Returns the input `finding` reference unchanged when
 * no propagation applies (no limitation, file-scoped gate denies, or both
 * the code and confidence are already at-or-past their targets).
 *
 * Per-finding confidence downgrade: when the rule's per-rule label dropped
 * below `"high"`, every per-finding emission from that rule shipping at
 * `confidence: "high"` contradicts the per-rule label and forces the agent
 * to reconcile silently. Downgrade to match the per-rule scalar. Don't
 * override already-degraded findings (`"medium"` / `"low"`) — they're
 * already at-or-below the target. Don't override `"inherited"` — it
 * carries special wrapper-derived semantics per ADR 0012.
 */
function applyPerRuleLimitationToFinding(
  finding: AgentFinding,
  filePath: string,
  perRuleLimitations: ReadonlyMap<string, PerRuleLimitation>,
  parseStateFiles: ParseStateFiles | undefined,
): AgentFinding {
  const limitation = perRuleLimitations.get(finding.ruleId);
  if (limitation === undefined) return finding;
  const { code, targetConfidence } = limitation;
  // File-scoped gate: codes named in `FILE_SCOPED_SUBSTRATE_CODES` attach
  // only to findings whose file path is in the named substrate set. Other
  // codes (corpus-level evidence limitations) propagate unconditionally.
  if (!isFileInSubstrateSetForCode(filePath, code, parseStateFiles)) return finding;
  const existing = finding.couldBeWrongBecause;
  const codeAlreadyPresent = existing?.includes(code) === true;
  const confidenceNeedsDowngrade =
    finding.confidence === "high" &&
    confidenceRank(targetConfidence) < confidenceRank(finding.confidence);
  if (codeAlreadyPresent && !confidenceNeedsDowngrade) return finding;
  const nextCouldBeWrongBecause = computeNextCouldBeWrongBecause(
    existing,
    code,
    codeAlreadyPresent,
  );
  return {
    ...finding,
    ...(nextCouldBeWrongBecause === undefined
      ? {}
      : { couldBeWrongBecause: nextCouldBeWrongBecause }),
    ...(confidenceNeedsDowngrade ? { confidence: targetConfidence } : {}),
  };
}

/**
 * Helper: compute the new `couldBeWrongBecause` array for a finding that
 * needs propagation. Returns the existing array unchanged when the code
 * is already present; otherwise appends the code (or seeds a fresh array
 * when the field was empty/absent). Returning `undefined` is impossible
 * here — every branch produces a defined array — but the caller's spread
 * still uses the conditional shape so the wire shape stays honest if
 * future call sites widen the contract.
 */
function computeNextCouldBeWrongBecause(
  existing: readonly string[] | undefined,
  code: string,
  codeAlreadyPresent: boolean,
): readonly string[] | undefined {
  if (codeAlreadyPresent) return existing;
  if (existing === undefined || existing.length === 0) return [code];
  return [...existing, code];
}

/**
 * Numeric rank for `Confidence` values along the trust axis. Higher
 * rank = more trust ({@link Confidence} `"high"` is `3`). Used to gate
 * the per-finding downgrade: a finding at `"high"` must downgrade to
 * `"medium"` or `"low"` when the per-rule label is degraded; a finding
 * already at `"medium"` or `"low"` stays put. `"inherited"` returns
 * `0` so the gate never targets it for downgrade — its wrapper-derived
 * semantics are out of scope for this propagation (ADR 0012).
 */
function confidenceRank(c: Confidence): number {
  if (c === "high") return 3;
  if (c === "medium") return 2;
  if (c === "low") return 1;
  return 0;
}

/**
 * True when the propagation gate allows attaching `code` to a finding
 * on `path`:
 *   - Codes not in {@link FILE_SCOPED_SUBSTRATE_CODES} bypass the gate
 *     (corpus-wide propagation).
 *   - File-scoped codes require `parseStateFiles` AND `path` membership
 *     in the named substrate set. When `parseStateFiles` is omitted
 *     entirely, falls back to the pre-gate corpus-wide propagation so
 *     legacy / fixture callers stay backward-compatible. When
 *     `parseStateFiles` is supplied but the named set is `undefined`
 *     (e.g. `fragment` left out by a caller that doesn't thread the
 *     fragment-files list), the gate denies — the safer half of the
 *     asymmetric failure modes (no false attribution of a substrate
 *     code).
 */
function isFileInSubstrateSetForCode(
  path: string,
  code: string,
  parseStateFiles: ParseStateFiles | undefined,
): boolean {
  const setName = FILE_SCOPED_SUBSTRATE_CODES.get(code);
  if (setName === undefined) return true;
  if (parseStateFiles === undefined) return true;
  if (setName === "fragment") {
    return parseStateFiles.fragment?.has(path) === true;
  }
  if (setName === "parserBailRoute") {
    return parseStateFiles.parserBailRoute?.has(path) === true;
  }
  if (setName === "parseError") return parseStateFiles.parseError.has(path);
  return parseStateFiles.partialParse.has(path);
}
