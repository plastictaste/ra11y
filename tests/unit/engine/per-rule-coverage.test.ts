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
import {
  buildPerRuleCoverage,
  partitionPerRuleCoverage,
} from "../../../src/engine/per-rule-coverage.ts";
import type { RuleEvaluationTracker } from "../../../src/engine/rule-runner.ts";
import type { StandardFilter } from "../../../src/engine/standard-filter.ts";
import type { Rule } from "../../../src/types/rule.ts";
import type { PerRuleCoverage, Violation } from "../../../src/types/violation.ts";

function mkRule(
  id: string,
  extensions?: readonly string[],
  opts: { crossFileCapable?: boolean } = {},
): Rule {
  return {
    id,
    satisfies: ["wcag22:1.4.3"],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    ...(extensions === undefined ? {} : { appliesTo: { fileExtensions: extensions } }),
    ...(opts.crossFileCapable === undefined ? {} : { crossFileCapable: opts.crossFileCapable }),
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
  // The level-gate diagnostic only fires for inactive rules; an
  // always-active filter never reaches it, so `undefined` is the
  // honest stub return.
  levelGateForInactiveRule: () => undefined,
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

  it("omits filter-inactive rules when no enabled standard reaches the rule", () => {
    // The "rule's `satisfies` resolves to no enabled-standard criterion"
    // case — there is no honest level-gate row to surface here, and
    // emitting one would be a lie, so the row stays absent.
    const rules = [mkRule("contrast/minimum", [".css"])];
    const filter: StandardFilter = {
      isRuleActive: () => false,
      citedCriteria: () => [],
      citedCriteriaTitles: () => [],
      levelGateForInactiveRule: () => undefined,
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

  // Q7-AAA-RULE-LOADER-SILENT-NORUN. A rule that the active conformance
  // level filtered out (canonical: an AAA-only rule under default `AA`)
  // used to disappear from `perRuleCoverage` — the agent reading the
  // response could not distinguish "rule isn't loaded" from "rule loaded
  // but level-gated." Surface, don't suppress: emit a structured row
  // with `skipReason: "gated_by_level"` plus `requiredLevel` /
  // `requestedLevel` so the agent has the exact remediation.
  it("emits a skipReason: 'gated_by_level' row when the level filter excluded the rule", () => {
    const rules = [mkRule("link/announce-target-blank", [".html", ".tsx"])];
    const filter: StandardFilter = {
      isRuleActive: () => false,
      citedCriteria: () => [],
      citedCriteriaTitles: () => [],
      levelGateForInactiveRule: () => ({ requiredLevel: "AAA", requestedLevel: "AA" }),
    };
    const entries = buildPerRuleCoverage(tracker({}), rules, filter, [], 3);
    expect(entries.length).toBe(1);
    const row = entries[0];
    expect(row).toBeDefined();
    expect(row!.ruleId).toBe("link/announce-target-blank");
    expect(row!.findingsEmitted).toBe(0);
    expect(row!.filesEvaluated).toBe(0);
    expect(row!.filesEligible).toBe(0);
    expect(row!.coverageConfidence).toBe("low");
    expect(row!.skipReason).toBe("gated_by_level");
    expect(row!.requiredLevel).toBe("AAA");
    expect(row!.requestedLevel).toBe("AA");
    // Reason + remediation carry actionable prose so an agent reading
    // the row alone has the full context.
    expect(row!.reason).toContain("AAA");
    expect(row!.reason).toContain("AA");
    expect(row!.remediation).toContain("level: 'AAA'");
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

  // ADR 0026 + Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-FILE-BLINDSPOT:
  // rules that declare `crossFileCapable: false` must downgrade a
  // would-be-high entry to `"medium"` with a structured reason code,
  // because their target spec encompasses cross-file wiring their
  // current implementation can't see.
  it("downgrades crossFileCapable:false rule from 'high' to 'medium' on eligible inputs", () => {
    const rules = [
      mkRule("keyboard/handler-missing", [".html", ".htm"], { crossFileCapable: false }),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "keyboard/handler-missing": { eligible: 2, evaluated: 2 } }),
      rules,
      passAllFilter,
      [],
      2,
    );
    const [row] = entries;
    expect(row!.coverageConfidence).toBe("medium");
    // Per-family structured reason code — agent-triage-useful beyond
    // the flat `cross_file_evidence_bounded_on_this_input` fallback.
    expect(row!.reason).toBe("cross_file_listener_resolution_limited_on_this_input");
    // No `remediation` on medium — the agent's next action is to read
    // the cited file, not to reshape the scan inputs. Conditional
    // spread at the builder keeps the field out of the row entirely.
    expect(row!.remediation).toBeUndefined();
    // File counts still honest: the rule did run on 2 eligible files.
    expect(row!.filesEligible).toBe(2);
    expect(row!.filesEvaluated).toBe(2);
    expect(row!.findingsEmitted).toBe(0);
  });

  it("keeps 'low' (not 'medium') when a crossFileCapable:false rule had zero eligible files", () => {
    // Rule with zero eligible files stays `"low"` — the existing
    // zero-eligible reason/remediation is strictly more actionable
    // than the medium downgrade. `"low"` already signals "don't trust
    // the clean tally"; routing through `"medium"` here would drop
    // the remediation string that tells the agent how to fix the
    // scan inputs. Zero-eligible precedes the cross-file downgrade.
    const rules = [
      mkRule("keyboard/handler-missing", [".html", ".htm"], { crossFileCapable: false }),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "keyboard/handler-missing": { eligible: 0, evaluated: 0 } }),
      rules,
      passAllFilter,
      [],
      2,
    );
    const [row] = entries;
    expect(row!.coverageConfidence).toBe("low");
    expect(row!.reason).toContain("no files matching");
    expect(row!.remediation).toBeDefined();
  });

  it("routes per-family reason codes for each tagged rule (idref, click-alternative, listener)", () => {
    // The per-family mapping keeps triage signal sharp: agents reading
    // `cross_file_idref_resolution_limited_on_this_input` know to look
    // for ids in sibling layout partials; `cross_file_click_
    // alternative_resolution_limited_on_this_input` points at a
    // possible parent-component fallback; `cross_file_listener_
    // resolution_limited_on_this_input` points at external `.js`.
    const rules = [
      mkRule("aria/labelledby-target-exists", [".html", ".htm"], { crossFileCapable: false }),
      mkRule("forms/error-message-not-associated", [".html", ".htm"], { crossFileCapable: false }),
      mkRule("navigation/skip-link", [".html", ".htm"], { crossFileCapable: false }),
      mkRule("pointer/drag-alternative", [".html", ".htm"], { crossFileCapable: false }),
    ];
    const entries = buildPerRuleCoverage(
      tracker({
        "aria/labelledby-target-exists": { eligible: 1, evaluated: 1 },
        "forms/error-message-not-associated": { eligible: 1, evaluated: 1 },
        "navigation/skip-link": { eligible: 1, evaluated: 1 },
        "pointer/drag-alternative": { eligible: 1, evaluated: 1 },
      }),
      rules,
      passAllFilter,
      [],
      1,
    );
    // Sorted alphabetically by rule id — same invariant the other
    // tests honor. Every entry is medium.
    expect(entries.map((r) => r.coverageConfidence)).toEqual([
      "medium",
      "medium",
      "medium",
      "medium",
    ]);
    const byId = new Map(entries.map((r) => [r.ruleId, r.reason]));
    expect(byId.get("aria/labelledby-target-exists")).toBe(
      "cross_file_idref_resolution_limited_on_this_input",
    );
    expect(byId.get("forms/error-message-not-associated")).toBe(
      "cross_file_idref_resolution_limited_on_this_input",
    );
    expect(byId.get("navigation/skip-link")).toBe(
      "cross_file_idref_resolution_limited_on_this_input",
    );
    expect(byId.get("pointer/drag-alternative")).toBe(
      "cross_file_click_alternative_resolution_limited_on_this_input",
    );
  });

  it("falls back to the generic reason code for a crossFileCapable:false rule not in the per-family map", () => {
    // A rule that opts into `crossFileCapable: false` but hasn't been
    // added to the per-family mapping yet still gets an honest
    // downgrade — the fallback code names the downgrade in generic
    // terms. Better than hiding the signal; prompts rule authors to
    // add a specific code if the triage distinction matters.
    const rules = [
      mkRule("future/hypothetical-rule", [".html", ".htm"], { crossFileCapable: false }),
    ];
    const entries = buildPerRuleCoverage(
      tracker({ "future/hypothetical-rule": { eligible: 1, evaluated: 1 } }),
      rules,
      passAllFilter,
      [],
      1,
    );
    const [row] = entries;
    expect(row!.coverageConfidence).toBe("medium");
    expect(row!.reason).toBe("cross_file_evidence_bounded_on_this_input");
  });

  it("crossFileCapable:true (or unset) keeps coverageConfidence='high' (no downgrade)", () => {
    // Project-scoped rules that walk every file's AST are the
    // canonical `crossFileCapable: true` case — they see the
    // cross-file evidence in their implementation, so no downgrade
    // applies. Rules that leave the field unset likewise stay high:
    // absence means "spec is single-file-scoped; cross-file evidence
    // is not in scope."
    const rules = [
      mkRule("contrast/minimum", [".css"], { crossFileCapable: true }),
      mkRule("media/alt-text-missing", [".html", ".htm"]), // unset — single-file spec
    ];
    const entries = buildPerRuleCoverage(
      tracker({
        "contrast/minimum": { eligible: 2, evaluated: 2 },
        "media/alt-text-missing": { eligible: 3, evaluated: 3 },
      }),
      rules,
      passAllFilter,
      [],
      5,
    );
    expect(entries.map((r) => r.coverageConfidence)).toEqual(["high", "high"]);
  });

  it("downgrades a project-scoped crossFileCapable:false rule symmetrically to the extension-gated branch", () => {
    // The cross-file downgrade applies to both branches of the
    // builder. A `crossFileCapable: false` rule without an extension
    // gate (unusual in practice — project-scoped rules almost
    // always walk the full file set — but the path exists for
    // symmetry so rule authors can trust the flag regardless of
    // where they wire their check).
    const rules = [mkRule("hypothetical/project-bounded", undefined, { crossFileCapable: false })];
    const entries = buildPerRuleCoverage(tracker({}), rules, passAllFilter, [], 5);
    const [row] = entries;
    expect(row!.coverageConfidence).toBe("medium");
    expect(row!.reason).toBe("cross_file_evidence_bounded_on_this_input");
  });
});

// Q7-PERRULECOVERAGE-EMPTY-ELIGIBLE-COLLAPSE: extension-gated rows that
// scanned zero eligible files of the rule's extension type used to ship
// ~200 chars of identical "no files matching .css were scanned"
// remediation prose, ~30 of ~70 entries on an HTML-only Tailwind scan.
// `partitionPerRuleCoverage` rolls those rows up into a single
// `rulesNotEvaluatedDueToInputType` counter keyed by the rule's first
// eligible extension — the agent reads `byExtension` once and decides
// whether to widen scope. Doctrine balance: surface the actionable
// signal (which extensions the scan never saw) without per-rule
// repetition; level-gated and project-scoped rows stay verbatim because
// they name orthogonal gaps the agent acts on differently.
describe("partitionPerRuleCoverage", () => {
  // Builds a zero-eligibility low-confidence row — the canonical
  // collapse target. The eligible-row tests construct their own literal
  // (without `reason` / `remediation`) instead of spreading overrides,
  // because `exactOptionalPropertyTypes: true` forbids passing
  // `reason: undefined` to override the default — the optional field
  // must be omitted from the literal entirely.
  function mkZeroEligibleRow(ruleId: string): PerRuleCoverage {
    return {
      ruleId,
      filesEvaluated: 0,
      filesEligible: 0,
      findingsEmitted: 0,
      coverageConfidence: "low",
      reason: `no files matching .css were scanned`,
      remediation: "add CSS source files to the scan path",
    };
  }

  it("rolls up extension-gated rows with zero eligibility under the rule's first extension", () => {
    const rules = [
      mkRule("contrast/minimum", [".css"]),
      mkRule("contrast/enhanced", [".css"]),
      mkRule("forms/autocomplete-missing", [".html", ".htm"]),
    ];
    const rows: PerRuleCoverage[] = [
      mkZeroEligibleRow("contrast/minimum"),
      mkZeroEligibleRow("contrast/enhanced"),
      {
        ruleId: "forms/autocomplete-missing",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        coverageConfidence: "low",
        reason: "no files matching .html, .htm were scanned",
        remediation: "add HTML source files to the scan path",
      },
    ];
    const partition = partitionPerRuleCoverage(rows, rules);
    expect(partition.retained).toHaveLength(0);
    expect(partition.notEvaluatedDueToInputType.count).toBe(3);
    // Each rule's FIRST eligible extension is the bucket key — the
    // dispatch's stated heuristic. Two CSS rules collapse under `.css`,
    // one HTML rule under `.html` (the head of `[".html", ".htm"]`).
    expect(partition.notEvaluatedDueToInputType.byExtension).toEqual({
      ".css": 2,
      ".html": 1,
    });
  });

  it("retains rows with at least one eligible file (zero-eligibility predicate is strict)", () => {
    const rules = [mkRule("contrast/minimum", [".css"]), mkRule("contrast/enhanced", [".css"])];
    const rows: PerRuleCoverage[] = [
      // First row has eligible inputs — must stay verbatim so the agent
      // sees the per-rule findingsEmitted / concentration / remediation
      // signal. `reason` / `remediation` are omitted entirely (not
      // passed as `undefined`) per `exactOptionalPropertyTypes: true`.
      // Second row collapses under `.css`.
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 3,
        filesEligible: 3,
        findingsEmitted: 0,
        coverageConfidence: "high",
      },
      mkZeroEligibleRow("contrast/enhanced"),
    ];
    const partition = partitionPerRuleCoverage(rows, rules);
    expect(partition.retained.map((r) => r.ruleId)).toEqual(["contrast/minimum"]);
    expect(partition.notEvaluatedDueToInputType.count).toBe(1);
    expect(partition.notEvaluatedDueToInputType.byExtension).toEqual({ ".css": 1 });
  });

  it("retains level-gated rows verbatim (skipReason carries actionable remediation a counter cannot)", () => {
    // Q7-AAA-RULE-LOADER-SILENT-NORUN. A level-gated row carries
    // `skipReason: "gated_by_level"` plus `requiredLevel` /
    // `requestedLevel` so the agent has the exact remediation
    // ("re-run with `level: 'AAA'`"). Folding it into the
    // `byExtension` counter would hide that — extensions and level
    // are orthogonal axes.
    const rules = [mkRule("contrast/enhanced", [".css"])];
    const rows: PerRuleCoverage[] = [
      {
        ruleId: "contrast/enhanced",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        coverageConfidence: "low",
        skipReason: "gated_by_level",
        requiredLevel: "AAA",
        requestedLevel: "AA",
        reason: "gated_by_level: rule requires level AAA; scan requested level AA",
        remediation: "re-run with `level: 'AAA'` to evaluate this rule",
      },
    ];
    const partition = partitionPerRuleCoverage(rows, rules);
    expect(partition.retained).toHaveLength(1);
    expect(partition.retained[0]!.ruleId).toBe("contrast/enhanced");
    expect(partition.retained[0]!.skipReason).toBe("gated_by_level");
    expect(partition.notEvaluatedDueToInputType.count).toBe(0);
    expect(partition.notEvaluatedDueToInputType.byExtension).toEqual({});
  });

  it("retains project-scoped rows (no extension gate) so the zero-file 'nothing to evaluate' signal stays visible", () => {
    // Project-scoped rules without `appliesTo.fileExtensions` carry a
    // distinct `reason: "no files were scanned; project-scoped rule
    // had nothing to evaluate"` that names a different gap (zero
    // parseable files at all) than "wrong input type." There's also
    // no extension to bucket by, so collapsing is structurally
    // meaningless.
    const rules = [mkRule("focus/outline-visible", undefined)];
    const rows: PerRuleCoverage[] = [
      {
        ruleId: "focus/outline-visible",
        filesEvaluated: 0,
        filesEligible: 0,
        findingsEmitted: 0,
        coverageConfidence: "low",
        reason: "no files were scanned; project-scoped rule had nothing to evaluate",
        remediation: "check the scan root and include patterns",
      },
    ];
    const partition = partitionPerRuleCoverage(rows, rules);
    expect(partition.retained).toHaveLength(1);
    expect(partition.retained[0]!.ruleId).toBe("focus/outline-visible");
    expect(partition.notEvaluatedDueToInputType.count).toBe(0);
  });

  it("retains rows whose rule isn't in the lookup map (defensive — collapsing on absent metadata would hide signal)", () => {
    // A row whose ruleId can't be resolved to a Rule (e.g. a stale
    // alias, a registry mismatch) keeps the row visible so the agent
    // sees the unknown row rather than silently dropping it into a
    // rolled-up counter under no honest extension key.
    const rules: Rule[] = [];
    const rows: PerRuleCoverage[] = [mkZeroEligibleRow("orphan/no-rule")];
    const partition = partitionPerRuleCoverage(rows, rules);
    expect(partition.retained).toHaveLength(1);
    expect(partition.retained[0]!.ruleId).toBe("orphan/no-rule");
    expect(partition.notEvaluatedDueToInputType.count).toBe(0);
  });

  it("returns a zero-and-empty counter and the input rows reference unchanged when nothing collapses", () => {
    const rules = [mkRule("contrast/minimum", [".css"])];
    const rows: PerRuleCoverage[] = [
      {
        ruleId: "contrast/minimum",
        filesEvaluated: 2,
        filesEligible: 2,
        findingsEmitted: 0,
        coverageConfidence: "high",
      },
    ];
    const partition = partitionPerRuleCoverage(rows, rules);
    // Identity preservation: when nothing collapses the same array
    // reference is returned so downstream identity checks (e.g. vendor-
    // concentration's `if (enriched === rows) return meta`) keep
    // working without an unconditional rebuild.
    expect(partition.retained).toBe(rows);
    expect(partition.notEvaluatedDueToInputType.count).toBe(0);
    expect(partition.notEvaluatedDueToInputType.byExtension).toEqual({});
  });

  it("counter is always present (zero-and-empty) even when input rows is empty", () => {
    // The counter rides at zero so the agent has a deterministic field
    // to read on every scan shape — present-when-meaningful is inverted
    // here for scan-confidence telemetry, see
    // `RulesNotEvaluatedDueToInputType` doc.
    const partition = partitionPerRuleCoverage([], []);
    expect(partition.retained).toHaveLength(0);
    expect(partition.notEvaluatedDueToInputType).toEqual({ count: 0, byExtension: {} });
  });
});
