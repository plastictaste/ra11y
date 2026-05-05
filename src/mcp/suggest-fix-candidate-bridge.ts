/**
 * Candidate-finder bridge for the `suggest_fix` `kind: "none"` branch.
 *
 * Background — the cross-surface invariant gap. Manual-review checklist
 * items ship `candidates[]` populated by candidate finders (see
 * `src/review/finders/*`). The set of locations a finder emits for a
 * criterion is intentionally broader than the set of locations the
 * single rule that satisfies that criterion fires on: the finder leans
 * "Surface, don't suppress" and emits low-confidence candidates the
 * rule's narrower predicate would skip (the canonical case is
 * `review/on-input-change` surfacing every `<select onchange>` while
 * `forms/select-onchange-context-change` only fires when a navigation
 * token is statically detected in the handler).
 *
 * `suggest_fix` runs the rule alone. When the agent picks a checklist
 * candidate's `(file, line)` and calls `suggest_fix(<rule-or-criterion>,
 * file, line)`, the rule lookup misses on every low-confidence
 * candidate the finder surfaced — the response shipped `kind: "none"`
 * with no breadcrumb, dead-ending the agent on a candidate the same
 * project response had advertised. Per AI-first doctrine "Per-call
 * shape must agree with per-class plan tally" extended one level deeper
 * to "checklist candidate → suggest_fix lane parity," the per-call
 * surface must address the candidate the cross-surface tool just
 * pointed at.
 *
 * The honest closure: when `suggest_fix`'s rule lookup misses, run the
 * candidate finders for the rule's `satisfies` criteria (or, when the
 * caller passed a criterion ID, that criterion alone) against the
 * already-parsed file. If a candidate's location matches the requested
 * line, return its `reason` text so the response carries actionable
 * guidance. The caller (`buildSuggestFixPayload`) shapes that into a
 * `kind: "guidance"` outcome rather than the dead-end `kind: "none"`.
 *
 * Pure function over its inputs — the runner is `runFindersForFile`
 * from the engine; we don't import from rules/standards directly.
 */

import { runFindersForFile } from "../engine/candidate-runner.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { CandidateFinder, ReviewCandidate } from "../types/review.ts";
import type { Rule } from "../types/rule.ts";
import type { Violation } from "../types/violation.ts";
import type { McpSession } from "./session.ts";

/**
 * Inputs to {@link findCandidateAtLine}. The caller (the suggest_fix
 * handler) supplies the parsed file, the registry's finders, the
 * criteria the lookup should consider (either the rule's `satisfies`
 * list or the single criterion passed to `suggest_fix` via the
 * criterion-bridge), and the line the agent asked about.
 */
export interface FindCandidateAtLineArgs {
  readonly parsed: ParsedFile;
  readonly finders: readonly CandidateFinder[];
  readonly criteria: readonly string[];
  readonly enabledStandards: ReadonlySet<string>;
  readonly line: number;
}

/**
 * Walks the registered candidate finders for the supplied criteria and
 * returns the first candidate whose `location.line` equals the
 * requested line. Returns null when no finder emits a candidate at that
 * line — the caller then falls through to the existing `kind: "none"`
 * shape (with `nearestFinding` / `inheritedFromWrapper` breadcrumbs).
 *
 * The finders run via the same `runFindersForFile` the main scanner
 * uses, so disable-pragma filtering and per-finder `appliesTo` gating
 * stay consistent across the surfaces. We intentionally don't surface
 * `afterProject` candidates: `suggest_fix` is single-file by design,
 * and a project-scoped candidate's evidence relies on cross-file
 * context the per-call surface doesn't have.
 */
export function findCandidateAtLine(args: FindCandidateAtLineArgs): ReviewCandidate | null {
  if (args.criteria.length === 0) return null;
  if (args.finders.length === 0) return null;
  const activeCriterionIds = new Set(args.criteria);
  const candidates = runFindersForFile({
    filePath: args.parsed.filePath,
    source: args.parsed.source,
    ast: args.parsed.ast,
    enabledStandards: args.enabledStandards,
    disableMap: args.parsed.disableMap ?? new Map(),
    finders: args.finders,
    activeCriterionIds,
  });
  for (const c of candidates) {
    if (c.location.line !== args.line) continue;
    if (!activeCriterionIds.has(c.criterionId)) continue;
    return c;
  }
  return null;
}

/**
 * Conditional wrapper around {@link findCandidateAtLine} for the
 * `suggest_fix` handler: returns null when the rule lookup matched
 * (so we never run finders we don't need to), otherwise routes the
 * lookup to the criterion the caller asked about (criterion-ID
 * input) or the rule's full `satisfies[]` list (rule-ID input). Lives
 * here so the MCP handler stays under the 150-effective-line cap
 * enforced by `scripts/check-limits.ts`.
 */
export function lookupCandidateBridge(args: {
  readonly match: Violation | undefined;
  readonly parsed: ParsedFile;
  readonly session: McpSession;
  readonly rule: Rule;
  readonly inputCriterionId: string | undefined;
  readonly standards: readonly string[];
  readonly line: number;
}): ReviewCandidate | null {
  if (args.match !== undefined) return null;
  return findCandidateAtLine({
    parsed: args.parsed,
    finders: args.session.registry.finders,
    criteria: args.inputCriterionId ? [args.inputCriterionId] : args.rule.satisfies,
    enabledStandards: new Set(args.standards),
    line: args.line,
  });
}
