/**
 * Integration test for `plan.topRules[].fixClass` cross-surface parity.
 *
 * The cross-surface invariant: when `plan.fixesByClass.<lane>` advertises
 * a positive count, at least one entry on `plan.topRules[]` must carry
 * `fixClass: "<lane>"`. The per-rule axis on `topRules` partitions the
 * per-class plan tally so an agent reading the headline can reach the
 * dominant rules in each remediation lane without paging through
 * `files[]` or `referenceGuide.fixDescriptions`.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-call shape must
 * agree with per-class plan tally": when a headline counter advertises
 * a count, the per-call surface must let the agent reach those
 * findings from the headline. The previous shape advertised
 * `plan.fixesByClass.mechanical: N` while `referenceGuide.fixDescriptions`
 * only enumerated rules tagged `fixClass: "verify-in-source"` and
 * `plan.topRules[]` carried no fixClass attribution at all — N
 * mechanical findings were unverifiable from the response shape alone.
 *
 * The test runs through the full MCP server (stdio JSON-RPC) so the
 * assertion exercises the entire response-assembly path —
 * `runScanAndFormat` → `countFixesByClass` → `withTopRules` (which
 * propagates the per-finding `fixClass` stamp into the per-rule
 * rollup) → `assembleScanProjectResponse`.
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

interface Lane {
  readonly source: number;
  readonly buildArtifact: number;
}

interface FixesByClass {
  readonly mechanical: Lane;
  readonly guidance: Lane;
  readonly runtimeOnly: Lane;
  readonly verifyInSource: Lane;
}

interface TopRule {
  readonly ruleId: string;
  readonly count: number;
  readonly topFile?: string;
  readonly fixClass?: string;
}

function laneTotal(lane: Lane): number {
  return lane.source + lane.buildArtifact;
}

describe("scan_project: topRules fixClass partitions the per-class plan tally", () => {
  it("each populated `fixesByClass` lane has at least one matching topRules entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-top-rules-fix-class-"));
    try {
      // Authored HTML — invalid `role="buton"` (typo) fires
      // `aria/invalid-role` which is `fixClass: "mechanical"`. The
      // `<img>` without `alt` is `verify-in-source`. Two distinct
      // remediation lanes share one fixture so the parity check has
      // multiple lanes to partition.
      writeFileSync(
        join(root, "page.html"),
        '<html><body><img src="hero.png"><div role="buton" tabindex="0">Save</div></body></html>\n',
      );
      // Authored CSS — black-on-grey contrast is a guidance-lane
      // finding (the rule ships prose guidance, no inline edit).
      writeFileSync(
        join(root, "site.css"),
        ".muted { color: #555555; background-color: #4a4a4a; }\n",
      );
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);
      const plan = body.plan as Record<string, unknown>;

      const fixesByClass = plan["fixesByClass"] as FixesByClass | undefined;
      const topRules = plan["topRules"] as readonly TopRule[] | undefined;
      expect(fixesByClass).toBeDefined();
      expect(topRules).toBeDefined();
      if (!fixesByClass || !topRules) throw new Error("fixesByClass or topRules missing");

      // Every populated lane must have at least one topRules entry
      // carrying that fixClass attribution. The agent reads the
      // per-class headline tally then partitions topRules to identify
      // the dominant rules in each lane — without this attribution,
      // a headline counter like `mechanical: 14` is unverifiable from
      // the response shape alone (the regression Q13 closed).
      const lanesWithFindings: { lane: keyof FixesByClass; fixClass: string }[] = [
        { lane: "mechanical", fixClass: "mechanical" },
        { lane: "guidance", fixClass: "guidance" },
        { lane: "runtimeOnly", fixClass: "runtime-only" },
        { lane: "verifyInSource", fixClass: "verify-in-source" },
      ];
      for (const { lane, fixClass } of lanesWithFindings) {
        if (laneTotal(fixesByClass[lane]) === 0) continue;
        const matching = topRules.filter((r) => r.fixClass === fixClass);
        expect(matching.length).toBeGreaterThan(0);
      }

      // Both lanes carry findings in this fixture — sanity that the
      // attribution check above isn't passing vacuously.
      expect(laneTotal(fixesByClass.mechanical)).toBeGreaterThan(0);
      expect(laneTotal(fixesByClass.guidance)).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
