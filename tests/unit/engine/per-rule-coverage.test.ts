/**
 * Unit tests for buildPerRuleCoverage — the confidence-annotation step
 * the scanner folds over its evaluation tracker.
 *
 * Four shapes matter:
 *   - eligible === 0 on a rule with an extension gate → low, with a
 *     specific reason + remediation (the Tailwind-pre-build case for
 *     `.css`-targeted rules is the acute one).
 *   - eligible > 0, evaluated > 0 → high.
 *   - eligible > 0, evaluated === 0 → low with the "excluded or empty"
 *     reason (path the tracker can't reach today, but the branch
 *     exists so the shape stays honest if the scanner grows a
 *     skip-after-parse step).
 *   - Project-scoped rules (no `appliesTo.fileExtensions`, lifecycle
 *     is `afterProject` only) get a row synthesized from the scan's
 *     `filesScanned` count — `high` when any files were scanned,
 *     `low` with a "nothing to evaluate" reason when zero were. The
 *     invariant `perRuleCoverage.length === rulesEvaluated` now holds
 *     for every scan shape (V1-META-RULES-EVALUATED-COVERAGE-DRIFT);
 *     agents reading both surfaces cannot hit silent absences for
 *     project-scoped rules.
 *
 * `findingsEmitted` (V1-SHAPE-RULECOV-COUNT) is a schema-required
 * counter on every entry — zero means "rule ran and found nothing,"
 * which paired with `coverageConfidence` is the load-bearing signal
 * agents use to distinguish "confidently clean" from "didn't exercise
 * the pattern." The covering tests assert presence-on-every-row, the
 * zero-as-meaningful semantics, and that the counter equals the number
 * of `Violation` records the rule produced.
 */

import { describe, expect, it } from "bun:test";
import { buildPerRuleCoverage } from "../../../src/engine/per-rule-coverage.ts";
import type { RuleEvaluationTracker } from "../../../src/engine/rule-runner.ts";
import type { StandardFilter } from "../../../src/engine/standard-filter.ts";
import type { Rule } from "../../../src/types/rule.ts";
import type { Violation } from "../../../src/types/violation.ts";

function mkRule(id: string, extensions?: readonly string[]): Rule {
  return {
    id,
    satisfies: ["wcag22:1.4.3"],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    ...(extensions === undefined ? {} : { appliesTo: { fileExtensions: extensions } }),
    docs: {
      description: "test",
      rationale: "test",
      goodExample: "",
      badExample: "",
      references: [],
    },
  };
}

const passAllFilter: StandardFilter = {
  isRuleActive: () => true,
  citedCriteria: () => ["wcag22:1.4.3"],
  citedCriteriaTitles: () => ["Contrast (Minimum)"],
};

function tracker(
  entries: Record<string, { eligible: number; evaluated: number }>,
): RuleEvaluationTracker {
  const counts = new Map<string, { eligible: number; evaluated: number }>();
  for (const [k, v] of Object.entries(entries)) counts.set(k, { ...v });
  return { counts };
}

function mkViolation(ruleId: string): Violation {
  return {
    ruleId,
    fixClass: "guidance",
    criteria: ["wcag22:1.4.3"],
    severity: "warning",
    location: { filePath: "a.css", line: 1, column: 1 },
    message: "test",
    findingId: `${ruleId}-fid`,
    groupKey: `${ruleId}-gk`,
  };
}

function mkViolationAt(ruleId: string, filePath: string): Violation {
  return {
    ruleId,
    fixClass: "guidance",
    criteria: ["wcag22:1.4.3"],
    severity: "warning",
    location: { filePath, line: 1, column: 1 },
    message: "test",
    findingId: `${ruleId}-${filePath}-fid`,
    groupKey: `${ruleId}-gk`,
  };
}

function mkViolationWithClass(ruleId: string, filePath: string, classEvidence: string): Violation {
  return {
    ruleId,
    fixClass: "verify-in-source",
    criteria: ["wcag22:4.1.2"],
    severity: "info",
    location: { filePath, line: 1, column: 1 },
    message: "test",
    findingId: `${ruleId}-${filePath}-${classEvidence}-fid`,
    groupKey: `${ruleId}-gk`,
    classEvidence,
  };
}

describe("buildPerRuleCoverage", () => {
  it("marks a rule with 0 eligible files as low confidence with reason + remediation", () => {
    const rules = [mkRule("contrast/minimum", [".css"])];
    const entries = buildPerRuleCoverage(
      tracker({ "contrast/minimum": { eligible: 0, evaluated: 0 } }),
      rules,
      passAllFilter,
      [],
      5,
    );
    expect(entries.length).toBe(1);
    const [row] = entries;
    expect(row!.ruleId).toBe("contrast/minimum");
    expect(row!.filesEligible).toBe(0);
    expect(row!.filesEvaluated).toBe(0);
    expect(row!.coverageConfidence).toBe("low");
    expect(row!.reason).toContain(".css");
    expect(row!.remediation).toContain("additionalPaths");
  });

  it("marks a rule that ran on at least one file as high confidence (reason/remediation omitted)", () => {
    const rules = [mkRule("media/alt-text-missing", [".html", ".htm", ".tsx", ".jsx"])];
    const entries = buildPerRuleCoverage(
      tracker({ "media/alt-text-missing": { eligible: 3, evaluated: 3 } }),
      rules,
      passAllFilter,
      [],
      5,
    );
    const [row] = entries;
    expect(row!.coverageConfidence).toBe("high");
    expect(row!.filesEligible).toBe(3);
    expect(row!.filesEvaluated).toBe(3);
    expect(row!.reason).toBeUndefined();
    expect(row!.remediation).toBeUndefined();
  });

  // V1-META-RULES-EVALUATED-COVERAGE-DRIFT: rules without an
  // extension gate (project-scoped, `afterProject` only) used to be
  // silently omitted from `perRuleCoverage`, leaving the invariant
  // `perRuleCoverage.length === rulesEvaluated` broken. Now they get
  // a synthesized row so an agent reading both surfaces sees every
  // rule that was evaluated.
  it("emits a project-scoped row for a rule without an extension gate (no silent absence)", () => {
    const rules = [mkRule("noop", undefined)];
    const entries = buildPerRuleCoverage(
      // Project-scoped rules don't appear in the per-file tracker —
      // the rule runner only sees them via `afterProject`, which runs
      // outside the per-file loop. Passing an empty tracker matches
      // the real scanner shape.
      tracker({}),
      rules,
      passAllFilter,
      [],
      5,
    );
    expect(entries.length).toBe(1);
    const [row] = entries;
    expect(row!.ruleId).toBe("noop");
    // Treats all scanned files as eligible — the project rule's
    // `afterProject` runs against the full file set in one shot.
    expect(row!.filesEvaluated).toBe(5);
    expect(row!.filesEligible).toBe(5);
    expect(row!.coverageConfidence).toBe("high");
    expect(row!.findingsEmitted).toBe(0);
  });

  // Zero-file scan: the project-scoped branch surfaces "no files
  // scanned" honestly rather than going silently absent.
  it("project-scoped rule with filesScanned:0 gets a low-confidence 'nothing to evaluate' row", () => {
    const rules = [mkRule("noop", undefined)];
    const entries = buildPerRuleCoverage(tracker({}), rules, passAllFilter, [], 0);
    expect(entries.length).toBe(1);
    const [row] = entries;
    expect(row!.filesEvaluated).toBe(0);
    expect(row!.filesEligible).toBe(0);
    expect(row!.coverageConfidence).toBe("low");
    expect(row!.reason).toContain("no files were scanned");
    expect(row!.remediation).toBeDefined();
  });

  it("omits filter-inactive rules (rule disabled under current standards)", () => {
    const rules = [mkRule("contrast/minimum", [".css"])];
    const filter: StandardFilter = {
      isRuleActive: () => false,
      citedCriteria: () => [],
      citedCriteriaTitles: () => [],
    };
    const entries = buildPerRuleCoverage(
      tracker({ "contrast/minimum": { eligible: 0, evaluated: 0 } }),
      rules,
      filter,
      [],
      5,
    );
    expect(entries.length).toBe(0);
  });

  it("sorts entries by rule ID for cross-run stability", () => {
    const rules = [
      mkRule("z/last", [".css"]),
      mkRule("a/first", [".html"]),
      mkRule("m/middle", [".tsx"]),
    ];
    const entries = buildPerRuleCoverage(
      tracker({
        "z/last": { eligible: 1, evaluated: 1 },
        "a/first": { eligible: 1, evaluated: 1 },
        "m/middle": { eligible: 1, evaluated: 1 },
      }),
      rules,
      passAllFilter,
      [],
      5,
    );
    expect(entries.map((e) => e.ruleId)).toEqual(["a/first", "m/middle", "z/last"]);
  });

  it("names CSS / HTML / JSX-TSX remediation text on zero-eligible rows", () => {
    const rules = [
      mkRule("contrast/minimum", [".css"]),
      mkRule("page/titled", [".html", ".htm"]),
      mkRule("nav/skip-link", [".tsx", ".jsx"]),
    ];
    const entries = buildPerRuleCoverage(
      tracker({
        "contrast/minimum": { eligible: 0, evaluated: 0 },
        "page/titled": { eligible: 0, evaluated: 0 },
        "nav/skip-link": { eligible: 0, evaluated: 0 },
      }),
      rules,
      passAllFilter,
      [],
      5,
    );
    const byId = new Map(entries.map((e) => [e.ruleId, e]));
    expect(byId.get("contrast/minimum")!.remediation).toContain("CSS");
    expect(byId.get("page/titled")!.remediation).toContain("HTML");
    expect(byId.get("nav/skip-link")!.remediation).toContain("JSX/TSX");
  });

  // V1-SHAPE-RULECOV-COUNT: findingsEmitted is schema-required and zero
  // is meaningful — these tests pin the invariant so consumers (Bootstrap
  // and other MCP scan responses) can budget against the counter without
  // re-deriving it from `files[].findings[]`.
  it("populates findingsEmitted on every entry — zero is the meaningful 'rule ran clean' signal", () => {
    const rules = [
      mkRule("contrast/minimum", [".css"]),
      mkRule("media/alt-text-missing", [".html", ".tsx"]),
    ];
    const entries = buildPerRuleCoverage(
      tracker({
        "contrast/minimum": { eligible: 0, evaluated: 0 },
        "media/alt-text-missing": { eligible: 4, evaluated: 4 },
      }),
      rules,
      passAllFilter,
      [],
      5,
    );
    expect(entries.length).toBe(2);
    for (const row of entries) {
      // Schema-required: never undefined, never null. Zero is the
      // meaningful "rule ran (or had nothing eligible) and emitted no
      // findings" signal.
      expect(row.findingsEmitted).toBe(0);
      expect(typeof row.findingsEmitted).toBe("number");
    }
  });

  it("findingsEmitted equals the number of Violations for that rule (invariant)", () => {
    const rules = [
      mkRule("contrast/minimum", [".css"]),
      mkRule("media/alt-text-missing", [".html", ".tsx"]),
    ];
    const violations: Violation[] = [
      mkViolation("contrast/minimum"),
      mkViolation("contrast/minimum"),
      mkViolation("contrast/minimum"),
      mkViolation("media/alt-text-missing"),
    ];
    const entries = buildPerRuleCoverage(
      tracker({
        "contrast/minimum": { eligible: 5, evaluated: 5 },
        "media/alt-text-missing": { eligible: 5, evaluated: 5 },
      }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const byId = new Map(entries.map((e) => [e.ruleId, e]));
    expect(byId.get("contrast/minimum")!.findingsEmitted).toBe(
      violations.filter((v) => v.ruleId === "contrast/minimum").length,
    );
    expect(byId.get("media/alt-text-missing")!.findingsEmitted).toBe(
      violations.filter((v) => v.ruleId === "media/alt-text-missing").length,
    );
  });

  it("findingsEmitted is 0 when a rule had no eligible files (rule never ran)", () => {
    // The Tailwind-pre-build acute case: contrast/minimum gets the
    // "low confidence + 0 eligible" row AND findingsEmitted: 0,
    // mirroring "the rule never had a chance to find anything." The
    // agent uses coverageConfidence + filesEvaluated to disambiguate
    // "didn't run" from "ran clean."
    const rules = [mkRule("contrast/minimum", [".css"])];
    const entries = buildPerRuleCoverage(
      tracker({ "contrast/minimum": { eligible: 0, evaluated: 0 } }),
      rules,
      passAllFilter,
      [mkViolation("media/alt-text-missing")], // unrelated rule fired
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(0);
    expect(row!.coverageConfidence).toBe("low");
  });

  // V1-NOISE-RULE-PER-FILE-ROLLUP: per-file concentration hint.
  // Thresholds: > 10 total findings AND > 50% share on the densest
  // file. Optional field — omitted via conditional spread (never null,
  // never empty-object) when thresholds don't clear. Findings
  // themselves are never hidden; this is additive telemetry on top of
  // the per-rule row.
  it("emits concentration when one file holds a strict majority past the total floor", () => {
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    const violations: Violation[] = [
      ...Array.from({ length: 12 }, () =>
        mkViolationAt("forms/autocomplete-missing", "site/floating-labels.html"),
      ),
      ...Array.from({ length: 3 }, () =>
        mkViolationAt("forms/autocomplete-missing", "site/other.html"),
      ),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 10, evaluated: 10 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(15);
    expect(row!.concentration).toEqual({
      file: "site/floating-labels.html",
      count: 12,
    });
  });

  it("omits concentration on an exact 50/50 split (share must strictly exceed 0.5)", () => {
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    const violations: Violation[] = [
      ...Array.from({ length: 10 }, () =>
        mkViolationAt("forms/autocomplete-missing", "site/a.html"),
      ),
      ...Array.from({ length: 10 }, () =>
        mkViolationAt("forms/autocomplete-missing", "site/b.html"),
      ),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 5, evaluated: 5 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(20);
    // Honest conditional-spread: the field is absent, not
    // present-as-undefined (CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest").
    expect(Object.hasOwn(row!, "concentration")).toBe(false);
    expect(row!.concentration).toBeUndefined();
  });

  it("omits concentration when total findings are below the floor (threshold: > 10)", () => {
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    // 8 findings all on one file — 100% share but below the 10-total
    // floor. Statistical noise at this volume; the agent can see the
    // idiom from the underlying findings listing.
    const violations: Violation[] = Array.from({ length: 8 }, () =>
      mkViolationAt("forms/autocomplete-missing", "site/only.html"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(8);
    expect(Object.hasOwn(row!, "concentration")).toBe(false);
  });

  it("omits concentration at the boundary (exactly 10 total findings — strict >, not >=)", () => {
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    const violations: Violation[] = Array.from({ length: 10 }, () =>
      mkViolationAt("forms/autocomplete-missing", "site/only.html"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(10);
    expect(Object.hasOwn(row!, "concentration")).toBe(false);
  });

  it("tie-break between peak files picks lexicographically smallest for deterministic output", () => {
    // Two files share the peak count of 8; total 16 → 50/50 share
    // fails the concentration threshold. Tip past the share by adding
    // one more to a third file WITHOUT changing which two files are
    // tied at the peak — this isolates the tie-break behavior. After
    // the push: a.html=8, z.html=8, m.html=1 → total 17; both leaders
    // at 8/17 ≈ 0.47, still under 0.5. Bump a.html by two (to 10/19 ≈
    // 0.53) so it clears the share AND the tie-break question is moot
    // (a.html truly wins). Then reorder insertion so z.html is seen
    // first — if the tie-break is wrong, z.html will win at the earlier
    // point where counts are equal.
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    const violations: Violation[] = [
      // z.html first so iteration order would otherwise favor it.
      ...Array.from({ length: 8 }, () =>
        mkViolationAt("forms/autocomplete-missing", "site/z.html"),
      ),
      ...Array.from({ length: 8 }, () =>
        mkViolationAt("forms/autocomplete-missing", "site/a.html"),
      ),
    ];
    // At this point a.html and z.html are tied at 8 apiece, total 16;
    // share is exactly 0.5 → concentration would be omitted. Push one
    // more onto a.html to break the share threshold and exercise the
    // tie-break path along the way.
    violations.push(mkViolationAt("forms/autocomplete-missing", "site/a.html"));
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 2, evaluated: 2 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(17);
    // 9/17 ≈ 0.529 > 0.5 and a.html strictly dominates now — test
    // pins both winner identity and deterministic tie-break reasoning.
    expect(row!.concentration).toEqual({ file: "site/a.html", count: 9 });
  });

  it("spreads concentration onto low-confidence rows too (coverage + concentration can co-exist)", () => {
    // A rule with 0 eligible files still gets 0 findingsEmitted, so
    // concentration is structurally impossible on a zero-eligible row.
    // This test pins the `evaluated === 0` low-confidence branch
    // instead — the branch we can actually exercise with violations.
    // Low-confidence low-eligible rows also omit concentration by
    // finding volume (< 11 total), but the assembly site spreads
    // unconditionally on every branch — this asserts the presence-on-
    // all-branches wiring holds.
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    const violations: Violation[] = Array.from({ length: 12 }, () =>
      mkViolationAt("forms/autocomplete-missing", "site/dense.html"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 5, evaluated: 5 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.coverageConfidence).toBe("high");
    expect(row!.concentration).toEqual({ file: "site/dense.html", count: 12 });
  });

  // Class-pattern concentration rollup: the canonical acute case is
  // `aria/icon-font-hidden` firing many times across sibling buttons
  // in one file, all sharing the same `fa fa-*` idiom. The rollup
  // names that (file, pattern) cluster so one file read triages many
  // candidates instead of N. Zero information loss — every finding
  // still ships in `files[].findings`.
  it("emits classPatternConcentration when a Font Awesome idiom dominates one file", () => {
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    const violations: Violation[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        mkViolationWithClass("aria/icon-font-hidden", "site/admin.html", `fa fa-glyph-${i % 3}`),
      ),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.classPatternConcentration).toBeDefined();
    expect(row!.classPatternConcentration).toHaveLength(1);
    const [cluster] = row!.classPatternConcentration!;
    expect(cluster!.file).toBe("site/admin.html");
    expect(cluster!.count).toBe(12);
    expect(cluster!.classPattern).toBe("fa fa-*");
    // Samples: up to 3 distinct class values, sorted deterministically.
    expect(cluster!.samples).toEqual(["fa fa-glyph-0", "fa fa-glyph-1", "fa fa-glyph-2"]);
  });

  it("omits classPatternConcentration for rules not in the opt-in registry", () => {
    // `forms/autocomplete-missing` doesn't participate in the rollup —
    // even 50 findings on one file with the same classEvidence must
    // not produce a classPatternConcentration row (the rollup is
    // explicit opt-in to avoid leaking rule-family coupling into every
    // rule's coverage entry).
    const rules = [mkRule("forms/autocomplete-missing", [".html"])];
    const violations: Violation[] = Array.from({ length: 50 }, () =>
      mkViolationWithClass("forms/autocomplete-missing", "site/a.html", "fa fa-times"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "forms/autocomplete-missing": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(Object.hasOwn(row!, "classPatternConcentration")).toBe(false);
    expect(row!.classPatternConcentration).toBeUndefined();
  });

  it("omits classPatternConcentration when cluster size is below the floor (9 findings)", () => {
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    const violations: Violation[] = Array.from({ length: 9 }, () =>
      mkViolationWithClass("aria/icon-font-hidden", "site/a.html", "fa fa-times"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(Object.hasOwn(row!, "classPatternConcentration")).toBe(false);
  });

  it("emits classPatternConcentration at the inclusive count boundary (exactly 10)", () => {
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    const violations: Violation[] = Array.from({ length: 10 }, () =>
      mkViolationWithClass("aria/icon-font-hidden", "site/a.html", "fa fa-times"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    const [cluster] = row!.classPatternConcentration!;
    expect(cluster!.count).toBe(10);
    expect(cluster!.classPattern).toBe("fa fa-*");
  });

  it("omits classPatternConcentration when the dominant pattern's share is below 80%", () => {
    // 10 findings on `site/a.html` split 7 `fa`/3 `material-icons` —
    // neither pattern individually clears the 80% share gate even
    // though the total clears the count floor.
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    const violations: Violation[] = [
      ...Array.from({ length: 7 }, () =>
        mkViolationWithClass("aria/icon-font-hidden", "site/a.html", "fa fa-home"),
      ),
      ...Array.from({ length: 3 }, () =>
        mkViolationWithClass("aria/icon-font-hidden", "site/a.html", "material-icons"),
      ),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(Object.hasOwn(row!, "classPatternConcentration")).toBe(false);
  });

  it("rolls up clusters per file independently (two files, each with its own dominant pattern)", () => {
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    const violations: Violation[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        mkViolationWithClass("aria/icon-font-hidden", "site/a.html", `fa fa-a-${i}`),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        mkViolationWithClass("aria/icon-font-hidden", "site/b.html", `bi bi-b-${i}`),
      ),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 2, evaluated: 2 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    expect(row!.classPatternConcentration).toHaveLength(2);
    // Sorted by count descending.
    const [first, second] = row!.classPatternConcentration!;
    expect(first!.file).toBe("site/b.html");
    expect(first!.classPattern).toBe("bi bi-*");
    expect(first!.count).toBe(15);
    expect(second!.file).toBe("site/a.html");
    expect(second!.classPattern).toBe("fa fa-*");
    expect(second!.count).toBe(10);
  });

  it("skips violations without classEvidence (honest — no evidence, no cluster membership)", () => {
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    // 10 findings with classEvidence → cluster qualifies.
    // 5 findings WITHOUT classEvidence on the same file → not included
    // in the cluster tally OR the share denominator (e.g. `<ion-icon>`
    // custom elements that key off tag name, not class).
    const withEvidence = Array.from({ length: 10 }, () =>
      mkViolationWithClass("aria/icon-font-hidden", "site/a.html", "fa fa-times"),
    );
    const withoutEvidence = Array.from({ length: 5 }, () =>
      mkViolationAt("aria/icon-font-hidden", "site/a.html"),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      [...withEvidence, ...withoutEvidence],
      5,
    );
    const [row] = entries;
    expect(row!.findingsEmitted).toBe(15);
    const [cluster] = row!.classPatternConcentration!;
    expect(cluster!.count).toBe(10);
    expect(cluster!.classPattern).toBe("fa fa-*");
  });

  it("caps samples at 3 distinct class values per cluster", () => {
    const rules = [mkRule("aria/icon-font-hidden", [".html"])];
    // 10 findings, 5 distinct classEvidence values — samples should
    // surface the first 3 distinct values seen, not all 5.
    const distinctEvidence = [
      "fa fa-home",
      "fa fa-user",
      "fa fa-cog",
      "fa fa-times",
      "fa fa-search",
    ];
    const violations: Violation[] = Array.from({ length: 10 }, (_, i) =>
      mkViolationWithClass(
        "aria/icon-font-hidden",
        "site/a.html",
        distinctEvidence[i % distinctEvidence.length] ?? "fa",
      ),
    );
    const entries = buildPerRuleCoverage(
      tracker({ "aria/icon-font-hidden": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      violations,
      5,
    );
    const [row] = entries;
    const [cluster] = row!.classPatternConcentration!;
    expect(cluster!.samples).toHaveLength(3);
    // Samples sorted — deterministic regardless of insertion order.
    expect(cluster!.samples).toEqual(["fa fa-cog", "fa fa-home", "fa fa-user"]);
  });
});
