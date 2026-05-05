/**
 * Integration test for the `audit_rule_coverage` MCP tool.
 *
 * Three invariants pinned end-to-end through the MCP server:
 *
 *   1. When a rule's extension gate matches AND the file emits a
 *      finding from that rule, the response reports `fired: true,
 *      eligibleByExtension: true, predicateMissed: false`. The next
 *      step routes to `findings_by_rule` so the agent can drill into
 *      every emission.
 *   2. When a rule's extension gate matches BUT the file emits no
 *      finding from that rule, the response reports `fired: false,
 *      eligibleByExtension: true, predicateMissed: true`. The next
 *      step routes to `scan_file({ verboseMeta: true })` so the agent
 *      reads the cited file and verifies whether the rule's predicate
 *      is missing this case.
 *   3. When a rule's extension gate does NOT match the file, the
 *      response reports `eligibleByExtension: false, fired: false,
 *      predicateMissed: false`. The next step routes to `explain_rule`
 *      so the agent picks a different rule or file.
 *
 * Why pin this end-to-end: this is a new tool surface designed to
 * collapse a multi-call false-negative investigation into one call.
 * The contract — the deterministic two-axis (eligibility, emission)
 * answer plus a state-matched `nextStep` — is exactly what an agent
 * triaging a missing emission relies on. A regression that flipped one
 * of the booleans, or routed `nextStep` to the wrong tool for a given
 * state, would silently mis-budget the agent's investigation.
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

interface NextStepStructured {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

describe("audit_rule_coverage: deterministic eligibility + emission probe", () => {
  it("reports fired=true when the rule emits a finding on the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-audit-rule-coverage-fired-"));
    try {
      // An <img> with no alt attribute reliably trips
      // `media/alt-text-missing` on HTML — the canonical mechanical-fix
      // case for the canonical text-source extension.
      const filePath = join(root, "page.html");
      writeFileSync(filePath, '<html><body><img src="x.png"></body></html>\n');

      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "audit_rule_coverage", {
          ruleId: "media/alt-text-missing",
          file: filePath,
          cwd: root,
        }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      expect(drill).toBeDefined();
      const body = bodyOf(drill as JsonRpcResponse);

      expect(body["ruleId"]).toBe("media/alt-text-missing");
      expect(body["fired"]).toBe(true);
      expect(body["eligibleByExtension"]).toBe(true);
      expect(body["predicateMissed"]).toBe(false);

      // nextStep routes to findings_by_rule per the doctrine "One tool
      // call should answer 'what next?'" — the agent's natural drill-in
      // for the fired case.
      const nextStepStructured = body["nextStepStructured"] as NextStepStructured | undefined;
      expect(nextStepStructured).toBeDefined();
      if (nextStepStructured) {
        expect(nextStepStructured.tool).toBe("findings_by_rule");
        expect(nextStepStructured.args["ruleId"]).toBe("media/alt-text-missing");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports predicateMissed=true when the rule is eligible but emits nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-audit-rule-coverage-missed-"));
    try {
      // Clean HTML — no accessibility issues. `media/alt-text-missing`
      // is eligible by extension (.html ∈ rule.appliesTo.fileExtensions)
      // but emits no finding because the file is clean. The
      // `predicateMissed` axis exists exactly for this case: the agent
      // can now distinguish "rule never ran" from "rule ran clean."
      const filePath = join(root, "page.html");
      writeFileSync(
        filePath,
        '<html lang="en"><head><title>OK</title></head><body><main>hi</main></body></html>\n',
      );

      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "audit_rule_coverage", {
          ruleId: "media/alt-text-missing",
          file: filePath,
          cwd: root,
        }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      const body = bodyOf(drill as JsonRpcResponse);

      expect(body["fired"]).toBe(false);
      expect(body["eligibleByExtension"]).toBe(true);
      expect(body["predicateMissed"]).toBe(true);

      // nextStep routes to scan_file with verboseMeta=true so the agent
      // can investigate the rule's coverage row inline. The cited path
      // is the absolute version (the tool resolves relative inputs to
      // absolute for the next-step recommendation).
      const nextStepStructured = body["nextStepStructured"] as NextStepStructured | undefined;
      expect(nextStepStructured).toBeDefined();
      if (nextStepStructured) {
        expect(nextStepStructured.tool).toBe("scan_file");
        expect(nextStepStructured.args["verboseMeta"]).toBe(true);
        expect(typeof nextStepStructured.args["path"]).toBe("string");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports eligibleByExtension=false when the rule's extension gate excludes the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-audit-rule-coverage-extmiss-"));
    try {
      // `.css` file paired with an HTML-scoped rule. The rule's
      // `appliesTo.fileExtensions` excludes `.css` outright, so the
      // tool reports `eligibleByExtension: false` without any
      // false-negative implication — there's nothing to investigate.
      const filePath = join(root, "styles.css");
      writeFileSync(filePath, ".btn { color: red; }\n");

      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "audit_rule_coverage", {
          ruleId: "media/alt-text-missing",
          file: filePath,
          cwd: root,
        }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      const body = bodyOf(drill as JsonRpcResponse);

      expect(body["fired"]).toBe(false);
      expect(body["eligibleByExtension"]).toBe(false);
      expect(body["predicateMissed"]).toBe(false);

      // nextStep routes to explain_rule so the agent can confirm the
      // rule's documented scope before picking a different rule or
      // file.
      const nextStepStructured = body["nextStepStructured"] as NextStepStructured | undefined;
      expect(nextStepStructured).toBeDefined();
      if (nextStepStructured) {
        expect(nextStepStructured.tool).toBe("explain_rule");
        expect(nextStepStructured.args["ruleId"]).toBe("media/alt-text-missing");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns rule-not-found for an unknown ruleId rather than a silent zero-result envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-audit-rule-coverage-unknown-"));
    try {
      const filePath = join(root, "page.html");
      writeFileSync(filePath, "<html><body></body></html>\n");

      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "audit_rule_coverage", {
          ruleId: "definitely-not-a-real-rule",
          file: filePath,
          cwd: root,
        }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      expect(drill).toBeDefined();
      const result = (drill as JsonRpcResponse).result as { isError?: boolean };
      expect(result.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns file-not-found when the file path does not exist on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "ra11y-audit-rule-coverage-missing-"));
    try {
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "audit_rule_coverage", {
          ruleId: "media/alt-text-missing",
          file: join(root, "nope.html"),
          cwd: root,
        }),
      ]);
      const drill = responses.find((r) => r.id === 2);
      const result = (drill as JsonRpcResponse).result as { isError?: boolean };
      expect(result.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
