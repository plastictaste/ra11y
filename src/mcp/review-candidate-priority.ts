/**
 * Shared review-candidate priority/confidence resolution.
 *
 * The `checklist` and `scan_file` MCP surfaces both ship review-
 * candidate records the agent ranks by `priority` (attention budget)
 * and `confidence` (how strong the finder's static evidence is). Per
 * `docs/kb/architecture/ai-first-consumer.md` "Per-tool review-candidate
 * shape must agree across surfaces", the same conceptual candidate
 * cannot ride at one priority/confidence on `checklist` and a different
 * one on `scan_file` — agents call both surfaces in sequence and a
 * shape mismatch reads as a different mental model of the same
 * evidence.
 *
 * This module owns the canonical ranking logic so both surfaces
 * consume the same function. The two axes are:
 *
 *   - `confidence` passes through verbatim from the finder
 *     ({@link ReviewCandidate.confidence}). When dedup folds N
 *     per-criterion copies into one entry on `scan_file`, the union
 *     takes the highest confidence — a single "high" hit sizes the
 *     entry honestly even when other hits are lower-signal (mirrors
 *     the per-item rollup `highestConfidence` in `tool-checklist.ts`).
 *
 *   - `priority` is derived from the candidate's level (A/AA → high
 *     base, AAA → medium base) and downgraded to "medium" when the
 *     candidate's own evidence concedes the predicate may be
 *     satisfied (hedging reason text, vendor-path-shape `vendorContext`,
 *     or logotype-pattern `predicateConceded`). Same downgrade gates
 *     as `priorityFor` in `tool-checklist.ts`. The level lookup uses
 *     a caller-supplied criterion → level map so the helper stays
 *     pure (no standards-registry dependency).
 *
 * Both surfaces compute these with the same inputs, so the resulting
 * `priority` / `confidence` values agree on the same conceptual
 * candidate regardless of which tool emitted it. Pinned by an
 * integration test in `tests/integration/mcp-consistency/`.
 */

import type {
  ReviewCandidate,
  ReviewCandidatePredicateConceded,
  ReviewCandidateVendorContext,
  ReviewConfidence,
} from "../types/review.ts";

/** Priority bucket — same enum/semantics across `checklist` and `scan_file`. */
export type ReviewCandidatePriority = "high" | "medium" | "low";

const CONFIDENCE_RANK: Readonly<Record<ReviewConfidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Hedging tokens an agent reads as "the predicate this candidate
 * names may not even apply here." Drawn from the doctrine list in
 * `docs/kb/architecture/ai-first-consumer.md` "Reason / priority /
 * fix-description must agree across all three channels". Matched
 * case-insensitively against each candidate's reason text. The list
 * is intentionally narrow — it targets self-conceding framings, not
 * generic guidance ("verify the heading order is logical" is not a
 * hedge; the predicate is affirmed). Kept aligned with the original
 * list in `tool-checklist.ts`'s `HEDGING_TOKENS` so the two surfaces
 * downgrade on the same evidence.
 */
const HEDGING_TOKENS: readonly RegExp[] = [
  /\bmay not apply\b/i,
  /\bonly if\b/i,
  /\bverify[^.]*\bbefore\b/i,
  /\bif this is\b/i,
  /Cross-file check:\s*grep/i,
];

/**
 * Minimal per-candidate evidence shape needed to resolve priority.
 * Both `ReviewCandidate` and `DedupedReviewCandidate` satisfy this
 * structurally — the helper does not care which surface called it.
 *
 * `confidence` is the optional fourth downgrade gate — when the
 * finder's static evidence is `"low"` (heuristic match on narrow
 * evidence per the {@link ReviewConfidence} contract), the candidate
 * cannot honestly ride at `"high"` priority on an A/AA criterion. The
 * confidence channel concedes the static evidence is weak; the
 * priority channel must agree per `docs/kb/architecture/ai-first-
 * consumer.md` "Reason / priority / fix-description must agree across
 * all three channels". Omitted when the caller has not threaded the
 * finder's confidence through (rare — the dedup path and the per-item
 * checklist rollup both have it on hand) and the resolver falls back
 * to the existing three-gate logic.
 */
export interface PriorityCandidateEvidence {
  readonly reason: string;
  readonly vendorContext?: ReviewCandidateVendorContext;
  readonly predicateConceded?: ReviewCandidatePredicateConceded;
  readonly confidence?: ReviewConfidence;
}

/**
 * Returns true when the candidate's reason text carries a hedging
 * token from the doctrine list. The agent reading the candidate sees
 * a self-conceding framing (`"if this is a standalone single-page
 * file"`, `"verify the inheritance chain before"`, etc.) and the
 * priority must agree with the framing rather than ride at "high"
 * attention.
 */
export function candidateHedges(c: PriorityCandidateEvidence): boolean {
  return HEDGING_TOKENS.some((re) => re.test(c.reason));
}

/**
 * Resolves the `priority` for a single review candidate, given the
 * caller-supplied level (A / AA / AAA / base / …). Mirrors the
 * `priorityFor` ranker in `tool-checklist.ts` for the single-candidate
 * case: A/AA criteria default to "high", AAA defaults to "medium",
 * and any candidate whose own evidence concedes the predicate (hedging
 * reason text, vendor-path-shape `vendorContext`, logotype-pattern
 * `predicateConceded`, or finder `confidence: "low"`) downgrades from
 * "high" to "medium" so the attention-budget signal agrees with the
 * framing the candidate already carries.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Reason / priority /
 * fix-description must agree across all three channels": the priority
 * channel cannot ride at "high" on a candidate whose reason concedes
 * the predicate may not apply, AND it cannot ride at "high" when the
 * finder itself reported `confidence: "low"` — the confidence channel
 * is the parallel signal naming "static evidence is heuristic on
 * narrow evidence" (per `ReviewConfidence` contract), and the
 * three-channel agreement rule applies symmetrically. Without this
 * gate, a heterogeneous corpus where most criteria are A/AA reports
 * uniform `priority: "high"` even when individual candidates ride at
 * `confidence: "low"`, denying the agent the ranking signal the
 * priority field exists to provide.
 *
 * The downgrade gates are checked individually (rather than the
 * `everyCandidateX` pattern checklist uses on the per-item rollup)
 * because this resolver runs per-candidate — the per-item helpers
 * fold across N candidates' evidence, but here every entry is a
 * single candidate (or a single deduped union) and the per-finding
 * `vendorContext` / `predicateConceded` / hedging / low-confidence
 * signal IS the conceded evidence.
 */
export function resolvePriorityForCandidate(args: {
  readonly level: string | undefined;
  readonly evidence: PriorityCandidateEvidence;
}): ReviewCandidatePriority {
  const { level, evidence } = args;
  // Default base when the caller could not resolve a level (unknown
  // standard, criterion lookup miss): treat as "medium" so the
  // candidate still surfaces but does not crowd out grounded A/AA
  // work the agent is budgeting against. Mirrors checklist's
  // behavior on the no-candidates branch — same default-down posture.
  const base: ReviewCandidatePriority = level === "A" || level === "AA" ? "high" : "medium";
  if (base !== "high") return base;
  if (candidateHedges(evidence)) return "medium";
  if (evidence.vendorContext !== undefined) return "medium";
  if (evidence.predicateConceded !== undefined) return "medium";
  if (evidence.confidence === "low") return "medium";
  return "high";
}

/**
 * Picks the strongest-attention level across a set of criteria the
 * candidate satisfies. Used by the dedup-fold path on `scan_file`:
 * one entry can carry multiple criterion IDs (canonical case:
 * `wcag22:1.3.6` + `wcag21:1.3.6` + `wcag22:3.3.8` folded by
 * `dedupeReviewCandidatesForSingleFile` Pass 2). The honest priority
 * is the highest-attention level among the union — riding at AAA
 * priority on a candidate that also satisfies an AA criterion would
 * understate the attention budget.
 *
 * Returns `"A"` when ANY criterion in the set is level A, then `"AA"`,
 * then `"AAA"`, then the first non-empty level we see. Returns
 * `undefined` when the lookup map can't resolve any criterion in the
 * set — caller treats that as "no level evidence" and falls back to
 * the no-level base in {@link resolvePriorityForCandidate}.
 */
export function strongestAttentionLevel(
  criteria: readonly string[],
  criterionLevels: ReadonlyMap<string, string>,
): string | undefined {
  let sawAA = false;
  let sawAAA = false;
  let other: string | undefined;
  for (const id of criteria) {
    const level = criterionLevels.get(id);
    if (level === undefined) continue;
    if (level === "A") return "A";
    if (level === "AA") sawAA = true;
    else if (level === "AAA") sawAAA = true;
    else if (other === undefined) other = level;
  }
  if (sawAA) return "AA";
  if (sawAAA) return "AAA";
  return other;
}

/**
 * Resolves `confidence` for a folded dedup union: passes through when
 * a single source candidate, takes the max across the rank when
 * multiple were folded. Mirrors `highestConfidence` in
 * `tool-checklist.ts`'s per-item rollup so a candidate union on
 * scan_file ships the same confidence the same union would ship as
 * the checklist item rollup.
 */
export function highestCandidateConfidence(
  candidates: readonly { readonly confidence: ReviewConfidence }[],
): ReviewConfidence | null {
  let best: ReviewConfidence | null = null;
  for (const c of candidates) {
    if (best === null || CONFIDENCE_RANK[c.confidence] > CONFIDENCE_RANK[best]) {
      best = c.confidence;
    }
  }
  return best;
}

/**
 * Builds a `criterionId → level` lookup map from a set of standards.
 * Single-pass over `standards[].criteria` so the caller can hand the
 * full registry once and the dedup helper does an O(1) lookup per
 * candidate criterion. Used by `scan_file`'s assembler call to
 * thread level info into the per-candidate priority resolver
 * without coupling the dedup module to the standards registry.
 */
export function buildCriterionLevelMap(
  standards: readonly {
    readonly criteria: readonly { readonly id: string; readonly level: string }[];
  }[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const s of standards) {
    for (const c of s.criteria) {
      out.set(c.id, c.level);
    }
  }
  return out;
}

/**
 * Convenience overload that takes a `ReviewCandidate` directly and
 * resolves priority by looking up its single `criterionId`. Used by
 * surfaces that emit one candidate per criterion (the `checklist`
 * per-criterion item shape). For surfaces that fold N criteria into
 * one entry (`scan_file`'s deduped shape), use
 * {@link strongestAttentionLevel} + {@link resolvePriorityForCandidate}
 * directly so the level reflects the union.
 */
export function resolvePriorityForReviewCandidate(args: {
  readonly candidate: ReviewCandidate;
  readonly criterionLevels: ReadonlyMap<string, string>;
}): ReviewCandidatePriority {
  const { candidate, criterionLevels } = args;
  const level = criterionLevels.get(candidate.criterionId);
  return resolvePriorityForCandidate({
    level,
    evidence: {
      reason: candidate.reason,
      confidence: candidate.confidence,
      ...(candidate.vendorContext === undefined ? {} : { vendorContext: candidate.vendorContext }),
      ...(candidate.predicateConceded === undefined
        ? {}
        : { predicateConceded: candidate.predicateConceded }),
    },
  });
}
