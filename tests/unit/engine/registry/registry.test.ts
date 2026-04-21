import { describe, expect, it } from "bun:test";
import { defineCandidateFinder, defineRule, defineStandard } from "../../../../src/api/plugin.ts";
import {
  createBuiltinRegistry,
  createRegistry,
  Registry,
} from "../../../../src/engine/registry/registry.ts";

// Synthetic fixtures: two standards whose same-numbered criteria declare
// mutual equivalence, so we can exercise rulesForCriterion's closure
// without depending on the full WCAG module graph.
const alpha = defineStandard({
  id: "alpha",
  name: "Alpha",
  version: "1.0",
  publisher: "Test",
  url: "https://example.com/alpha",
  levels: ["A"],
  criteria: [
    {
      id: "alpha:1.1",
      standardId: "alpha",
      localId: "1.1",
      title: "Alpha 1.1",
      level: "A",
      description: "…",
      url: "https://example.com/alpha#1.1",
      automatable: "partial",
      equivalentTo: ["beta:1.1"],
    },
    {
      id: "alpha:2.2",
      standardId: "alpha",
      localId: "2.2",
      title: "Alpha 2.2",
      level: "A",
      description: "…",
      url: "https://example.com/alpha#2.2",
      automatable: "full",
    },
  ],
});

const beta = defineStandard({
  id: "beta",
  name: "Beta",
  version: "1.0",
  publisher: "Test",
  url: "https://example.com/beta",
  levels: ["A"],
  criteria: [
    {
      id: "beta:1.1",
      standardId: "beta",
      localId: "1.1",
      title: "Beta 1.1",
      level: "A",
      description: "…",
      url: "https://example.com/beta#1.1",
      automatable: "partial",
    },
  ],
});

function makeRule(id: string, satisfies: readonly string[]) {
  return defineRule({
    id,
    satisfies,
    severity: "error",
    scope: "node",
    fixClass: "mechanical",
    docs: {
      description: "",
      rationale: "",
      goodExample: "",
      badExample: "",
      references: [],
    },
    check() {
      return undefined;
    },
  });
}

const ruleOnAlpha = makeRule("test/rule-on-alpha", ["alpha:1.1"]);
const ruleOnBeta = makeRule("test/rule-on-beta", ["beta:1.1"]);
const ruleOnAlphaOther = makeRule("test/rule-on-alpha-other", ["alpha:2.2"]);

const finderOnAlpha = defineCandidateFinder({
  id: "review/test-finder",
  criterionIds: ["alpha:1.1"],
  scope: "node",
  docs: {
    description: "Test finder for Registry unit tests.",
    reviewPrompt: "Does this location need human review?",
    references: [],
  },
  find() {
    return undefined;
  },
});

function makeRegistry() {
  return new Registry({
    rules: [ruleOnAlpha, ruleOnBeta, ruleOnAlphaOther],
    standards: [alpha, beta],
    finders: [finderOnAlpha],
  });
}

describe("Registry — accessors", () => {
  it("exposes the loaded rules, standards, and finders in input order", () => {
    const reg = makeRegistry();
    expect(reg.rules.map((r) => r.id)).toEqual([
      "test/rule-on-alpha",
      "test/rule-on-beta",
      "test/rule-on-alpha-other",
    ]);
    expect(reg.standards.map((s) => s.id)).toEqual(["alpha", "beta"]);
    expect(reg.finders.map((f) => f.id)).toEqual(["review/test-finder"]);
  });

  it("findRule returns the rule for a known ID", () => {
    const reg = makeRegistry();
    const hit = reg.findRule("test/rule-on-alpha");
    expect(hit?.id).toBe("test/rule-on-alpha");
  });

  it("findRule returns undefined for an unknown ID", () => {
    const reg = makeRegistry();
    expect(reg.findRule("does/not-exist")).toBeUndefined();
  });

  it("findStandard returns the standard for a known ID", () => {
    const reg = makeRegistry();
    expect(reg.findStandard("alpha")?.id).toBe("alpha");
    expect(reg.findStandard("beta")?.id).toBe("beta");
  });

  it("findStandard returns undefined for an unknown ID", () => {
    const reg = makeRegistry();
    expect(reg.findStandard("nope")).toBeUndefined();
  });

  it("findCriterion returns the criterion for a known ID", () => {
    const reg = makeRegistry();
    expect(reg.findCriterion("alpha:1.1")?.id).toBe("alpha:1.1");
    expect(reg.findCriterion("beta:1.1")?.id).toBe("beta:1.1");
  });

  it("findCriterion returns undefined for an unknown ID", () => {
    const reg = makeRegistry();
    expect(reg.findCriterion("alpha:9.9")).toBeUndefined();
  });

  it("exposes the composed CriteriaRegistry via `criteria`", () => {
    const reg = makeRegistry();
    // Should have every criterion from every loaded standard.
    expect(reg.criteria.has("alpha:1.1")).toBe(true);
    expect(reg.criteria.has("alpha:2.2")).toBe(true);
    expect(reg.criteria.has("beta:1.1")).toBe(true);
    expect(reg.criteria.size).toBe(3);
  });

  it("exposes the composed RulesRegistry via `rulesIndex`", () => {
    const reg = makeRegistry();
    expect(reg.rulesIndex.size).toBe(3);
    expect(reg.rulesIndex.get("test/rule-on-alpha")?.id).toBe("test/rule-on-alpha");
  });
});

describe("Registry — rulesForCriterion", () => {
  it("returns rules whose satisfies directly includes the criterion", () => {
    const reg = makeRegistry();
    const rules = reg.rulesForCriterion("alpha:2.2");
    expect(rules.map((r) => r.id)).toEqual(["test/rule-on-alpha-other"]);
  });

  it("returns rules reachable via equivalentTo in either direction", () => {
    const reg = makeRegistry();
    // alpha:1.1.equivalentTo = ['beta:1.1'], so:
    //   - asking for alpha:1.1 must return both rules (direct + via equivalent)
    //   - asking for beta:1.1 must also return both rules (reciprocal closure)
    const forAlpha = reg.rulesForCriterion("alpha:1.1").map((r) => r.id);
    const forBeta = reg.rulesForCriterion("beta:1.1").map((r) => r.id);
    expect([...forAlpha].sort()).toEqual(["test/rule-on-alpha", "test/rule-on-beta"]);
    expect([...forBeta].sort()).toEqual(["test/rule-on-alpha", "test/rule-on-beta"]);
  });

  it("returns results ordered by the input `rules` position", () => {
    // Reverse the input order and confirm rulesForCriterion reflects that.
    const reversed = new Registry({
      rules: [ruleOnBeta, ruleOnAlpha],
      standards: [alpha, beta],
      finders: [],
    });
    expect(reversed.rulesForCriterion("alpha:1.1").map((r) => r.id)).toEqual([
      "test/rule-on-beta",
      "test/rule-on-alpha",
    ]);
  });

  it("returns [] for a criterion with no satisfying rule", () => {
    const reg = new Registry({
      rules: [ruleOnAlphaOther],
      standards: [alpha, beta],
      finders: [],
    });
    expect(reg.rulesForCriterion("beta:1.1")).toEqual([]);
  });

  it("returns [] for an unknown criterion ID", () => {
    const reg = makeRegistry();
    expect(reg.rulesForCriterion("nope:9.9")).toEqual([]);
  });
});

describe("createBuiltinRegistry", () => {
  it("constructs a non-empty registry from the built-in barrels", () => {
    const reg = createBuiltinRegistry();
    expect(reg.rules.length).toBeGreaterThan(0);
    expect(reg.standards.length).toBeGreaterThan(0);
    expect(reg.finders.length).toBeGreaterThan(0);
  });

  it("resolves at least one shipped rule by ID", () => {
    const reg = createBuiltinRegistry();
    // `media/alt-text-missing` is a v0.1.0 built-in; the precise set can
    // evolve but this one is a stable anchor for the smoke check.
    const hit = reg.findRule("media/alt-text-missing");
    expect(hit?.id).toBe("media/alt-text-missing");
  });

  it("resolves the wcag22 standard and a representative criterion", () => {
    const reg = createBuiltinRegistry();
    expect(reg.findStandard("wcag22")?.id).toBe("wcag22");
    expect(reg.findCriterion("wcag22:1.1.1")?.id).toBe("wcag22:1.1.1");
  });

  it("returns at least one rule for a criterion with built-in coverage", () => {
    const reg = createBuiltinRegistry();
    // 1.1.1 Non-text content is covered by media/alt-text-missing.
    const rules = reg.rulesForCriterion("wcag22:1.1.1").map((r) => r.id);
    expect(rules).toContain("media/alt-text-missing");
  });

  it("fans a shipped rule out across equivalent standards via rulesForCriterion", () => {
    // Section 508 and EN 301 549 declare equivalences into WCAG 2.2; a
    // rule satisfying the WCAG criterion must be reachable from the
    // equivalent criterion ID without re-declaring `satisfies`. This is
    // the behavior the standard filter already relies on; we lock it in
    // here so future refactors of rulesForCriterion don't silently drop it.
    const reg = createBuiltinRegistry();
    const wcagRules = reg.rulesForCriterion("wcag22:1.1.1").map((r) => r.id);
    // Pick a rule known to satisfy 1.1.1 and confirm it also appears for
    // at least one of the equivalent-standard criteria.
    expect(wcagRules).toContain("media/alt-text-missing");
    const en = reg.findCriterion("wcag22:1.1.1");
    // If wcag22:1.1.1's equivalentTo declares any neighbors, every one
    // should surface the same rules. If not declared, this sub-check is
    // vacuous but the one above still holds.
    const equivalents = en?.equivalentTo ?? [];
    for (const equivId of equivalents) {
      const neighborRules = reg.rulesForCriterion(equivId).map((r) => r.id);
      expect(neighborRules).toContain("media/alt-text-missing");
    }
  });
});

describe("Registry — determinism across constructions", () => {
  it("two independent Registry instances with the same input produce identical rulesForCriterion output", () => {
    const a = makeRegistry();
    const b = makeRegistry();
    expect(a.rulesForCriterion("alpha:1.1").map((r) => r.id)).toEqual(
      b.rulesForCriterion("alpha:1.1").map((r) => r.id),
    );
  });
});

// ─── createRegistry (plugin-seam factory) ──────────────────────────────────

describe("createRegistry — plugin seam", () => {
  it("returns a built-ins-only registry when no overrides are supplied", () => {
    const baseline = createBuiltinRegistry();
    const reg = createRegistry();
    expect(reg.rules.length).toBe(baseline.rules.length);
    expect(reg.standards.length).toBe(baseline.standards.length);
    expect(reg.finders.length).toBe(baseline.finders.length);
    // Anchor a stable built-in: media/alt-text-missing.
    expect(reg.findRule("media/alt-text-missing")?.id).toBe("media/alt-text-missing");
  });

  it("appends a user rule alongside the built-ins so list_rules and scans see it", () => {
    const baseline = createBuiltinRegistry();
    const userRule = makeRule("example/user-plugin-smoke", ["wcag22:1.1.1"]);
    const reg = createRegistry({ rules: [userRule] });

    expect(reg.rules.length).toBe(baseline.rules.length + 1);
    expect(reg.findRule("example/user-plugin-smoke")?.id).toBe("example/user-plugin-smoke");
    // Built-ins remain resolvable — the plugin rule is additive, not a
    // replacement. This is the invariant list_rules / scan_project read on.
    expect(reg.findRule("media/alt-text-missing")?.id).toBe("media/alt-text-missing");
  });

  it("folds the user rule into the equivalence closure for an overlapping criterion", () => {
    // The user rule declares it satisfies wcag22:1.1.1. When the Registry
    // asks rulesForCriterion("wcag22:1.1.1"), both the built-in
    // media/alt-text-missing AND the user rule must appear — otherwise
    // scan_project would never evaluate the plugin against 1.1.1.
    const userRule = makeRule("example/user-plugin-fan-out", ["wcag22:1.1.1"]);
    const reg = createRegistry({ rules: [userRule] });
    const ids = reg.rulesForCriterion("wcag22:1.1.1").map((r) => r.id);
    expect(ids).toContain("media/alt-text-missing");
    expect(ids).toContain("example/user-plugin-fan-out");
  });

  it("appends user finders alongside the built-ins", () => {
    const baseline = createBuiltinRegistry();
    const userFinder = defineCandidateFinder({
      id: "example/user-finder",
      criterionIds: ["wcag22:1.4.3"],
      scope: "node",
      docs: {
        description: "Plugin-seam unit smoke.",
        reviewPrompt: "Does this pass contrast?",
        references: [],
      },
      find() {
        return undefined;
      },
    });
    const reg = createRegistry({ finders: [userFinder] });
    expect(reg.finders.length).toBe(baseline.finders.length + 1);
    expect(reg.finders.some((f) => f.id === "example/user-finder")).toBe(true);
  });
});
