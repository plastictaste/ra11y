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
import {
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
}

/** Aggregator entry held during the dedup passes. */
interface DedupAcc {
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
): readonly DedupedReviewCandidate[] {
  const byReasonKey = passOneCollectByReasonKey(candidates);
  const byPositionKey = passTwoCollectByPosition(byReasonKey);
  return [...byPositionKey.values()]
    .sort((a, b) => a.order - b.order)
    .map((acc) => materializeDedupedCandidate(acc, criterionLevels));
}

// Re-export the helper so callers (e.g. response-assembler) can
// build the lookup map once from the standards registry without
// reaching into the priority module directly.
export { buildCriterionLevelMap } from "./review-candidate-priority.ts";

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
): DedupedReviewCandidate {
  const criteria = [...g.criteria].sort();
  // Take the strongest-attention level across the union of criteria
  // — riding at AAA priority on a candidate that also satisfies an
  // AA criterion would understate the attention budget. The shared
  // resolver is the same logic checklist runs per-item, so the same
  // conceptual candidate ranks identically across both surfaces.
  const level = strongestAttentionLevel(criteria, criterionLevels);
  const priority = resolvePriorityForCandidate({
    level,
    evidence: {
      reason: g.reason,
      ...(g.vendorContext === undefined ? {} : { vendorContext: g.vendorContext }),
      ...(g.predicateConceded === undefined ? {} : { predicateConceded: g.predicateConceded }),
    },
  });
  // Take the highest confidence across the folded union — single
  // "high" hit sizes the entry honestly even when other hits are
  // lower-signal. Confidences is non-empty by construction (every
  // source candidate seeded one entry); the fallback narrows the
  // type for downstream consumers.
  const confidence: ReviewConfidence =
    highestCandidateConfidence(g.confidences.map((c) => ({ confidence: c }))) ?? "low";
  return {
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
  };
}
