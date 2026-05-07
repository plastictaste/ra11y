/**
 * Integration test: every checklist candidate's `(criterionId, file, line)`
 * tuple resolves to a non-`none` kind on `suggest_fix` — whether the
 * agent calls suggest_fix with the criterion ID directly OR with a
 * rule that satisfies the criterion.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Per-call
 * shape must agree with per-class plan tally" extended one hop to
 * checklist→suggest_fix lane parity. When checklist surfaces a
 * candidate at `(criterionId, file, line)` and the agent follows the
 * cross-surface pointer to suggest_fix, the per-call surface MUST
 * produce a non-`none` shape — otherwise the cross-surface tools
 * disagree on "is there work here?" for the same input, which is the
 * canonical silent-miss the cross-surface count invariant guards
 * against. The pre-fix shape was `kind: "none"` with `explanation:
 * "No violation for ... at line N."` — a dead-end the agent could
 * not act on without re-reading the source from scratch.
 *
 * Test strategy: build a small corpus carrying handler shapes that the
 * `review/on-input-change` finder fires on but the
 * `forms/select-onchange-context-change` rule does NOT fire on (the
 * canonical regression — finder is predicate-broad, rule is
 * predicate-narrow), run the scan, then walk the same checklist
 * surface the cross-surface agent reads. For every checklist
 * candidate's `(criterionId, file, line)` tuple, drive
 * `buildSuggestFixPayload` (a) once with the candidate's own
 * `criterionId` (the criterion-bridge path) and (b) once with each
 * rule that satisfies the criterion, and assert every call returns a
 * `kind` other than `"none"`.
 */

import { describe, expect, it } from "bun:test";

import { runScan } from "../../src/engine/scanner.ts";
import { parseHtml } from "../../src/input/parsers/html.ts";
import { indexFindersByCriterion } from "../../src/mcp/review-candidate-prompts.ts";
import type { McpSession } from "../../src/mcp/session.ts";
import { findCandidateMatch } from "../../src/mcp/suggest-fix-candidate-match.ts";
import { applyCriterionBridge } from "../../src/mcp/suggest-fix-criterion-bridge.ts";
import { buildSuggestFixPayload } from "../../src/mcp/tool-suggest-fix-internals.ts";
import { BUILTIN_CANDIDATE_FINDERS } from "../../src/review/index.ts";
import { BUILTIN_RULES } from "../../src/rules/index.ts";
import { BUILTIN_STANDARDS } from "../../src/standards/index.ts";

interface FileSpec {
  readonly filePath: string;
  readonly source: string;
}

function parseHtmlSpec(spec: FileSpec) {
  const parsed = parseHtml(spec.source);
  return {
    filePath: spec.filePath,
    source: spec.source,
    ast: { language: "html" as const, root: parsed.root, errors: parsed.errors },
  };
}

function findersByCriterionFromBuiltins() {
  // Mirror what the suggest_fix handler does: walk the loaded
  // finder registry once and key it by criterion id so the resolver
  // can pair the candidate's `criterionId` with the finder's
  // `reviewPrompt`. Using the real built-in finders here keeps the
  // test honest — a regression in `indexFindersByCriterion` would
  // surface here too.
  return indexFindersByCriterion(BUILTIN_CANDIDATE_FINDERS);
}

describe("checklist→suggest_fix candidate parity (Q14)", () => {
  it("a candidate at a line where the rule does NOT fire still resolves to non-`none`", () => {
    // Canonical regression: `<select onchange="redirect('/path')">` —
    // the `review/on-input-change` finder fires (its NAVIGATION_PATTERNS
    // list includes `redirect()`), but the `forms/select-onchange-
    // context-change` rule does NOT fire (its CONTEXT_CHANGE_TOKENS list
    // does not include `redirect`). The cross-surface agent reading
    // checklist gets a wcag22:3.2.2 candidate at this line; calling
    // `suggest_fix(forms/select-onchange-context-change, file, line)`
    // used to return `kind: "none"`.
    const spec: FileSpec = {
      filePath: "_includes/lang-switcher.html",
      source: `<form>\n<select onchange="redirect('/lang')">\n  <option value="en">English</option>\n</select>\n</form>\n`,
    };
    const built = [parseHtmlSpec(spec)];

    const { result, report } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      finders: BUILTIN_CANDIDATE_FINDERS,
      enabled: ["wcag22"],
      files: built,
    });

    const candidates = report.candidates ?? [];
    // Sanity: the corpus must produce at least one candidate the
    // checklist would surface (the finder fires on this onchange shape).
    expect(candidates.length).toBeGreaterThan(0);

    // The rule must NOT fire at the same line — the regression depends
    // on this asymmetry. If a future tightening of the rule's token
    // list closes this gap, swap the corpus to another finder/rule pair
    // exhibiting the same shape; the parity invariant remains.
    const ruleEmittedAtCandidate = result.violations.some(
      (v) =>
        v.ruleId === "forms/select-onchange-context-change" &&
        v.location.filePath === spec.filePath &&
        candidates.some((c) => c.location.line === v.location.line),
    );
    expect(ruleEmittedAtCandidate).toBe(false);

    const findersByCriterion = findersByCriterionFromBuiltins();

    // Track that we exercise at least one (candidate, rule) pairing —
    // a corpus that produced only manual-only candidates (criteria
    // with no satisfying rule, e.g. wcag22:1.3.6) would silently make
    // the assertions vacuous.
    let pairingsExercised = 0;
    for (const candidate of candidates) {
      // (a) criterion-bridge path: the agent calls suggest_fix with
      //     the candidate's own criterionId. The bridge resolves it to
      //     the most-specific rule and the candidate-match resolver
      //     routes to `kind: "guidance"`.
      // (b) rule-id path: the agent picks any rule satisfying the
      //     criterion (rules are advertised on `list_rules`) and calls
      //     suggest_fix with that rule. Same parity must hold.
      const rules = BUILTIN_RULES.filter((r) => r.satisfies.includes(candidate.criterionId));
      // Manual-only criteria (no satisfying rule) are exempt from this
      // rule-id parity loop — the agent could not call suggest_fix
      // with a rule that satisfies them in the first place. The
      // criterion-bridge path is exercised separately in
      // `mcp-tools.test.ts` ("manual-only criterion ID returns kind:
      // 'guidance'"); on that lane `applyCriterionBridge` routes to
      // `manualOnlyCriterion` and the handler emits a `kind:
      // "guidance"` payload framed as manual-review only. Skip
      // silently here.
      if (rules.length === 0) continue;
      for (const rule of rules) {
        pairingsExercised += 1;
        const candidateMatch = findCandidateMatch({
          rule,
          filePath: candidate.location.filePath,
          line: candidate.location.line,
          candidates,
          findersByCriterion,
        });
        // The resolver must locate the candidate when the rule
        // satisfies the candidate's criterion — that's the precondition
        // the lane parity rests on.
        expect(candidateMatch).not.toBeNull();

        const payload = buildSuggestFixPayload({
          ruleId: rule.id,
          line: candidate.location.line,
          match: undefined,
          sourceContext: spec.source,
          source: spec.source,
          filePath: candidate.location.filePath,
          sameFileFindings: result.violations,
          ...(candidateMatch === null ? {} : { candidateMatch }),
        });
        // The whole point of the fix: never `kind: "none"` on a tuple
        // checklist surfaced as actionable manual review.
        expect(payload["kind"]).not.toBe("none");
        expect(payload["kind"]).toBe("guidance");
        // The guidance payload must carry the candidate's reason as
        // explanation so the agent can act on the same prose checklist
        // shipped — without this, the per-call surface would still
        // surface a non-`none` kind but with no actionable framing.
        const primary = payload["primary"] as { explanation?: string };
        expect(primary?.explanation).toContain(candidate.reason);
      }
    }
    // Defensive: the corpus must include at least one candidate whose
    // criterion has a satisfying rule — otherwise the inner assertions
    // are silently skipped and the test would pass on a regression.
    expect(pairingsExercised).toBeGreaterThan(0);
  });

  it("findCandidateMatch returns null when no candidate matches the queried line", () => {
    // Negative shape — the resolver must NOT manufacture matches; an
    // unrelated query line still routes through the `kind: "none"`
    // breadcrumb path. This guards against the symmetric "Heuristic
    // emission" failure mode (over-surfacing) the AI-first doctrine
    // warns against.
    const spec: FileSpec = {
      filePath: "_includes/lang-switcher.html",
      source: `<form>\n<select onchange="redirect('/lang')">\n</select>\n</form>\n`,
    };
    const built = [parseHtmlSpec(spec)];
    const { report } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      finders: BUILTIN_CANDIDATE_FINDERS,
      enabled: ["wcag22"],
      files: built,
    });
    const candidates = report.candidates ?? [];
    const findersByCriterion = findersByCriterionFromBuiltins();
    const anyRule = BUILTIN_RULES[0];
    if (anyRule === undefined) throw new Error("expected built-in rules");
    const candidateMatch = findCandidateMatch({
      rule: anyRule,
      filePath: spec.filePath,
      // line 999 — far beyond the source file's content.
      line: 999,
      candidates,
      findersByCriterion,
    });
    expect(candidateMatch).toBeNull();
  });

  it("findCandidateMatch returns null when a candidate exists but the rule does not satisfy its criterion", () => {
    // Negative shape — the rule's `satisfies` list gates the resolver.
    // An agent that calls suggest_fix with an unrelated rule (e.g. a
    // contrast rule) must not get a candidate-match guidance payload
    // for an onchange candidate; the criterion-rule binding is
    // load-bearing per the doctrine "Per-tool review-candidate shape
    // must agree across surfaces."
    const spec: FileSpec = {
      filePath: "_includes/lang-switcher.html",
      source: `<form>\n<select onchange="redirect('/lang')">\n</select>\n</form>\n`,
    };
    const built = [parseHtmlSpec(spec)];
    const { report } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      finders: BUILTIN_CANDIDATE_FINDERS,
      enabled: ["wcag22"],
      files: built,
    });
    const candidates = report.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    const findersByCriterion = findersByCriterionFromBuiltins();
    // Pick a candidate whose criterion has at least one rule, then
    // pick an unrelated rule that does NOT satisfy that criterion.
    const target = candidates.find((c) =>
      BUILTIN_RULES.some((r) => r.satisfies.includes(c.criterionId)),
    );
    if (target === undefined) throw new Error("expected at least one candidate with a rule");
    const unrelated = BUILTIN_RULES.find((r) => !r.satisfies.includes(target.criterionId));
    if (unrelated === undefined) throw new Error("expected an unrelated rule");
    const candidateMatch = findCandidateMatch({
      rule: unrelated,
      filePath: target.location.filePath,
      line: target.location.line,
      candidates,
      findersByCriterion,
    });
    // Resolver must reject the rule/candidate pairing — even when the
    // file:line coordinate hits, the criterion mismatch is the load-
    // bearing predicate that keeps the per-call shape honest.
    expect(candidateMatch).toBeNull();
  });

  it("criterion-bridge resolution surfaces a non-`none` kind on a candidate-only line", () => {
    // The other half of the lane parity: when the agent passes the
    // candidate's `criterionId` directly (no rule id at hand), the
    // criterion-bridge resolves it to the most-specific rule and the
    // candidate-match resolver picks up from there. Mocking a session
    // would be heavyweight; instead, exercise the resolver pieces
    // directly to confirm the bridge produces a rule whose `satisfies`
    // covers the candidate's criterion.
    const spec: FileSpec = {
      filePath: "_includes/lang-switcher.html",
      source: `<form>\n<select onchange="redirect('/lang')">\n</select>\n</form>\n`,
    };
    const built = [parseHtmlSpec(spec)];
    const { report } = runScan({
      standards: BUILTIN_STANDARDS,
      rules: BUILTIN_RULES,
      finders: BUILTIN_CANDIDATE_FINDERS,
      enabled: ["wcag22"],
      files: built,
    });
    const candidates = report.candidates ?? [];
    // Pick a candidate whose criterion has at least one satisfying
    // rule — manual-only criteria (e.g. wcag22:1.3.6) route to the
    // `manualOnlyCriterion` branch of `applyCriterionBridge` (covered
    // in `mcp-tools.test.ts` "manual-only criterion ID returns kind:
    // 'guidance'"), not the rule-resolution lane under test here.
    const target = candidates.find((c) =>
      BUILTIN_RULES.some((r) => r.satisfies.includes(c.criterionId)),
    );
    if (target === undefined) throw new Error("expected at least one candidate with a rule");
    // Stand-in McpSession for `applyCriterionBridge` — only
    // `registry.rulesForCriterion` is consulted by the bridge.
    const session = {
      registry: {
        rulesForCriterion: (criterionId: string) =>
          BUILTIN_RULES.filter((r) => r.satisfies.includes(criterionId)),
      },
    } as unknown as McpSession;
    const bridge = applyCriterionBridge(target.criterionId, session);
    expect("error" in bridge).toBe(false);
    if ("error" in bridge) return;
    // The bridged rule's `satisfies` must include the candidate's
    // criterion — that's the precondition the candidate-match resolver
    // depends on. Without this, the bridge would resolve to a rule the
    // resolver would then reject and the lane parity would still fail.
    const bridgedRule = BUILTIN_RULES.find((r) => r.id === bridge.ruleId);
    if (bridgedRule === undefined) throw new Error("expected bridged rule to exist");
    expect(bridgedRule.satisfies).toContain(target.criterionId);
  });
});
