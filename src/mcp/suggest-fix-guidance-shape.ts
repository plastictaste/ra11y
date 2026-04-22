/**
 * Helpers for the `kind: "guidance"` response shape in `suggest_fix`.
 *
 * Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY: guidance responses nest
 * `approach` + `explanation` + `sourceContext` + `confidence` under
 * a ranked `primary` block to match the tool description's advertised
 * contract. `alternatives` is present-when-meaningful (CLAUDE.md §1
 * "Ambiguous field shapes are dishonest") and carries `{ approach,
 * explanation }` entries derived from the rule's structured
 * `FixPath[]`.
 *
 * Lives in its own file so `tool-suggest-fix-internals.ts` stays under
 * the 150-LOC MCP-handler budget; the guidance builder imports these
 * pure helpers directly.
 */

import type { FixPath } from "../types/violation.ts";

/**
 * Machine-parseable verify hint shared across every `suggest_fix`
 * outcome. Lives here (rather than in the main internals file) so both
 * `tool-suggest-fix-internals.ts` and `tool-suggest-fix-fixpaths.ts`
 * can reference it without creating a circular import between them.
 *
 * `tool` is always `"scan_file"` — the narrowest, most deterministic
 * verify surface (one file, one pass). `scan_project` is deliberately
 * NOT used here: broader scans dilute the honest signal ("did this
 * specific fix land?") with unrelated findings and cost the agent a
 * slower round-trip.
 *
 * `verifyRuleId` sits as a sibling of `args` (not inside it) because
 * `scan_file` has no `ruleId` parameter — encoding it in `args` would
 * emit an undeclared key against the tool's inputSchema. Agents that
 * want to post-filter the verify scan to only this rule can read it
 * here.
 */
export interface VerifyCommandStructured {
  readonly tool: "scan_file";
  readonly args: {
    readonly path: string;
  };
  readonly verifyRuleId: string;
}

/**
 * Derive a terse `approach` label from prose when the rule did not
 * supply a structured `FixPath.label` — used by the no-fixPaths
 * guidance branch where all we have is `match.suggestion` or
 * `match.message`. The label caps at the first sentence or ~80 chars
 * so the agent can glance at it; the full prose lives in `explanation`
 * alongside.
 */
export function deriveApproachFromProse(prose: string): string {
  const trimmed = prose.trim();
  // Prefer the first sentence (through terminal punctuation).
  const sentenceMatch = trimmed.match(/^[^.!?\n]{1,120}[.!?]/);
  const candidate = sentenceMatch ? sentenceMatch[0] : trimmed;
  if (candidate.length <= 80) return candidate.replace(/[.!?]$/, "");
  return `${candidate.slice(0, 77).trimEnd()}…`;
}

/**
 * Build the `alternatives` array for `kind: "guidance"` from the
 * rule's structured `FixPath[]`. Each entry carries an `approach`
 * (from the FixPath label) and an `explanation`. We reuse the
 * structured label as the explanation when no richer prose is
 * available — the label is the explanation at that grain — but keep
 * the two fields split because the advertised contract promises both.
 * Returns `undefined` when no alternatives exist; the caller conditional-
 * spreads the field to honor "present-when-meaningful."
 */
export function buildGuidanceAlternatives(
  paths: readonly FixPath[],
): ReadonlyArray<{ readonly approach: string; readonly explanation: string }> | undefined {
  if (paths.length === 0) return undefined;
  return paths.map((p) => ({
    approach: p.label,
    explanation: p.label,
  }));
}
