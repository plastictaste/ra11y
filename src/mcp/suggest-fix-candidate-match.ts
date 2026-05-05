/**
 * Review-candidate match resolver for `suggest_fix`. Closes the
 * checklist→suggest_fix lane parity gap: when a checklist candidate
 * cites `(criterionId, file, line)` and the agent calls `suggest_fix`
 * with a rule that satisfies the criterion, the rule may not fire as
 * a violation at that line (rules are predicate-narrow; finders are
 * predicate-broad), and the per-call surface used to dead-end with
 * `kind: "none"`. This resolver locates the same review candidate
 * checklist surfaced and threads its prose into a `kind: "guidance"`
 * payload so the agent gets the same actionable framing the manual-
 * review surface promised.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md`
 *   - "Per-call shape must agree with per-class plan tally" extended
 *     one hop to checklist→suggest_fix lane parity. When checklist
 *     points at (criterionId, file, line), suggest_fix on a satisfying
 *     rule's id must resolve to a non-`none` shape — otherwise the
 *     agent reads two responses from the same input that disagree on
 *     "is there work here?" and the silent-miss failure mode is
 *     identical to the cross-surface count invariant.
 *   - "Per-tool review-candidate shape must agree across surfaces" —
 *     the candidate is the same conceptual entry the checklist surfaced;
 *     the per-call surface must address it via the same emission-locator.
 *
 * The match key is `(file, line, criterionId ∈ rule.satisfies)`. A rule
 * may satisfy multiple criteria across standards; any one of them
 * matching the candidate's `criterionId` is enough — equivalentTo
 * traversal happens implicitly because rules carry every criterion they
 * satisfy across all loaded standards in their `satisfies` list.
 *
 * Pure function over the per-call inputs. No I/O.
 */

import type { CandidateFinder, ReviewCandidate } from "../types/review.ts";
import type { Rule } from "../types/rule.ts";
import { indexFindersByCriterion } from "./review-candidate-prompts.ts";
import type { McpSession } from "./session.ts";
import { findRule } from "./tools-helpers.ts";

/**
 * Compact shape threaded onto `BuildSuggestFixPayloadArgs.candidateMatch`
 * when the resolver finds a candidate at the requested line. The args
 * type is opaque to the resolver — it carries only the fields the
 * payload builder needs to compose `kind: "guidance"`. Including the
 * resolved finder's `reviewPrompt` lets the builder pair the candidate's
 * per-row `reason` with the finder's full verification guidance, which
 * agents previously had to re-fetch via `review_candidates`.
 */
export interface CandidateMatch {
  /** The candidate's `reason` text — already prose framed as "verify X". */
  readonly reason: string;
  /**
   * The finder's documented verification prompt — the long-form prose
   * the per-criterion review surface ships. Optional because plugin
   * finders may register without a doc block; when absent the payload
   * builder relies on `reason` alone.
   */
  readonly reviewPrompt?: string;
  /**
   * The criterion the candidate is grounded in. The payload builder
   * names this criterion in the suggestion prose so the agent can
   * cross-reference checklist's row on the same criterion id.
   */
  readonly criterionId: string;
}

/**
 * Locate the review candidate at `(filePath, line)` whose `criterionId`
 * is in `rule.satisfies`, optionally enrich with the finder's
 * `reviewPrompt`, and return the compact {@link CandidateMatch} the
 * payload builder consumes. Returns `null` when:
 *
 *   - no candidate matches the file:line coordinate;
 *   - a candidate matches the coordinate but its `criterionId` is not
 *     in the rule's `satisfies` list (the agent passed an unrelated
 *     rule and the resolver cannot honestly route via this candidate).
 *
 * The first match wins — checklist's per-criterion dedup already
 * collapsed (path, line, reason) duplicates upstream, so a tie at the
 * coordinate level represents independent finders that happened to
 * fire on the same element. Either entry is correct grounding for the
 * `kind: "guidance"` payload; first-seen ordering keeps the choice
 * deterministic across runs.
 */
export function findCandidateMatch(args: {
  readonly rule: Rule;
  readonly filePath: string;
  readonly line: number;
  readonly candidates: readonly ReviewCandidate[];
  readonly findersByCriterion: ReadonlyMap<string, CandidateFinder>;
}): CandidateMatch | null {
  const { rule, filePath, line, candidates, findersByCriterion } = args;
  const satisfies = new Set(rule.satisfies);
  for (const c of candidates) {
    if (c.location.filePath !== filePath) continue;
    if (c.location.line !== line) continue;
    if (!satisfies.has(c.criterionId)) continue;
    const finder = findersByCriterion.get(c.criterionId);
    const reviewPrompt = finder?.docs.reviewPrompt;
    return {
      reason: c.reason,
      criterionId: c.criterionId,
      ...(reviewPrompt === undefined ? {} : { reviewPrompt }),
    };
  }
  return null;
}

/**
 * Handler-side glue around {@link findCandidateMatch}. Resolves the
 * rule on the registry, indexes the finder map, and returns the
 * candidate match — null when:
 *
 *   - the rule lookup already matched a violation
 *     (`match !== undefined`); the existing routing lanes own that
 *     case;
 *   - the rule does not resolve on the session registry (the handler
 *     emits `rule-not-found` upstream of this resolver, so this guard
 *     covers the defensive race only);
 *   - no candidate at the queried coordinate is associated with one
 *     of the rule's criteria.
 *
 * Lives here (rather than inlined in `tool-suggest-fix.ts`) so the
 * MCP handler stays under the file budget enforced by
 * `scripts/check-limits.ts`. Pure function over the inputs.
 */
export function resolveCandidateMatchForHandler(args: {
  readonly match: unknown;
  readonly ruleId: string;
  readonly filePath: string;
  readonly line: number;
  readonly session: McpSession;
  readonly candidates: readonly ReviewCandidate[];
}): CandidateMatch | null {
  if (args.match !== undefined) return null;
  const rule = findRule(args.ruleId, args.session);
  if (rule === undefined) return null;
  return findCandidateMatch({
    rule,
    filePath: args.filePath,
    line: args.line,
    candidates: args.candidates,
    findersByCriterion: indexFindersByCriterion(args.session.registry.finders),
  });
}
