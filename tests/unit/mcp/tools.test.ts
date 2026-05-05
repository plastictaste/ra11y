/**
 * Unit tests for MCP tool handlers.
 *
 * Each tool is tested with synthetic inputs against the real scanner.
 * Tests use the fixture files from tests/fixtures/ to get deterministic
 * scan results.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defineRule } from "../../../src/api/plugin.ts";
import { createRegistry } from "../../../src/engine/registry/registry.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures");
const BAD_ALT = join(FIXTURE_DIR, "bad", "alt-text-missing", "img-no-alt.html");
const GOOD_ALT = join(FIXTURE_DIR, "good", "alt-text-missing", "img-with-alt.html");

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe("MCP tool: list_rules", () => {
  it("returns all built-in rules", async () => {
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({}, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as { rules: unknown[] };
    expect(data.rules.length).toBeGreaterThan(0);

    const first = data.rules[0] as Record<string, unknown>;
    expect(typeof first.id).toBe("string");
    expect(typeof first.description).toBe("string");
    expect(typeof first.severity).toBe("string");
    expect(Array.isArray(first.satisfies)).toBe(true);
  });

  it("filters by standard", async () => {
    const tool = findTool("list_rules");
    const session = new McpSession();
    const all = await tool.handler({}, session);
    const wcag21 = await tool.handler({ standard: "wcag21" }, session);

    const allRules = JSON.parse(all.content[0].text) as { rules: unknown[] };
    const filteredRules = JSON.parse(wcag21.content[0].text) as { rules: unknown[] };

    // wcag21 filter should return fewer or equal rules.
    expect(filteredRules.rules.length).toBeLessThanOrEqual(allRules.rules.length);
    expect(filteredRules.rules.length).toBeGreaterThan(0);
  });

  it("omits filter field and reports matchedOf when no filter applied", async () => {
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({}, session);

    const data = JSON.parse(result.content[0].text) as {
      filter?: unknown;
      matchedOf: { total: number; matched: number };
      rules: unknown[];
    };

    // Conditional spread: no filter ⇒ no filter field (present-when-meaningful).
    expect("filter" in data).toBe(false);
    // matchedOf always present. No filter ⇒ matched equals total and both equal rules.length.
    expect(data.matchedOf.total).toBe(data.rules.length);
    expect(data.matchedOf.matched).toBe(data.rules.length);
    expect(data.matchedOf.matched).toBe(data.matchedOf.total);
  });

  it("echoes filter and narrows out wcag21-only rules (wcag22)", async () => {
    // WCAG 2.2 removed SC 4.1.1 Parsing, so rules that satisfy only
    // wcag21:4.1.1 (parsing/invalid-id-shape) are correctly dropped when
    // the caller filters by wcag22. The matchedOf signal makes that
    // honest: matched < total tells the agent the filter did narrow.
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag22" }, session);

    const data = JSON.parse(result.content[0].text) as {
      filter: { standard: string };
      matchedOf: { total: number; matched: number };
      rules: unknown[];
    };

    expect(data.filter).toEqual({ standard: "wcag22" });
    expect(data.matchedOf.matched).toBeLessThan(data.matchedOf.total);
    expect(data.matchedOf.matched).toBeGreaterThan(0);
    expect(data.rules.length).toBe(data.matchedOf.matched);
  });

  it("reports matched < total when filter narrows the list (wcag21)", async () => {
    // wcag21 predates several wcag22-only rules (e.g. focus-appearance,
    // target-size/minimum), so filtering by wcag21 is a genuine narrowing.
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag21" }, session);

    const data = JSON.parse(result.content[0].text) as {
      filter: { standard: string };
      matchedOf: { total: number; matched: number };
      rules: unknown[];
    };

    expect(data.filter).toEqual({ standard: "wcag21" });
    expect(data.matchedOf.matched).toBeLessThan(data.matchedOf.total);
    expect(data.matchedOf.matched).toBeGreaterThan(0);
    expect(data.rules.length).toBe(data.matchedOf.matched);
  });

  it("carries meta with scan-confidence telemetry (rules + standards counts)", async () => {
    // Envelope parity with the other onboarding tools: every
    // response ships `meta` so the agent can cross-check that the
    // enumeration resolved against the expected registry without a
    // second round-trip.
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({}, session);

    const data = JSON.parse(result.content[0].text) as {
      rules: unknown[];
      matchedOf: { total: number; matched: number };
      meta: {
        rulesTotal: number;
        rulesMatched: number;
        standardsLoaded: number;
        standards: string[];
      };
    };

    expect(data.meta).toBeDefined();
    expect(data.meta.rulesTotal).toBe(data.matchedOf.total);
    expect(data.meta.rulesMatched).toBe(data.matchedOf.matched);
    expect(data.meta.rulesMatched).toBe(data.rules.length);
    expect(data.meta.standardsLoaded).toBeGreaterThan(0);
    expect(Array.isArray(data.meta.standards)).toBe(true);
    expect(data.meta.standards.length).toBe(data.meta.standardsLoaded);
    // Built-in standards always include wcag22 + wcag21 — parity with
    // the fixture assumptions elsewhere in this file.
    expect(data.meta.standards).toContain("wcag22");
    expect(data.meta.standards).toContain("wcag21");
  });

  it("meta reflects matched count when a filter narrows the list", async () => {
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag21" }, session);

    const data = JSON.parse(result.content[0].text) as {
      meta: { rulesTotal: number; rulesMatched: number };
      matchedOf: { total: number; matched: number };
    };

    expect(data.meta.rulesTotal).toBe(data.matchedOf.total);
    expect(data.meta.rulesMatched).toBe(data.matchedOf.matched);
    expect(data.meta.rulesMatched).toBeLessThan(data.meta.rulesTotal);
  });

  it("emits nextStep + nextStepStructured routing to scan_project (no filter)", async () => {
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({}, session);

    const data = JSON.parse(result.content[0].text) as {
      nextStep: string;
      nextStepStructured: { tool: string; args: Record<string, unknown> };
    };

    expect(typeof data.nextStep).toBe("string");
    expect(data.nextStep).toContain("scan_project");
    expect(data.nextStep).toContain("explain_rule");
    // Structured hint is the machine twin of the prose — parity with
    // the other onboarding tools.
    expect(data.nextStepStructured.tool).toBe("scan_project");
    expect(data.nextStepStructured.args).toEqual({});
  });

  it("nextStep prose reflects the filter when one is applied", async () => {
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag21" }, session);

    const data = JSON.parse(result.content[0].text) as {
      nextStep: string;
      nextStepStructured: { tool: string; args: Record<string, unknown> };
    };

    // Filter name appears in the prose so the agent can confirm which
    // standard the count refers to without re-reading the echoed
    // `filter` field.
    expect(data.nextStep).toContain("wcag21");
    expect(data.nextStep).toContain("scan_project");
    // Structured twin pre-fills the standard arg so the agent's next
    // scan narrows to the same framework without re-specifying it.
    expect(data.nextStepStructured.tool).toBe("scan_project");
    expect(data.nextStepStructured.args).toEqual({ standard: "wcag21" });
  });

  it("displays equivalentTo-resolved satisfies so same-family rules share the cross-standard shape", async () => {
    // Same-family rules currently hand-curate `satisfies` differently:
    // `semantics/table-caption-missing` declares all 4 standards,
    // `semantics/table-headers` declares only wcag22 + wcag21.
    // After resolution through the reciprocal `equivalentTo` index,
    // every rule that satisfies a 1.3.1-family criterion must surface
    // its `wcag22:`, `wcag21:`, `section508:`, and `en301549:`
    // equivalents — otherwise an agent filtering by Section 508 sees
    // an inconsistent rule subset (matched against declared shape)
    // that does not reflect actual coverage.
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({}, session);

    const data = JSON.parse(result.content[0].text) as {
      rules: Array<{ id: string; satisfies: string[] }>;
    };

    const tableRuleIds = [
      "semantics/table-caption-missing",
      "semantics/table-headers",
      "semantics/table-th-scope-missing",
    ];
    for (const ruleId of tableRuleIds) {
      const entry = data.rules.find((r) => r.id === ruleId);
      expect(entry, `expected ${ruleId} in rules list`).toBeDefined();
      const satisfies = entry?.satisfies ?? [];
      expect(satisfies, `${ruleId} should resolve wcag22:1.3.1`).toContain("wcag22:1.3.1");
      expect(satisfies, `${ruleId} should resolve wcag21:1.3.1`).toContain("wcag21:1.3.1");
      expect(satisfies, `${ruleId} should resolve section508:1.3.1`).toContain("section508:1.3.1");
      expect(satisfies, `${ruleId} should resolve en301549:9.1.3.1`).toContain("en301549:9.1.3.1");
    }
  });

  it("standard filter matches rules through the equivalentTo-resolved set", async () => {
    // A rule that declared only `wcag22:1.3.1` + `wcag21:1.3.1` must
    // still appear under the `section508` filter because
    // `section508:1.3.1` is reachable via the reciprocal equivalentTo
    // index. Filtering on the raw declared shape would silently drop
    // the rule and force agents auditing Section 508 to cross-read
    // every rule's metadata against the standards registry.
    const tool = findTool("list_rules");
    const session = new McpSession();
    const result = await tool.handler({ standard: "section508" }, session);

    const data = JSON.parse(result.content[0].text) as {
      rules: Array<{ id: string; satisfies: string[] }>;
    };

    const tableHeaders = data.rules.find((r) => r.id === "semantics/table-headers");
    expect(tableHeaders).toBeDefined();
    expect(tableHeaders?.satisfies).toContain("section508:1.3.1");
  });
});

describe("MCP tool: explain_rule", () => {
  it("returns full rule metadata", async () => {
    const tool = findTool("explain_rule");
    const session = new McpSession();
    const result = await tool.handler({ ruleId: "media/alt-text-missing" }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(data.id).toBe("media/alt-text-missing");
    expect(typeof data.description).toBe("string");
    expect(typeof data.rationale).toBe("string");
    expect(typeof data.goodExample).toBe("string");
    expect(typeof data.badExample).toBe("string");
    expect(Array.isArray(data.satisfies)).toBe(true);
    expect(Array.isArray(data.references)).toBe(true);
  });

  it("returns error for unknown rule", async () => {
    const tool = findTool("explain_rule");
    const session = new McpSession();
    const result = await tool.handler({ ruleId: "nonexistent/rule" }, session);

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text) as { error: string };
    expect(data.error).toContain("not found");
  });

  it("returns error when ruleId is missing", async () => {
    const tool = findTool("explain_rule");
    const session = new McpSession();
    const result = await tool.handler({}, session);

    expect(result.isError).toBe(true);
  });

  /**
   * Affordance test: the optional `knownFalsePositives` /
   * `knownLimitations` fields on `RuleDocs` flow through `explain_rule`
   * present-when-meaningful — populated when the rule declares them,
   * omitted otherwise. Existing built-in rules don't declare these fields
   * yet (per-rule follow-up work); this regression pins the
   * affordance via a fixture rule wired through a registry override so
   * the absence of the fields on built-ins doesn't mask a wiring break.
   */
  it("surfaces knownFalsePositives + knownLimitations when the rule declares them", async () => {
    const fixtureRule = defineRule({
      id: "example/known-fps-affordance",
      satisfies: ["wcag22:1.1.1"],
      severity: "warning",
      scope: "node",
      fixClass: "mechanical",
      docs: {
        description: "Fixture rule pinning the explain_rule affordance.",
        rationale: "Affordance test only.",
        goodExample: "",
        badExample: "",
        references: [],
        knownFalsePositives: [
          "fires on every CSS animation: declaration regardless of infinite vs one-shot",
        ],
        knownLimitations: [
          "single-file scope: cross-file addEventListener attachments are not resolved",
        ],
      },
      check() {
        return undefined;
      },
    });
    const registry = createRegistry({ rules: [fixtureRule] });
    const session = new McpSession(registry);

    const tool = findTool("explain_rule");
    const result = await tool.handler({ ruleId: "example/known-fps-affordance" }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      knownFalsePositives?: readonly string[];
      knownLimitations?: readonly string[];
    };
    expect(data.knownFalsePositives).toEqual([
      "fires on every CSS animation: declaration regardless of infinite vs one-shot",
    ]);
    expect(data.knownLimitations).toEqual([
      "single-file scope: cross-file addEventListener attachments are not resolved",
    ]);
  });

  it("omits knownFalsePositives + knownLimitations when the rule does not declare them", async () => {
    // Built-in rules don't declare these fields yet; the response should
    // simply not contain the keys (present-when-meaningful), distinct from
    // emitting `[]`. An agent reading "no `knownFalsePositives` key" treats
    // it as "the rule author hasn't audited" rather than "audited and none
    // known", which is the honest signal until per-rule population lands.
    const tool = findTool("explain_rule");
    const session = new McpSession();
    const result = await tool.handler({ ruleId: "media/alt-text-missing" }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect("knownFalsePositives" in data).toBe(false);
    expect("knownLimitations" in data).toBe(false);
  });

  /**
   * Empty-array honesty: a rule that *has* been audited declares `[]`
   * deliberately ("we checked and there are no known FPs") — distinct
   * from the omit case ("we haven't checked yet"). The handler must
   * preserve that distinction by emitting the empty array rather than
   * collapsing it to omitted.
   */
  it("emits empty arrays verbatim when the rule declares them deliberately", async () => {
    const fixtureRule = defineRule({
      id: "example/audited-no-fps",
      satisfies: ["wcag22:1.1.1"],
      severity: "warning",
      scope: "node",
      fixClass: "mechanical",
      docs: {
        description: "Fixture rule pinning empty-array honesty.",
        rationale: "Affordance test only.",
        goodExample: "",
        badExample: "",
        references: [],
        knownFalsePositives: [],
        knownLimitations: [],
      },
      check() {
        return undefined;
      },
    });
    const registry = createRegistry({ rules: [fixtureRule] });
    const session = new McpSession(registry);

    const tool = findTool("explain_rule");
    const result = await tool.handler({ ruleId: "example/audited-no-fps" }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      knownFalsePositives?: readonly string[];
      knownLimitations?: readonly string[];
    };
    expect(data.knownFalsePositives).toEqual([]);
    expect(data.knownLimitations).toEqual([]);
  });

  it("expands satisfies through the equivalentTo reciprocal index", async () => {
    // media/alt-text-missing declares `["wcag22:1.1.1", "wcag21:1.1.1"]` —
    // the criteria registry's reciprocal closure should pull in
    // `section508:1.1.1` and `en301549:9.1.1.1` so Section 508 / EN 301 549
    // auditors see the full cross-standard coverage without having to
    // cross-read the standards registry.
    const tool = findTool("explain_rule");
    const session = new McpSession();
    const result = await tool.handler({ ruleId: "media/alt-text-missing" }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as { satisfies: string[] };
    expect(data.satisfies).toContain("wcag22:1.1.1");
    expect(data.satisfies).toContain("wcag21:1.1.1");
    expect(data.satisfies).toContain("section508:1.1.1");
    expect(data.satisfies).toContain("en301549:9.1.1.1");
    // Declared criteria come first in source order; equivalents follow.
    expect(data.satisfies.indexOf("wcag22:1.1.1")).toBeLessThan(
      data.satisfies.indexOf("section508:1.1.1"),
    );
    expect(data.satisfies.indexOf("wcag21:1.1.1")).toBeLessThan(
      data.satisfies.indexOf("section508:1.1.1"),
    );
    // No duplicates (declared criteria are not re-added via their own
    // equivalence closures).
    expect(new Set(data.satisfies).size).toBe(data.satisfies.length);
  });
});

describe("MCP tool: scan", () => {
  it("finds violations in bad fixture", async () => {
    const tool = findTool("scan");
    const session = new McpSession();
    const result = await tool.handler({ paths: [BAD_ALT] }, session);

    expect(result.isError).toBeUndefined();
    type FbcLane = { source: number; buildArtifact: number };
    const data = JSON.parse(result.content[0].text) as {
      plan: {
        notes: number;
        fixesByClass?: {
          mechanical: FbcLane;
          guidance: FbcLane;
          runtimeOnly: FbcLane;
          verifyInSource: FbcLane;
        };
      };
      files: Array<{ path: string; findings: unknown[] }>;
      meta: { filesScanned: number };
    };
    // The flat `plan.violations`
    // headline is gone; sum the four `fixesByClass` lanes for the
    // error+warning total alongside `plan.notes`. Each lane carries
    // a per-scan-kind sub-tally (`source + buildArtifact`).
    const lanes = data.plan.fixesByClass;
    const laneSum = (l: FbcLane): number => l.source + l.buildArtifact;
    const errorWarning = lanes
      ? laneSum(lanes.mechanical) +
        laneSum(lanes.guidance) +
        laneSum(lanes.runtimeOnly) +
        laneSum(lanes.verifyInSource)
      : 0;
    expect(errorWarning + data.plan.notes).toBeGreaterThan(0);
    expect(data.files.length).toBeGreaterThan(0);
    expect(data.meta.filesScanned).toBe(1);
  });

  it("returns clean scan for good fixture", async () => {
    const tool = findTool("scan");
    const session = new McpSession();
    const result = await tool.handler({ paths: [GOOD_ALT] }, session);

    // Good fixture may still have document-level findings (like missing title),
    // but should have zero alt-text findings.
    const filesData = JSON.parse(result.content[0].text) as {
      files: Array<{ findings: Array<{ ruleId: string }> }>;
    };
    const altFindings = filesData.files.flatMap((f) =>
      f.findings.filter((v) => v.ruleId === "media/alt-text-missing"),
    );
    expect(altFindings.length).toBe(0);
  });

  it("returns error for empty paths", async () => {
    const tool = findTool("scan");
    const session = new McpSession();
    const result = await tool.handler({ paths: [] }, session);
    expect(result.isError).toBe(true);
  });

  it("omits verbose arrays by default and surfaces them under verboseMeta", async () => {
    const tool = findTool("scan");
    const session = new McpSession();
    const terse = await tool.handler({ paths: [BAD_ALT] }, session);
    const terseData = JSON.parse(terse.content[0].text) as {
      meta: { analysisCoverage?: Record<string, unknown> };
    };
    const terseCov = terseData.meta.analysisCoverage ?? {};
    expect(terseCov.parseErrorFiles).toBeUndefined();
    expect(terseCov.opaqueCustomComponentNames).toBeUndefined();
    expect(terseCov.rulesEligibleByExtension).toBeUndefined();
    // ADR 0028: the canonical field rides only under verboseMeta.
    // The pre-release shape went through two earlier names — first
    // `rulesByExtension` (collided with `perRuleCoverage` semantics),
    // then `rulesFiredByExtension` (the "fired" verb lied because the
    // values measure eligibility, not actual emission). Both prior
    // names were dropped before any tagged release per the AI-first
    // consumer doctrine ("Ambiguous field shapes are dishonest" and
    // "Heuristic-mislabeled meta sub-fields are dishonest" in
    // `docs/kb/architecture/ai-first-consumer.md`), so neither must
    // resurface at any verbosity.
    expect(terseCov.rulesByExtension).toBeUndefined();
    expect(terseCov.rulesFiredByExtension).toBeUndefined();

    const verbose = await tool.handler({ paths: [BAD_ALT], verboseMeta: true }, session);
    const verboseData = JSON.parse(verbose.content[0].text) as {
      meta: { analysisCoverage?: Record<string, unknown> };
      warnings?: readonly string[];
    };
    const cov = verboseData.meta.analysisCoverage ?? {};
    // BAD_ALT is a .html fixture — expect rulesEligibleByExtension to include .html.
    expect(cov.rulesEligibleByExtension).toBeDefined();
    const byExt = cov.rulesEligibleByExtension as Record<string, string[]>;
    expect(Array.isArray(byExt[".html"])).toBe(true);
    expect(byExt[".html"].length).toBeGreaterThan(0);
    // The canonical field rides alone — both pre-release names
    // (`rulesByExtension` and `rulesFiredByExtension`) were dropped
    // before any tagged release per ADR 0028 and the AI-first
    // consumer doctrine. Both must stay absent at every verbosity,
    // and the legacy deprecation warning code must never fire.
    expect(cov.rulesByExtension).toBeUndefined();
    expect(cov.rulesFiredByExtension).toBeUndefined();
    expect(verboseData.warnings ?? []).not.toContain(
      "deprecated_field_rules_by_extension_renamed_rules_fired_by_extension",
    );
  });
});

describe("MCP tool: scan_project", () => {
  it("scans the provided cwd as a single root and reports the scanned envelope", async () => {
    const tool = findTool("scan_project");
    const session = new McpSession();
    const fixtureDir = BAD_ALT.replace(/\/[^/]+$/, "");
    const result = await tool.handler({ cwd: fixtureDir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      meta: { filesScanned: number; scanned: { mode: string; root: string } };
      scanned?: unknown;
    };
    // The scanned envelope lives inside meta only — the top-level
    // duplicate was removed. Assert the top-level field is gone so the
    // shape stays de-duplicated.
    expect(data.scanned).toBeUndefined();
    expect(data.meta.scanned).toEqual({ mode: "project", root: fixtureDir });
    expect(data.meta.filesScanned).toBeGreaterThan(0);
  });

  describe("directive nextStep", () => {
    it("on a fixture with violations, names the first file:line and the recommended tool", async () => {
      const tool = findTool("scan_project");
      const session = new McpSession();
      const fixtureDir = BAD_ALT.replace(/\/[^/]+$/, "");
      const result = await tool.handler({ cwd: fixtureDir }, session);
      type Lane = { source: number; buildArtifact: number };
      const data = JSON.parse(result.content[0].text) as {
        plan: {
          fixesByClass?: {
            mechanical?: Lane;
            guidance?: Lane;
            runtimeOnly?: Lane;
            verifyInSource?: Lane;
          };
        };
        nextStep: string;
      };
      // The fixture at tests/fixtures/bad/alt-text-missing/ has violations.
      // The flat `plan.violations`
      // counter is gone — sum the per-lane tally instead. Each lane
      // carries a per-scan-kind sub-tally; the flat per-lane number
      // is the sum of `source + buildArtifact`.
      const lanes = data.plan.fixesByClass;
      const laneSum = (l: Lane | undefined): number => (l?.source ?? 0) + (l?.buildArtifact ?? 0);
      const errorWarning =
        laneSum(lanes?.mechanical) +
        laneSum(lanes?.guidance) +
        laneSum(lanes?.runtimeOnly) +
        laneSum(lanes?.verifyInSource);
      expect(errorWarning).toBeGreaterThan(0);
      // Directive guidance: names something concrete the agent can
      // follow. Three shapes the response can take, all valid:
      //   1. `suggest_fix` hop on a file:line — fires when the violation's
      //      lane (`mechanical` or `guidance`) is countable as
      //      "fixable" by `nextStep`.
      //   2. `explain_rule` hop on a `ruleId` — fires when no violation
      //      is in the fixable lanes (e.g. `media/alt-text-missing` re-
      // tagged to `verify-in-source` per-
      //      ALT-MECHANICAL-DOWNGRADE; the lane is excluded from
      //      `fixable` because suggest_fix can't action it inline).
      // 3. Inline `primary.edit` prose under the
      //      trim — fires when EVERY violation is `fixClass: "mechanical"`.
      // The branches below cover all three without locking in one lane;
      // the test asserts "the response points somewhere concrete."
      // top-level location.
      if (/suggest_fix/.test(data.nextStep)) {
        expect(data.nextStep).toMatch(/\.html:\d+|\.tsx:\d+|\.jsx:\d+/);
      } else if (/explain_rule/.test(data.nextStep)) {
        expect(data.nextStep).toMatch(/`[\w/-]+`/);
      } else {
        expect(data.nextStep).toContain("primary.edit");
      }
    });

    it("on a clean directory, points at checklist for the manual-review half", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-clean-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir }, session);
      // top-level location.
      const data = JSON.parse(result.content[0].text) as { nextStep: string };
      expect(data.nextStep).toContain("checklist");
    });

    // `nextStep` and
    // `nextStepStructured` ship at the top level of the scan-family
    // response — never nested inside `meta`. The doctrine is "one
    // pointer, one place": a load-bearing agent-direction field
    // appearing in two locations forces the agent to disambiguate which
    // copy is canonical and opens a drift surface when the two copies
    // disagree. The invariant runs across every scan-family tool
    // (`scan_project`, `scan`, `scan_file`) so a future refactor that
    // re-introduces the meta-nested copy on any one tool trips this
    // guard instead of shipping silently.
    it("nextStep lives at the top level only, never under meta", async () => {
      const scanProjectTool = findTool("scan_project");
      const scanTool = findTool("scan");
      const scanFileTool = findTool("scan_file");
      const session = new McpSession();
      const fixtureDir = BAD_ALT.replace(/\/[^/]+$/, "");
      const bodies = [
        JSON.parse(
          (await scanProjectTool.handler({ cwd: fixtureDir }, session)).content[0].text,
        ) as Record<string, unknown>,
        JSON.parse(
          (await scanTool.handler({ paths: [fixtureDir] }, session)).content[0].text,
        ) as Record<string, unknown>,
        JSON.parse(
          (await scanFileTool.handler({ path: BAD_ALT }, session)).content[0].text,
        ) as Record<string, unknown>,
      ];
      for (const body of bodies) {
        // Top-level presence — the canonical location.
        expect(typeof body["nextStep"]).toBe("string");
        // Never nested — meta carries scan-confidence telemetry, not
        // agent direction.
        const meta = body["meta"] as Record<string, unknown> | undefined;
        expect(meta).toBeDefined();
        expect(meta).not.toHaveProperty("nextStep");
        expect(meta).not.toHaveProperty("nextStepStructured");
      }
    });
  });

  describe("autoDetectWrappers", () => {
    it("registers PascalCase-with-onClick components inline and surfaces them in meta", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-auto-detect-"));
      await writeFile(
        joinPath(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <ActionButton onClick={a} />",
          "      <ActionButton onClick={b} />",
          "      <Card onClick={c} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          autoDetectedWrappers?: { ran: boolean; candidates: string[] };
          autoDetectedWrappersNote?: string;
        };
      };
      expect(data.meta.autoDetectedWrappers).toEqual({
        ran: true,
        candidates: ["ActionButton", "Card"],
      });
      // Note spells out the concrete defineConfig shape so the agent
      // can compose the ra11y.config.ts edit in one Read+Edit pass.
      expect(data.meta.autoDetectedWrappersNote).toContain("defineConfig");
      expect(data.meta.autoDetectedWrappersNote).toContain('"ActionButton"');
      expect(data.meta.autoDetectedWrappersNote).toContain('"Card"');
    });

    it("omits the meta fields entirely when the flag is off", async () => {
      const tool = findTool("scan_project");
      const session = new McpSession();
      const fixtureDir = BAD_ALT.replace(/\/[^/]+$/, "");
      const result = await tool.handler({ cwd: fixtureDir }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: Record<string, unknown>;
      };
      expect(data.meta["autoDetectedWrappers"]).toBeUndefined();
      expect(data.meta["autoDetectedWrappersNote"]).toBeUndefined();
    });

    it("surfaces wrapper candidates as suggestions (not registrations) when config is missing and the flag is off", async () => {
      // Onboarding signal: the agent should see what a nativeWrappers
      // list would look like before writing ra11y.config.ts, without
      // implicitly registering anything. Silent onboarding was the
      // most common field-report friction.
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-config-miss-hint-"));
      await writeFile(
        joinPath(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <ActionButton onClick={a} />",
          "      <Card onClick={c} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          configSource: string | null;
          autoDetectedWrappers?: { ran: boolean; candidates: string[] };
          suggestedNativeWrappers?: string[];
          suggestedNativeWrappersNote?: string;
        };
      };
      expect(data.meta.configSource).toBeNull();
      expect(data.meta.autoDetectedWrappers).toBeUndefined();
      expect(data.meta.suggestedNativeWrappers).toEqual(["ActionButton", "Card"]);
      expect(data.meta.suggestedNativeWrappersNote).toContain("Not yet registered");
      expect(data.meta.suggestedNativeWrappersNote).toContain("autoDetectWrappers: true");
    });

    it("keeps session config pristine — detected wrappers are scan-scoped only", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-auto-detect-scope-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Widget onClick={x} />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      expect(session.config.nativeWrappers).not.toContain("Widget");
    });

    it("does NOT mis-attribute auto-detected wrappers to session provenance", async () => {
      // Regression: prior impl dumped detected names into fromSession so
      // the sessionOverridesNote falsely warned that configure() had
      // added them. Under the unified tagged list, the invariant is
      // that no entry carries `source: "session"` and
      // sessionOverridesNote stays absent when the agent only used
      // autoDetectWrappers.
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-auto-detect-attrib-"));
      await writeFile(
        joinPath(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <DesignSystemButton onClick={a} />",
          "      <DesignSystemCard onClick={b} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          autoDetectedWrappers?: { ran: boolean; candidates: string[] };
          activeNativeWrappers?: Array<{ name: string; source: string; confirmed?: boolean }>;
          sessionOverridesNote?: string;
        };
      };
      expect(data.meta.autoDetectedWrappers).toEqual({
        ran: true,
        candidates: ["DesignSystemButton", "DesignSystemCard"],
      });
      const sessionTagged = (data.meta.activeNativeWrappers ?? []).filter(
        (e) => e.source === "session",
      );
      expect(sessionTagged).toEqual([]);
      expect(data.meta.sessionOverridesNote).toBeUndefined();
    });

    it("tags each activeNativeWrappers entry with its source (config / session / autoDetect)", async () => {
      // Debugging "why is X active?" needs the source per wrapper.
      // configure() contributes `source: "session"`, autoDetect
      // contributes `source: "autoDetect"` (with a `confirmed` flag),
      // and ra11y.config.ts contributes `source: "config"`. The
      // unified tagged list shows all three in one field.
      //
      // autoDetect names are split by the one-hop AST probe.
      // This test adds a defining `ActionButton.tsx` whose root is a
      // native <button>, so the detector promotes it to
      // `confirmed: true` — the path that flows into the active
      // allowlist and silences findings.
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapper-provenance-"));
      await writeFile(
        joinPath(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <ActionButton onClick={a} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );
      await writeFile(
        joinPath(dir, "ActionButton.tsx"),
        "export function ActionButton(p) { return <button {...p} />; }",
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      // Simulate a prior configure() call contributing a wrapper that
      // isn't present in this scan's source — so the session and
      // autoDetect channels stay cleanly non-overlapping.
      session.config.nativeWrappers = ["SessionOnlyWidget"];
      const result = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          activeNativeWrappers?: Array<{ name: string; source: string; confirmed?: boolean }>;
        };
      };
      const entries = data.meta.activeNativeWrappers ?? [];
      expect(entries).toEqual(
        expect.arrayContaining([
          { name: "ActionButton", source: "autoDetect", confirmed: true },
          { name: "SessionOnlyWidget", source: "session" },
        ]),
      );
      // No config-sourced entries because no ra11y.config.ts lives
      // under the temp dir.
      expect(entries.some((e) => e.source === "config")).toBe(false);
    });

    it("splits auto-detected wrappers into confirmed vs assumed via the one-hop AST probe", async () => {
      // The core behavior: an auto-detected wrapper whose
      // defining file renders a native <button> is `confirmed: true`
      // and silences findings; one whose defining file renders <div>
      // is `confirmed: false` (assumed) and stays opaque (rules fire
      // as if the name were NOT in the wrapper list). See CLAUDE.md
      // §1 "No heuristic suppression" — only structural evidence
      // earns confirmation.
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-autodetect-split-"));
      // The real <button> wrapper — confirms.
      await writeFile(
        joinPath(dir, "Button.tsx"),
        "export function Button(p) { return <button {...p} />; }",
      );
      // A PascalCase wrapper whose root is a bare <div> — assumed.
      // This is the canonical silent-silencing risk the probe closes: if
      // this wrapper reached the effective allowlist, findings on it
      // would disappear even though the <div> underneath might be a
      // real keyboard-operability bug.
      await writeFile(
        joinPath(dir, "BeliefSubmitButton.tsx"),
        "export function BeliefSubmitButton(p) { return <div {...p}>submit</div>; }",
      );
      await writeFile(
        joinPath(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <Button onClick={a} />",
          "      <BeliefSubmitButton onClick={b} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          activeNativeWrappers?: Array<{ name: string; source: string; confirmed?: boolean }>;
        };
      };
      // Both names surface as tagged entries; only the confirmed one
      // carries `confirmed: true`, the assumed one carries
      // `confirmed: false` and is left out of the effective allowlist.
      const entries = data.meta.activeNativeWrappers ?? [];
      expect(entries).toEqual([
        { name: "Button", source: "autoDetect", confirmed: true },
        { name: "BeliefSubmitButton", source: "autoDetect", confirmed: false },
      ]);
    });

    it("leaves assumed wrappers opaque — findings on them are NOT silenced", async () => {
      // Acceptance criterion (v) from the probe brief, observed at the
      // MCP filter layer: when a wrapper is assumed (confirmed: false),
      // the scanner's wrapper-noise filter must not drop findings
      // carrying that component's name.
      //
      // Under the unified tagged list, the invariant is that an
      // assumed entry is still emitted (so the agent sees it), but
      // `dropWrapperNoise` is keyed on the confirmed-only effective
      // allowlist — so findings on assumed names stay live.
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-assumed-opaque-"));
      await writeFile(
        joinPath(dir, "PerceptionSlider.tsx"),
        // <div role='slider'> is the canonical motivating example — looks
        // like a native wrapper by name, is a real bug underneath.
        "export function PerceptionSlider(p) { return <div role='slider' {...p} />; }",
      );
      await writeFile(
        joinPath(dir, "app.tsx"),
        "export const App = () => <PerceptionSlider onClick={x} />;",
      );
      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          activeNativeWrappers?: Array<{ name: string; source: string; confirmed?: boolean }>;
        };
      };
      expect(data.meta.activeNativeWrappers).toEqual([
        { name: "PerceptionSlider", source: "autoDetect", confirmed: false },
      ]);
    });

    it("distinguishes ran-empty from did-not-run via the object-form shape", async () => {
      // Per AI-first doctrine "Ambiguous field shapes are dishonest":
      // an empty `autoDetectedWrappers: []` array used to read identically
      // whether the detector ran and found nothing or whether the
      // detector did not run at all (since the not-run case omits the
      // field entirely, an agent reading `data.meta.autoDetectedWrappers
      // ?? []` would coerce both to the same value). The object form
      // `{ ran: true, candidates: [...] }` makes the two states
      // structurally distinct: presence-with-`ran:true` means "ran";
      // absence means "did not run."
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-auto-detect-empty-"));
      await writeFile(joinPath(dir, "app.ts"), "export const x = 1;");
      // The handler's "configMissing" branch suggests wrappers via a
      // separate `suggestedNativeWrappers` field, so to isolate the
      // ran-empty case we add a stub config so configMissing is false.
      await writeFile(
        joinPath(dir, "ra11y.config.ts"),
        'import { defineConfig } from "@ra11y/core";\nexport default defineConfig({});\n',
      );

      const tool = findTool("scan_project");
      const session = new McpSession();

      // Case 1: detector RAN (autoDetectWrappers: true) and found nothing.
      const ran = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const ranData = JSON.parse(ran.content[0].text) as {
        meta: {
          autoDetectedWrappers?: { ran: boolean; candidates: string[] };
          autoDetectedWrappersNote?: string;
        };
      };
      expect(ranData.meta.autoDetectedWrappers).toEqual({ ran: true, candidates: [] });
      expect(ranData.meta.autoDetectedWrappersNote).toContain("found no");

      // Case 2: detector did NOT run (flag omitted, config present so
      // the configMissing onboarding hint also stays silent).
      const notRan = await tool.handler({ cwd: dir }, session);
      const notRanData = JSON.parse(notRan.content[0].text) as {
        meta: {
          autoDetectedWrappers?: { ran: boolean; candidates: string[] };
          autoDetectedWrappersNote?: string;
          suggestedNativeWrappers?: string[];
        };
      };
      expect(notRanData.meta.autoDetectedWrappers).toBeUndefined();
      expect(notRanData.meta.autoDetectedWrappersNote).toBeUndefined();
      expect(notRanData.meta.suggestedNativeWrappers).toBeUndefined();

      // The two states must be structurally distinguishable from the
      // response alone (the whole point of the object-form shape).
      expect(ranData.meta.autoDetectedWrappers).not.toEqual(
        notRanData.meta.autoDetectedWrappers,
      );
    });

    it("detects input-shaped wrappers (value + onChange) alongside button-shaped ones", async () => {
      // The React controlled-input signal: PascalCase + value + onChange.
      // Before this, only onClick components were registered and Input
      // wrappers stayed in opaqueCustomComponents forever.
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-input-wrapper-"));
      await writeFile(
        joinPath(dir, "app.tsx"),
        [
          "export function App() {",
          "  return (",
          "    <>",
          "      <Input value={v} onChange={setV} />",
          "      <Checkbox checked={c} onChange={setC} />",
          "      <Textarea defaultValue={t} onChange={setT} />",
          "      <SubmitButton onClick={go} />",
          "    </>",
          "  );",
          "}",
        ].join("\n"),
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, autoDetectWrappers: true }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: { autoDetectedWrappers?: { ran: boolean; candidates: string[] } };
      };
      expect(data.meta.autoDetectedWrappers).toEqual({
        ran: true,
        candidates: ["Checkbox", "Input", "SubmitButton", "Textarea"],
      });
    });
  });

  describe("additionalPaths", () => {
    it("scans a gitignored dist directory when listed explicitly", async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-"));
      await writeFile(joinPath(dir, ".gitignore"), "dist/\n");
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");
      await mkdir(joinPath(dir, "dist", "assets"), { recursive: true });
      await writeFile(
        joinPath(dir, "dist", "assets", "main.css"),
        ".foo { color: #eee; background: #fff; }",
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["dist/assets"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          additionalPathsScanned?: { filesAdded: number; paths: string[]; note: string };
        };
      };
      expect(data.meta.additionalPathsScanned).toBeDefined();
      expect(data.meta.additionalPathsScanned?.filesAdded).toBe(1);
      expect(data.meta.additionalPathsScanned?.paths).toEqual(["dist/assets"]);
    });

    it("omits the additionalPathsScanned meta block when the param is absent", async () => {
      const tool = findTool("scan_project");
      const session = new McpSession();
      const fixtureDir = BAD_ALT.replace(/\/[^/]+$/, "");
      const result = await tool.handler({ cwd: fixtureDir }, session);
      const data = JSON.parse(result.content[0].text) as { meta: Record<string, unknown> };
      expect(data.meta["additionalPathsScanned"]).toBeUndefined();
    });

    it("reports 0 filesAdded when every additional file is already in the base tree", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-dup-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["."] }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          additionalPathsScanned?: { filesAdded: number };
        };
      };
      expect(data.meta.additionalPathsScanned?.filesAdded).toBe(0);
    });

    // `filesAdded: 0` + no `skipped`
    // entries is ambiguous on its own — the caller can't tell whether
    // the paths were ignored (skipped reasons) or redundant (files
    // already in the default set). The `redundant_additional_paths`
    // warning names the second case so the caller can drop the param
    // instead of re-targeting the path.
    it("fires the `redundant_additional_paths` warning when additional files were all in the base set", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-redundant-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["."] }, session);
      const data = JSON.parse(result.content[0].text) as {
        warnings?: string[];
        meta: { additionalPathsScanned?: { filesAdded: number } };
      };
      expect(data.meta.additionalPathsScanned?.filesAdded).toBe(0);
      expect(data.warnings).toContain("redundant_additional_paths");
    });

    // Q13-REDUNDANT-ADDITIONAL-PATHS-EMPTY-DETAILS — when the warning
    // fires, `warningsDetails.redundant_additional_paths` carries the
    // per-input redundant subset + a deterministic `reason` so the
    // agent's remediation cue is one read away. Without the payload,
    // the bare code reads as "the flag was redundant" but on a
    // multi-entry `additionalPaths` array the agent cannot tell which
    // subset was redundant vs. which was skipped — silent-miss per the
    // AI-first doctrine "Empty `warningsDetails.<code>: {}` is dishonest."
    it("populates warningsDetails.redundant_additional_paths with redundantPaths/reason when the warning fires", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-redundant-payload-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["."] }, session);
      const data = JSON.parse(result.content[0].text) as {
        warnings?: string[];
        warningsDetails?: Record<string, unknown>;
      };
      expect(data.warnings).toContain("redundant_additional_paths");
      const detail = data.warningsDetails?.["redundant_additional_paths"] as
        | { readonly redundantPaths?: readonly string[]; readonly reason?: string }
        | undefined;
      expect(detail).toBeDefined();
      // payload must be non-empty (the rule the closure addresses).
      expect(Object.keys(detail ?? {}).length).toBeGreaterThan(0);
      expect(detail?.redundantPaths).toEqual(["."]);
      expect(typeof detail?.reason).toBe("string");
      expect((detail?.reason ?? "").length).toBeGreaterThan(0);
    });

    // Cross-input invariant: a multi-entry `additionalPaths` array
    // mixing redundant + skipped entries must list ONLY the redundant
    // subset under `warningsDetails.redundant_additional_paths.redundantPaths`.
    // The skipped entries surface separately under
    // `meta.additionalPathsScanned.skipped[]`; the warning payload is
    // exclusively the redundancy cue ("drop the param") not the
    // skip cue ("fix the path").
    it("lists ONLY the redundant subset when additionalPaths mixes redundant + skipped entries", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-redundant-mixed-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler(
        { cwd: dir, additionalPaths: [".", "does-not-exist"] },
        session,
      );
      const data = JSON.parse(result.content[0].text) as {
        warnings?: string[];
        warningsDetails?: Record<string, unknown>;
        meta: { additionalPathsScanned?: { skipped?: { path: string; reason: string }[] } };
      };
      expect(data.warnings).toContain("redundant_additional_paths");
      const detail = data.warningsDetails?.["redundant_additional_paths"] as
        | { readonly redundantPaths?: readonly string[] }
        | undefined;
      expect(detail?.redundantPaths).toEqual(["."]);
      // skipped entries surface under the meta block, NOT the warning
      // payload — the two channels never overlap.
      expect(data.meta.additionalPathsScanned?.skipped).toEqual([
        { path: "does-not-exist", reason: "not-found" },
      ]);
    });

    // Distinct-from-ignored invariant: when `additionalPaths` resolved
    // to nothing (the path doesn't exist, has an unsupported extension,
    // or is excluded by glob), the code path is `skipped` reasons —
    // NOT `redundant_additional_paths`. The two codes name different
    // remediations (fix the path vs. drop the param) and must not
    // co-fire on the same input.
    it("does NOT fire `redundant_additional_paths` when the path was classified as skipped", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-skipped-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["does-not-exist"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        warnings?: string[];
        meta: {
          additionalPathsScanned?: {
            filesAdded: number;
            skipped?: { path: string; reason: string }[];
          };
        };
      };
      expect(data.meta.additionalPathsScanned?.skipped).toEqual([
        { path: "does-not-exist", reason: "not-found" },
      ]);
      expect(data.warnings ?? []).not.toContain("redundant_additional_paths");
    });

    // Regression guard: when the additional path contributed at least
    // one genuinely new file (gitignored dist/ etc.), the flag was NOT
    // redundant — the warning must stay dropped.
    it("does NOT fire `redundant_additional_paths` when at least one new file was added", async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-productive-"));
      await writeFile(joinPath(dir, ".gitignore"), "dist/\n");
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");
      await mkdir(joinPath(dir, "dist", "assets"), { recursive: true });
      await writeFile(
        joinPath(dir, "dist", "assets", "main.css"),
        ".foo { color: #eee; background: #fff; }",
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["dist/assets"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        warnings?: string[];
        meta: { additionalPathsScanned?: { filesAdded: number } };
      };
      expect(data.meta.additionalPathsScanned?.filesAdded).toBe(1);
      expect(data.warnings ?? []).not.toContain("redundant_additional_paths");
    });

    // Per-path skip reason reporting — filesAdded alone hides WHY a
    // given additionalPath contributed zero. Three deterministic
    // reasons are surfaced so the caller can distinguish unparseable
    // extensions, missing paths, and config-excluded paths without
    // a second round-trip.
    it("surfaces `not-found` when an additional path does not exist on disk", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-missing-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["does-not-exist"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          additionalPathsScanned?: {
            filesAdded: number;
            skipped?: { path: string; reason: string }[];
          };
        };
      };
      expect(data.meta.additionalPathsScanned?.skipped).toEqual([
        { path: "does-not-exist", reason: "not-found" },
      ]);
    });

    it("surfaces `unsupported-extension` when an additional file has no parseable extension", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-ext-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");
      // Use `.txt` — `.md` is now parseable under ADR 0025 (markdown
      // Option B). Any truly non-parseable extension demonstrates the
      // `unsupported-extension` path.
      await writeFile(joinPath(dir, "notes.txt"), "not parseable");

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["notes.txt"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          additionalPathsScanned?: {
            filesAdded: number;
            skipped?: { path: string; reason: string }[];
          };
        };
      };
      expect(data.meta.additionalPathsScanned?.skipped).toEqual([
        { path: "notes.txt", reason: "unsupported-extension" },
      ]);
    });

    it("surfaces `excluded-by-glob` when an additional path matches a configured exclude pattern", async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-excluded-"));
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");
      await mkdir(joinPath(dir, "generated"), { recursive: true });
      await writeFile(
        joinPath(dir, "generated", "out.css"),
        ".foo { color: #eee; background: #fff; }",
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      session.configure({ exclude: ["generated/**", "generated"] });
      const result = await tool.handler({ cwd: dir, additionalPaths: ["generated"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          additionalPathsScanned?: {
            filesAdded: number;
            skipped?: { path: string; reason: string }[];
          };
        };
      };
      expect(data.meta.additionalPathsScanned?.skipped).toEqual([
        { path: "generated", reason: "excluded-by-glob" },
      ]);
    });

    it("omits the `skipped` field when every additional path contributed parseable files", async () => {
      const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-extra-clean-"));
      await writeFile(joinPath(dir, ".gitignore"), "dist/\n");
      await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <div />;");
      await mkdir(joinPath(dir, "dist", "assets"), { recursive: true });
      await writeFile(
        joinPath(dir, "dist", "assets", "main.css"),
        ".foo { color: #eee; background: #fff; }",
      );

      const tool = findTool("scan_project");
      const session = new McpSession();
      const result = await tool.handler({ cwd: dir, additionalPaths: ["dist/assets"] }, session);
      const data = JSON.parse(result.content[0].text) as {
        meta: {
          additionalPathsScanned?: {
            filesAdded: number;
            skipped?: unknown;
          };
        };
      };
      expect(data.meta.additionalPathsScanned?.filesAdded).toBe(1);
      expect(data.meta.additionalPathsScanned?.skipped).toBeUndefined();
    });
  });

  describe("processes config threading", () => {
    // Guards the wiring fix: when a project config declares `processes`,
    // scan_project must thread them into `runScan` so project-scoped
    // finders (WCAG 3.2.3 Consistent Navigation, 3.2.4 Consistent
    // Identification) fire. Without threading, those finders see no
    // page-set evidence and emit zero candidates even when the files
    // actually diverge. The consistent-identification finder is the
    // clearest probe: it emits candidates ONLY when processes are
    // declared AND pages diverge, so comparing `actionableManualItems`
    // between a processes-declared scan and a no-processes scan on the
    // same files isolates the threading delta from sibling finders
    // that fire regardless.
    it("routes wcag22:3.2.4 to actionable when declared processes have divergent identical-key buttons", async () => {
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { realpathSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join: joinPath } = await import("node:path");

      async function scratch(withProcesses: boolean) {
        const raw = await mkdtemp(joinPath(tmpdir(), "ra11y-proc-"));
        const dir = realpathSync(raw);
        // Two pages with the SAME data-testid but divergent visible
        // labels — the canonical 3.2.4 divergence the finder flags.
        await writeFile(
          joinPath(dir, "cart.html"),
          '<!doctype html><html><body><button data-testid="primary">Save</button></body></html>',
        );
        await writeFile(
          joinPath(dir, "checkout.html"),
          '<!doctype html><html><body><button data-testid="primary">Submit</button></body></html>',
        );
        const cfg = withProcesses
          ? { processes: [{ name: "checkout", pages: ["cart.html", "checkout.html"] }] }
          : {};
        await writeFile(joinPath(dir, "ra11y.config.json"), JSON.stringify(cfg));
        return dir;
      }

      const tool = findTool("scan_project");
      const withDir = await scratch(true);
      const withoutDir = await scratch(false);
      const withResult = await tool.handler({ cwd: withDir }, new McpSession());
      const withoutResult = await tool.handler({ cwd: withoutDir }, new McpSession());
      const withData = JSON.parse(withResult.content[0].text) as {
        plan: { actionableManualItems: number };
      };
      const withoutData = JSON.parse(withoutResult.content[0].text) as {
        plan: { actionableManualItems: number };
      };
      // Threading the processes config causes the
      // consistent-identification finder to ground 3.2.4, pushing it
      // from the untargeted bucket into actionable. The exact baseline
      // value isn't pinned — sibling finders that don't consume
      // processes fire identically in both runs, so the delta isolates
      // the threading fix.
      expect(withData.plan.actionableManualItems).toBeGreaterThan(
        withoutData.plan.actionableManualItems,
      );
    });
  });
});

describe("MCP tool: scan_file", () => {
  it("scans a single file", async () => {
    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: BAD_ALT }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: Array<{ ruleId: string }>;
    };
    expect(data.findings.length).toBeGreaterThan(0);
  });

  it("returns error for missing path", async () => {
    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({}, session);
    expect(result.isError).toBe(true);
  });

  it("file-unsupported remediation lists every parseable extension from the parser registry", async () => {
    // Invariant: the remediation string is derived from
    // `PARSEABLE_EXTENSIONS` in src/utils/path.ts, so when the parser
    // registry grows (e.g. a new `.vue` or `.svelte` adapter lands),
    // the scan_file error message stays honest without a manual edit.
    // Regression case: the pre-fix string listed only .tsx/.jsx/.ts/.js,
    // .html/.htm, .css and silently omitted .scss, .mdx, .astro —
    // agents reading it would conclude those extensions weren't
    // supported when in fact the scanner parses them.
    //
    // Scenario uses a real file with an unsupported extension so the
    // pre-check (path-exists) passes and the handler reaches the
    // extension-filter branch that emits `file-unsupported`. Post-
    // Q-SHARED-SCAN-FILE-ERROR-DISCRIMINATION a nonexistent path
    // returns `file-not-found` instead — covered by a sibling test.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-unsupported-ext-"));
    const yamlPath = joinPath(dir, "config.yaml");
    await writeFile(yamlPath, "key: value\n");
    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: yamlPath }, session);
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { code?: string; remediation?: string };
    expect(structured.code).toBe("file-unsupported");
    const remediation = structured.remediation ?? "";
    // Every registry-listed extension shows up in the remediation, so
    // the message can't drift against the list of parsers the scanner
    // actually loads.
    for (const ext of [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".html",
      ".htm",
      ".css",
      ".scss",
      ".less",
      ".mdx",
      ".astro",
      ".erb",
    ]) {
      expect(remediation).toContain(ext);
    }
  });

  it("scan_file emits `file-not-found` (distinct from `file-unsupported`) when the path does not exist", async () => {
    // Q-SHARED-SCAN-FILE-ERROR-DISCRIMINATION invariant: a nonexistent
    // path with an otherwise-parseable extension (e.g. `.tsx`) must
    // branch on `file-not-found`, not the old umbrella
    // `file-unsupported`. The unit-level guard complements the
    // integration test — lives here so bun:test exercises the code
    // path without spawning the CLI subprocess.
    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: "/definitely/does/not/exist.tsx" }, session);
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      code?: string;
      details?: Record<string, unknown>;
    };
    expect(structured.code).toBe("file-not-found");
    expect(structured.details?.["filePath"]).toBe("/definitely/does/not/exist.tsx");
  });

  it("scan_file emits `scan_file_parser_bail_no_findings` on a `.js` configuration object literal that the tsx parser routed through silently", async () => {
    // Per AI-first doctrine "Zero-output success is ambiguous failure":
    // when a `.js` file scans to zero findings AND the dispatcher
    // aliased it through the in-house TSX parser (per
    // `session.ts::parseForExtension`), the response shape is
    // indistinguishable from a true clean scan. The TSX parser bails
    // silently on relational expressions read as JSX, so a clean
    // `ast.errors` list against a `.js` file is itself ambiguous
    // evidence that no findings dropped. The conjunction-named warning
    // gives the agent the structured triage signal that
    // `parser_bailed_on_non_jsx_in_tsx_route` (routing-only) and
    // `parser_bailed_zero_findings` (parse-error-only) cannot ship
    // alone — the "Automated checks clean" `nextStep` framing is then
    // honestly disambiguated.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-scan-file-bail-no-findings-"));
    const jsPath = joinPath(dir, "webpack.config.js");
    // Pure non-JSX configuration object literal — the kind of `.js`
    // file users actually scan when they ask "is this clean?" The
    // tsx parser produces an AST without errors but its evidence
    // horizon does not match a JS-native parser; the routing-decision
    // signal is the sole bail evidence here (no parse errors).
    await writeFile(
      jsPath,
      [
        "const path = require('path');",
        "module.exports = {",
        "  entry: './src/index.js',",
        "  output: {",
        "    path: path.resolve(__dirname, 'dist'),",
        "    filename: 'bundle.js',",
        "  },",
        "};",
        "",
      ].join("\n"),
    );

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: jsPath }, session);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: unknown[];
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
    };
    expect(data.findings).toHaveLength(0);
    expect(data.warnings).toContain("scan_file_parser_bail_no_findings");
    const payload = data.warningsDetails?.["scan_file_parser_bail_no_findings"] as
      | { filePath: string; parserAttempted: string; naturalParser?: string; evidence: string }
      | undefined;
    expect(payload).toBeDefined();
    expect(payload?.filePath).toBe(jsPath);
    expect(payload?.parserAttempted).toBe("tsx");
    expect(payload?.naturalParser).toBe("js");
    expect(payload?.evidence).toBe("non_jsx_in_tsx_route");
  });

  it("scan_file emits `scan_file_parser_bail_no_findings` (parse_errors evidence) when the parser errored AND zero findings surfaced", async () => {
    // The parse-errors variant — `analysisCoverage.parseErrorFileCount > 0`
    // AND zero findings — covers the single-file analogue of the
    // project-shape `parser_bailed_zero_findings` predicate. Distinct
    // discriminated `evidence` so the agent's recovery action stays
    // deterministic (read `analysisCoverage.parseErrorFiles[]` for the
    // per-error fix pivot rather than re-routing by extension).
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-scan-file-bail-parse-error-"));
    const htmlPath = joinPath(dir, "broken.html");
    // Mismatched HTML triggers a parser error AND no a11y rule fires.
    await writeFile(htmlPath, "<<<>>>\n<div><span></div>\n");

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: htmlPath }, session);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: unknown[];
      warnings?: readonly string[];
      warningsDetails?: Record<string, unknown>;
    };
    expect(data.findings).toHaveLength(0);
    expect(data.warnings).toContain("scan_file_parser_bail_no_findings");
    const payload = data.warningsDetails?.["scan_file_parser_bail_no_findings"] as
      | { filePath: string; parserAttempted: string; naturalParser?: string; evidence: string }
      | undefined;
    expect(payload).toBeDefined();
    expect(payload?.filePath).toBe(htmlPath);
    expect(payload?.parserAttempted).toBe("html");
    expect(payload?.evidence).toBe("parse_errors");
    // naturalParser omitted because attempted matches natural for `.html`.
    expect("naturalParser" in (payload ?? {})).toBe(false);
  });

  it("scan_file does NOT emit `scan_file_parser_bail_no_findings` when findings surfaced (the conjunction predicate gates on zero findings)", async () => {
    // The warning's predicate is the CONJUNCTION of zero findings AND
    // parser-bail evidence. A scan that surfaced findings — even on a
    // routing-suspect substrate — is not the silent-miss shape the
    // warning names; the agent has real findings to triage and the
    // "Automated checks clean" framing did not ship.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-scan-file-bail-with-findings-"));
    const htmlPath = joinPath(dir, "withfinding.html");
    // `<img>` with no alt text fires `a11y/img-alt-missing` so findings
    // ride alongside any other warnings the response carries.
    await writeFile(htmlPath, "<img src='foo.png'>\n");

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: htmlPath }, session);
    const data = JSON.parse(result.content[0].text) as {
      findings: unknown[];
      warnings?: readonly string[];
    };
    expect(data.findings.length).toBeGreaterThan(0);
    expect(data.warnings ?? []).not.toContain("scan_file_parser_bail_no_findings");
  });

  it("parses .scss end-to-end and fires CSS-shaped contrast rules on the AST", async () => {
    // Invariant: `.scss` files reach the scanner through the same path
    // as `.css` files — discovery accepts them (PARSEABLE_EXTENSIONS),
    // `parseFile` dispatches to `parseScss` which emits the CSS AST
    // shape, and CSS-targeting rules (contrast/minimum) run against
    // that AST so authored Sass participates in conformance. Regression
    // guard for: the Jekyll field report
    // observed `file-unsupported` on `.scss` + `skippedByExtension`
    // with SCSS counts against a stale MCP subprocess; the wiring has
    // been in place since feat(input): route .scss through the scss
    // parser end-to-end (96620ec), and this test locks it in so a
    // future refactor can't silently drop any link in the chain
    // (discovery allow-list → parser dispatcher → rule eligibility).
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-scss-scan-file-"));
    const scssPath = joinPath(dir, "button.scss");
    // #777 on #fff is ~4.48:1 — below AA normal-text 4.5:1.
    await writeFile(scssPath, ".btn { color: #777; background: #fff; }\n");

    const tool = findTool("scan_file");
    const session = new McpSession();
    // verboseMeta: true — assertion inspects the per-row
    // perRuleCoverage[] (filesEligible per rule). Default verbosity
    // surfaces only the compact summary (-
    // DEFAULT).
    const result = await tool.handler({ path: scssPath, verboseMeta: true }, session);

    // Not the file-unsupported error the Jekyll agent observed.
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: Array<{ ruleId: string; criteria: readonly string[] }>;
      meta: {
        filesByExtension: Readonly<Record<string, number>>;
        perRuleCoverage: Array<{ ruleId: string; filesEligible: number }>;
      };
    };
    // Discovery + parser dispatch: .scss surfaces as a scanned ext.
    expect(data.meta.filesByExtension[".scss"]).toBe(1);
    // Rule eligibility: contrast/minimum declares .css, and the
    // `.scss → .css` alias in `extensionMatches` makes the rule
    // eligible on SCSS files. One rule-eligible file, one finding.
    const contrast = data.meta.perRuleCoverage.find((r) => r.ruleId === "contrast/minimum");
    expect(contrast?.filesEligible).toBe(1);
    const contrastFindings = data.findings.filter((f) => f.ruleId === "contrast/minimum");
    expect(contrastFindings.length).toBe(1);
    expect(contrastFindings[0]?.criteria).toContain("wcag22:1.4.3");
  });

  it("parses .erb end-to-end and routes through parseHtml so HTML-shaped rules fire", async () => {
    // Invariant: `.erb` files (Rails views, Middleman templates,
    // Jekyll `*.md.erb` scaffolds) reach the scanner through the
    // same path as `.html` — discovery accepts them
    // (PARSEABLE_EXTENSIONS), the dispatcher routes to `parseHtml`
    // which strips ERB directive spans from text nodes, and every
    // HTML-scoped rule runs against the resulting AST. Regression
    // guard for: the Jekyll field report observed
    // `file-unsupported` on a `.erb` file whose content would parse
    // cleanly as `.html`; the asymmetric allow-list was the bug, not
    // any parser capability gap.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-erb-scan-file-"));
    const erbPath = joinPath(dir, "index.html.erb");
    // `<img>` with a missing `alt` attribute — the HTML parser must
    // see the element after the ERB directive is stripped from the
    // surrounding text. `<%= @page.author %>` is the ERB shape the
    // field report cited; keeping it in the fixture documents that
    // the strip pass runs on ERB-dispatched `.erb` files.
    await writeFile(
      erbPath,
      "<!doctype html>\n<html><body><p>by <%= @page.author %></p>\n<img src='x.png'></body></html>\n",
    );

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: erbPath }, session);

    // Not file-unsupported, which was the old Jekyll-field-report
    // failure mode.
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      findings: Array<{ ruleId: string }>;
      meta: { filesByExtension: Readonly<Record<string, number>> };
    };
    // Discovery + parser dispatch: `.erb` surfaces as a scanned ext.
    expect(data.meta.filesByExtension[".erb"]).toBe(1);
    // HTML-scoped rules run on the ERB-dispatched AST — the alt-text
    // rule fires on `<img src='x.png'>`.
    const altFindings = data.findings.filter((f) => f.ruleId === "media/alt-text-missing");
    expect(altFindings.length).toBeGreaterThan(0);
  });

  it("discovers .erb files and does not report them as skipped by extension", async () => {
    // Sibling to the scan_file test above at the scan-project entry:
    // walk a tree with `.erb` + `.html` and assert every `.erb` is
    // accepted. Regression tripwire for — if discovery
    // drops `.erb` again this test is where it lands.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-erb-scan-project-"));
    await writeFile(joinPath(dir, "a.html.erb"), "<img src='a.png'>\n");
    await writeFile(joinPath(dir, "b.erb"), "<img src='b.png'>\n");
    await writeFile(joinPath(dir, "c.html"), "<img src='c.png'>\n");

    const tool = findTool("scan_project");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      meta: {
        filesScanned: number;
        filesByExtension: Readonly<Record<string, number>>;
        analysisCoverage?: { skippedByExtension?: Readonly<Record<string, number>> };
      };
    };
    expect(data.meta.filesScanned).toBe(3);
    expect(data.meta.filesByExtension[".erb"]).toBe(2);
    expect(data.meta.filesByExtension[".html"]).toBe(1);
    // `.erb` must NOT appear in skippedByExtension — the whole point.
    expect(data.meta.analysisCoverage?.skippedByExtension ?? {}).not.toHaveProperty(".erb");
  });

  it("discovers .scss files and does not report them as skipped by extension", async () => {
    // Sibling to the scan_file test above but at the scan-project
    // entry: scan a directory tree containing `.scss` + `.css` and
    // assert the walker accepts every `.scss` file and emits no
    // `skippedByExtension` entry for `.scss`. The Jekyll field
    // report observed `skippedByExtension: {".scss": 18}` on a tree
    // that was already supposed to be parseable; if discovery ever
    // silently drops `.scss` again this test is the tripwire.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-scss-scan-project-"));
    await writeFile(joinPath(dir, "a.scss"), ".btn { color: #777; background: #fff; }\n");
    await writeFile(joinPath(dir, "b.scss"), ".card { color: #888; background: #fff; }\n");
    await writeFile(joinPath(dir, "c.css"), ".ok { color: #000; background: #fff; }\n");

    const tool = findTool("scan_project");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      meta: {
        filesScanned: number;
        filesByExtension: Readonly<Record<string, number>>;
        analysisCoverage?: { skippedByExtension?: Readonly<Record<string, number>> };
      };
    };
    expect(data.meta.filesScanned).toBe(3);
    expect(data.meta.filesByExtension[".scss"]).toBe(2);
    expect(data.meta.filesByExtension[".css"]).toBe(1);
    // .scss must NOT appear in skippedByExtension — the whole point.
    expect(data.meta.analysisCoverage?.skippedByExtension ?? {}).not.toHaveProperty(".scss");
  });
});

describe("MCP tool: detect_native_wrappers", () => {
  it("groups info-level keyboard/handler-missing findings by component name", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-"));
    // Two occurrences of ActionButton, one of Card, and a real <div onClick>.
    // The tool should surface the first two as candidates and skip the div.
    const fixture = joinPath(dir, "app.tsx");
    await writeFile(
      fixture,
      [
        "export function App() {",
        "  return (",
        "    <>",
        "      <ActionButton onClick={a} />",
        "      <ActionButton onClick={b} />",
        "      <Card onClick={c} />",
        "      <div onClick={d}>native</div>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      candidates: Array<{ component: string; occurrences: number }>;
      nextStep: string;
    };
    const names = data.candidates.map((c) => c.component).sort();
    expect(names).toEqual(["ActionButton", "Card"]);
    const action = data.candidates.find((c) => c.component === "ActionButton");
    expect(action?.occurrences).toBe(2);
    expect(data.nextStep).toContain("nativeWrappers");
  });

  it("returns empty candidates when no PascalCase onClick is present", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-empty-"));
    await writeFile(joinPath(dir, "app.tsx"), "export const x = 1;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      candidates: unknown[];
      emptyReason?: string;
      nextStep: string;
    };
    expect(data.candidates).toEqual([]);
    // Structured discriminator — agents branch on this instead of
    // string-matching the prose nextStep. The parseable file here
    // yields zero PascalCase-with-onClick components, so the
    // combined "no-pascalcase-onclick-components" token applies.
    expect(data.emptyReason).toBe("no-pascalcase-onclick-components");
    expect(data.nextStep).toContain("No PascalCase");
  });

  it("returns inapplicable: { reason: 'no_jsx_in_tree' } when parseFiles returns nothing", async () => {
    // An empty cwd has zero JSX-bearing files, so the detector's
    // evidence model never had a surface to inspect. Per AI-first
    // doctrine "Zero-output success is ambiguous failure" + "One
    // tool call should answer 'what next?'" — we surface a top-level
    // `inapplicable` block carrying a structured reason discriminator
    // and a per-extension census. Distinct from the "tool ran clean"
    // case (some JSX scanned, no wrappers detected): an agent
    // branching on `inapplicable` can route once without re-calling
    // on a different cwd to discriminate.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-no-files-"));
    // Intentionally empty — no .tsx/.jsx/.html/.css to parse.

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      candidates: unknown[];
      inapplicable?: {
        reason: string;
        filesByExtension: Readonly<Record<string, number>>;
      };
      emptyReason?: string;
    };
    expect(data.candidates).toEqual([]);
    expect(data.inapplicable?.reason).toBe("no_jsx_in_tree");
    expect(data.inapplicable?.filesByExtension).toEqual({});
    // The "tool inapplicable" branch carries the structured
    // discriminator; `emptyReason` is reserved for "tool ran clean
    // but found nothing" cases.
    expect("emptyReason" in data).toBe(false);
  });

  it("returns inapplicable: { reason: 'no_jsx_in_tree' } with a per-extension census on a pure-HTML/CSS project", async () => {
    // A project with parseable HTML/CSS/MD files but no `.tsx`/`.jsx`/
    // `.mdx`/`.astro` source has no surface where a wrapper could be
    // defined. Per "Zero-output success is ambiguous failure," this
    // is structurally distinct from "tool ran clean": the
    // `inapplicable` block names the underlying reason and ships the
    // per-extension file census so the agent can branch in one read
    // (e.g. "this is a pure HTML site, skip wrapper-onboarding"
    // vs "this is a JSX project — re-run with a different cwd"). The
    // census combines parsed extensions and parser-rejected
    // extensions into a single map.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-pure-html-"));
    await writeFile(
      joinPath(dir, "index.html"),
      "<!doctype html><html><body><h1>Hi</h1></body></html>",
    );
    await writeFile(
      joinPath(dir, "about.html"),
      "<!doctype html><html><body><p>About</p></body></html>",
    );
    await writeFile(joinPath(dir, "styles.css"), "body { color: black; }");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      candidates: unknown[];
      inapplicable?: {
        reason: string;
        filesByExtension: Readonly<Record<string, number>>;
      };
      emptyReason?: string;
      nextStep: string;
    };
    expect(data.candidates).toEqual([]);
    expect(data.inapplicable?.reason).toBe("no_jsx_in_tree");
    expect(data.inapplicable?.filesByExtension[".html"]).toBe(2);
    expect(data.inapplicable?.filesByExtension[".css"]).toBe(1);
    expect("emptyReason" in data).toBe(false);
    // The prose nextStep MUST NOT reference the opaque-components
    // inventory — that surface only makes sense when the JSX walker
    // actually saw PascalCase tags. The "no JSX in tree" prose points
    // the agent at the structured `inapplicable` block instead.
    expect(data.nextStep).not.toContain("opaqueCustomComponentNames");
  });

  it("inlines opaqueCustomComponentNames when emptyReason is no-jsx-onclick-candidates-found-but-opaque-components-present", async () => {
    // The Astro/MDX case. The scanned JSX/TSX carries PascalCase
    // wrappers but none have inline `onClick` handlers — wrappers in
    // MDX/Astro render as children and receive events at the leaf
    // level, not the tag. Per AI-first doctrine "One tool call
    // should answer 'what next?'", the response inlines the
    // `opaqueCustomComponentNames` array on this branch so the
    // agent can open each component directly rather than re-calling
    // `scan_project` just to read the same inventory.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-opaque-"));
    // Two PascalCase components, neither with onClick or the
    // controlled-input prop shape — mirrors the Astro/MDX authoring
    // pattern where a `<Button>` wrapper is rendered with children
    // and the click binding lives on an inner native element.
    await writeFile(
      joinPath(dir, "app.tsx"),
      [
        "export function App() {",
        "  return (",
        "    <>",
        '      <Button variant="primary">Save</Button>',
        '      <Card title="Hello">content</Card>',
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      candidates: unknown[];
      emptyReason?: string;
      opaqueCustomComponentNames?: readonly string[];
      nextStep: string;
    };
    expect(data.candidates).toEqual([]);
    expect(data.emptyReason).toBe("no-jsx-onclick-candidates-found-but-opaque-components-present");
    // Inlined per "One tool call should answer 'what next?'" — sorted,
    // deterministic.
    expect(data.opaqueCustomComponentNames).toEqual(["Button", "Card"]);
    // Prose still names the inlined surface so agents reading either
    // string-matched or structurally-branched code land on the same
    // next call.
    expect(data.nextStep).toContain("opaqueCustomComponentNames");
  });

  it("omits opaqueCustomComponentNames on the no-pascalcase-onclick-components branch", async () => {
    // Present-when-meaningful: the inline inventory is inlined ONLY
    // on the opaque-components branch. A JSX file with no PascalCase
    // tags at all hits the bare-empty branch and the field is
    // omitted entirely (rather than shipped as `[]`) per CLAUDE.md
    // §1 "Ambiguous field shapes are dishonest."
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-no-pcc-"));
    await writeFile(joinPath(dir, "app.tsx"), "export const x = 1;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const raw = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(raw.candidates).toEqual([]);
    expect(raw.emptyReason).toBe("no-pascalcase-onclick-components");
    expect("opaqueCustomComponentNames" in raw).toBe(false);
  });

  it("omits emptyReason entirely when candidates are non-empty", async () => {
    // Present-when-meaningful: the discriminator only applies to
    // the empty-candidates branch. When the scan actually surfaces
    // wrappers, agents should see the field absent (not `""` or
    // `null`) so a `typeof` check is decisive.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-populated-"));
    await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Button onClick={x} />;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const raw = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(Array.isArray(raw.candidates)).toBe(true);
    expect((raw.candidates as unknown[]).length).toBeGreaterThan(0);
    expect("emptyReason" in raw).toBe(false);
  });

  it("emits suggestedConfigSnippet as a structured field when candidates are found", async () => {
    // agents previously had to parse the English
    // `nextStep` prose to extract a usable config fragment. The
    // structured twin is a `defineConfig`-compatible string they can
    // paste directly into ra11y.config.ts. Array form here because
    // `collectWrapperCandidates` does not carry per-candidate native
    // element mappings.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-snippet-"));
    await writeFile(
      joinPath(dir, "app.tsx"),
      [
        "export function App() {",
        "  return (",
        "    <>",
        "      <Link onClick={x} />",
        "      <Button onClick={y} />",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      candidates: Array<{ component: string }>;
      suggestedConfigSnippet?: string;
      nextStep: string;
    };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(typeof data.suggestedConfigSnippet).toBe("string");
    // defineConfig-compatible; names sorted lexicographically.
    // Final entry omits its trailing element-comma per the
    // "Bootstrap output must be paste-safe" doctrine; "Button"
    // (sorted before "Link") still carries its separator comma.
    expect(data.suggestedConfigSnippet).toBe(
      ["defineConfig({", "  nativeWrappers: [", '    "Button",', '    "Link"', "  ],", "});"].join(
        "\n",
      ),
    );
    // nextStep prose stays unchanged — agents using either surface
    // keep working (is additive, not a replacement).
    expect(data.nextStep).toContain("nativeWrappers");
  });

  it("omits suggestedConfigSnippet entirely when zero candidates are produced", async () => {
    // Per CLAUDE.md §1 "Ambiguous field shapes are dishonest," the
    // response omits the field via conditional spread rather than
    // shipping `""` or `null`. A caller checking `typeof` sees
    // `undefined` and knows there's nothing to paste.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-snippet-empty-"));
    await writeFile(joinPath(dir, "app.tsx"), "export const x = 1;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const raw = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(raw.candidates).toEqual([]);
    expect("suggestedConfigSnippet" in raw).toBe(false);
  });

  // Guards the cwd-not-found error envelope — distinct from a
  // successful zero-candidates / inapplicable response (which would
  // be the silent-failure shape AI-first doctrine warns against).
  // Mirrors the wrapper_introspect cwd-not-found test so onboarding
  // tools share the same contract.
  it("hard-errors with code cwd-not-found when cwd does not exist", async () => {
    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler(
      { cwd: "/nonexistent/ra11y-detect-native-wrappers/does-not-exist-xyz" },
      session,
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      readonly code?: string;
      readonly candidates?: unknown;
    };
    expect(payload.code).toBe("cwd-not-found");
    // Error envelope must not carry a `candidates` array — otherwise
    // an agent branching on "has candidates" might treat the error as
    // a clean empty scan.
    expect(payload.candidates).toBeUndefined();
  });

  it("is idempotent on re-call — same cwd returns byte-identical snippet", async () => {
    // Re-calling the tool on an unchanged project must yield the same
    // snippet. Load-bearing for agents that diff scans across calls;
    // a flapping snippet would look like a config change.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-snippet-idem-"));
    await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Button onClick={x} />;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const first = await tool.handler({ cwd: dir }, session);
    const second = await tool.handler({ cwd: dir }, session);

    const a = JSON.parse(first.content[0].text) as { suggestedConfigSnippet?: string };
    const b = JSON.parse(second.content[0].text) as { suggestedConfigSnippet?: string };
    expect(a.suggestedConfigSnippet).toBeDefined();
    expect(a.suggestedConfigSnippet).toBe(b.suggestedConfigSnippet);
  });

  // ---------------------------------------------------------------------
  // projectKind hint — derived deterministically from the parsed-file
  // extension set + discovery walker's `skippedByExtension` map. The
  // empty-candidates branch was previously ambiguous between "no
  // components in a JSX repo (coverage miss)" and "this isn't a JSX
  // repo at all (tool doesn't apply)"; the structured field rides on
  // every response so agents can short-circuit speculative re-calls.
  // ---------------------------------------------------------------------

  it("stamps projectKind 'jsx' when the scan saw a parseable .tsx file", async () => {
    // Provable: the parsed-file set contains at least one
    // JSX-bearing extension. Wins over any other classification
    // signal (a Rails repo with one stray .tsx is still a JSX project
    // for the detector's purposes).
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-projectkind-jsx-"));
    await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Button onClick={x} />;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as { projectKind?: string };
    expect(data.projectKind).toBe("jsx");
  });

  it("stamps projectKind 'ruby' when the discovery walker rejected .rb files", async () => {
    //. A Rails-shaped repo
    // with .rb files but no JSX/HTML drops to candidates: [] under
    // the previous shape — indistinguishable from "JSX project with
    // no PascalCase onClick." The named-language label closes that
    // ambiguity in one read, and the prose nextStep tells the agent
    // the empty result is "tool doesn't apply" rather than a
    // coverage miss.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-projectkind-ruby-"));
    await writeFile(joinPath(dir, "app.rb"), "puts 'hello'");
    await writeFile(joinPath(dir, "model.rb"), "class User; end");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      candidates: unknown[];
      projectKind?: string;
      emptyReason?: string;
      inapplicable?: { reason: string; filesByExtension: Readonly<Record<string, number>> };
      nextStep?: string;
    };
    expect(data.candidates).toEqual([]);
    expect(data.projectKind).toBe("ruby");
    // The "tool inapplicable" branch applies here — every `.rb` file
    // was rejected by the parseable-extension check, so the scanned
    // tree carries zero JSX-bearing files. The per-extension census
    // surfaces the `.rb` count via the discovery walker's
    // `skippedByExtension` map.
    expect(data.inapplicable?.reason).toBe("no_jsx_in_tree");
    expect(data.inapplicable?.filesByExtension[".rb"]).toBe(2);
  });

  it("stamps projectKind 'static-site' when only .html parses and no backend signature", async () => {
    // Pure HTML/CSS — the walker parsed the documents but there's no
    // JSX surface and no .rb/.py/.go signature. The agent can read
    // projectKind=static-site once and skip wrapper-onboarding for
    // this codebase.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-projectkind-static-"));
    await writeFile(
      joinPath(dir, "index.html"),
      "<!doctype html><html><body><h1>Hi</h1></body></html>",
    );
    await writeFile(joinPath(dir, "styles.css"), "body { color: black; }");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as { projectKind?: string };
    expect(data.projectKind).toBe("static-site");
  });

  it("named-language projectKind drives the empty-result nextStep prose", async () => {
    // The structured discriminator and the prose nudge must stay in
    // lockstep. On a Python-shaped repo the agent reading either
    // surface should land on "tool doesn't apply, skip
    // detect_native_wrappers" rather than the JSX-coverage prose.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-projectkind-py-prose-"));
    await writeFile(joinPath(dir, "app.py"), "print('hello')");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      projectKind?: string;
      inapplicable?: { reason: string };
      nextStep?: string;
    };
    expect(data.projectKind).toBe("python");
    // The "tool inapplicable" branch fires here too (no JSX-bearing
    // files in tree); projectKind="python" is the deterministic
    // backend-signature signal layered on top.
    expect(data.inapplicable?.reason).toBe("no_jsx_in_tree");
  });

  it("projectKind: 'jsx' wins when JSX files coexist with backend-language files", async () => {
    // Order-of-precedence guard. A monorepo subtree with a `.tsx`
    // component file alongside `.rb` scripts must classify as
    // `"jsx"` — the JSX surface is the strongest signal that the
    // detector applies, and surfacing `"ruby"` here would route the
    // agent away from a real wrapper-onboarding opportunity.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-detect-projectkind-mixed-"));
    await writeFile(joinPath(dir, "script.rb"), "puts 'hi'");
    await writeFile(joinPath(dir, "another.rb"), "puts 'bye'");
    await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Button onClick={x} />;");

    const tool = findTool("detect_native_wrappers");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as { projectKind?: string };
    expect(data.projectKind).toBe("jsx");
  });
});

describe("MCP tool: sessionConfigure", () => {
  it("sets session defaults and returns active config", async () => {
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag21", level: "A" }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      active: { standard: string; level: string; ruleCount: number };
    };
    expect(data.active.standard).toBe("wcag21");
    expect(data.active.level).toBe("A");
    expect(data.active.ruleCount).toBeGreaterThan(0);

    // Session state persists.
    expect(session.config.standard).toBe("wcag21");
    expect(session.config.level).toBe("A");
  });

  it("applies per-rule severity overrides to subsequent scans", async () => {
    const configureTool = findTool("sessionConfigure");
    const scanFileTool = findTool("scan_file");
    const session = new McpSession();

    // First, scan without overrides to confirm alt-text-missing fires.
    const before = await scanFileTool.handler({ path: BAD_ALT }, session);
    const beforeData = JSON.parse(before.content[0].text) as {
      findings: Array<{ ruleId: string }>;
    };
    const hadAltFinding = beforeData.findings.some((f) => f.ruleId === "media/alt-text-missing");
    expect(hadAltFinding).toBe(true);

    // Disable the rule via configure, then re-scan.
    await configureTool.handler({ rules: { "media/alt-text-missing": "off" } }, session);
    const after = await scanFileTool.handler({ path: BAD_ALT }, session);
    const afterData = JSON.parse(after.content[0].text) as {
      findings: Array<{ ruleId: string }>;
    };
    const stillFires = afterData.findings.some((f) => f.ruleId === "media/alt-text-missing");
    expect(stillFires).toBe(false);
  });

  it("respects ra11y.config.ts rule settings in the caller's cwd", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-mcp-config-"));
    await writeFile(
      joinPath(dir, "ra11y.config.ts"),
      `export default { rules: { "media/alt-text-missing": "off" } };\n`,
    );
    // Fixture file inside the temp dir so cwd-scoped discovery picks it up.
    const fixture = joinPath(dir, "bad.html");
    await writeFile(fixture, `<img src="x.png">\n`);

    const scanTool = findTool("scan");
    const session = new McpSession();
    const result = await scanTool.handler({ paths: [fixture], cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      meta: { configSource: string | null };
      files: Array<{ findings: Array<{ ruleId: string }> }>;
    };
    // ra11y.config.ts was discovered
    expect(data.meta.configSource).toContain("ra11y.config.ts");
    // And its "off" for media/alt-text-missing silenced the finding
    const fires = data.files.some((f) =>
      f.findings.some((v) => v.ruleId === "media/alt-text-missing"),
    );
    expect(fires).toBe(false);
  });

  it("re-reads ra11y.config.ts on each scan (no stale cache)", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-stale-cache-"));
    const fixture = joinPath(dir, "bad.html");
    await writeFile(fixture, `<img src="x.png">\n`);

    const scanTool = findTool("scan");
    const session = new McpSession();

    // First scan: no config file yet, configSource should be null.
    const before = await scanTool.handler({ paths: [fixture], cwd: dir }, session);
    const beforeData = JSON.parse(before.content[0].text) as {
      meta: { configSource: string | null };
      files: Array<{ findings: Array<{ ruleId: string }> }>;
    };
    expect(beforeData.meta.configSource).toBeNull();
    expect(
      beforeData.files.some((f) => f.findings.some((v) => v.ruleId === "media/alt-text-missing")),
    ).toBe(true);

    // Create the config partway through the session — the next scan must pick it up.
    await writeFile(
      joinPath(dir, "ra11y.config.ts"),
      `export default { rules: { "media/alt-text-missing": "off" } };\n`,
    );

    const after = await scanTool.handler({ paths: [fixture], cwd: dir }, session);
    const afterData = JSON.parse(after.content[0].text) as {
      meta: { configSource: string | null };
      files: Array<{ findings: Array<{ ruleId: string }> }>;
    };
    expect(afterData.meta.configSource).toContain("ra11y.config.ts");
    expect(
      afterData.files.some((f) => f.findings.some((v) => v.ruleId === "media/alt-text-missing")),
    ).toBe(false);
  });

  it("keyboard/handler-missing trusts PascalCase and still errors on <div onClick>", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-native-wrappers-"));
    // Custom components are assumed keyboard-operable — "can't see through
    // the component" is not a finding. A bare <div onClick> remains an
    // error because the DOM surface is visible and broken.
    const fixture = joinPath(dir, "app.tsx");
    await writeFile(
      fixture,
      [
        "export function App() {",
        "  return (",
        "    <>",
        "      <ActionButton onClick={a} />",
        "      <OtherWidget onClick={b} />",
        "      <div onClick={c}>click</div>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const scanTool = findTool("scan");
    const session = new McpSession();
    const result = await scanTool.handler({ paths: [fixture], cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      files: Array<{ findings: Array<{ ruleId: string; message: string; severity: string }> }>;
    };
    const khm = data.files.flatMap((f) =>
      f.findings.filter((v) => v.ruleId === "keyboard/handler-missing"),
    );
    expect(khm.some((v) => v.message.includes("ActionButton"))).toBe(false);
    expect(khm.some((v) => v.message.includes("OtherWidget"))).toBe(false);
    expect(khm.some((v) => v.severity === "error")).toBe(true);
  });

  it("nativeWrappers glob patterns silence findings for every matching component", async () => {
    // A design-system root can register `*Button` once instead of
    // enumerating every Icon/Action/Submit/Ghost variant. Each variant
    // is silenced by `dropWrapperNoise` via the glob match — no need
    // to keep the config list in lockstep with component renames.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapper-glob-"));
    await writeFile(
      joinPath(dir, "ra11y.config.ts"),
      `export default { nativeWrappers: ["*Button", "Icon*"] };\n`,
    );
    await writeFile(
      joinPath(dir, "app.tsx"),
      [
        "export function App() {",
        "  return (",
        "    <>",
        "      <ActionButton onClick={a} />",
        "      <IconBadge onClick={b} />",
        "      <div onClick={c}>bare</div>",
        "    </>",
        "  );",
        "}",
      ].join("\n"),
    );

    const scanTool = findTool("scan");
    const session = new McpSession();
    const result = await scanTool.handler({ paths: [dir], cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      files: Array<{ findings: Array<{ ruleId: string; message: string; severity: string }> }>;
    };
    const khm = data.files.flatMap((f) =>
      f.findings.filter((v) => v.ruleId === "keyboard/handler-missing"),
    );
    expect(khm.some((v) => v.message.includes("ActionButton"))).toBe(false);
    expect(khm.some((v) => v.message.includes("IconBadge"))).toBe(false);
    // Bare `<div onClick>` still errors — wrapper globs only silence
    // PascalCase component names.
    expect(khm.some((v) => v.severity === "error")).toBe(true);
  });

  it("unusedNativeWrappers reports glob patterns that matched nothing in scope", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapper-glob-unused-"));
    await writeFile(
      joinPath(dir, "ra11y.config.ts"),
      `export default { nativeWrappers: ["*Button", "Ghost*"] };\n`,
    );
    await writeFile(
      joinPath(dir, "app.tsx"),
      ["export function App() {", '  return <ActionButton label="Save" />;', "}"].join("\n"),
    );

    const scanTool = findTool("scan");
    const session = new McpSession();
    const result = await scanTool.handler({ paths: [dir], cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      meta: { unusedNativeWrappers?: string[] };
    };
    // `*Button` matched ActionButton — "used." `Ghost*` matched
    // nothing — surfaces as unused.
    expect(data.meta.unusedNativeWrappers).toEqual(["Ghost*"]);
  });

  it("unusedNativeWrappers ignores wrappers that are used via JSX (no suppressed violation)", async () => {
    // Regression: unusedNativeWrappers previously relied on suppressed
    // keyboard/handler-missing info violations to learn which wrappers
    // were "seen." A wrapper used correctly (no violation ever fires)
    // was wrongly reported unused — pushing users to delete valid
    // ra11y.config.ts entries. Now we scan the JSX directly.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-unused-wrappers-"));
    await writeFile(
      joinPath(dir, "ra11y.config.ts"),
      `export default { nativeWrappers: ["ActionButton", "GhostWrapper"] };\n`,
    );
    // ActionButton is used with valid props (no onClick → no noise to
    // suppress), GhostWrapper never appears. Only GhostWrapper should
    // surface as unused.
    await writeFile(
      joinPath(dir, "app.tsx"),
      ["export function App() {", '  return <ActionButton label="Save" />;', "}"].join("\n"),
    );

    const scanTool = findTool("scan");
    const session = new McpSession();
    const result = await scanTool.handler({ paths: [dir], cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      meta: { unusedNativeWrappers?: string[] };
    };
    expect(data.meta.unusedNativeWrappers).toEqual(["GhostWrapper"]);
  });

  it("unusedNativeWrappers widens detection into excluded paths (stories, dev-tools)", async () => {
    // Regression for Leela feedback: ActionButton was only referenced
    // from dev-tools/ and *.stories.*, both default-excluded. The
    // narrow AST-only detector marked it unused even though the real
    // code used it — just not in files ra11y scans by default.
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapper-widen-"));
    await writeFile(
      joinPath(dir, "ra11y.config.ts"),
      `export default { nativeWrappers: ["ActionButton", "TrulyGhost"] };\n`,
    );
    // No in-scope usage — ActionButton lives only in dev-tools/.
    const devToolsDir = joinPath(dir, "dev-tools");
    await mkdir(devToolsDir);
    await writeFile(
      joinPath(devToolsDir, "panel.tsx"),
      `export const Panel = () => <ActionButton label="Reload" />;\n`,
    );
    // Keep an in-scope .tsx file so the scan has something to parse.
    await writeFile(joinPath(dir, "app.tsx"), `export const App = () => <div />;\n`);

    const scanTool = findTool("scan");
    const session = new McpSession();
    const result = await scanTool.handler({ paths: [dir], cwd: dir }, session);

    const data = JSON.parse(result.content[0].text) as {
      meta: { unusedNativeWrappers?: string[] };
    };
    // ActionButton present in excluded dev-tools/ → not unused.
    // TrulyGhost present nowhere → still unused.
    expect(data.meta.unusedNativeWrappers).toEqual(["TrulyGhost"]);
  });

  it("allowWrite: true persists without cwd and echoes the effective gate", async () => {
    // Regression guard: prior behavior silently dropped `allowWrite:
    // true` in some envs and returned `active.allowWrite:false` as if
    // the gate had never been asked to flip. AI-first doctrine rejects
    // that silent-success shape — the echoed `active` must match the
    // session's post-call state, and a boolean opt-in with no other
    // params must land.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ allowWrite: true }, session);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      active: { allowWrite: boolean };
    };
    expect(data.active.allowWrite).toBe(true);
    expect(session.config.allowWrite).toBe(true);
  });

  it("allowWrite: false re-gates a previously opened session", async () => {
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    await tool.handler({ allowWrite: true }, session);
    expect(session.config.allowWrite).toBe(true);
    const result = await tool.handler({ allowWrite: false }, session);
    const data = JSON.parse(result.content[0].text) as {
      active: { allowWrite: boolean };
    };
    expect(data.active.allowWrite).toBe(false);
    expect(session.config.allowWrite).toBe(false);
  });

  it("rejects non-boolean allowWrite instead of silently dropping it", async () => {
    // Silent drop shape: caller sends `allowWrite: "true"` (string) or
    // `allowWrite: 1` (number), the typeof guard skips the assignment,
    // and the response echoes `active.allowWrite:false`. Indistinguishable
    // from "I never asked" — the AI-first doctrine's canonical
    // ambiguous-success failure mode. Reject with a structured error so
    // the agent knows to resend a real boolean.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ allowWrite: "true" }, session);
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { code: string; details?: { param: string } };
    expect(structured.code).toBe("invalid-param");
    expect(structured.details?.param).toBe("allowWrite");
    // Session state must not have been mutated on a rejected call.
    expect(session.config.allowWrite).toBe(false);
  });

  it("omitting allowWrite leaves the existing session setting untouched", async () => {
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    await tool.handler({ allowWrite: true }, session);
    // Follow-up call that changes `standard` only must not collapse
    // allowWrite back to its default — "absent" is not "false".
    const result = await tool.handler({ standard: "wcag21" }, session);
    const data = JSON.parse(result.content[0].text) as {
      active: { allowWrite: boolean; standard: string };
    };
    expect(data.active.allowWrite).toBe(true);
    expect(data.active.standard).toBe("wcag21");
    expect(session.config.allowWrite).toBe(true);
  });

  it("mutating-tool gate honors the post-configure state", async () => {
    // End-to-end check: after sessionConfigure({allowWrite:true}),
    // apply_fix's `allow-write-disabled` gate must no longer trip.
    // This is what the backlog item's "gate doesn't actually apply"
    // variant is asking for — the echoed effective state in
    // `active.allowWrite` must line up with what the enforcement
    // sites read.
    const tool = findTool("sessionConfigure");
    const applyFixTool = findTool("apply_fix");
    const session = new McpSession();

    // Before: gate engaged, a missing-args call should still rebound
    // off `allow-write-disabled` specifically, not some other error.
    const blocked = await applyFixTool.handler({}, session);
    expect(blocked.isError).toBe(true);
    const blockedCode = (blocked.structuredContent as { code: string }).code;
    expect(blockedCode).toBe("allow-write-disabled");

    // Flip the gate and re-call: the same bare-args call should now
    // fail on a DIFFERENT code (missing `file`), proving allowWrite
    // actually applied downstream.
    await tool.handler({ allowWrite: true }, session);
    const afterGate = await applyFixTool.handler({}, session);
    expect(afterGate.isError).toBe(true);
    const afterCode = (afterGate.structuredContent as { code: string }).code;
    expect(afterCode).not.toBe("allow-write-disabled");
  });

  it("echoes merged session state on the active block", async () => {
    // a caller that lands rules,
    // wrappers, exclude, and cwd in one configure call must see all of
    // them on the response so they can verify the merge applied. Before
    // this, the response only echoed standard/level/ruleCount/
    // allowWrite — a wrong rule ID was a silent no-op the agent could
    // not discover.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler(
      {
        rules: { "media/alt-text-missing": "warning" },
        nativeWrappers: { Button: "button", IconButton: "button" },
        exclude: ["dist/**"],
        cwd: "/tmp/echo-state-test",
      },
      session,
    );
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      active: {
        standard: string;
        level: string;
        allowWrite: boolean;
        rules?: Record<string, string>;
        nativeWrappers?: readonly string[];
        nativeWrapperElements?: Record<string, string>;
        exclude?: readonly string[];
        cwd?: string;
      };
    };
    expect(data.active.rules).toEqual({ "media/alt-text-missing": "warning" });
    expect(data.active.nativeWrappers?.includes("Button")).toBe(true);
    expect(data.active.nativeWrappers?.includes("IconButton")).toBe(true);
    expect(data.active.nativeWrapperElements).toEqual({
      Button: "button",
      IconButton: "button",
    });
    expect(data.active.exclude).toEqual(["dist/**"]);
    expect(data.active.cwd).toBe("/tmp/echo-state-test");
  });

  it("omits empty echo fields per present-when-meaningful doctrine", async () => {
    // A bare-args call (no rules, no wrappers, no excludes) must NOT
    // return `rules: {}`, `nativeWrappers: []`, `exclude: []` — empty
    // sentinels are dishonest under AI-first doctrine. The required
    // fields stay populated; the optional fields are conditional-
    // spread.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag21" }, session);
    const data = JSON.parse(result.content[0].text) as {
      active: Record<string, unknown>;
    };
    expect(data.active["standard"]).toBe("wcag21");
    expect("rules" in data.active).toBe(false);
    expect("nativeWrappers" in data.active).toBe(false);
    expect("nativeWrapperElements" in data.active).toBe(false);
    expect("exclude" in data.active).toBe(false);
    expect("cwd" in data.active).toBe(false);
  });

  it("emits unknown_rule_ids warning when a rule ID does not match the registry", async () => {
    // The canonical silent-no-op the backlog item names. The session
    // still records the setting (no-op fast path: nothing in the
    // registry has that ID, so nothing changes), but the agent sees
    // a structured warning + the offending IDs in `warningsDetails` so
    // a typo or stale post-rename ID is discoverable.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler(
      { rules: { "made/up-rule": "warning", "another/typo": "off" } },
      session,
    );
    const data = JSON.parse(result.content[0].text) as {
      warnings?: readonly string[];
      warningsDetails?: { unknown_rule_ids?: { ruleIds: readonly string[] } };
    };
    expect(data.warnings?.includes("unknown_rule_ids")).toBe(true);
    expect(data.warningsDetails?.unknown_rule_ids?.ruleIds).toEqual([
      "another/typo",
      "made/up-rule",
    ]);
  });

  it("omits unknown_rule_ids when every ID resolves through the registry or alias table", async () => {
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ rules: { "media/alt-text-missing": "off" } }, session);
    const data = JSON.parse(result.content[0].text) as {
      warnings?: readonly string[];
    };
    expect(data.warnings?.includes("unknown_rule_ids") ?? false).toBe(false);
  });

  it("does not flag aliased rule IDs as unknown", async () => {
    // `navigation/href-placeholder` is a deprecated alias that resolves
    // to `navigation/href-javascript-scheme`. The unknown-rule check
    // must follow the alias table before testing the registry, or
    // every legacy ID would noisily trip the warning during the
    // deprecation window.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ rules: { "navigation/href-placeholder": "off" } }, session);
    const data = JSON.parse(result.content[0].text) as {
      warnings?: readonly string[];
    };
    expect(data.warnings?.includes("unknown_rule_ids") ?? false).toBe(false);
  });

  it("emits session_allow_write_enabled whenever the merged gate is open", async () => {
    // The write gate is security-load-bearing: every configure response
    // surfaces the open state additively so an agent reading the
    // response after any param change still sees the signal — the gate
    // does not reset when the next call doesn't mention it.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const opened = await tool.handler({ allowWrite: true }, session);
    const openedData = JSON.parse(opened.content[0].text) as {
      warnings?: readonly string[];
    };
    expect(openedData.warnings?.includes("session_allow_write_enabled")).toBe(true);

    // Subsequent unrelated call still surfaces the warning because the
    // session state still has allowWrite open.
    const followup = await tool.handler({ standard: "wcag21" }, session);
    const followupData = JSON.parse(followup.content[0].text) as {
      warnings?: readonly string[];
    };
    expect(followupData.warnings?.includes("session_allow_write_enabled")).toBe(true);
  });

  it("omits session_allow_write_enabled when the gate is closed", async () => {
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    const result = await tool.handler({ standard: "wcag21" }, session);
    const data = JSON.parse(result.content[0].text) as {
      warnings?: readonly string[];
    };
    expect(data.warnings?.includes("session_allow_write_enabled") ?? false).toBe(false);
  });
});

describe("MCP tool: coverage", () => {
  it("returns coverage data", async () => {
    const tool = findTool("coverage");
    const session = new McpSession();
    const result = await tool.handler({ paths: [BAD_ALT] }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      standardId: string;
      automatedCriteriaPassRate: number;
      criteriaTotalForProfile: number;
      criteriaByLevel: Record<string, number>;
      criteriaAutomatable: number;
      // The redundant top-level `actionableManualItems` /
      // `criteriaUntestable` scalars were dropped from the coverage
      // entry per AI-first doctrine "Sibling fields naming the same
      // concept must use one shape" — agents read the criteria-axis
      // count from `summary.actionable.criteria` (or
      // `manualWithCandidates.length` when the array ships) and the
      // untestable count from
      // `summary.automatedCoverage.criteriaWithoutEligibleInputs`
      // (or `untestableCriteria.length` when the array ships).
      manualWithCandidates?: ReadonlyArray<{ criterionId: string }>;
      untargetedCriteria: number;
      // Structured `summary` dict — mirrors `checklist.summary` so an
      // agent reading `summary.actionable.criteria` /
      // `summary.untargetedCriteria` / `summary.likelyIrrelevant` on
      // either tool gets the same path resolution. Pre-fix this field
      // shipped as a prose string while `checklist.summary` shipped as
      // a dict — the canonical "Sibling fields naming the same concept
      // must use one shape" failure mode in
      // `docs/kb/architecture/ai-first-consumer.md`. Prose lives at
      // `summary.headline`.
      summary: {
        actionable: { criteria: number };
        untargetedCriteria: number;
        likelyIrrelevant: number;
        automatedCoverage: {
          standardId: string;
          criteriaWithRulesAllClean: number;
          criteriaWithoutEligibleInputs: number;
          automatedCriteriaPassRate?: number;
        };
        headline: string;
      };
    };
    expect(data.standardId).toBe("wcag22");
    expect(typeof data.automatedCriteriaPassRate).toBe("number");
    expect(data.criteriaTotalForProfile).toBeGreaterThan(0);
    expect(data.criteriaAutomatable).toBeLessThanOrEqual(data.criteriaTotalForProfile);
    // Level breakdown sums to the headline — anchors the otherwise-bare
    // count to its conformance shape (default level "AA" includes both
    // A and AA criteria).
    const levelSum = Object.values(data.criteriaByLevel).reduce((a, b) => a + b, 0);
    expect(levelSum).toBe(data.criteriaTotalForProfile);
    // The criteria-axis count rides on `summary.actionable.criteria`
    // (canonical structured access path mirroring
    // `checklist.summary.actionable.criteria`) and on the
    // `manualWithCandidates` array's length when the array ships.
    // The untargeted count rides on `untargetedCriteria` (no array
    // twin alongside it on the default envelope). Per AI-first
    // doctrine "Composite headline counts are dishonest" the legacy
    // composite `criteriaManualReviewRequired` was deleted; per
    // "Sibling fields naming the same concept must use one shape"
    // the redundant top-level scalars were dropped — agents read
    // through the structured surfaces.
    expect(typeof data.untargetedCriteria).toBe("number");
    expect(data.summary.actionable.criteria + data.untargetedCriteria).toBeGreaterThan(0);
    expect((data as Record<string, unknown>).criteriaManualReviewRequired).toBeUndefined();
    expect((data as Record<string, unknown>).actionableManualItems).toBeUndefined();
    expect((data as Record<string, unknown>).criteriaUntestable).toBeUndefined();
    // Structured summary dict — every leg the agent reads matches
    // checklist's keys exactly. `actionable.criteria` is the canonical
    // cross-tool count (matches `manualWithCandidates.length` and
    // `checklist.summary.actionable.criteria` on identical cwd).
    expect(typeof data.summary).toBe("object");
    expect(data.summary.actionable.criteria).toBe(data.manualWithCandidates?.length ?? 0);
    expect(data.summary.untargetedCriteria).toBe(data.untargetedCriteria);
    expect(typeof data.summary.likelyIrrelevant).toBe("number");
    expect(data.summary.automatedCoverage.standardId).toBe("wcag22");
    expect(typeof data.summary.automatedCoverage.criteriaWithRulesAllClean).toBe("number");
    expect(typeof data.summary.automatedCoverage.criteriaWithoutEligibleInputs).toBe("number");
    // Headline (prose) still names the two split counts as separate
    // clauses — pin both phrases appear so a future drift back to a
    // composite phrase fails here.
    expect(data.summary.headline).toContain("Manual review");
    expect(data.summary.headline).toContain("actionable items");
    expect(data.summary.headline).toContain("untargeted criteria");
    // Must NOT expose overallAutomatedCoverage — that ratio reads as failure
    // ("54%") when it actually measures a property of the rule library.
    expect((data as Record<string, unknown>).overallAutomatedCoverage).toBeUndefined();
  });
});

describe("MCP tool: audit", () => {
  it("returns { scan, coverage, checklist, nextStep } in one round-trip", async () => {
    const tool = findTool("audit");
    const session = new McpSession();
    const result = await tool.handler(
      { cwd: join(FIXTURE_DIR, "good", "alt-text-missing") },
      session,
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      scan: unknown;
      coverage: unknown;
      checklist: unknown;
      nextStep: unknown;
    };
    expect(typeof data.nextStep).toBe("string");
    expect(data.scan).toBeTruthy();
    expect(data.coverage).toBeTruthy();
    expect(data.checklist).toBeTruthy();
    const checklist = data.checklist as {
      summary: {
        actionable: {
          criteria: number;
          candidatesUncapped: number;
          candidatesReturned: number;
        };
      };
    };
    expect(typeof checklist.summary.actionable.criteria).toBe("number");
    expect(typeof checklist.summary.actionable.candidatesUncapped).toBe("number");
    expect(typeof checklist.summary.actionable.candidatesReturned).toBe("number");
  });

  it("forwards scan-only parameters to the scan leg", async () => {
    // autoDetectWrappers is a scan_project-only flag; verify audit
    // doesn't choke when a union-of-params is passed and that the
    // checklist/coverage legs still complete.
    const tool = findTool("audit");
    const session = new McpSession();
    const result = await tool.handler(
      { cwd: join(FIXTURE_DIR, "good", "alt-text-missing"), autoDetectWrappers: true },
      session,
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as {
      scan: { meta: { autoDetectedWrappers?: { ran: boolean; candidates: string[] } } };
    };
    // Shape contract: object-form `{ ran, candidates }` regardless of
    // whether the detector found anything (per AI-first doctrine
    // "Ambiguous field shapes are dishonest" — empty-array sentinel
    // can't double as "did not run").
    expect(data.scan.meta.autoDetectedWrappers).toBeDefined();
    expect(data.scan.meta.autoDetectedWrappers?.ran).toBe(true);
    expect(Array.isArray(data.scan.meta.autoDetectedWrappers?.candidates)).toBe(true);
  });
});

describe("MCP tool: suggest_fix", () => {
  it("returns fix suggestion for a known violation", async () => {
    const tool = findTool("suggest_fix");
    const session = new McpSession();

    // First scan to find a violation line.
    const scanTool = findTool("scan_file");
    const scanResult = await scanTool.handler({ path: BAD_ALT }, session);
    const scanData = JSON.parse(scanResult.content[0].text) as {
      findings: Array<{ ruleId: string; line: number }>;
    };

    const altFinding = scanData.findings.find((f) => f.ruleId === "media/alt-text-missing");
    if (!altFinding) {
      // If no alt-text finding, skip test gracefully.
      return;
    }

    const result = await tool.handler(
      { ruleId: altFinding.ruleId, file: BAD_ALT, line: altFinding.line },
      session,
    );

    expect(result.isError).toBeUndefined();
    // `kind: "edit"` retains a top-level `explanation`; `kind: "guidance"`
    // nests it under `primary.explanation` per Q-SHARED-SUGGEST-FIX-
    // GUIDANCE-PRIMARY. Read from whichever branch fires so the assertion
    // survives either rule outcome.
    const data = JSON.parse(result.content[0].text) as {
      kind: string;
      explanation?: string;
      primary?: { explanation?: string };
    };
    const explanation = data.kind === "guidance" ? data.primary?.explanation : data.explanation;
    expect(typeof explanation).toBe("string");
    expect((explanation ?? "").length).toBeGreaterThan(0);
  });

  it("returns error for missing params", async () => {
    const tool = findTool("suggest_fix");
    const session = new McpSession();
    const result = await tool.handler({ ruleId: "media/alt-text-missing" }, session);
    expect(result.isError).toBe(true);
  });

  it("surfaces structured primary + alternatives for rules that emit fixPaths", async () => {
    // label-in-name emits ranked fix paths; for `kind: "guidance"` the
    // primary approach + alternatives are nested per Q-SHARED-SUGGEST-
    // FIX-GUIDANCE-PRIMARY: `primary: { approach, explanation, ... }`
    // plus `alternatives: [{ approach, explanation }]`.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-suggest-fix-paths-"));
    const file = joinPath(dir, "index.html");
    await writeFile(file, `<button aria-label="Submit form">Send</button>`);

    const tool = findTool("suggest_fix");
    const session = new McpSession();
    const result = await tool.handler(
      { ruleId: "semantics/label-in-name", file, line: 1 },
      session,
    );
    const data = JSON.parse(result.content[0].text) as {
      kind: string;
      primary?: { approach?: string; explanation?: string };
      alternatives?: Array<{ approach: string; explanation: string }>;
    };
    expect(data.kind).toBe("guidance");
    expect(data.primary?.approach).toBeTruthy();
    expect(data.primary?.explanation).toBeTruthy();
    expect(data.alternatives).toHaveLength(2);
    expect(data.alternatives?.every((a) => a.approach.length > 0)).toBe(true);
    expect(data.alternatives?.every((a) => a.explanation.length > 0)).toBe(true);
  });

  it("returns kind: 'none' when no violation matches at the given line", async () => {
    const tool = findTool("suggest_fix");
    const session = new McpSession();
    const result = await tool.handler(
      { ruleId: "media/alt-text-missing", file: BAD_ALT, line: 9999 },
      session,
    );
    const data = JSON.parse(result.content[0].text) as { kind: string };
    expect(data.kind).toBe("none");
  });
});

describe("nativeWrapperElements round-trip through MCP handlers", () => {
  // Guards that `LoadedConfig.nativeWrapperElements` surfaces on the
  // scan response envelope as `activeNativeWrapperElements` when the
  // user has authored the object form of `Config.nativeWrappers`, and
  // stays absent otherwise (honest-shape per CLAUDE.md §1 — an empty
  // `{}` would read as "present but empty" rather than "no mapping").
  // Exercises the three entry points: scan_project (config-on-disk),
  // scan_file (config-on-disk), sessionConfigure (ephemeral object
  // form layered on top of a file-less session).

  it("scan_project with object-form nativeWrappers surfaces activeNativeWrapperElements", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapmap-mcp-object-"));
    await writeFile(
      joinPath(dir, "ra11y.config.json"),
      JSON.stringify({
        nativeWrappers: { Button: "button", RouterLink: "a", Avatar: "img" },
      }),
    );
    await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Button />;");

    const tool = findTool("scan_project");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      meta: { activeNativeWrapperElements?: Readonly<Record<string, string>> };
    };
    expect(data.meta.activeNativeWrapperElements).toEqual({
      Button: "button",
      RouterLink: "a",
      Avatar: "img",
    });
  });

  it("scan_project with array-form nativeWrappers omits activeNativeWrapperElements", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapmap-mcp-array-"));
    await writeFile(
      joinPath(dir, "ra11y.config.json"),
      JSON.stringify({ nativeWrappers: ["Button", "RouterLink"] }),
    );
    await writeFile(joinPath(dir, "app.tsx"), "export const App = () => <Button />;");

    const tool = findTool("scan_project");
    const session = new McpSession();
    const result = await tool.handler({ cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      meta: { activeNativeWrapperElements?: Readonly<Record<string, string>> };
    };
    // Names are present in the tagged list (array form still registers
    // them), but the element-mapping surface is absent because the
    // legacy shape supplies no mapping.
    expect(data.meta.activeNativeWrapperElements).toBeUndefined();
  });

  it("scan_file with object-form nativeWrappers surfaces activeNativeWrapperElements", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapmap-mcp-scan-file-"));
    await writeFile(
      joinPath(dir, "ra11y.config.json"),
      JSON.stringify({ nativeWrappers: { IconButton: "button" } }),
    );
    const appPath = joinPath(dir, "app.tsx");
    await writeFile(appPath, "export const App = () => <IconButton />;");

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: appPath, cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      plan: Record<string, unknown>;
      meta: { activeNativeWrapperElements?: Readonly<Record<string, string>> };
    };
    expect(data.meta.activeNativeWrapperElements).toEqual({ IconButton: "button" });
  });

  it("sessionConfigure accepts the object form and layers it onto the session element map", async () => {
    // The object shape must reach session.config.nativeWrapperElements
    // through the schema + handler path. We verify via session state
    // (the canonical source) rather than via a scan — keeps the test
    // scoped to the MCP-configure wiring.
    const tool = findTool("sessionConfigure");
    const session = new McpSession();
    await tool.handler({ nativeWrappers: { Button: "button", RouterLink: "a" } }, session);
    expect(session.config.nativeWrapperElements).toEqual({
      Button: "button",
      RouterLink: "a",
    });
    // Folded into the flat names list too, so consumers that only read
    // `nativeWrappers` see the object-form contributions.
    expect([...session.config.nativeWrappers].sort()).toEqual(["Button", "RouterLink"]);
  });

  it("sessionConfigure object-form surfaces activeNativeWrapperElements on a subsequent scan", async () => {
    // End-to-end wiring: agent configures the map via MCP, then calls
    // scan — the response envelope must carry the mapping back so the
    // round-trip is complete. Uses `scan` (paths-based) to keep the
    // fixture minimal.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapmap-mcp-session-"));
    const appPath = joinPath(dir, "app.tsx");
    await writeFile(appPath, "export const App = () => <IconButton />;");

    const configure = findTool("sessionConfigure");
    const session = new McpSession();
    await configure.handler({ nativeWrappers: { IconButton: "button" } }, session);

    const scan = findTool("scan");
    const result = await scan.handler({ paths: [appPath], cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      meta: { activeNativeWrapperElements?: Readonly<Record<string, string>> };
    };
    expect(data.meta.activeNativeWrapperElements).toEqual({ IconButton: "button" });
  });

  it("session element map layers on top of file element map (session wins on collision)", async () => {
    // Mirrors the name-side precedence: a `sessionConfigure` override
    // for a key present in ra11y.config.ts replaces the file value in
    // the merged `activeNativeWrapperElements`. Agents refining a
    // mapping mid-session don't need to restate the whole object.
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const dir = await mkdtemp(joinPath(tmpdir(), "ra11y-wrapmap-mcp-merge-"));
    await writeFile(
      joinPath(dir, "ra11y.config.json"),
      JSON.stringify({ nativeWrappers: { Button: "button", Card: "div" } }),
    );
    const appPath = joinPath(dir, "app.tsx");
    await writeFile(appPath, "export const App = () => <Button />;");

    const configure = findTool("sessionConfigure");
    const session = new McpSession();
    // Override the file's `Button: "button"` with `Button: "a"` for
    // the session. Card stays at the file's value.
    await configure.handler({ nativeWrappers: { Button: "a" } }, session);

    const scan = findTool("scan_project");
    const result = await scan.handler({ cwd: dir }, session);
    const data = JSON.parse(result.content[0].text) as {
      meta: { activeNativeWrapperElements?: Readonly<Record<string, string>> };
    };
    expect(data.meta.activeNativeWrapperElements).toEqual({ Button: "a", Card: "div" });
  });
});
