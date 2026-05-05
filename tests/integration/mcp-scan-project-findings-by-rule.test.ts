/**
 * Integration test for the full per-rule count map on
 * `scan_project.plan.findingsByRule`.
 *
 * Three invariants pinned end-to-end through the MCP server:
 *
 *   1. The map is a flat `{[ruleId]: count}` object — one entry per
 *      rule that emitted at least one error/warning finding. Lets an
 *      agent paginating by rule (`scan_file({ruleId})` round-trips,
 *      per-rule fix batches) budget the round-trip cost without
 *      paging through `files[]`.
 *   2. Per-rule counts agree with `plan.topRules` on every overlapping
 *      ruleId — both surfaces filter info-severity findings the same
 *      way, so the cross-surface count invariant holds. `findingsByRule`
 *      additionally carries the long tail `topRules` clips beyond its
 *      default top-10.
 *   3. Sum across `findingsByRule` equals the error+warning total
 *      summed across both `plan.fixesByClass` scan-kinds — the same
 *      cross-surface count invariant `findingsByFile` honors. Without
 *      this equality, an agent reading the per-rule histogram would
 *      get a different denominator from the per-class headline.
 *
 * Why pin this end-to-end: per
 * `docs/kb/architecture/ai-first-consumer.md` "One tool call should
 * answer 'what next?'", the headline must let an agent route triage
 * without paging. A regression that drops the severity filter, drops
 * a rule entry, or silently double-counts under the per-class headline
 * would force the agent into the per-file pagination loop the rollup
 * exists to defeat.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

type JsonRpcResponse = Record<string, unknown>;

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  const payload = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
  proc.stdin.write(payload);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  proc.kill();
  return text
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as JsonRpcResponse);
}

function initMsg(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-agent", version: "1.0" },
    },
  };
}

function toolCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function bodyOf(response: JsonRpcResponse): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

interface TopRule {
  readonly ruleId: string;
  readonly count: number;
}

interface FixesByClassLane {
  readonly source: number;
  readonly buildArtifact: number;
}

interface FixesByClass {
  readonly mechanical: FixesByClassLane;
  readonly guidance: FixesByClassLane;
  readonly runtimeOnly: FixesByClassLane;
  readonly verifyInSource: FixesByClassLane;
  readonly suppressRecommended: FixesByClassLane;
}

function laneTotal(lane: FixesByClassLane): number {
  return lane.source + lane.buildArtifact;
}

function fixesByClassTotal(fbc: FixesByClass): number {
  return (
    laneTotal(fbc.mechanical) +
    laneTotal(fbc.guidance) +
    laneTotal(fbc.runtimeOnly) +
    laneTotal(fbc.verifyInSource) +
    laneTotal(fbc.suppressRecommended)
  );
}

describe("scan_project: plan.findingsByRule full per-rule count map", () => {
  it("emits a flat ruleId→count map covering every rule that fired at least one error/warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-findings-by-rule-"));
    try {
      // Multiple HTML files exercising several rules so the per-rule
      // distribution has multiple entries to walk. `a.html` carries
      // multiple missing-alt violations; `b.html` carries an empty
      // anchor; both inherit the document-shape rules (lang,
      // page-titled, landmark-main, heading-hierarchy) that any HTML
      // envelope fires. The exact rule-set is implementation-defined;
      // the test asserts structural invariants (map is flat, per-rule
      // counts agree with topRules on overlap, sum equals fixesByClass
      // total) rather than fixed absolute counts so a future rule
      // addition won't break the contract.
      writeFileSync(
        join(root, "a.html"),
        '<html><body><img src="1.png"><img src="2.png"></body></html>\n',
      );
      writeFileSync(join(root, "b.html"), '<html><body><a href="/x"></a></body></html>\n');

      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      const findingsByRule = plan["findingsByRule"] as Record<string, number> | undefined;
      expect(findingsByRule).toBeDefined();
      if (!findingsByRule) throw new Error("findingsByRule missing");

      // Every entry value is a positive integer — no zero-count rows
      // (those would be the noise-not-signal shape the helper omits).
      for (const [ruleId, count] of Object.entries(findingsByRule)) {
        expect(typeof ruleId).toBe("string");
        expect(ruleId.length).toBeGreaterThan(0);
        expect(count).toBeGreaterThan(0);
        expect(Number.isInteger(count)).toBe(true);
      }

      // Cross-surface count invariant #1 — per-rule counts agree with
      // `topRules` on every overlapping ruleId. `topRules` is the
      // rank-ordered top-N enriched head; `findingsByRule` is the flat
      // full map. Both filter info-severity findings, so where they
      // overlap the counts must match.
      const topRules = plan["topRules"] as readonly TopRule[] | undefined;
      expect(topRules).toBeDefined();
      if (!topRules) throw new Error("topRules missing");
      for (const entry of topRules) {
        expect(findingsByRule[entry.ruleId]).toBe(entry.count);
      }

      // Cross-surface count invariant #2 — sum across
      // `findingsByRule` equals the error+warning total summed across
      // both `plan.fixesByClass` scan-kinds. Same axis, different
      // shape; the equality is what the doctrine's "Cross-surface
      // count invariant" pins.
      const fixesByClass = plan["fixesByClass"] as FixesByClass | undefined;
      expect(fixesByClass).toBeDefined();
      if (!fixesByClass) throw new Error("fixesByClass missing");
      const sum = Object.values(findingsByRule).reduce((a, b) => a + b, 0);
      expect(sum).toBe(fixesByClassTotal(fixesByClass));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits findingsByRule on a clean scan (no error/warning findings) — present-when-meaningful", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-findings-by-rule-clean-"));
    try {
      // Empty corpus → no findings. The map would be `{}` if emitted —
      // the helper conditional-spreads it out so the agent reading the
      // plan can't confuse "absent" with "no findings"; a clean scan
      // emits no entry, which the agent reads as "no error/warning
      // distribution to budget."
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;
      // No HTML/CSS/JSX in the corpus → no error/warning findings at
      // all. `findingsByRule` is omitted via conditional spread.
      expect(plan["findingsByRule"]).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ships findingsByRule on the summaryOnly: true envelope alongside topRules and findingsByFile", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-findings-by-rule-summary-"));
    try {
      writeFileSync(
        join(root, "a.html"),
        '<html><body><img src="1.png"><img src="2.png"></body></html>\n',
      );
      writeFileSync(join(root, "b.html"), '<html><body><img src="x.png"></body></html>\n');

      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, summaryOnly: true }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);
      // `summaryOnly: true` discriminator is set, and the plan still
      // ships the full per-rule histogram so the agent's first call
      // can budget the per-rule pagination cost without re-issuing.
      expect(body["summaryOnly"]).toBe(true);
      const plan = body["plan"] as Record<string, unknown>;
      const findingsByRule = plan["findingsByRule"] as Record<string, number> | undefined;
      expect(findingsByRule).toBeDefined();
      if (!findingsByRule) throw new Error("findingsByRule missing on summaryOnly response");
      expect(Object.keys(findingsByRule).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
