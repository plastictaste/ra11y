/**
 * Pre-payload preflight for the suggest_fix MCP handler.
 *
 * Runs the single-file rule scan, looks up the matching violation,
 * and runs the candidate-bridge fallback when the rule lookup misses.
 * Returns the per-call view the handler threads into
 * `buildSuggestFixPayload`. Lives in its own module so the
 * `tool-suggest-fix.ts` MCP handler stays under the
 * 150-effective-line cap enforced by `scripts/check-limits.ts`.
 *
 * Pure pass-through over `runScan` + `lookupCandidateBridge` — no I/O
 * beyond what the scan helpers already perform.
 */

import { runScan } from "../engine/scanner.ts";
import type { Rule } from "../types/rule.ts";
import type { Violation } from "../types/violation.ts";
import type { McpSession } from "./session.ts";
import { lookupCandidateBridge } from "./suggest-fix-candidate-bridge.ts";
import { applyRuleSettings, resolveStandards } from "./tools-helpers.ts";

export interface SuggestFixPreflightArgs {
  readonly session: McpSession;
  readonly parsed: NonNullable<Awaited<ReturnType<McpSession["parseFile"]>>>;
  readonly rule: Rule;
  readonly inputCriterionId: string | undefined;
  readonly ruleId: string;
  readonly line: number;
}

export interface SuggestFixPreflightResult {
  readonly result: ReturnType<typeof runScan>["result"];
  readonly match: Violation | undefined;
  readonly candidateMatch: ReturnType<typeof lookupCandidateBridge>;
}

export function runSuggestFixPreflight(args: SuggestFixPreflightArgs): SuggestFixPreflightResult {
  const standards = resolveStandards(undefined, args.session);
  const { result } = runScan({
    standards: args.session.registry.standards,
    rules: applyRuleSettings(args.session.registry.rules, args.session.config.rules),
    enabled: standards,
    files: [args.parsed],
    level: args.session.config.level,
  });
  const match = result.violations.find(
    (v) => v.ruleId === args.ruleId && v.location.line === args.line,
  );
  const candidateMatch = lookupCandidateBridge({
    match,
    parsed: args.parsed,
    session: args.session,
    rule: args.rule,
    inputCriterionId: args.inputCriterionId,
    standards,
    line: args.line,
  });
  return { result, match, candidateMatch };
}
