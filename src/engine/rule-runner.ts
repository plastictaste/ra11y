/**
 * Rule runner.
 *
 * Invokes the rules that apply to a given file, wraps each invocation in
 * a try/catch (a crashing rule never crashes the scanner — it produces a
 * synthetic `internal/rule-crash` violation and the scan continues), and
 * stamps each emitted violation with its ruleId and cited criteria.
 *
 * See docs/kb/architecture/rule-engine.md.
 */

import type { Ast } from "../types/ast.ts";
import type { EmittedViolation, FixClass, Language, Rule } from "../types/rule.ts";
import type { Severity, Violation } from "../types/violation.ts";
import { computeFindingId } from "../utils/finding-id.ts";
import { computeGroupKey, UNKNOWN_SHAPE } from "../utils/group-key.ts";
import { extensionMatches } from "../utils/path.ts";
import { maybePatternId } from "../utils/pattern-id.ts";
import { describeNodeShape, findTargetNodeAtLocation } from "./ast-helpers.ts";
import { buildContext, type ContextInput } from "./context-builder.ts";
import type { StandardFilter } from "./standard-filter.ts";

/**
 * Per-rule coverage counters the scanner threads through every
 * `runRulesForFile` call. Mutated in place: each per-file invocation
 * bumps `eligible` when the file's extension matches the rule's
 * `appliesTo.fileExtensions` (unconstrained rules are eligible on every
 * file), and bumps `evaluated` when the rule actually runs. The
 * engine folds the resulting map into `ScanProducts.perRuleCoverage`
 * at scan end — see `src/engine/scanner.ts` and
 * `src/types/violation.ts` for the surface shape.
 *
 * `crossFileCandidates` is an opt-in counter rules bump (via
 * {@link RuleContext.markCrossFileCandidate}) whenever they observe a
 * token whose resolution may extend beyond the current file —
 * `aria-labelledby="x"` (idref), `var(--name)` (custom property),
 * `<a href="#main">` (in-page anchor), an attribute that wires up an
 * external listener. The per-rule-coverage builder gates the
 * `crossFileCapable: false` confidence downgrade on this counter:
 * downgrade to `"medium"` only fires when the rule actually saw at
 * least one candidate token it couldn't fully resolve. With zero
 * candidates the row stays `"high"` — the rule ran on eligible inputs
 * and saw nothing the cross-file blindspot could have hidden, so the
 * default-pessimism `"medium"` would lie about what evidence the rule
 * had. See docs/kb/architecture/ai-first-consumer.md "Reason text and
 * severity must agree" — a `medium` row whose `reason` admits the rule
 * never saw a candidate token is the same dishonesty at the
 * scan-confidence layer.
 */
export interface RuleEvaluationTracker {
  readonly counts: Map<
    string,
    { eligible: number; evaluated: number; crossFileCandidates: number }
  >;
}

/** Per-file input to the rule runner. */
export interface RuleRunnerInput extends ContextInput {
  readonly rules: readonly Rule[];
  readonly filter: StandardFilter;
  /**
   * Optional per-rule tracker. When supplied, each active rule's
   * eligibility (extension match) and evaluation (actual run) is
   * counted into `tracker.counts`. Undefined in unit-test call sites
   * that don't care about the coverage shape.
   */
  readonly tracker?: RuleEvaluationTracker;
}

/** Runs every applicable rule against the given file and returns violations. */
export function runRulesForFile(input: RuleRunnerInput): readonly Violation[] {
  const out: Violation[] = [];
  const language = input.ast.language as Language;
  const fileExt = extractExtension(input.filePath);

  for (const rule of input.rules) {
    if (!input.filter.isRuleActive(rule)) continue;
    const eligible = applies(rule, fileExt, language);
    if (input.tracker) bumpTracker(input.tracker, rule.id, eligible);
    if (!eligible) continue;
    runOneRule(rule, input, out);
  }

  return out;
}

/**
 * Mutates `tracker.counts` in place: guarantees a `{ eligible, evaluated }`
 * entry for every active rule (even rules where no scanned file matches
 * their extension gate, so the scanner can surface zero-coverage as a
 * low-confidence signal rather than silently omit the rule). Bumps the
 * eligible count when the file matches, and — when eligible — the
 * evaluated count, since eligible files always proceed to
 * {@link runOneRule}.
 */
function bumpTracker(tracker: RuleEvaluationTracker, ruleId: string, eligible: boolean): void {
  const existing = tracker.counts.get(ruleId);
  const entry = existing ?? { eligible: 0, evaluated: 0, crossFileCandidates: 0 };
  if (eligible) {
    entry.eligible += 1;
    entry.evaluated += 1;
  }
  if (!existing) tracker.counts.set(ruleId, entry);
}

/**
 * Bumps the `crossFileCandidates` counter for a rule, ensuring the
 * tracker entry exists. Called from {@link RuleContext.markCrossFileCandidate}
 * whenever a rule observes a token whose resolution may extend beyond
 * the current file. Idempotent on missing entries — the rule may
 * mark candidates before its eligibility row has been set up if a
 * test harness wires a custom flow, so we initialize the row defensively.
 */
export function bumpCrossFileCandidate(tracker: RuleEvaluationTracker, ruleId: string): void {
  const existing = tracker.counts.get(ruleId);
  if (existing) {
    existing.crossFileCandidates += 1;
    return;
  }
  tracker.counts.set(ruleId, { eligible: 0, evaluated: 0, crossFileCandidates: 1 });
}

/**
 * Executes one rule's lifecycle against the current file and stamps its
 * emitted violations into `out`. Isolated so the top-level runner stays
 * under the cognitive-complexity budget — no nested try/catch, no
 * per-rule local state leaking into the loop.
 */
function runOneRule(rule: Rule, input: RuleRunnerInput, out: Violation[]): void {
  const citedCriteria = input.filter.citedCriteria(rule);
  const citedCriteriaTitles = input.filter.citedCriteriaTitles(rule);
  const sink: EmittedViolation[] = [];
  // Wire `markCrossFileCandidate` only for `crossFileCapable: false`
  // rules — there is no scan-confidence signal to derive for rules
  // that already resolve cross-file evidence in their own
  // implementation, and the unused method on every other rule's
  // context would be misleading. Tracker may be undefined in
  // unit-test call sites; the method becomes a no-op then.
  const tracker = input.tracker;
  const marker =
    tracker && rule.crossFileCapable === false
      ? () => bumpCrossFileCandidate(tracker, rule.id)
      : undefined;
  const ctx = buildContext(input, sink, rule.wrapperTreatsAsElement, marker);

  try {
    invokeLifecycle(rule, ctx, input.ast.root, sink);
  } catch (err) {
    out.push(ruleCrashViolation(rule.id, input.filePath, input.source, err));
    return;
  }

  for (const emitted of sink) {
    if (ctx.isDisabled(emitted.location.line, rule.id)) continue;
    out.push(
      stampViolation(
        emitted,
        rule.id,
        citedCriteria,
        citedCriteriaTitles,
        rule.fixClass,
        input.filePath,
        input.source,
        input.ast,
      ),
    );
  }
}

/** Calls beforeFile → check → afterFile, pushing any returned arrays into the sink. */
function invokeLifecycle(
  rule: Rule,
  ctx: ReturnType<typeof buildContext>,
  astRoot: unknown,
  sink: EmittedViolation[],
): void {
  const fileCtx = { ...ctx, nodes: astRoot };
  rule.beforeFile?.(fileCtx);
  collectReturn(rule.check?.(ctx), sink);
  collectReturn(rule.afterFile?.(fileCtx), sink);
}

function collectReturn(maybe: readonly Violation[] | undefined, sink: EmittedViolation[]): void {
  if (Array.isArray(maybe)) {
    for (const v of maybe) sink.push(v);
  }
}

/**
 * Builds the final Violation record from the rule's emitted form.
 * Rules don't know their own file path — the engine owns that fact —
 * so we stamp it here. This also lets a rule emit with `filePath: ""`
 * as a placeholder without the formatter losing the filename downstream.
 *
 * Also stamps `findingId` (stable cross-run identity) and `groupKey`
 * (stable cross-finding grouping by rule + normalized AST shape — see
 * docs/adr/0008-violation-group-key.md). The AST root is threaded
 * through so the engine can resolve the target node at the emitted
 * location; rules never compute either token themselves.
 */
function stampViolation(
  emitted: EmittedViolation,
  ruleId: string,
  criteria: readonly string[],
  criteriaTitles: readonly string[],
  fixClass: FixClass,
  filePath: string,
  source: string,
  ast: Ast,
): Violation {
  // `variantKey` disambiguates sub-variant emits from the same rule at
  // the same `(filePath, line)` (e.g. navigation/link-descriptive-text
  // firing both "generic-phrase" and "duplicate-name" on one anchor).
  // Conditional spread per exactOptionalPropertyTypes: finding-id.ts
  // folds the key into the hash only when present + non-empty, so
  // rules that don't opt in preserve their existing `findingId`s.
  const findingId = computeFindingId({
    ruleId,
    filePath,
    source,
    line: emitted.location.line,
    ...(emitted.variantKey ? { variantKey: emitted.variantKey } : {}),
  });
  const groupKey = computeGroupKey({
    ruleId,
    shape: shapeAtLocation(ast, emitted.location.line, emitted.location.column),
  });
  // Cross-template pattern fingerprint — stamped only when the rule
  // emitted a non-empty `snippet`. See `src/utils/pattern-id.ts`.
  const patternId = maybePatternId(ruleId, emitted.snippet);
  return {
    ruleId,
    fixClass,
    criteria,
    criteriaTitles,
    severity: emitted.severity,
    location: { ...emitted.location, filePath },
    // Selector/declaration line split for selector-scoped CSS findings
    //. `location.line` carries the
    // structural anchor (the CSS rule's selector start); `decline` carries
    // the offending declaration's line within that rule. Conditional
    // spread keeps `decline: undefined` off the wire per CLAUDE.md §1
    // "Ambiguous field shapes are dishonest." Currently emitted by
    // `motion/pause-stop-hide`.
    ...(typeof emitted.decline === "number" ? { decline: emitted.decline } : {}),
    message: emitted.message,
    findingId,
    groupKey,
    ...(patternId !== undefined && { patternId }),
    ...(emitted.suggestion !== undefined && { suggestion: emitted.suggestion }),
    ...(emitted.fix !== undefined && { fix: emitted.fix }),
    ...(emitted.fixPaths !== undefined && { fixPaths: emitted.fixPaths }),
    ...(emitted.snippet !== undefined && { snippet: emitted.snippet }),
    // Named reason codes for known escape hatches. Conditional spread
    // so `couldBeWrongBecause: []` (defensive: empty array from a rule)
    // collapses to absent on the stamped Violation — per
    // docs/adr/0009-violation-could-be-wrong-because.md + CLAUDE.md §1
    // ("Ambiguous field shapes are dishonest").
    ...(emitted.couldBeWrongBecause && emitted.couldBeWrongBecause.length > 0
      ? { couldBeWrongBecause: emitted.couldBeWrongBecause }
      : {}),
    // Per-finding scanner-confidence label, for rules whose evidence
    // horizon is bounded on the substrate they ran against (e.g.
    // `keyboard/handler-missing` on HTML referencing an external
    // `<script src>` whose handler bindings live in a sibling JS file
    // the rule can't see). Per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest" + the AI-first per-finding-confidence rule
    // (docs/kb/architecture/ai-first-consumer.md), the per-finding label
    // mirrors the per-rule `coverageConfidence` so an agent reading
    // both surfaces gets the same signal. Conditional spread keeps
    // `confidence: undefined` off the wire.
    ...(emitted.confidence !== undefined && { confidence: emitted.confidence }),
    // `classEvidence` is populated only by rules whose detection keys
    // off a class attribute (currently `aria/icon-font-hidden`). The
    // scanner surfaces it onto the Violation so the per-rule-coverage
    // aggregator can roll up per-file-per-class-pattern concentration
    // without rules having to re-derive the evidence. Conditional
    // spread keeps `classEvidence: ""` / `undefined` off the wire
    // (CLAUDE.md §1 "Ambiguous field shapes are dishonest").
    ...(typeof emitted.classEvidence === "string" && emitted.classEvidence.length > 0
      ? { classEvidence: emitted.classEvidence }
      : {}),
    // `siblingInstances` is populated only by rules that detected ≥3
    // visually-grouped sibling emissions sharing one parent + a stable
    // `(tagName, type, attributes-modulo-id)` fingerprint and collapsed
    // them into one canonical finding (-
    // COLLAPSE). The conditional spread keeps `siblingInstances: []` /
    // `undefined` off the wire (CLAUDE.md §1 "Ambiguous field shapes
    // are dishonest"). The rule is the only emitter — it has the
    // parent-DOM context the engine doesn't.
    ...(emitted.siblingInstances && emitted.siblingInstances.length > 0
      ? { siblingInstances: emitted.siblingInstances }
      : {}),
  };
}

function extractExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot);
}

function applies(rule: Rule, fileExt: string, _language: Language): boolean {
  const extensions = rule.appliesTo?.fileExtensions;
  if (!extensions || extensions.length === 0) return true;
  return extensionMatches(fileExt, extensions);
}

/**
 * Resolves the target node at the given emitted `(line, column)` and
 * describes it. When no node covers the location (synthetic emits,
 * project-scope rules that point at a placeholder), returns
 * `UNKNOWN_SHAPE` so every such emission under a single rule groups
 * into one "un-groupable" bucket — honest, deterministic, and never
 * throws. See docs/adr/0008-violation-group-key.md.
 */
function shapeAtLocation(ast: Ast, line: number, column: number): string {
  const node = findTargetNodeAtLocation(ast.root, line, column);
  return node ? describeNodeShape(node) : UNKNOWN_SHAPE;
}

function ruleCrashViolation(
  ruleId: string,
  filePath: string,
  source: string,
  err: unknown,
): Violation {
  const message = err instanceof Error ? err.message : String(err);
  const errorSeverity: Severity = "error";
  const findingId = computeFindingId({
    ruleId: "internal/rule-crash",
    filePath,
    source,
    line: 1,
  });
  // Synthetic crashes have no target node — group every crash record
  // per-ruleId into one bucket (the "un-groupable" shape) so agents
  // can still batch-triage "all crashes from rule X" if they want.
  const groupKey = computeGroupKey({ ruleId: "internal/rule-crash", shape: UNKNOWN_SHAPE });
  return {
    ruleId: "internal/rule-crash",
    // Synthetic crash reports route into the verify-in-source lane:
    // the agent reads the stack trace and the failing rule's source
    // to decide next steps. There is no deterministic edit, no prose
    // remediation, and no runtime harness that applies — this is a
    // ra11y bug, not a user a11y issue.
    fixClass: "verify-in-source",
    criteria: [],
    severity: errorSeverity,
    location: { filePath, line: 1, column: 1 },
    message: `Rule '${ruleId}' crashed: ${message}`,
    suggestion: `This is a ra11y bug in rule '${ruleId}', not a problem with your code. Please file an issue with the stack trace if you can reproduce it.`,
    findingId,
    groupKey,
  };
}
