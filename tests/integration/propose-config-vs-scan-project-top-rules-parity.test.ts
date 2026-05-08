/**
 * Integration test: `propose_config.suggestedConfig` per-rule comment
 * counts agree with `scan_project.plan.topRules[].count` on identical
 * input.
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Cross-surface
 * count invariant." When the same conceptual counter ships from two
 * project-rooted tools on the same input — the per-rule finding count
 * — the values must agree. Drift is silent: an agent reading the
 * bootstrap response budgets against `suggestedConfig`'s comment, the
 * subsequent `scan_project` returns a different per-rule count, and the
 * disagreement only surfaces by chance.
 *
 * Pre-fix observation: `propose_config` called `runScan` directly,
 * skipping the post-scan filter chain `runScanAndFormat` runs
 * (severity filter dropping info-severity findings, wrapper-noise
 * drop, vendor-CSS dedup, criterion skip). `scan_project.plan.topRules`
 * is computed from `formatted.files` AFTER those filters apply, so the
 * two counts diverged on any corpus where any of those lanes carried
 * non-zero findings. The closure routes `propose_config` through the
 * same `runScanAndFormat` + `computeTopRules` helper pair.
 *
 * Tests drive the handlers directly (no MCP subprocess) so failures
 * point at the count predicate without a transport-overhead delta.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../src/mcp/session.ts";
import { proposeConfigTool } from "../../src/mcp/tool-propose-config.ts";
import { scanProjectTool } from "../../src/mcp/tool-scan-project.ts";

interface ProposeConfigResponseLike {
  readonly suggestedConfig: string;
}

interface ScanProjectResponseLike {
  readonly plan?: {
    readonly topRules?: readonly { readonly ruleId: string; readonly count: number }[];
  };
}

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-propose-vs-scan-toprules-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Parses every `'<ruleId>': '<severity>', // N findings` comment line
 * out of the `suggestedConfig` rules-stub block. Returns a Map keyed
 * by ruleId so the test can pin the equality. Tolerant of singular
 * "1 finding" form (the emitter pluralizes).
 */
function parseRuleCounts(suggestedConfig: string): Map<string, number> {
  const out = new Map<string, number>();
  const lineRe = /\/\/\s*"([^"]+)":\s*"[^"]+",?\s*\/\/\s*(\d+)\s+finding/g;
  for (const match of suggestedConfig.matchAll(lineRe)) {
    const ruleId = match[1];
    const count = match[2];
    if (ruleId !== undefined && count !== undefined) {
      out.set(ruleId, Number.parseInt(count, 10));
    }
  }
  return out;
}

async function callProposeConfig(dir: string): Promise<ProposeConfigResponseLike> {
  const session = new McpSession();
  const result = await proposeConfigTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as ProposeConfigResponseLike;
}

async function callScanProject(dir: string): Promise<ScanProjectResponseLike> {
  const session = new McpSession();
  const result = await scanProjectTool.handler({ cwd: dir }, session);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? "{}") as ScanProjectResponseLike;
}

describe("propose_config vs scan_project: per-rule count parity", () => {
  it("emits the same per-rule counts on a corpus with multiple firing rules", async () => {
    await withScratch(async (dir) => {
      // Corpus seeds three rules: missing alt, missing label, missing
      // lang. Each fires multiple times so the per-rule counts are
      // not all 1 (counts of 1 would silently agree even on a
      // double-counting bug).
      await writeFile(
        join(dir, "a.html"),
        "<!DOCTYPE html><html><head></head><body>" +
          '<img src="/a.png"><img src="/b.png"><img src="/c.png">' +
          '<input type="text"><input type="text">' +
          "</body></html>\n",
      );
      await writeFile(
        join(dir, "b.html"),
        "<!DOCTYPE html><html><head></head><body>" +
          '<img src="/d.png"><img src="/e.png">' +
          "</body></html>\n",
      );
      const propose = await callProposeConfig(dir);
      const scan = await callScanProject(dir);
      const proposeCounts = parseRuleCounts(propose.suggestedConfig);
      const scanTopRules = scan.plan?.topRules ?? [];
      // Build a {ruleId: count} map from scan_project's topRules so
      // the parity assertion can lookup by id rather than by index
      // (scan_project ranks top-10; propose_config emits top-3).
      const scanCounts = new Map<string, number>();
      for (const entry of scanTopRules) scanCounts.set(entry.ruleId, entry.count);
      // Sanity: both surfaces saw at least one firing rule. Without
      // this, a regression that empties both sides would pass the
      // equality assertion vacuously.
      expect(proposeCounts.size).toBeGreaterThan(0);
      expect(scanCounts.size).toBeGreaterThan(0);
      // Every rule that lands in propose_config's top-3 stub must
      // appear in scan_project's top-10 with the same count. The
      // reverse is not required (scan ships up to 10, propose ships
      // up to 3 — the long tail can disagree on membership without
      // disagreeing on count).
      for (const [ruleId, count] of proposeCounts) {
        expect(scanCounts.has(ruleId)).toBe(true);
        expect(scanCounts.get(ruleId)).toBe(count);
      }
    });
  });

  it("emits empty counts when the scan is clean — both surfaces agree on zero firing rules", async () => {
    // Negative case: a clean codebase produces no rule counts on
    // either surface. Pin the agreement on the empty-set so a
    // regression that silently re-introduces info-severity findings
    // on one side surfaces here.
    await withScratch(async (dir) => {
      await writeFile(
        join(dir, "index.html"),
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Hello</title></head><body><p>content</p></body></html>\n',
      );
      const propose = await callProposeConfig(dir);
      const scan = await callScanProject(dir);
      const proposeCounts = parseRuleCounts(propose.suggestedConfig);
      const scanTopRules = scan.plan?.topRules ?? [];
      expect(proposeCounts.size).toBe(0);
      expect(scanTopRules.length).toBe(0);
    });
  });
});
