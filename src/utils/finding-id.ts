/**
 * Stable finding identity — two complementary tokens.
 *
 * Every {@link import("../types/violation.ts").Violation} carries TWO
 * sha256-derived tokens for identity, with opposite polarity:
 *
 *   `findingId`      — addresses ONE emission within a scan response.
 *                      Per-emission unique by construction: includes
 *                      `(ruleId, relativeFilePath, line, column,
 *                      variantKey?)` in the hash input. Two distinct
 *                      emissions on different lines (or different
 *                      columns of the same line) get distinct ids,
 *                      even when the line text is byte-identical. This
 *                      is the address `suggest_fix(findingId)` and
 *                      source-level disable pragmas resolve against.
 *
 *   `findingGroupId` — identifies ONE finding ACROSS RUNS of the same
 *                      scan. Hashes `(ruleId, relativeFilePath,
 *                      normalizedLineText, variantKey?)`; line NUMBER
 *                      is deliberately excluded so an unrelated edit
 *                      above the violation does not invalidate the
 *                      cross-run identity. This is the key baselines
 *                      and `scan_diff` match on — same line text means
 *                      same group across runs even after line drift.
 *
 * Why two tokens?
 *
 * The two answer different questions and the historical single-token
 * design (one `findingId` doing both jobs) collided silently when a
 * rule emitted N entries against N lines whose text was byte-identical
 * — those N entries collapsed to one token. `suggest_fix(findingId)`
 * resolved ambiguously, and an agent suppressing on the id silenced
 * sibling lines it never read. Per AI-first doctrine "Per-finding
 * identifiers must be addressable, not collision-prone," the per-
 * emission address now lives on `findingId`; the cross-run/dedupe
 * concern moved to `findingGroupId`.
 *
 * Recipes:
 *
 *   findingId = sha256(
 *     [ruleId, relativeFilePath, line, column, variantKey?]
 *       .map(asString)
 *       .filter((p) => p.length > 0)
 *       .join(" ")
 *   ).slice(0, FINDING_ID_LENGTH)
 *
 *   findingGroupId = sha256(
 *     [ruleId, relativeFilePath, normalizedLineText, variantKey?]
 *       .filter(Boolean)
 *       .join(" ")
 *   ).slice(0, FINDING_ID_LENGTH)
 *
 * where `normalizedLineText` is the source text of the single line at
 * `line` (1-based), with trailing whitespace stripped.
 *
 * Path normalization: the per-emission `findingId` hashes a stable
 * within-process address — its consumer is `suggest_fix(findingId)`
 * resolving back through the same scanner state, never a cross-
 * machine baseline (that's {@link computeFindingGroupId}'s job, which
 * uses normalized line TEXT rather than path). To guarantee that the
 * SAME conceptual candidate produces ONE id across `scan_file`
 * (which receives the agent's `path` verbatim — possibly relative),
 * `scan_project` (whose discovery walker resolves to absolute paths),
 * and `checklist` (same), the per-emission hash always anchors on the
 * RESOLVED ABSOLUTE path. When `scanRoot` is supplied and `filePath`
 * is relative, the helper resolves `(scanRoot, filePath)` → absolute
 * before hashing; when `filePath` is already absolute, it is used
 * verbatim. Without `scanRoot`, a relative `filePath` is normalized
 * in place (backslashes → forward slashes; leading `./` stripped) —
 * the same shape both surfaces would have produced before this
 * helper existed, so legacy fixture-stamp paths still hash stably.
 *
 * The cross-run-stable {@link computeFindingGroupId} continues to
 * relativize where possible: that token's consumers (baseline,
 * scan_diff) DO read across machines and need the cross-machine-
 * stable shape.
 *
 * Length: 12 hex chars = 48 bits. For a single scan producing tens
 * of thousands of violations, the birthday-collision probability is
 * still under 1e-6, and a 48-bit token reads cleanly in agent
 * transcripts and diff output. Full sha256 is available internally
 * if ever needed.
 *
 * Trade-off on `findingGroupId`: by design, two findings of the same
 * rule at the same filePath whose violation line holds byte-identical
 * text collapse to one `findingGroupId` — e.g. three `<button
 * title="…">` on a single HTML line share one group id. That collapse
 * is what baseline + dedup flows depend on (see
 * `tests/unit/mcp/tool-propose-baseline.test.ts` "collapses violations
 * that share a findingGroupId"). Sub-variant rules that emit
 * categorically different findings at the same site disambiguate via
 * the `variantKey` hash input on BOTH tokens.
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";

/** Output length (hex chars) of the truncated sha256 digest. */
export const FINDING_ID_LENGTH = 12;

export interface FindingIdInputs {
  readonly ruleId: string;
  readonly filePath: string;
  /** 1-based line number of the violation. */
  readonly line: number;
  /** 1-based column number of the violation. */
  readonly column: number;
  /**
   * Absolute or logical "scan root" for path relativization. When
   * omitted, the `filePath` is normalized in place without
   * relativization. Callers that know their root (scanner, CLI) pass
   * it; callers that don't (tests, synthetic emitters) don't.
   */
  readonly scanRoot?: string;
  /**
   * Sub-variant discriminator for rules that emit more than one kind
   * of finding against the same `(ruleId, filePath, line, column)`
   * tuple — see {@link FindingGroupIdInputs#variantKey} for the
   * canonical use case.
   */
  readonly variantKey?: string;
}

export interface FindingGroupIdInputs {
  readonly ruleId: string;
  readonly filePath: string;
  /** Full source text of the file. May be empty for synthetic violations. */
  readonly source: string;
  /** 1-based line number of the violation. */
  readonly line: number;
  /**
   * Absolute or logical "scan root" for path relativization. When
   * omitted, the `filePath` is normalized in place without
   * relativization. Callers that know their root (scanner, CLI) pass
   * it; callers that don't (tests, synthetic emitters) don't.
   */
  readonly scanRoot?: string;
  /**
   * Sub-variant discriminator for rules that emit more than one kind
   * of finding against the same `(ruleId, filePath, line-text)` tuple.
   *
   * Rules that genuinely emit multiple sub-variants on the same site
   * (e.g. `navigation/link-descriptive-text` firing both "not
   * descriptive" and "duplicate same-href" against the same anchor —
   * satisfies both 2.4.4 and 2.4.9 at once) pass a short, stable,
   * snake-case key (`"generic-phrase"`, `"icon-only"`, `"duplicate-
   * href"`, …) so the two findings get distinct ids — otherwise the
   * agent's suppress + dedup flows silently merge them.
   *
   * Only folded into the hash when non-empty, so single-variant rules
   * don't carry an empty suffix in the hash input. Do NOT use
   * free-form user-facing message text here — any wording tweak would
   * invalidate every `findingGroupId` for the rule. Use a stable token
   * the rule owns.
   */
  readonly variantKey?: string;
}

/**
 * Computes the per-emission `findingId`. Pure function over its inputs;
 * no I/O. Two distinct emissions in the same response with different
 * `(line, column)` always get distinct ids, even when the surrounding
 * line text is identical.
 *
 * Hashes the resolved-absolute path (when `scanRoot` is supplied to
 * resolve a relative input, OR when the input is already absolute)
 * so the same conceptual emission produces ONE id whether the caller
 * addressed the file by an absolute path or a `cwd`-relative shape.
 */
export function computeFindingId(inputs: FindingIdInputs): string {
  const path = normalizeAbsolutePathForFindingId(inputs.filePath, inputs.scanRoot);
  const variantSuffix =
    inputs.variantKey !== undefined && inputs.variantKey.length > 0 ? ` ${inputs.variantKey}` : "";
  const canonical = `${inputs.ruleId} ${path} ${inputs.line} ${inputs.column}${variantSuffix}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, FINDING_ID_LENGTH);
}

export interface CandidateFindingIdInputs {
  /**
   * Every criterion ID this conceptual candidate satisfies. Sorted and
   * joined to form the rule-equivalent slot in the hash so the same
   * `(filePath, line, column)` candidate produces identical ids across
   * surfaces:
   *
   *   - `scan_file.reviewCandidates[]` post-dedup ships `criteria:
   *     string[]` (the union after cross-criterion / cross-finder
   *     fold) — pass it verbatim.
   *   - `scan_project.reviewCandidates[]` ships `criteria: string[]`
   *     (the same union) — pass it verbatim.
   *   - `checklist.items[].candidates[]` is per-criterion at emit
   *     time but `annotateSharedCandidates` populates `criteria:
   *     [...sortedIds]` when ≥2 items share the same `(path, line,
   *     reason)`. Pass that final array (or `[criterionId]` for
   *     singletons).
   *
   * Each surface arrives at the same sorted union for the same
   * conceptual candidate, so `computeCandidateFindingId` produces one
   * id per candidate across all three.
   */
  readonly criteria: readonly string[];
  readonly filePath: string;
  /** 1-based line number of the candidate. */
  readonly line: number;
  /** 1-based column number of the candidate. */
  readonly column: number;
  /**
   * Absolute or logical "scan root" for path relativization. When
   * omitted, the `filePath` is normalized in place — same semantics as
   * {@link FindingIdInputs#scanRoot}.
   */
  readonly scanRoot?: string;
  /**
   * The candidate's `reason` text. Folded into the hash as a
   * variant discriminator so two distinct finders firing at the same
   * `(filePath, line, column)` with identical criterion unions but
   * different `reason` text get distinct `findingId`s.
   *
   * Without this leg the per-position cross-standard fold key — which
   * already includes `reason` so distinct reasons stay separate dedup
   * groups (see `candidateCriteriaUnionKey` in
   * `src/mcp/review-candidate-dedup.ts`) — collapses to one id when
   * each group's criteria union happens to be identical (canonical
   * case: `review/alt-duplicates-sibling-text` and
   * `review/redundant-alt-text` both declaring
   * `[wcag22:1.1.1, wcag21:1.1.1]` and emitting at the same `<img>`
   * with distinct framing text). The dedup key already encodes the
   * reason axis; folding it into the hash carries the same axis to
   * the addressable id so `suggest_fix(findingId)` and source-level
   * disable pragmas resolve unambiguously.
   *
   * Per AI-first doctrine "Per-finding identifiers must be
   * addressable, not collision-prone." Optional for backward
   * compatibility — callers that don't have a reason in scope (test
   * synthetic emits) skip it; production callers in `src/mcp/**`
   * always pass it.
   */
  readonly reason?: string;
}

/**
 * Computes the per-emission `findingId` for a review candidate. Mirrors
 * {@link computeFindingId} on the rule surface — same hash function,
 * same length, same path normalization — but takes a sorted `criteria`
 * array as the rule-equivalent slot so the same conceptual candidate
 * produces identical ids on every surface that ships it (`scan_file`
 * post-dedup, `scan_project.reviewCandidates`, `checklist.items[]
 * .candidates[]`).
 *
 * Per AI-first doctrine "Per-finding identifiers must be addressable,
 * not collision-prone": location-coordinate-hashed so two distinct
 * emissions on different `(line, column)` always get distinct ids, and
 * "Per-tool review-candidate shape must agree across surfaces": the
 * hash is a pure function over the sorted `criteria` union plus the
 * location plus the optional `reason` discriminator, so an agent can
 * address the same candidate by id regardless of which tool surfaced
 * it AND two finders firing at the same byte position with distinct
 * reason text remain individually addressable.
 */
export function computeCandidateFindingId(inputs: CandidateFindingIdInputs): string {
  // Sort defensively even though every caller already sorts: hash
  // stability depends on the canonical order, and a missed sort would
  // silently desynchronize ids across surfaces.
  const sorted = [...inputs.criteria].sort();
  const ruleId = sorted.join(",");
  // Reason text is folded into the hash via the variant slot so the
  // per-position cross-standard dedup fold's reason axis carries
  // through to the id. The dedup helper groups on `(filePath, line,
  // column, reason)` already; matching that key here means each
  // distinct group ships a distinct id even when criteria unions
  // happen to coincide.
  const variantKey =
    inputs.reason !== undefined && inputs.reason.length > 0
      ? hashReasonVariantKey(inputs.reason)
      : undefined;
  return computeFindingId({
    ruleId,
    filePath: inputs.filePath,
    line: inputs.line,
    column: inputs.column,
    ...(inputs.scanRoot === undefined ? {} : { scanRoot: inputs.scanRoot }),
    ...(variantKey === undefined ? {} : { variantKey }),
  });
}

/**
 * Hashes the candidate `reason` to a short stable token suitable for
 * the `variantKey` slot of {@link computeFindingId}. The full reason
 * text can be a paragraph (finder authors enrich it with verify-step
 * prose); we hash so the variant slot stays bounded and the canonical
 * hash input doesn't grow unbounded with reason length, but identity
 * is preserved — same reason → same variant token → same id.
 */
function hashReasonVariantKey(reason: string): string {
  return createHash("sha256").update(reason).digest("hex").slice(0, FINDING_ID_LENGTH);
}

/**
 * Computes the cross-run-stable `findingGroupId`. Pure function over
 * its inputs; no I/O. Hashes the normalized text of the violation
 * line rather than the line number, so an unrelated edit above the
 * violation does not change the id (line-drift resilient by design).
 *
 * Baselines and `scan_diff` match against this token; a single rule
 * emitting against N lines of byte-identical text collapses to one
 * `findingGroupId` (the existing dedup contract that propose-baseline
 * and the SARIF formatter rely on).
 */
export function computeFindingGroupId(inputs: FindingGroupIdInputs): string {
  const path = normalizeRelativePath(inputs.filePath, inputs.scanRoot);
  const lineText = extractNormalizedLineText(inputs.source, inputs.line);
  const variantSuffix =
    inputs.variantKey !== undefined && inputs.variantKey.length > 0 ? ` ${inputs.variantKey}` : "";
  const canonical = `${inputs.ruleId} ${path} ${lineText}${variantSuffix}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, FINDING_ID_LENGTH);
}

/**
 * Extracts the normalized text for the given 1-based `line` from
 * `source`. Trailing whitespace is stripped so indentation tweaks on
 * the violation line don't churn the id. When `line` is out of bounds
 * or `source` is empty (synthetic emits, test fixtures), returns the
 * empty string — the `(ruleId, filePath, variantKey)` tuple still
 * carries identity for those cases.
 *
 * Exported so baseline/diagnostic code can reconstruct the same
 * identity from stored inputs without needing to reimplement the line
 * slicing.
 */
export function extractNormalizedLineText(source: string, line: number): string {
  if (source.length === 0 || line < 1) return "";
  const lines = source.split("\n");
  if (line > lines.length) return "";
  const raw = lines[line - 1] ?? "";
  return raw.replace(/[ \t]+$/u, "");
}

/**
 * Normalizes a file path to a portable relative string. Absolute
 * paths break across machines; the hash has to produce the same
 * value on CI, on the user's laptop, and inside a sandbox, so we
 * always return a forward-slash relative form.
 *
 * When `scanRoot` is provided and the path resolves under it, the
 * `path.relative` form is used. Otherwise (or when no root is
 * provided), the input is normalized in place: backslashes → slashes,
 * leading `./` stripped.
 */
function normalizeRelativePath(filePath: string, scanRoot?: string): string {
  let normalized = filePath;
  if (scanRoot !== undefined && scanRoot.length > 0 && isAbsolute(filePath)) {
    const rel = relativePath(scanRoot, filePath);
    // `relative` can return an empty string when the paths match, or
    // `../…` when the file is outside the scan root. Empty is fine
    // (collapse to the filename); `..` we accept verbatim.
    if (rel.length > 0) normalized = rel;
  }
  return normalized.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Normalizes a file path to a resolved-absolute, forward-slash form
 * for the per-emission {@link computeFindingId} hash. The within-
 * process address consumer (`suggest_fix(findingId)`) reads the same
 * scanner state, so cross-machine portability is not the goal here —
 * cross-surface stability IS. Resolving to absolute means an agent
 * calling `scan_file({path: "_includes/footer.html", cwd: "/abs"})`
 * and `checklist({cwd: "/abs"})` produce the same id on the same
 * conceptual emission, regardless of which path shape the agent
 * happened to use.
 *
 * - Absolute `filePath` → returned verbatim (slash-normalized).
 * - Relative `filePath` + `scanRoot` → `resolve(scanRoot, filePath)`.
 * - Relative `filePath` without `scanRoot` → in-place normalization
 *   (backslashes → slashes, leading `./` stripped) — matches the
 *   pre-Q15 stamp shape so legacy fixture-stamp paths still hash
 *   stably for tests that don't supply a root.
 */
function normalizeAbsolutePathForFindingId(filePath: string, scanRoot?: string): string {
  if (isAbsolute(filePath)) {
    return filePath.replace(/\\/g, "/");
  }
  if (scanRoot !== undefined && scanRoot.length > 0) {
    const resolved = resolvePath(scanRoot, filePath);
    return resolved.replace(/\\/g, "/");
  }
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}
