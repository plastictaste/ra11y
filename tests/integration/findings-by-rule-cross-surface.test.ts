/**
 * Integration test for the `findings_by_rule` MCP tool.
 *
 * Three invariants pinned end-to-end through the MCP server:
 *
 *   1. The cross-surface count invariant — `totalFindings` from
 *      `findings_by_rule({ ruleId, cwd })` equals
 *      `scan_project({ cwd }).plan.findingsByRule[ruleId]` for the
 *      same input. Both surfaces filter info-severity findings the
 *      same way, so the counts must agree per
 *      `docs/kb/architecture/ai-first-consumer.md` "Cross-surface
 *      count invariant."
 *   2. Per-finding shape parity — every finding in the flat
 *      `findings[]` mirrors the per-finding shape `scan_project`
 *      emits under `files[].findings[]` (same `findingId`, `ruleId`,
 *      `criteria`, `severity`, `line`, `column`). The flat envelope
 *      adds a top-level `file` field naming the relative path so the
 *      agent can route into `suggest_fix` without walking back through
 *      a parent.
 *   3. Zero-output success carries a structured warning — calling on
 *      a cwd with no parseable files emits `scanned_zero_files`,
 *      distinguishing "tool ran on nothing" from "rule has zero
 *      findings on a real corpus" per "Zero-output success is
 *      ambiguous failure."
 *
 * Why pin this end-to-end: the tool exists to replace N paginated
 * `scan_project` calls with one. If the count invariant drifts, the
 * agent reading `findingsByRule[ruleId]` first and budgeting against
 * it gets a different number than `findings_by_rule` returns —
 * silent miss per the doctrine.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..");

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

interface FindingShape {
  readonly findingId: string;
  readonly ruleId: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: string;
  readonly criteria: readonly string[];
}

describe("findings_by_rule: cross-surface count + per-finding shape parity", () => {
  it("returns every finding for a single rule across the project, agreeing with scan_project.plan.findingsByRule", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-findings-by-rule-tool-"));
    try {
      // Multiple HTML files exercising several rules so the per-rule
      // distribution has multiple entries to walk. Three files with
      // missing-alt findings + an empty anchor exercises a handful of
      // rules concurrently — the test asserts structural invariants
      // (count parity, shape parity) rather than fixed absolute counts
      // so a future rule addition won't break the contract.
      writeFileSync(
        posixJoin(root, "a.html"),
        '<html><body><img src="1.png"><img src="2.png"></body></html>\n',
      );
      writeFileSync(
        posixJoin(root, "b.html"),
        '<html><body><img src="3.png"><img src="4.png"></body></html>\n',
      );
      writeFileSync(posixJoin(root, "c.html"), '<html><body><a href="/x"></a></body></html>\n');

      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const scanBody = bodyOf(scan as JsonRpcResponse);
      const plan = scanBody.plan as Record<string, unknown>;
      const findingsByRule = plan["findingsByRule"] as Record<string, number> | undefined;
      expect(findingsByRule).toBeDefined();
      if (!findingsByRule) throw new Error("findingsByRule missing on scan_project response");

      // Pick the rule with the most findings — drilling in via
      // `findings_by_rule` is the canonical workflow per the tool's
      // pairing description.
      const ruleEntries = Object.entries(findingsByRule);
      expect(ruleEntries.length).toBeGreaterThan(0);
      ruleEntries.sort(([, a], [, b]) => b - a);
      const [topRuleId, expectedCount] = ruleEntries[0];

      const drillResponses = await mcpSession([
        initMsg(1),
        toolCall(2, "findings_by_rule", { ruleId: topRuleId, cwd: root }),
      ]);
      const drill = drillResponses.find((r) => r.id === 2);
      expect(drill).toBeDefined();
      const drillBody = bodyOf(drill as JsonRpcResponse);

      // Cross-surface count invariant — findings_by_rule.totalFindings
      // === scan_project.plan.findingsByRule[ruleId].
      expect(drillBody["ruleId"]).toBe(topRuleId);
      expect(drillBody["totalFindings"]).toBe(expectedCount);
      const findings = drillBody["findings"] as readonly FindingShape[];
      expect(findings.length).toBe(expectedCount);

      // Per-finding shape parity — each entry carries the canonical
      // per-finding fields plus a top-level `path` for routing. The
      // address field name is `path` (mirroring `AgentFile.path`) per
      // `docs/kb/architecture/ai-first-consumer.md` "Sibling fields
      // naming the same concept must use one shape."
      for (const f of findings) {
        expect(typeof f.findingId).toBe("string");
        expect(f.findingId.length).toBeGreaterThan(0);
        expect(f.ruleId).toBe(topRuleId);
        expect(typeof f.path).toBe("string");
        expect(f.path.length).toBeGreaterThan(0);
        expect(typeof f.line).toBe("number");
        expect(f.line).toBeGreaterThan(0);
        expect(typeof f.severity).toBe("string");
        // Info-severity findings are filtered out by the same predicate
        // `computeFindingsByRule` applies, so the cross-surface count
        // agrees.
        expect(f.severity).not.toBe("info");
        expect(Array.isArray(f.criteria)).toBe(true);
      }

      // Findings carry distinct findingIds (per-emission addressability
      // per `docs/kb/architecture/ai-first-consumer.md` "Per-finding
      // identifiers must be addressable, not collision-prone").
      const ids = new Set(findings.map((f) => f.findingId));
      expect(ids.size).toBe(findings.length);

      // nextStep + nextStepStructured ride together when populated, per
      // the conditional-spread doctrine.
      expect(typeof drillBody["nextStep"]).toBe("string");
      expect(drillBody["nextStepStructured"]).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a `scanned_zero_files` warning when called on a cwd with no parseable files", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-findings-by-rule-empty-"));
    try {
      // Empty corpus — the tool ran but had nothing to scan. Per
      // `docs/kb/architecture/ai-first-consumer.md` "Zero-output
      // success is ambiguous failure," the warning makes the empty
      // result distinguishable from "rule clean on a real corpus."
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "findings_by_rule", { ruleId: "media/alt-text-missing", cwd: root }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      const body = bodyOf(drill as JsonRpcResponse);
      expect(body["totalFindings"]).toBe(0);
      const findings = body["findings"] as readonly unknown[];
      expect(findings.length).toBe(0);
      const warnings = body["warnings"] as readonly string[] | undefined;
      expect(warnings).toBeDefined();
      if (!warnings) throw new Error("warnings missing on zero-files response");
      expect(warnings).toContain("scanned_zero_files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns rule-not-found for an unknown ruleId rather than a silent zero-results envelope", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-findings-by-rule-unknown-"));
    try {
      writeFileSync(posixJoin(root, "a.html"), "<html><body></body></html>\n");
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "findings_by_rule", {
          ruleId: "definitely-not-a-real-rule",
          cwd: root,
        }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      // Structured error envelope — surface, don't suppress.
      expect(drill).toBeDefined();
      const result = (drill as JsonRpcResponse).result as { isError?: boolean };
      expect(result.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
