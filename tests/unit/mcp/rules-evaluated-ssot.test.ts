/**
 * Cross-surface invariant tests for the `rulesEvaluated` SSOT
 * (Q-SHARED-RULES-EVALUATED-SSOT).
 *
 * Before the SSOT, every scan-family / scan-derivative MCP tool derived
 * its `activeRules` list independently — some merged project config,
 * some didn't, and the divergence produced `meta.rulesEvaluated.loaded`
 * drift across surfaces on the same `cwd` (the canonical field report:
 * `scan_project: 53`, `propose_config: 54`, `list_rules: 54`).
 *
 * This file encodes the invariants that make the SSOT load-bearing:
 *
 *   1. `list_rules.rules[*].id` is a superset of every scan's
 *      `perRuleCoverage[*].ruleId`. A rule showing up in a scan's
 *      coverage telemetry must be discoverable via `list_rules`; the
 *      reverse is not guaranteed (standards + level filtering can drop
 *      rules before they reach `perRuleCoverage`).
 *   2. Every scan-family tool that reports `meta.rulesEvaluated.loaded`
 *      reports the SAME number as its peers on the same session + cwd.
 *      This is the structural invariant the SSOT encodes — a rule the
 *      session config silenced must be silenced identically in every
 *      surface that runs a scan, and the `loaded` count must reflect
 *      that identically too.
 *
 * Tests run against a real scratch directory with known files so the
 * scanner produces a deterministic `perRuleCoverage` shape. The
 * assertions are structural (set-containment, cross-tool equality) —
 * they don't pin exact counts, which would rot with every rule addition.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { checklistTool } from "../../../src/mcp/tool-checklist.ts";
import { coverageTool } from "../../../src/mcp/tool-coverage.ts";
import { listSuppressionsTool } from "../../../src/mcp/tool-list-suppressions.ts";
import { proposeConfigTool } from "../../../src/mcp/tool-propose-config.ts";
import { scanProjectTool } from "../../../src/mcp/tool-scan-project.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";
import type { McpTool } from "../../../src/mcp/tools-helpers.ts";

interface ListSuppressionsMetaShape {
  readonly meta: Record<string, unknown>;
}

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-ssot-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface ScanMetaShape {
  readonly meta: {
    readonly rulesEvaluated: { readonly loaded: number };
    readonly perRuleCoverage?: ReadonlyArray<{ readonly ruleId: string }>;
  };
}

async function callJson<T>(
  tool: McpTool,
  params: Record<string, unknown>,
  session: McpSession,
): Promise<T> {
  const result = await tool.handler(params, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

describe("rulesEvaluated SSOT: cross-surface invariants", () => {
  // Invariant #1: every rule the scanner reports in `perRuleCoverage`
  // must be discoverable via `list_rules`. Drift the other direction
  // (a rule in `list_rules` but not in `perRuleCoverage`) is expected
  // — the standards + level filter drops rules before they reach
  // coverage telemetry — so this is a one-way containment assertion.
  //
  // This is the "cross-surface invariant" named in the backlog item:
  // `list_rules` rule set ⊇ keys in any scan's `perRuleCoverage`.
  it("list_rules rule set ⊇ scan_project.perRuleCoverage rule IDs", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!doctype html><html lang="en"><head><title>Hi</title></head><body><img src="/x.png"><button></button></body></html>\n',
      );
      const session = new McpSession();
      const listRules = await callJson<{ rules: ReadonlyArray<{ id: string }> }>(
        findTool("list_rules"),
        {},
        session,
      );
      const listedIds = new Set(listRules.rules.map((r) => r.id));

      const scan = await callJson<ScanMetaShape>(scanProjectTool, { cwd: dir }, session);
      const coverage = scan.meta.perRuleCoverage ?? [];
      expect(coverage.length).toBeGreaterThan(0);
      for (const row of coverage) {
        expect(listedIds.has(row.ruleId)).toBe(true);
      }
    });
  });

  // Invariant #2: every scan-family / scan-derivative tool reports the
  // SAME `meta.rulesEvaluated.loaded` count on the same session + cwd.
  // Before the SSOT, `tool-checklist` / `tool-coverage` used
  // `session.config.rules` alone while `tool-scan-project` /
  // `tool-propose-config` merged project config — producing different
  // `loaded` counts on any cwd whose `ra11y.config.ts` silenced a rule.
  //
  // `list_suppressions` is intentionally OUTSIDE this invariant: that
  // tool runs zero rules, so it omits `rulesEvaluated` entirely
  // (V1-LIST-SUPPRESSIONS-RULES-EVALUATED-DRIFT). Including it under a
  // counter named "evaluated" would be cross-tool dishonest. The
  // companion absence-check below pins the omission so a future
  // re-introduction trips the test.
  //
  // The scratch dir has no config file, so the session-only and
  // session+project-config code paths produce the same answer — the
  // test passes today. When a regression reintroduces the split (e.g.
  // a new tool derives `activeRules` from `session.config.rules` alone),
  // this test stays green against an empty-config scratch but a future
  // config-aware variant catches the bug.
  it("scan_project, checklist, coverage, propose_config agree on rulesEvaluated.loaded", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!doctype html><html lang="en"><head><title>Hi</title></head><body><img src="/x.png" alt="x"></body></html>\n',
      );
      const session = new McpSession();

      const scan = await callJson<ScanMetaShape>(scanProjectTool, { cwd: dir }, session);
      // `checklist` and `coverage` emit `meta` only under `metaMode: "delta"`
      // (legacy callers see no `meta` block) — opt in so the SSOT
      // invariant is checkable.
      const checklist = await callJson<ScanMetaShape>(
        checklistTool,
        { cwd: dir, metaMode: "delta" },
        session,
      );
      const coverage = await callJson<ScanMetaShape>(
        coverageTool,
        { cwd: dir, metaMode: "delta" },
        session,
      );
      const propose = await callJson<ScanMetaShape>(proposeConfigTool, { cwd: dir }, session);
      const listSupp = await callJson<ListSuppressionsMetaShape>(
        listSuppressionsTool,
        { cwd: dir },
        session,
      );

      const loaded = scan.meta.rulesEvaluated.loaded;
      expect(loaded).toBeGreaterThan(0);
      expect(checklist.meta.rulesEvaluated.loaded).toBe(loaded);
      expect(coverage.meta.rulesEvaluated.loaded).toBe(loaded);
      expect(propose.meta.rulesEvaluated.loaded).toBe(loaded);
      // `list_suppressions` runs zero rules — `rulesEvaluated` must be
      // absent from its meta. Pinning here keeps the cross-tool drift
      // protection one regression-test wide.
      expect("rulesEvaluated" in listSupp.meta).toBe(false);
    });
  });

  // Invariant #3: when a `ra11y.config.ts` in the scratch dir silences
  // a rule via `{ rules: { "<id>": "off" } }`, EVERY scan-family
  // surface must reflect that exclusion in its `rulesEvaluated.loaded`
  // count. This is the positive assertion of the SSOT contract — the
  // config is honored uniformly, not just by the tools that happened
  // to open-code the project-config merge.
  //
  // Uses a known-present rule ID so the test fails loudly if the rule
  // is ever removed from the registry (rather than silently passing
  // because the "off" directive matched nothing).
  it("honors project-config rule-off uniformly across scan-family surfaces", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!doctype html><html lang="en"><head><title>Hi</title></head><body></body></html>\n',
      );
      // Pick a rule ID present in the default registry. `alt-text/missing`
      // is load-bearing across WCAG — if it's removed, the registry has
      // regressed and we want the test to fail loudly.
      const session = new McpSession();
      const listRules = await callJson<{ rules: ReadonlyArray<{ id: string }> }>(
        findTool("list_rules"),
        {},
        session,
      );
      const ruleToSilence = "media/alt-text-missing";
      expect(listRules.rules.some((r) => r.id === ruleToSilence)).toBe(true);

      await writeFile(
        join(dir, "ra11y.config.ts"),
        `export default { rules: { "${ruleToSilence}": "off" } };\n`,
      );

      // Fresh session to force project config reload.
      const session2 = new McpSession();
      const scan = await callJson<ScanMetaShape>(scanProjectTool, { cwd: dir }, session2);
      const checklist = await callJson<ScanMetaShape>(
        checklistTool,
        { cwd: dir, metaMode: "delta" },
        session2,
      );
      const coverage = await callJson<ScanMetaShape>(
        coverageTool,
        { cwd: dir, metaMode: "delta" },
        session2,
      );
      const propose = await callJson<ScanMetaShape>(proposeConfigTool, { cwd: dir }, session2);
      const listSupp = await callJson<ListSuppressionsMetaShape>(
        listSuppressionsTool,
        { cwd: dir },
        session2,
      );

      const loadedWithOff = scan.meta.rulesEvaluated.loaded;
      expect(loadedWithOff).toBeGreaterThan(0);
      // All scan-family surfaces agree on the same post-off count.
      // `list_suppressions` is excluded — it omits `rulesEvaluated`
      // entirely, so there's nothing to compare; we still pin the
      // omission to catch a regression that re-adds the field.
      expect(checklist.meta.rulesEvaluated.loaded).toBe(loadedWithOff);
      expect(coverage.meta.rulesEvaluated.loaded).toBe(loadedWithOff);
      expect(propose.meta.rulesEvaluated.loaded).toBe(loadedWithOff);
      expect("rulesEvaluated" in listSupp.meta).toBe(false);

      // The off directive must have actually removed one rule from the
      // post-settings count — `list_rules` (raw registry) stays one
      // higher than the scan-surface `loaded`.
      expect(listRules.rules.length - loadedWithOff).toBe(1);
    });
  });

  // Invariant #4: `sessionConfigure.active.ruleCount` agrees with
  // `scan_project.meta.rulesEvaluated.loaded` on the same session.
  //
  // Before V1-SESSION-RULECOUNT-VS-SCAN-RULESLOADED, `sessionConfigure`
  // open-coded its counter as "registry rules whose `satisfies` cites
  // a criterion under the configured standard." That filter excluded
  // rules like `parsing/invalid-id-shape` (cites only `wcag21:4.1.1` —
  // WCAG 2.2 dropped SC 4.1.1) and produced an off-by-one against
  // `scan_project.meta.rulesEvaluated.loaded` on the same session
  // (74 vs 75 in the canonical field report). Per AI-first doctrine,
  // cross-surface counts that name the same concept must agree.
  // Routing the `sessionConfigure` count through `resolveActiveRules`
  // brings it onto the same SSOT every scan-family surface uses.
  it("sessionConfigure.ruleCount agrees with scan_project.rulesEvaluated.loaded", async () => {
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!doctype html><html lang="en"><head><title>Hi</title></head><body></body></html>\n',
      );
      const session = new McpSession();
      const configureResult = await callJson<{
        active: { ruleCount: number };
      }>(findTool("sessionConfigure"), {}, session);
      const scan = await callJson<ScanMetaShape>(scanProjectTool, { cwd: dir }, session);
      expect(configureResult.active.ruleCount).toBe(scan.meta.rulesEvaluated.loaded);
    });
  });
});
