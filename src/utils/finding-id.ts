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
 * Path normalization: both hashes work off the relative form — absolute
 * paths break across machines (CI vs developer laptop vs sandbox).
 * When `scanRoot` is provided and the `filePath` is absolute under
 * that root, the relative form is used; otherwise the `filePath` is
 * normalized in place (backslashes → forward slashes; leading `./`
 * stripped) so the same logical path produces the same hash on
 * Windows and POSIX.
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
import { isAbsolute, relative as relativePath } from "node:path";

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
 */
export function computeFindingId(inputs: FindingIdInputs): string {
  const path = normalizeRelativePath(inputs.filePath, inputs.scanRoot);
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
 * location, so an agent can address the same candidate by id
 * regardless of which tool surfaced it.
 */
export function computeCandidateFindingId(inputs: CandidateFindingIdInputs): string {
  // Sort defensively even though every caller already sorts: hash
  // stability depends on the canonical order, and a missed sort would
  // silently desynchronize ids across surfaces.
  const sorted = [...inputs.criteria].sort();
  const ruleId = sorted.join(",");
  return computeFindingId({
    ruleId,
    filePath: inputs.filePath,
    line: inputs.line,
    column: inputs.column,
    ...(inputs.scanRoot === undefined ? {} : { scanRoot: inputs.scanRoot }),
  });
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
