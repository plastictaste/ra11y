/**
 * Q-SHARED-SCAN-PROJECT-INLINE-REVIEW-CANDIDATES: inline manual-review
 * candidate surfacing for `scan_project` responses.
 *
 * When a `scan_project` call produces zero automated findings (`files:
 * []`) but grounded manual-review candidates exist
 * (`actionableManualItems > 0`), the response carries no `file:line`
 * pointer the agent can act on — historically forcing a separate
 * `checklist` round trip just to recover the locations the scan already
 * had in hand. Doctrine: "One tool call should answer 'what next?'"
 *
 * This helper builds the `reviewCandidates` array that rides on
 * `scan_project` in that narrow case. Shape choices follow the AI-first
 * consumer rules:
 *
 *   - Cross-standard dedup: one finder emits the same location once per
 *     criterion it satisfies (e.g. `wcag22:1.2.1` + `wcag21:1.2.1` +
 *     `section508:1194.22.b` at the same file:line:column:reason). The
 *     surfaced shape folds duplicates into a single entry with a sorted
 *     `criteria: string[]` — mirrors {@link DedupedReviewCandidate} on
 *     `scan_file` so an agent's existing parser for that shape works
 *     here too.
 *   - Manual-only filter: only candidates whose criterion ID lives in
 *     the caller's enabled-standards manual set surface. Candidates
 *     whose criterion isn't manual at this scan's level don't
 *     contribute to `actionableManualItems` either, so they'd be
 *     surface-only noise.
 *   - Cap at the caller's `limit`: the same knob that bounds the
 *     response's `files[]` applies here so one pathologically noisy
 *     finder can't blow the token budget.
 *   - Present-when-meaningful: the caller conditional-spreads the field
 *     (see `tool-scan-project.ts`); this helper never emits `[]`. Empty
 *     result means "omit the field entirely."
 *
 * Doctrine: "Surface, don't suppress" + "Ambiguous field shapes are
 * dishonest" + "One tool call should answer 'what next?'".
 */

import type { ReviewCandidate, ReviewConfidence } from "../types/review.ts";
import { computeCandidateFindingId } from "../utils/finding-id.ts";
import { buildCandidateCriteriaUnion } from "./review-candidate-dedup.ts";

/**
 * Per-candidate entry surfaced on `scan_project.reviewCandidates`.
 *
 * `criteria` carries every criterion ID the collapsed candidates
 * satisfied — sorted for deterministic output. `confidence` threads the
 * finder's static-evidence-strength signal so an agent reading the list
 * can prioritize (high-confidence lines first) without parsing
 * `reason`. `snippet` rides present-when-meaningful per CLAUDE.md §1
 * "Ambiguous field shapes are dishonest" — no sentinel empty string.
 */
export interface ScanProjectReviewCandidate {
  /**
   * Per-emission unique address — hashed via
   * {@link computeCandidateFindingId} over the cross-criterion union
   * plus `(file, line, column, reason)`. The post-dedup surface ships
   * ONE row per `(file, line, column, reason)` — `findingId` is unique
   * by construction here. The sibling {@link ScanProjectReviewCandidate#findingGroupId}
   * carries the cross-surface identity matching the same value on
   * `scan_file.reviewCandidates[]` and the per-item rows on
   * `checklist.items[].candidates[]` that point at this conceptual
   * emission.
   *
   * Per AI-first doctrine "Per-finding identifiers must be
   * addressable, not collision-prone": every `findingId` in a single
   * response must be unique.
   */
  readonly findingId: string;
  /**
   * Cross-surface group identity — same recipe as `findingId` on this
   * surface (one row per `(file, line, column, reason)`, so the group
   * equals the emission). Stamped explicitly so the wire shape mirrors
   * `checklist.items[].candidates[]`, where per-(criterion, position)
   * rows ship distinct `findingId` values but agree on
   * `findingGroupId` — letting an agent dedup-walk the cross-surface
   * conceptual group via this stable token.
   *
   * Per AI-first doctrine "Per-tool review-candidate shape must agree
   * across surfaces."
   */
  readonly findingGroupId: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly criteria: readonly string[];
  readonly reason: string;
  readonly confidence: ReviewConfidence;
  readonly snippet?: string;
}

interface GroupEntry {
  file: string;
  line: number;
  column: number;
  criteria: Set<string>;
  reason: string;
  confidence: ReviewConfidence;
  snippet: string | undefined;
  order: number;
}

/**
 * Build the `reviewCandidates` array for a `scan_project` response.
 *
 * Groups candidates by `(filePath, line, column, reason)` and folds
 * cross-standard criterion replication into one entry with a sorted
 * `criteria: string[]`. Filters to candidates whose criterion ID is in
 * `manualIds` (same filter the `actionableManualItems` headline uses)
 * so the shape is honest about "the candidates the headline counted."
 * Preserves first-seen order for determinism, then caps at `limit`.
 *
 * Returns `[]` when no candidates survive — the caller conditional-
 * spreads the field, so never emits an empty array on the wire.
 */
export function buildScanProjectReviewCandidates(args: {
  readonly candidates: readonly ReviewCandidate[];
  readonly manualIds: ReadonlySet<string>;
  readonly limit: number;
  /**
   * Caller-supplied scan root for path normalization in the per-emission
   * `findingId` hash. When provided, absolute candidate paths under
   * this root relativize before hashing so the same conceptual
   * candidate produces ONE id across `scan_file`, `scan_project`, and
   * `checklist`. Per `docs/kb/architecture/ai-first-consumer.md`
   * "Per-finding identifiers must be addressable, not collision-prone"
   * + "Per-tool review-candidate shape must agree across surfaces."
   */
  readonly scanRoot?: string;
}): readonly ScanProjectReviewCandidate[] {
  const { candidates, manualIds, limit, scanRoot } = args;
  if (candidates.length === 0 || limit <= 0) return [];
  // Per-`(file, line, column, reason)` within-finder cross-standard
  // union — built off the FULL raw candidate stream (not the manual-
  // filtered subset) so the union matches what `scan_file.review
  // Candidates[]` and `checklist.items[].candidates[]` hash. The
  // shared key shape means each finder's per-criterion entry produces
  // its own `findingId`, addressable independently. Manual-id
  // filtering still gates which entries SHIP; it just no longer
  // narrows the hashed criteria slot.
  const criteriaUnionByPosition = buildCandidateCriteriaUnion(candidates);
  const byKey = new Map<string, GroupEntry>();
  let nextOrder = 0;
  for (const c of candidates) {
    if (!manualIds.has(c.criterionId)) continue;
    const { filePath, line, column } = c.location;
    const key = `${filePath} ${line} ${column} ${c.reason}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.criteria.add(c.criterionId);
      continue;
    }
    byKey.set(key, {
      file: filePath,
      line,
      column,
      criteria: new Set([c.criterionId]),
      reason: c.reason,
      confidence: c.confidence,
      snippet: c.snippet,
      order: nextOrder++,
    });
  }
  if (byKey.size === 0) return [];
  const ordered = [...byKey.values()].sort((a, b) => a.order - b.order);
  const capped = ordered.slice(0, limit);
  return capped.map((g) => {
    // Local (per-reason) fold for the `criteria` field on the wire —
    // preserves the existing per-reason cardinality that downstream
    // consumers and tests pin against. The findingId hash uses the
    // per-`(file, line, column, reason)` within-finder cross-standard
    // union — same key the dedup helper hashes on so the same
    // conceptual candidate produces ONE `findingId` across scan_file,
    // scan_project, and checklist.
    const criteria = [...g.criteria].sort();
    const positionKey = `${g.file}\x00${g.line}\x00${g.column}\x00${g.reason}`;
    const hashCriteria = criteriaUnionByPosition.get(positionKey) ?? criteria;
    // Per-emission address — sorted-criteria-joined slot. On this
    // surface `findingId === findingGroupId` because dedup ships one
    // row per `(file, line, column, reason)`, so the emission IS the
    // group. The pair lands on the wire so the shape mirrors
    // `checklist.items[].candidates[]`, where the two ids diverge.
    const findingId = computeCandidateFindingId({
      criteria: hashCriteria,
      filePath: g.file,
      line: g.line,
      column: g.column,
      reason: g.reason,
      ...(scanRoot === undefined ? {} : { scanRoot }),
    });
    return {
      findingId,
      findingGroupId: findingId,
      file: g.file,
      line: g.line,
      column: g.column,
      criteria,
      reason: g.reason,
      confidence: g.confidence,
      // Present-when-meaningful: snippet-undefined omits the field
      // entirely rather than ship a sentinel empty string (CLAUDE.md §1).
      ...(g.snippet === undefined ? {} : { snippet: g.snippet }),
    };
  });
}
