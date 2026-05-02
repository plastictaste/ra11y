/**
 * Dedupes review candidates across enabled standards AND across
 * sibling finders that emit at the same `(filePath, line, column)`.
 *
 * Two collapse passes run in sequence:
 *
 * Pass 1 — within-finder cross-standard fold. A single finder (e.g.
 * `review/images-of-text`) declares many `criterionIds` across the
 * WCAG 2.2 / 2.1 / Section 508 / EN 301 549 matrix and emits one
 * candidate per criterion at the same `(filePath, line, column)` so
 * the scanner doesn't drop cross-standard coverage. Reason text is
 * identical across these copies (the finder builds it once per
 * element). Group key: `(filePath, line, column, reason)`. This
 * preserves the rare per-criterion-reason signal: the images-of-text
 * finder, for example, appends a logotype-exemption hint on
 * 1.4.5-family criteria that 1.4.9 doesn't carry — different reason =
 * different advice to verify even if the line is the same.
 *
 * Pass 2 — cross-finder positional fold. Two distinct finders may
 * emit at the same `(filePath, line, column)` for genuinely different
 * criteria (canonical case: `<input type="password">` triggers both
 * `review/identify-purpose` for `wcag22:1.3.6` AND
 * `review/password-inputs` for `wcag22:3.3.8` at the same byte
 * position). Pre-fold these surfaced as N separate entries in
 * `scan_file.reviewCandidates`; `checklist.items[].candidates` already
 * annotates the cross-criterion sharing via `criteria: [...]` on every
 * instance per `annotateSharedCandidates`. The asymmetric shape forced
 * the agent to walk the same line under N different reasons in one
 * tool and under one merged badge in the other. Pass 2 closes the
 * drift: candidates sharing the post-Pass-1 `(filePath, line, column)`
 * key collapse to the first-seen entry, with `criteria` widened to the
 * union and reason text concatenated (separator `" | "`) so each
 * finder's WCAG-specific guidance survives the fold. The agent reads
 * one entry whose `criteria` carries every owning standard ID and
 * whose `reason` carries every finder's framing — same logical model
 * checklist's annotation surface ships, just collapsed instead of
 * annotated because `scan_file.reviewCandidates` is a flat list, not
 * a per-criterion grouped tree.
 *
 * `actionableManualItems` (counter-not-list) is unaffected by either
 * pass — both surfaces compute it via `tallyManualCriteria{,FromCoverage}`
 * over the original (un-folded) candidate set, keyed on `criterionId`.
 * The fold operates on the response surface only.
 */

import type {
  ReviewCandidate,
  ReviewCandidatePredicateConceded,
  ReviewCandidateSibling,
  ReviewCandidateVendorContext,
  ReviewConfidence,
} from "../types/review.ts";
import { computeCandidateFindingId } from "../utils/finding-id.ts";
import {
  couldBeWrongBecauseForVendorBuildArtifact,
  highestCandidateConfidence,
  type ReviewCandidatePriority,
  resolvePriorityForCandidate,
  strongestAttentionLevel,
} from "./review-candidate-priority.ts";

/**
 * Shape of a candidate in the `scan_file` response after dedup.
 * `criteria` is a sorted list of every criterion ID the candidate
 * satisfies — mirrors `Violation.criteria` on findings.
 *
 * `priority` and `confidence` mirror the per-item shape `checklist`
 * ships so an agent walking the same conceptual candidate across
 * the two surfaces reads the same attention-budget signal. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-
 * candidate shape must agree across surfaces" — populated via the
 * shared resolvers in {@link ./review-candidate-priority.ts} so the
 * two surfaces compute from the same logic over the same inputs.
 */
export interface DedupedReviewCandidate {
  /**
   * Per-emission unique address — same recipe as {@link Violation#findingId}
   * on the rule surface, hashed via {@link computeCandidateFindingId}
   * over `(sortedCriteria.join(","), filePath, line, column)`. The
   * canonical sorted-criteria join means the SAME conceptual candidate
   * surfaces with the SAME `findingId` on `scan_file.reviewCandidates[]`,
   * `scan_project.reviewCandidates[]`, and `checklist.items[].candidates[]`
   * — an agent calling those tools in sequence can address the same
   * candidate by id regardless of which surface produced it. Per AI-first
   * doctrine "Per-finding identifiers must be addressable, not collision-
   * prone" + "Per-tool review-candidate shape must agree across surfaces"
   * (the candidate-shape closure pinned by
   * `tests/integration/mcp-consistency/candidate-finding-id-cross-surface.test.ts`).
   */
  readonly findingId: string;
  readonly criteria: readonly string[];
  readonly line: number;
  readonly column: number;
  readonly reason: string;
  /**
   * Attention-budget signal — same enum/semantics as the `priority`
   * field on `checklist.items[]`. Resolved per-candidate from the
   * strongest-attention level among the union of `criteria` (A → AA
   * → AAA), downgraded to "medium" when the candidate's own static
   * evidence concedes the predicate (hedging reason, vendor-path-
   * shape `vendorContext`, or logotype-pattern `predicateConceded`).
   * Required — agents budget against this signal and a missing or
   * `null` value is the dishonest shape per
   * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field
   * shapes are dishonest."
   */
  readonly priority: ReviewCandidatePriority;
  /**
   * How strongly the finder's static evidence supports this candidate.
   * Same enum/semantics as `confidence` on `checklist.items[].candidates[]`
   * and `review_candidates.candidates[]`. When dedup folded N
   * per-criterion copies into one entry, the union takes the highest
   * confidence (a single "high" hit sizes the entry honestly even
   * when other hits are lower-signal). Required — every grounded
   * candidate carries a confidence value; the field cannot be
   * absent or `null`.
   */
  readonly confidence: ReviewConfidence;
  readonly snippet?: string;
  /**
   * Present when the finder aggregated ≥2 adjacent same-shape siblings
   * (or deduped ≥2 same-stem candidates) into this candidate (e.g. ten
   * sponsor-logo `<img>` siblings collapsed into one). Each entry names
   * a group member by `line` plus optional `alt` / `href` for agent-
   * facing enumeration. Omitted for singleton candidates per CLAUDE.md
   * §1 "Ambiguous field shapes are dishonest."
   */
  readonly siblingOccurrences?: readonly ReviewCandidateSibling[];
  /**
   * Passes through the finder's structured vendor-path-shape evidence
   * (see `ReviewCandidate.vendorPathHint`). Present-when-meaningful —
   * omitted when the finder did not classify the file as a vendor /
   * build-output drop.
   */
  readonly vendorPathHint?: boolean;
  /**
   * Passes through the finder's structured duration evidence for
   * timing-related candidates (see `ReviewCandidate.durationLiteralMs`).
   * Single-typed `number` for literal-resolved millisecond counts;
   * non-literal expressions surface on the sibling `durationExpression`
   * field. Omitted when no duration applies (HTML `<meta refresh>`,
   * degenerate calls).
   */
  readonly durationLiteralMs?: number;
  /**
   * Passes through the finder's verbatim non-literal duration
   * expression for timing-related candidates (see
   * `ReviewCandidate.durationExpression`). Sibling to
   * `durationLiteralMs`: exactly one is populated when the underlying
   * call has a duration argument; both omitted otherwise.
   */
  readonly durationExpression?: string;
  /**
   * Number of source occurrences this candidate represents — present
   * when stem-dedup collapsed ≥2 candidates into one. Mirrors
   * {@link DedupedReviewCandidate#siblingOccurrences} for stem-dedup
   * groups; omitted on singletons.
   */
  readonly sourceCount?: number;
  /**
   * Byte offset of the literal token the finder matched, when known.
   * Pairs with {@link DedupedReviewCandidate#matchLength} — passed through
   * verbatim from the source candidate so a downstream consumer (CLI
   * `--format agent`, custom formatter) can re-derive a tight snippet
   * even after the cross-standard fold.
   */
  readonly matchOffset?: number;
  /** Byte length of the matched token; pairs with `matchOffset`. */
  readonly matchLength?: number;
  /**
   * Structured codes naming the evidence-quality limitations a
   * downstream consumer should weigh when reading this candidate's
   * `priority` / `confidence` signal — same vocabulary and present-
   * when-meaningful semantics as
   * {@link import("../types/review.ts").ReviewCandidate#couldBeWrongBecause}.
   *
   * Currently populated by the materializer when the
   * minified-vendor-no-sourcemap gate fires (per-file `vendorPathHint:
   * true` co-occurring with the candidate's path appearing in the
   * scan-time `buildArtifactPaths` set). The same gate drops `priority`
   * to `"low"`; the two channels compose at the assembly site so the
   * agent's dismissal path is "verify the evidence-quality concession"
   * rather than guessing why the budget dropped.
   *
   * Omitted entirely when no limitation applies (per CLAUDE.md §1
   * "Ambiguous field shapes are dishonest" — never sentinel-empty).
   */
  readonly couldBeWrongBecause?: readonly string[];
}

/** Aggregator entry held during the dedup passes. */
interface DedupAcc {
  /**
   * Source file path captured from the first candidate in the group.
   * `dedupeReviewCandidatesForSingleFile` is per-file by construction,
   * so every candidate folded into a single acc shares the same path —
   * preserved here so {@link materializeDedupedCandidate} can hash it
   * into the per-emission `findingId`.
   */
  filePath: string;
  criteria: Set<string>;
  line: number;
  column: number;
  reason: string;
  snippet: string | undefined;
  siblingOccurrences: readonly ReviewCandidateSibling[] | undefined;
  vendorPathHint: boolean | undefined;
  vendorContext: ReviewCandidateVendorContext | undefined;
  predicateConceded: ReviewCandidatePredicateConceded | undefined;
  durationLiteralMs: number | undefined;
  durationExpression: string | undefined;
  sourceCount: number | undefined;
  matchOffset: number | undefined;
  matchLength: number | undefined;
  /**
   * Pass-through of {@link ReviewCandidate.handlerFunctionName} for
   * surfaces that consume the dedup output (today: the by-reason
   * surface used by `review_candidates`). Preserved on the first-seen
   * candidate; per-criterion siblings under the same key share the
   * same value because the field is keyed off the AST node, not the
   * criterion ID.
   */
  handlerFunctionName: string | undefined;
  /**
   * Pass-through of {@link ReviewCandidate.dismissalKey}. Same shape
   * rationale as {@link DedupAcc.handlerFunctionName} — finder-level
   * fingerprint that does not vary across per-criterion siblings.
   */
  dismissalKey: string | undefined;
  /**
   * Pass-through of {@link ReviewCandidate.couldBeWrongBecause}.
   * The finder owns this signal at the candidate level; per-criterion
   * siblings carry the same value, so first-seen wins. The deduped
   * `scan_file` materializer overrides this when the minified-vendor-
   * no-sourcemap gate fires (see {@link materializeDedupedCandidate});
   * the by-reason materializer leaves it as the finder's verbatim
   * value.
   */
  couldBeWrongBecause: readonly string[] | undefined;
  /**
   * Every source candidate's confidence — folded across pass 1 + 2
   * so {@link materializeDedupedCandidate} can take the highest via
   * {@link highestCandidateConfidence}. A union of N per-criterion
   * copies (which share the finder, so the values are identical) plus
   * any cross-finder fold (Pass 2) where the two finders may have
   * picked different confidence values.
   */
  confidences: ReviewConfidence[];
  order: number;
}

/**
 * Folds review candidates so the response surface ships one entry per
 * unique `(filePath, line, column)` even when N distinct finders emit
 * at the same byte position for different criteria. Two passes:
 *
 *   Pass 1 keys on `(filePath, line, column, reason)` so per-criterion
 *   copies a single finder emits across standards collapse without
 *   erasing the rare per-criterion reason signal (e.g. images-of-text's
 *   logotype hint on 1.4.5 vs the bare reason on 1.4.9).
 *
 *   Pass 2 keys on `(filePath, line, column)` to fold cross-finder
 *   coincidences (canonical case: `<input type="password">` gets
 *   `review/identify-purpose` (1.3.6) AND `review/password-inputs`
 *   (3.3.8) at the same position). Reasons concatenate with `" | "`
 *   so each finder's framing survives; `criteria` carries the union.
 *
 * Input is sorted by the scanner; first-seen order is preserved so
 * the response is deterministic across runs.
 */
export function dedupeReviewCandidatesForSingleFile(
  candidates: readonly ReviewCandidate[],
  criterionLevels: ReadonlyMap<string, string> = new Map(),
  buildArtifactPaths: ReadonlySet<string> = new Set(),
): readonly DedupedReviewCandidate[] {
  const byReasonKey = passOneCollectByReasonKey(candidates);
  const byPositionKey = passTwoCollectByPosition(byReasonKey);
  return [...byPositionKey.values()]
    .sort((a, b) => a.order - b.order)
    .map((acc) => materializeDedupedCandidate(acc, criterionLevels, buildArtifactPaths));
}

/**
 * Cross-criterion dedup for the by-row review-candidates surface. When
 * a finder declares multiple criterion IDs (canonical case:
 * `review/identify-purpose` declaring `wcag22:1.3.6` + `wcag21:1.3.6`)
 * it emits one candidate per criterion at the same `(filePath, line,
 * column)` with byte-identical reason text. Pre-fold the agent saw
 * N rows under one location with the same evidence; post-fold one row
 * carrying every covered criterion in a sorted `criteria` list. The
 * `verdict_candidate` tool then accepts that list and applies one
 * verdict to all listed criteria atomically — same evidence, one
 * agent action.
 *
 * Pass-1-only semantics: same finder, same evidence, distinct criteria
 * fold; cross-finder coincidences at the same `(line, column)` with
 * different reasons stay as distinct rows so each finder's WCAG-
 * specific framing survives. The per-position fold (used by
 * `scan_file.reviewCandidates[]` / `scan_project.reviewCandidates[]`
 * via {@link dedupeReviewCandidatesForSingleFile}) collapses those
 * cross-finder coincidences too because that surface is a per-position
 * tree, not a flat by-row list — see the function-level docstring
 * there for the two-pass rationale.
 *
 * Multi-file safe: the input may carry candidates from any number of
 * source files; the helper buckets by `filePath` first so a `(line,
 * column)` collision across two distinct files cannot fold (a latent
 * issue in the per-position pass that's invisible in practice for
 * single-file surfaces).
 *
 * Returns an augmented shape sharing `ReviewCandidate`'s field names so
 * surface mappers can pass-through every existing field without a new
 * conversion layer; the only added field is `criteria: string[]`
 * (sorted, always populated, ≥1 ID; the canonical first ID matches
 * the row's `criterionId` for surfaces that retain the singular field
 * for filter compatibility).
 */
export function dedupeReviewCandidatesByReason(
  candidates: readonly ReviewCandidate[],
): readonly ReasonDedupedCandidate[] {
  const byFile = new Map<string, ReviewCandidate[]>();
  for (const c of candidates) {
    const arr = byFile.get(c.location.filePath);
    if (arr === undefined) byFile.set(c.location.filePath, [c]);
    else arr.push(c);
  }
  const out: ReasonDedupedCandidate[] = [];
  for (const fileCandidates of byFile.values()) {
    const byReasonKey = passOneCollectByReasonKey(fileCandidates);
    for (const acc of byReasonKey.values()) {
      out.push(materializeReasonDeduped(acc));
    }
  }
  return out;
}

// Re-export the helper so callers (e.g. response-assembler) can
// build the lookup map once from the standards registry without
// reaching into the priority module directly.
export { buildCriterionLevelMap } from "./review-candidate-priority.ts";

/**
 * Output shape of {@link dedupeReviewCandidatesByReason}. Carries the
 * full {@link ReviewCandidate} field set so a tool that already maps
 * `ReviewCandidate` rows can drop the helper output in with the only
 * added concern being the new `criteria` array. The `criterionId` slot
 * holds the canonical first ID of the sorted union — surfaces that
 * retain the singular field (e.g. `review_candidates` for filter
 * compatibility) read it; surfaces that key on the union read
 * `criteria`.
 *
 * `criteria` is always populated (≥1 element, sorted). Wire-shape
 * mappers omit the array when length is 1 per CLAUDE.md §1 "Ambiguous
 * field shapes are dishonest" — a length-1 `criteria: ["wcag22:1.3.6"]`
 * sibling next to `criterionId: "wcag22:1.3.6"` would be redundant
 * noise; the array surfaces only when it carries new information
 * (the cross-criterion union).
 */
export interface ReasonDedupedCandidate
  extends Omit<ReviewCandidate, "criterionId" | "couldBeWrongBecause"> {
  /** Canonical (sorted-first) criterion ID of the folded union. */
  readonly criterionId: string;
  /**
   * Every criterion ID this candidate's evidence covers, sorted. Always
   * populated with ≥1 element; surfaces conditional-spread the field
   * when length is 1 to avoid the redundant-with-`criterionId` shape.
   */
  readonly criteria: readonly string[];
  /** Pass-through of {@link ReviewCandidate.couldBeWrongBecause}. */
  readonly couldBeWrongBecause?: readonly string[];
}

/**
 * Materializes a {@link DedupAcc} into the by-reason output shape.
 * Preserves every per-finder evidence field {@link DedupAcc} carries
 * (siblingOccurrences, vendorPathHint, vendorContext, predicateConceded,
 * durationLiteralMs, durationExpression, sourceCount, matchOffset,
 * matchLength, snippet) plus the new `criteria` union. `confidence`
 * is the highest across the folded copies (a single "high" hit sizes
 * the entry honestly), mirroring the per-item rollup used elsewhere.
 *
 * Note: handlerFunctionName / dismissalKey / couldBeWrongBecause are
 * carried on the {@link ReviewCandidate} type but not threaded through
 * {@link DedupAcc} (the within-finder fold preserves the first-seen
 * candidate's values and per-criterion siblings under the same
 * `(file, line, column, reason)` key carry identical values by
 * construction). The materializer reads them off the first folded
 * candidate via the `firstCandidate` reference.
 */
function materializeReasonDeduped(acc: DedupAcc): ReasonDedupedCandidate {
  const criteria = [...acc.criteria].sort();
  const confidence: ReviewConfidence =
    highestCandidateConfidence(acc.confidences.map((c) => ({ confidence: c }))) ?? "low";
  return {
    // Sorted-first canonical: matches the existing
    // `DedupedReviewCandidate.criteria[0]` ordering on the per-position
    // surfaces (`scan_file.reviewCandidates[]` /
    // `scan_project.reviewCandidates[]`) so the same conceptual
    // candidate's `criterionId` slot reads identically across the
    // by-row and by-position families. Per AI-first doctrine "Per-tool
    // review-candidate shape must agree across surfaces" the canonical
    // pick must be deterministic and uniform; alphabetical first is
    // both. Agents filtering by membership read `criteria.includes(id)`
    // — the sorted union always carries every covered criterion.
    criterionId: criteria[0] ?? "",
    criteria,
    location: { filePath: acc.filePath, line: acc.line, column: acc.column },
    reason: acc.reason,
    confidence,
    ...reasonDedupedAdditiveFields(acc),
  };
}

/**
 * Conditional-spreads the present-when-meaningful additive evidence
 * fields onto a {@link ReasonDedupedCandidate}. Extracted from
 * {@link materializeReasonDeduped} so the per-field branches don't
 * push the materializer's cognitive complexity above the lint cap as
 * new evidence sub-fields accrete on {@link DedupAcc}. Each branch
 * follows the canonical CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest" pattern: omit entirely when the source value is
 * undefined / empty so a downstream consumer never has to disambiguate
 * "absent" from "present-but-empty."
 */
function reasonDedupedAdditiveFields(acc: DedupAcc): Partial<ReasonDedupedCandidate> {
  return {
    ...(acc.snippet === undefined ? {} : { snippet: acc.snippet }),
    ...(acc.siblingOccurrences === undefined || acc.siblingOccurrences.length === 0
      ? {}
      : { siblingOccurrences: acc.siblingOccurrences }),
    ...(acc.vendorPathHint ? { vendorPathHint: acc.vendorPathHint } : {}),
    ...(acc.vendorContext === undefined ? {} : { vendorContext: acc.vendorContext }),
    ...(acc.predicateConceded === undefined ? {} : { predicateConceded: acc.predicateConceded }),
    ...(acc.durationLiteralMs === undefined ? {} : { durationLiteralMs: acc.durationLiteralMs }),
    ...(acc.durationExpression === undefined ? {} : { durationExpression: acc.durationExpression }),
    ...(acc.sourceCount === undefined ? {} : { sourceCount: acc.sourceCount }),
    ...(acc.matchOffset === undefined ? {} : { matchOffset: acc.matchOffset }),
    ...(acc.matchLength === undefined ? {} : { matchLength: acc.matchLength }),
    ...(acc.handlerFunctionName === undefined
      ? {}
      : { handlerFunctionName: acc.handlerFunctionName }),
    ...(acc.dismissalKey === undefined ? {} : { dismissalKey: acc.dismissalKey }),
    ...(acc.couldBeWrongBecause === undefined || acc.couldBeWrongBecause.length === 0
      ? {}
      : { couldBeWrongBecause: acc.couldBeWrongBecause }),
  };
}

/**
 * Pass 1: collect candidates grouped by `(filePath, line, column, reason)`.
 * Within a finder, per-criterion copies share the reason verbatim and
 * therefore share the key — `criteria` merges across standards while
 * the reason-distinguishing signal stays intact (different reasons =
 * different keys = distinct entries).
 */
function passOneCollectByReasonKey(candidates: readonly ReviewCandidate[]): Map<string, DedupAcc> {
  const byKey = new Map<string, DedupAcc>();
  let nextOrder = 0;
  for (const c of candidates) {
    const key = `${c.location.filePath} ${c.location.line} ${c.location.column} ${c.reason}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.criteria.add(c.criterionId);
      // Pass-1 fold across per-criterion copies of one finder: the
      // confidence value is identical across copies (the finder
      // emits one confidence per call site), but tracking each
      // sibling keeps the array consistent with the cross-finder
      // fold in Pass 2 where the values may genuinely differ.
      existing.confidences.push(c.confidence);
      continue;
    }
    byKey.set(key, {
      filePath: c.location.filePath,
      criteria: new Set([c.criterionId]),
      line: c.location.line,
      column: c.location.column,
      reason: c.reason,
      snippet: c.snippet,
      // siblingOccurrences is set by the finder when it aggregated
      // same-shape siblings (or deduped same-stem candidates); dedup
      // preserves the first-seen list (all copies carry the same list
      // because they share the same location+reason key) and
      // conditional-spreads it away when undefined or empty.
      siblingOccurrences: c.siblingOccurrences,
      // Structured vendor-path / duration evidence — preserved on the
      // first-seen candidate. All sibling copies under the same
      // location+reason key carry the same values because the finder
      // populates them from the file path / call site, not from the
      // criterion ID.
      vendorPathHint: c.vendorPathHint,
      // Pass through the structured `vendorContext` and
      // `predicateConceded` payloads so the priority resolver can
      // read them on the materialize step. Mirrors `vendorPathHint`
      // — preserved on the first-seen candidate; per-criterion
      // siblings under the same key carry identical values.
      vendorContext: c.vendorContext,
      predicateConceded: c.predicateConceded,
      durationLiteralMs: c.durationLiteralMs,
      durationExpression: c.durationExpression,
      // sourceCount mirrors siblingOccurrences for stem-deduped
      // candidates; preserved verbatim across the cross-standard fold.
      sourceCount: c.sourceCount,
      // Pass-through of the literal match offset/length so downstream
      // consumers can rebuild a tight snippet even after the cross-
      // standard fold collapsed N per-criterion copies into one.
      matchOffset: c.matchOffset,
      matchLength: c.matchLength,
      // Pass-through of finder-level fingerprints — preserved on the
      // first-seen candidate; per-criterion siblings carry identical
      // values because the finder populates from the AST node / file
      // path, not the criterion ID. Required by the by-reason surface
      // (`review_candidates`) so the agent's grep target / dismissal
      // hash survives the fold.
      handlerFunctionName: c.handlerFunctionName,
      dismissalKey: c.dismissalKey,
      couldBeWrongBecause: c.couldBeWrongBecause,
      // Seed the confidence accumulator so the post-fold
      // materialization can take the highest across the union.
      confidences: [c.confidence],
      order: nextOrder++,
    });
  }
  return byKey;
}

/**
 * Pass 2: fold cross-finder duplicates that share `(filePath, line,
 * column)` after the within-finder pass. Reasons concatenate with
 * `" | "`; criteria union; structured per-finder evidence
 * (`vendorPathHint`, `durationLiteralMs`, `siblingOccurrences`,
 * `sourceCount`, `matchOffset`/`matchLength`, `snippet`) preserves
 * first-seen and back-fills missing fields from the second finder
 * because subsequent finders are observing the same element and their
 * inferred evidence is either equivalent or complementary in a way
 * the agent will reconcile by reading the file. Idempotent
 * identity-reason guard prevents `"r | r"` if a fragment already
 * matches the existing reason.
 */
function passTwoCollectByPosition(byReasonKey: Map<string, DedupAcc>): Map<string, DedupAcc> {
  const byPos = new Map<string, DedupAcc>();
  for (const acc of byReasonKey.values()) {
    // Position key: drop the reason suffix the within-finder pass
    // used. This is the seam where cross-finder coincidences fold.
    const posKey = positionKey(acc);
    const existing = byPos.get(posKey);
    if (existing === undefined) {
      byPos.set(posKey, acc);
      continue;
    }
    mergeIntoExisting(existing, acc);
  }
  return byPos;
}

/**
 * Builds the position-only key used in pass 2. Path is implied by the
 * single-file caller (every candidate in a `dedupeReviewCandidatesFor
 * SingleFile` call shares a filePath by construction); `(line, column)`
 * suffices.
 */
function positionKey(acc: DedupAcc): string {
  return `${acc.line} ${acc.column}`;
}

/**
 * Merges `acc` into `existing` for the cross-finder fold. Criteria
 * union; reason concatenation with idempotency guard; structured
 * evidence back-fills missing fields only.
 */
function mergeIntoExisting(existing: DedupAcc, acc: DedupAcc): void {
  for (const id of acc.criteria) existing.criteria.add(id);
  if (acc.reason !== existing.reason && !hasReasonFragment(existing.reason, acc.reason)) {
    existing.reason = `${existing.reason} | ${acc.reason}`;
  }
  // Pass-2 fold across distinct finders: the union takes the highest
  // confidence the cross-finder evidence supports, mirroring the per-
  // item rollup `highestConfidence` in `tool-checklist.ts`.
  for (const conf of acc.confidences) existing.confidences.push(conf);
  backfillStructuredEvidence(existing, acc);
}

/**
 * Back-fills the structured-evidence sub-fields on `existing` from
 * `acc` for any field `existing` left undefined. Extracted so
 * {@link mergeIntoExisting}'s cognitive complexity stays under the
 * lint cap as new evidence sub-fields accrete on
 * {@link DedupedReviewCandidate}. Each field-pair is the same shape
 * — `existing.X === undefined && acc.X !== undefined` → copy — and a
 * data-driven loop both shrinks the function and removes the
 * branch-per-field repetition that would otherwise compound.
 *
 * Type-erased to `Record<string, unknown>` at the seam: the keys are
 * structurally typed on {@link DedupAcc} above, and the shared shape
 * means a correctness regression here would also fire on the
 * compile-time {@link DedupedReviewCandidate} surface — the typed
 * accessors stay public; this internal helper is the de-duplication
 * implementation.
 */
function backfillStructuredEvidence(existing: DedupAcc, acc: DedupAcc): void {
  const keys: ReadonlyArray<keyof DedupAcc> = [
    "siblingOccurrences",
    "vendorPathHint",
    "vendorContext",
    "predicateConceded",
    "durationLiteralMs",
    "durationExpression",
    "sourceCount",
    "matchOffset",
    "matchLength",
    "snippet",
    "handlerFunctionName",
    "dismissalKey",
    "couldBeWrongBecause",
  ];
  const e = existing as unknown as Record<string, unknown>;
  const a = acc as unknown as Record<string, unknown>;
  for (const k of keys) {
    if (e[k] === undefined && a[k] !== undefined) e[k] = a[k];
  }
}

/**
 * Idempotency guard for pass-2 reason concatenation: if the candidate
 * reason already appears as a `" | "`-separated fragment of the
 * existing one, skip the append. Lets the helper run multiple times
 * over the same data without growing the reason string.
 */
function hasReasonFragment(existing: string, candidate: string): boolean {
  if (existing === candidate) return true;
  const parts = existing.split(" | ");
  return parts.includes(candidate);
}

/**
 * Materializes a {@link DedupAcc} into the public
 * {@link DedupedReviewCandidate} shape. Conditional-spread per
 * CLAUDE.md §1 "Ambiguous field shapes are dishonest" — fields with
 * no meaningful value are omitted entirely rather than emitted as
 * empty strings or null.
 */
function materializeDedupedCandidate(
  g: DedupAcc,
  criterionLevels: ReadonlyMap<string, string>,
  buildArtifactPaths: ReadonlySet<string>,
): DedupedReviewCandidate {
  const criteria = [...g.criteria].sort();
  // Take the strongest-attention level across the union of criteria
  // — riding at AAA priority on a candidate that also satisfies an
  // AA criterion would understate the attention budget. The shared
  // resolver is the same logic checklist runs per-item, so the same
  // conceptual candidate ranks identically across both surfaces.
  const level = strongestAttentionLevel(criteria, criterionLevels);
  // Take the highest confidence across the folded union — single
  // "high" hit sizes the entry honestly even when other hits are
  // lower-signal. Confidences is non-empty by construction (every
  // source candidate seeded one entry); the fallback narrows the
  // type for downstream consumers.
  const confidence: ReviewConfidence =
    highestCandidateConfidence(g.confidences.map((c) => ({ confidence: c }))) ?? "low";
  // Per-file build-artifact membership — the second leg of the
  // minified-vendor-no-sourcemap gate. The first leg (`vendorPathHint:
  // true`) ships verbatim from the finder; the second is corpus-level
  // evidence the assembler resolved via `collectBuildArtifacts`. When
  // both fire, the priority resolver drops to `"low"` and the paired
  // `couldBeWrongBecause: ["minified_vendor_no_sourcemap"]` evidence
  // stamp lands on the materialized candidate (composed below).
  const isBuildArtifact = buildArtifactPaths.has(g.filePath);
  // Thread the rolled-up confidence into the priority resolver so a
  // dedup union whose evidence concedes "low" static signal cannot
  // ride at `priority: "high"` on an A/AA criterion. Mirrors the
  // hedging / vendorContext / predicateConceded gates — the
  // confidence channel is the parallel signal naming heuristic
  // evidence; per `docs/kb/architecture/ai-first-consumer.md`
  // "Reason / priority / fix-description must agree across all
  // three channels", priority must agree with that framing.
  const evidence = {
    reason: g.reason,
    confidence,
    ...(g.vendorContext === undefined ? {} : { vendorContext: g.vendorContext }),
    ...(g.predicateConceded === undefined ? {} : { predicateConceded: g.predicateConceded }),
    ...(g.vendorPathHint === true ? { vendorPathHint: true } : {}),
    ...(isBuildArtifact ? { isBuildArtifact: true } : {}),
  };
  const priority = resolvePriorityForCandidate({ level, evidence });
  // Pair the priority drop with the structured evidence stamp the
  // gate concedes — the agent reads BOTH the `"low"` budget signal
  // AND the `couldBeWrongBecause: ["minified_vendor_no_sourcemap"]`
  // token so the dismissal path is "verify the predicate-strength
  // concession the gate names" rather than guessing why the budget
  // dropped. Helper returns null when no gate fired, so the
  // conditional spread below leaves the field omitted on ordinary
  // candidates per CLAUDE.md §1 "Ambiguous field shapes are dishonest."
  const couldBeWrongBecause = couldBeWrongBecauseForVendorBuildArtifact(evidence);
  // Per-emission unique address — sorted-criteria-joined ruleId slot
  // means the same conceptual candidate produces the same id on every
  // surface that ships it (`scan_file`, `scan_project.reviewCandidates`,
  // `checklist.items[].candidates`). See
  // `src/utils/finding-id.ts#computeCandidateFindingId` for the recipe
  // and the cross-surface invariant test
  // `tests/integration/mcp-consistency/candidate-finding-id-cross-surface.test.ts`.
  const findingId = computeCandidateFindingId({
    criteria,
    filePath: g.filePath,
    line: g.line,
    column: g.column,
  });
  return {
    findingId,
    criteria,
    line: g.line,
    column: g.column,
    reason: g.reason,
    priority,
    confidence,
    ...(g.snippet === undefined ? {} : { snippet: g.snippet }),
    ...(g.siblingOccurrences === undefined || g.siblingOccurrences.length === 0
      ? {}
      : { siblingOccurrences: g.siblingOccurrences }),
    ...(g.vendorPathHint ? { vendorPathHint: g.vendorPathHint } : {}),
    ...(g.durationLiteralMs === undefined ? {} : { durationLiteralMs: g.durationLiteralMs }),
    ...(g.durationExpression === undefined ? {} : { durationExpression: g.durationExpression }),
    ...(g.sourceCount === undefined ? {} : { sourceCount: g.sourceCount }),
    ...(g.matchOffset === undefined ? {} : { matchOffset: g.matchOffset }),
    ...(g.matchLength === undefined ? {} : { matchLength: g.matchLength }),
    ...(couldBeWrongBecause === null ? {} : { couldBeWrongBecause }),
  };
}
