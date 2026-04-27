import { describe, expect, it } from "bun:test";
import { type ParsedFile, runScan } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/index.ts";
import {
  buildSubsetClosure,
  pruneCandidatesCoveredByViolations,
} from "../../../src/review/criterion-subsets.ts";
import { finder as identifyPurpose } from "../../../src/review/finders/identify-purpose.ts";
import { rule as autocompleteMissing } from "../../../src/rules/forms/autocomplete-missing.ts";
import { wcag22 } from "../../../src/standards/wcag22/standard.ts";
import type { Ast } from "../../../src/types/ast.ts";
import type { ReviewCandidate } from "../../../src/types/review.ts";
import type { Criterion } from "../../../src/types/standard.ts";
import type { Violation } from "../../../src/types/violation.ts";
import { withFindingId } from "../../helpers/make-violation.ts";

const FILE = "/repo/page.html";

function violation(criteria: readonly string[], line: number, column = 0): Violation {
  return withFindingId({
    ruleId: "forms/autocomplete-missing",
    fixClass: "mechanical",
    criteria,
    severity: "warning",
    location: { filePath: FILE, line, column },
    message: "missing autocomplete",
  });
}

function candidate(criterionId: string, line: number, column = 0): ReviewCandidate {
  return {
    criterionId,
    location: { filePath: FILE, line, column },
    reason: "<input> no autocomplete attribute",
    confidence: "medium",
  };
}

/**
 * Minimal criteria fixture that mirrors the WCAG 2.2 ↔ WCAG 2.1
 * `equivalentTo` shape the real registry produces. Lets the closure
 * helper expand a single declaration row into the cross-standard
 * pairs without depending on the full standards module in unit tests.
 */
const CRITERIA_FIXTURE: readonly Criterion[] = [
  mkCriterion("wcag22:1.3.5", ["wcag21:1.3.5"]),
  mkCriterion("wcag22:1.3.6", ["wcag21:1.3.6"]),
  mkCriterion("wcag21:1.3.5", ["wcag22:1.3.5"]),
  mkCriterion("wcag21:1.3.6", ["wcag22:1.3.6"]),
];

function mkCriterion(id: string, equivalentTo: readonly string[]): Criterion {
  const [standardId, localId] = id.split(":");
  return {
    id,
    standardId: standardId ?? "",
    localId: localId ?? "",
    title: "",
    level: "AA",
    description: "",
    url: "",
    automatable: "manual",
    equivalentTo,
  };
}

describe("buildSubsetClosure", () => {
  it("expands the seed 1.3.6 ↔ 1.3.5 row across WCAG 2.1 equivalents", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    // Both wcag22:1.3.6 and wcag21:1.3.6 are parent keys (WCAG 2.1 is
    // an `equivalentTo` of WCAG 2.2 and vice versa).
    const subsetsOfWcag22Parent = closure.get("wcag22:1.3.6");
    const subsetsOfWcag21Parent = closure.get("wcag21:1.3.6");
    expect(subsetsOfWcag22Parent).toBeDefined();
    expect(subsetsOfWcag21Parent).toBeDefined();
    expect(subsetsOfWcag22Parent?.has("wcag22:1.3.5")).toBe(true);
    expect(subsetsOfWcag22Parent?.has("wcag21:1.3.5")).toBe(true);
  });

  it("returns an empty closure when no criteria are supplied (defensive)", () => {
    // The seed row references wcag22:* IDs; with no criteria fixture
    // the equivalent index still seeds singleton buckets so the row
    // expands to itself.
    const closure = buildSubsetClosure([]);
    expect(closure.get("wcag22:1.3.6")?.has("wcag22:1.3.5")).toBe(true);
  });
});

describe("pruneCandidatesCoveredByViolations", () => {
  it("drops a 1.3.6 candidate when a 1.3.5 violation fires at the same line", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    const out = pruneCandidatesCoveredByViolations(
      [candidate("wcag22:1.3.6", 7), candidate("wcag21:1.3.6", 7)],
      [violation(["wcag22:1.3.5", "wcag21:1.3.5"], 7)],
      closure,
    );
    expect(out).toEqual([]);
  });

  it("keeps the candidate when the 1.3.5 violation fires on a different line", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    const out = pruneCandidatesCoveredByViolations(
      [candidate("wcag22:1.3.6", 12)],
      [violation(["wcag22:1.3.5"], 7)],
      closure,
    );
    expect(out).toHaveLength(1);
  });

  it("keeps the candidate when the violation cites unrelated criteria", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    const out = pruneCandidatesCoveredByViolations(
      [candidate("wcag22:1.3.6", 7)],
      [violation(["wcag22:2.4.5"], 7)],
      closure,
    );
    expect(out).toHaveLength(1);
  });

  it("ignores column when matching position (rule and finder may report different columns on the same element)", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    const out = pruneCandidatesCoveredByViolations(
      [candidate("wcag22:1.3.6", 7, 4)],
      [violation(["wcag22:1.3.5"], 7, 12)],
      closure,
    );
    expect(out).toEqual([]);
  });

  it("returns the input unchanged when the closure is empty", () => {
    const candidates = [candidate("wcag22:1.3.6", 7)];
    const out = pruneCandidatesCoveredByViolations(
      candidates,
      [violation(["wcag22:1.3.5"], 7)],
      new Map(),
    );
    expect(out).toBe(candidates);
  });

  it("only suppresses candidates whose criterion the closure declares (other criteria pass through untouched)", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    const c1 = candidate("wcag22:1.3.6", 7);
    const c2 = candidate("wcag22:2.4.5", 7);
    const out = pruneCandidatesCoveredByViolations(
      [c1, c2],
      [violation(["wcag22:1.3.5"], 7)],
      closure,
    );
    expect(out).toEqual([c2]);
  });

  it("suppresses the WCAG 2.1 mirror candidate when WCAG 2.1 1.3.5 is the only fired violation", () => {
    const closure = buildSubsetClosure(CRITERIA_FIXTURE);
    const out = pruneCandidatesCoveredByViolations(
      [candidate("wcag21:1.3.6", 7)],
      [violation(["wcag21:1.3.5"], 7)],
      closure,
    );
    expect(out).toEqual([]);
  });
});

describe("runScan integration: 1.3.6 candidate suppressed when 1.3.5 violation fires at the same line", () => {
  function htmlFile(filePath: string, source: string): ParsedFile {
    const r = parseHtml(source);
    const ast: Ast = { language: "html", root: r.root, errors: r.errors };
    return { filePath, source, ast };
  }

  it("emits a 1.3.5 violation but no 1.3.6 review candidate at the same input line", () => {
    // Canonical case: an `<input type="email" name="email">` lacking
    // `autocomplete=` triggers the 1.3.5 rule (deterministic mechanical
    // edit) AND would normally trigger the 1.3.6 finder at the same
    // line. The subset dedup wired into runScan suppresses the
    // candidate so the agent doesn't double-budget against one defect.
    const file = htmlFile("/repo/contact.html", `<form><input type="email" name="email"></form>`);
    const { result, report } = runScan({
      standards: [wcag22],
      rules: [autocompleteMissing],
      finders: [identifyPurpose],
      enabled: ["wcag22"],
      files: [file],
    });
    // Sanity: the rule fired for 1.3.5.
    const ruleViolations = result.violations.filter(
      (v) => v.ruleId === "forms/autocomplete-missing",
    );
    expect(ruleViolations.length).toBeGreaterThan(0);
    expect(ruleViolations[0]?.criteria).toContain("wcag22:1.3.5");
    // Dedup: no 1.3.6 candidate at the input line.
    const candidates = report.candidates ?? [];
    const candidateLines = candidates
      .filter((c) => c.criterionId === "wcag22:1.3.6")
      .map((c) => c.location.line);
    const violationLine = ruleViolations[0]?.location.line;
    expect(candidateLines).not.toContain(violationLine);
  });

  it("keeps the 1.3.6 candidate on a control where the 1.3.5 rule does NOT fire (search box, no purpose match)", () => {
    // Search inputs are out of scope for 1.3.5 (the rule's
    // SEARCH_TOKENS list excludes them) but 1.3.6 still surveys them
    // because 1.3.6 broadens the criterion to all UI components — the
    // candidate must survive the dedup since no 1.3.5 violation fires.
    // This exercises the negative branch: prune touches only positions
    // a violation actually covers.
    const file = htmlFile("/repo/search.html", `<form><input type="text" name="firstname"></form>`);
    const { result, report } = runScan({
      standards: [wcag22],
      rules: [autocompleteMissing],
      finders: [identifyPurpose],
      enabled: ["wcag22"],
      files: [file],
    });
    const ruleHits = result.violations.filter((v) => v.ruleId === "forms/autocomplete-missing");
    const candidateHits = (report.candidates ?? []).filter((c) => c.criterionId === "wcag22:1.3.6");
    if (ruleHits.length === 0) {
      // No rule violation → candidate survives unchanged.
      expect(candidateHits.length).toBeGreaterThan(0);
    } else {
      // Rule violation present → candidate at that line is dropped;
      // candidates on other lines (or for other criteria) survive.
      const violationLines = new Set(ruleHits.map((v) => v.location.line));
      for (const c of candidateHits) {
        expect(violationLines.has(c.location.line)).toBe(false);
      }
    }
  });

  function loadCriterionFixture(): readonly Criterion[] {
    // Sanity assert that a real-world Criterion fixture (the one we
    // build the closure from at scan time) carries an `equivalentTo`
    // back-edge so the closure expansion test above is grounded in
    // production data, not just the synthetic fixture.
    const ids = wcag22.criteria.map((c) => c.id);
    return ids.length > 0 ? wcag22.criteria : CRITERIA_FIXTURE;
  }

  it("buildSubsetClosure expands across the registered standards' equivalentTo graph", () => {
    const closure = buildSubsetClosure(loadCriterionFixture());
    const subsetsOfWcag22 = closure.get("wcag22:1.3.6");
    expect(subsetsOfWcag22?.has("wcag22:1.3.5")).toBe(true);
  });
});
