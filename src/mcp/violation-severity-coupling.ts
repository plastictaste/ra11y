/**
 * Couple severity to the curated verify-in-source token set on the
 * raw violation stream.
 *
 * Doctrine source: docs/kb/architecture/ai-first-consumer.md
 *   "Reason text and severity must agree" (conceded-uncertainty
 *   extension)
 *
 * When a rule emits a violation whose `couldBeWrongBecause` array
 * contains a token in {@link VERIFY_IN_SOURCE_TOKENS}, the rule has
 * conceded — at the emit site — that the predicate may not hold on
 * this substrate (layout/partial composition site, isolated component
 * demo body shape, template-injected title, runtime DOM mutation, …).
 * Shipping such a finding at `severity: error` / `warning` while the
 * conceded reason rides on the same finding is the canonical
 * contradiction the doctrine names: the agent budgets against the
 * surfacing pressure (severity), reads the reason that concedes the
 * predicate, and discovers the budget was wasted.
 *
 * Closure picked: structural coupling at the response-pipeline layer
 * (this helper) rather than at each rule's emit site. Five rules
 * across the {@link semantics/landmark-main} / {@link
 * semantics/heading-hierarchy} / {@link document/page-titled} /
 * {@link document/lang-attribute} / {@link tooltip/dismissable}
 * families ship the same dishonest shape; centralizing the
 * normalization keeps the rules' emit-site code uniform and ensures the
 * cross-surface contract holds — the pre-formatting tally
 * ({@link tallyManualCriteria}) walks the same coupled stream the
 * AgentFinding pipeline serializes, so `actionableManualItemsBySource`
 * agrees with the per-finding shape the agent reads on the wire.
 *
 * Scope is narrow by construction. Only the curated token set in
 * {@link VERIFY_IN_SOURCE_TOKENS} qualifies — the membership criterion
 * (per the docblock at that constant) is "the rule's evidence model
 * has conceded the predicate may not hold on this substrate." Tokens
 * naming corpus-level evidence-horizon limitations
 * (`cross_file_listener_resolution_not_attempted_by_rule`,
 * `cross_file_idref_resolution_not_attempted_by_rule`) are NOT in the
 * set — those describe scanner limitations on findings that legitimately
 * stay at full severity, and the per-finding-confidence-parity helper
 * already propagates the cross-file caveat onto each finding's
 * `couldBeWrongBecause`. Likewise the parser-substrate codes
 * (`file_parse_error`, `partial_parse`,
 * `fragment_input_no_document_envelope`) describe substrate-bounded
 * evidence rather than a "verify the predicate" frame, and the
 * per-finding-beyond-parse-boundary helper drives those independently.
 *
 * No-op fast path: when the input has no qualifying violation, returns
 * the input array reference unchanged so common-case authored-source
 * scans pay no allocation. Returns a fresh array only when at least one
 * violation was rewritten.
 *
 * Idempotent: re-applying the pass on its own output is a no-op (a
 * `severity: info` violation has no further axis to downgrade), so
 * threading the coupling at multiple call sites is safe.
 */

import type { Violation } from "../types/violation.ts";
import { VERIFY_IN_SOURCE_TOKENS } from "./manual-criteria-tally.ts";

/**
 * Returns a violation stream whose `severity` is downgraded to `info`
 * for every entry carrying at least one entry in
 * {@link VERIFY_IN_SOURCE_TOKENS} on `couldBeWrongBecause`. Other
 * fields (rule id, message, location, fix, criteria, evidence) ride
 * unchanged.
 *
 * The downgrade is one-way: violations already at `severity: info`
 * stay at `info`; violations with no qualifying token stay at their
 * emitted severity. Findings carrying tokens outside the curated set
 * are not affected — see the file-level docblock for the membership
 * rationale.
 */
export function coupleSeverityToVerifyTokens(
  violations: readonly Violation[],
): readonly Violation[] {
  let mutated = false;
  const out = violations.map((v) => {
    if (v.severity === "info") return v;
    const reasons = v.couldBeWrongBecause;
    if (reasons === undefined || reasons.length === 0) return v;
    if (!hasVerifyToken(reasons)) return v;
    mutated = true;
    return { ...v, severity: "info" as const };
  });
  return mutated ? out : violations;
}

/**
 * True when at least one entry in `reasons` is in
 * {@link VERIFY_IN_SOURCE_TOKENS}. Pulled out of the main coupling
 * walker so the per-violation predicate stays under Biome's cognitive-
 * complexity ceiling and so future callers gating on the same shape
 * can reuse the same predicate.
 */
function hasVerifyToken(reasons: readonly string[]): boolean {
  for (const r of reasons) {
    if (VERIFY_IN_SOURCE_TOKENS.has(r)) return true;
  }
  return false;
}
