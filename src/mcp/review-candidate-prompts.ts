/**
 * Cross-surface helper: hoist the per-criterion shared `reason` text
 * from review-candidate fan-outs into a top-level prompts-style map.
 *
 * Background — the dishonest shape this closes:
 *   Six `<audio>` elements emit candidates under wcag22:1.2.1 (and the
 *   wcag21:1.2.1 sibling). Each emission carries a byte-identical
 *   `reason: "audio element -- verify transcript is provided"` because
 *   the finder builds the reason once per element-tag and reuses it
 *   for every criterion the element fans out to. Pre-hoist, the wire
 *   shape ships 6 candidates × 1 criterion = 6 rows of identical prose
 *   + the same prose duplicated again on the wcag21 fan-out — agents
 *   reading the response see signal duplicated where it should be
 *   shared. Per `docs/kb/architecture/ai-first-consumer.md` "Sibling
 *   fields naming the same concept must use one shape" the duplication
 *   is itself the failure mode.
 *
 * The hoist keyed on `criterionId` lifts the shared form to a top-
 * level `Record<criterionId, { genericReason }>` map agents read
 * once. Per-candidate `reason` stays populated unchanged — the field
 * is the per-location shape every consumer already binds against;
 * removing it would break the shape contract on
 * `scan_file.reviewCandidates[]` / `checklist.items[].candidates[]` /
 * `scan_project.reviewCandidates[]`. The hoist is purely additive: a
 * top-level `genericReason` for the criteria where every emitted
 * candidate carried the same reason text, omitted entirely for
 * criteria with varying reasons (mdx prose-container suffix, cross-
 * finder concatenations under `dedupeReviewCandidatesForSingleFile`'s
 * pass 2, etc.).
 *
 * Doctrine-consistent precedent — `review_candidates` already hoists
 * the WCAG review-prompt text to `prompts[criterionId].text` once per
 * criterion (line 17 of `tool-review-candidates.ts` documents the
 * ~450-char prose dedup rationale). This helper is the same move at
 * one layer up: instead of the WCAG prompt the finder declares once,
 * it dedups the per-finder static reason the finder constructs once
 * per element. The resulting `prompts[criterionId]` object thus
 * carries `text` (WCAG review prompt) AND `genericReason` (the
 * finder's shared reason text) on `review_candidates`; sibling
 * surfaces ship a parallel `reviewCandidatePrompts: Record<criterionId,
 * { genericReason }>` map for the same field.
 *
 * Why additive rather than slim: the slim form (omit per-candidate
 * `reason` when shared, surface `genericReason` instead) was
 * considered. Per AI-first doctrine "Per-tool review-candidate shape
 * must agree across surfaces" + "Ambiguous field shapes are
 * dishonest", a per-candidate field that switches between populated
 * and absent based on sibling context creates a shape the agent
 * cannot read by inspecting one row alone — it must consult the
 * top-level `prompts` to disambiguate. The additive form preserves
 * per-row addressability (every candidate carries its `reason` in
 * the same slot) AND adds the dedup signal (top-level prompts) so
 * agents that want to recognize / batch-act on the shared form have
 * the explicit signal. Failure modes are asymmetric: under-surfacing
 * a real reason variation (slim) is silent and non-reversible; over-
 * surfacing the dedup signal as additive prose costs a few bytes
 * per criterion.
 *
 * Output shape: `Record<criterionId, { genericReason: string }>`
 * where every entry's `genericReason` is the verbatim shared reason.
 * Criteria whose emissions did not share a reason are absent from
 * the map (per CLAUDE.md §1 "Ambiguous field shapes are dishonest"
 * — present-when-meaningful). Empty map signals "no criterion's
 * candidates had a deterministic shared reason"; callers
 * conditional-spread the wire field so an empty map never lands as a
 * `reviewCandidatePrompts: {}` sentinel.
 */

import type { CandidateFinder, ReviewCandidate } from "../types/review.ts";

/**
 * Per-criterion entry in the prompts map. The structured object shape
 * (rather than a bare `Record<criterionId, string>`) leaves room for
 * future additive fields the per-criterion bucket might carry —
 * mirroring the existing `review_candidates` `prompts[criterionId]`
 * shape that already carries `{ text, finderId }` so consumers can
 * read both prompts surfaces with one parser.
 */
export interface ReviewCandidatePromptEntry {
  /**
   * The verbatim reason text every candidate of this criterion shared.
   * Always present when the entry is emitted — the helper never emits
   * a sentinel empty string, per CLAUDE.md §1 "Ambiguous field shapes
   * are dishonest." A criterion whose emissions vary in reason text
   * is omitted from the map entirely.
   */
  readonly genericReason: string;
}

/**
 * Packs the conditional-spread fragment for the inline review-
 * candidate fields shipped on `scan_project` responses
 * (`reviewCandidates` + `reviewCandidatePrompts`). Both fields are
 * present-when-meaningful per CLAUDE.md §1 — the helper omits each
 * entry independently when its input is empty / missing so the
 * wire shape stays honest. Extracted from the assembler so its
 * cognitive complexity stays under the lint cap.
 */
export function buildScanProjectReviewFields<TCandidate>(
  reviewCandidates: readonly TCandidate[] | undefined,
  reviewCandidatePrompts: Readonly<Record<string, ReviewCandidatePromptEntry>> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (reviewCandidates !== undefined && reviewCandidates.length > 0) {
    out["reviewCandidates"] = reviewCandidates;
  }
  if (reviewCandidatePrompts !== undefined && Object.keys(reviewCandidatePrompts).length > 0) {
    out["reviewCandidatePrompts"] = reviewCandidatePrompts;
  }
  return out;
}

/**
 * Build the per-criterion `genericReason` map from a flat candidate
 * list. Groups by `criterionId`; emits an entry only when every
 * candidate of that criterion carries byte-identical `reason` text
 * AND the criterion has at least one candidate.
 *
 * The byte-identical predicate matches the existing
 * `dedupeReviewCandidatesByReason` /
 * `dedupeReviewCandidatesForSingleFile` pass-1 fold key
 * `(filePath, line, column, reason)` — the same predicate that
 * folds per-criterion siblings within a single finder is the
 * predicate that says "the finder produces the same reason for every
 * emission of this criterion." When the finder varies the reason
 * (mdx prose-container suffix, cross-finder pass-2 concatenation
 * under `dedupeReviewCandidatesForSingleFile`'s position fold), the
 * predicate fails and the entry is omitted — the agent reads the
 * per-candidate `reason` field on each row instead, which is the
 * accurate per-location framing.
 *
 * Optional `manualIds` filter: when provided, restricts the map to
 * criteria whose ID is in the set. Mirrors the same filter
 * `buildScanProjectReviewCandidates` applies to its candidate list,
 * so the prompts map and the candidates list share the same
 * criterion universe — no orphan prompts entries for criteria the
 * caller doesn't surface candidates for.
 */
export function buildReviewCandidatePrompts(args: {
  readonly candidates: readonly ReviewCandidate[];
  readonly manualIds?: ReadonlySet<string>;
}): Readonly<Record<string, ReviewCandidatePromptEntry>> {
  const { candidates, manualIds } = args;
  if (candidates.length === 0) return {};
  // Track per-criterion: the first-seen reason text plus a `varies`
  // flag set the moment a sibling's reason diverges. Once `varies` is
  // true, the criterion is removed from the map at the materialize step.
  const byCriterion = new Map<string, { reason: string; varies: boolean }>();
  for (const c of candidates) {
    if (manualIds !== undefined && !manualIds.has(c.criterionId)) continue;
    const existing = byCriterion.get(c.criterionId);
    if (existing === undefined) {
      byCriterion.set(c.criterionId, { reason: c.reason, varies: false });
      continue;
    }
    if (existing.varies) continue;
    if (existing.reason !== c.reason) existing.varies = true;
  }
  const out: Record<string, ReviewCandidatePromptEntry> = {};
  for (const [criterionId, entry] of byCriterion.entries()) {
    if (entry.varies) continue;
    out[criterionId] = { genericReason: entry.reason };
  }
  return out;
}

/**
 * Index every loaded {@link CandidateFinder} by every criterion ID it
 * declares. Used by `review_candidates` and `checklist` to look up the
 * canonical WCAG `reviewPrompt` text per criterion — the same source of
 * truth so the two surfaces never drift on the prompt string for the
 * same criterion (per `docs/kb/architecture/ai-first-consumer.md` "Per-
 * tool review-candidate shape must agree across surfaces").
 *
 * First-finder-wins on collision: when two finders declare the same
 * criterion ID, the first one indexed by the registry's iteration order
 * stays. This matches the existing behavior of the per-tool
 * implementations being collapsed here — preserving identity across
 * the move.
 */
export function indexFindersByCriterion(
  finders: readonly CandidateFinder[],
): ReadonlyMap<string, CandidateFinder> {
  const out = new Map<string, CandidateFinder>();
  for (const finder of finders) {
    for (const cid of finder.criterionIds) {
      if (!out.has(cid)) out.set(cid, finder);
    }
  }
  return out;
}
