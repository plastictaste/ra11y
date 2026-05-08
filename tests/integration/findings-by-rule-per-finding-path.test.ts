/**
 * Integration test: every finding emitted by `findings_by_rule` carries
 * a populated `path` field naming the file the finding lives in.
 *
 * Field report (CSS-framework documentation corpus): `findings_by_rule`
 * shipped per-finding entries with `path: null` across multiple rule
 * probes. `line` and `snippet` were populated; only the file address
 * was missing — leaving the agent with line numbers but no anchor for
 * `suggest_fix` and no source-level pragma target. Per AI-first
 * doctrine "Per-finding identifiers must be addressable, not collision-
 * prone" (`docs/kb/architecture/ai-first-consumer.md`), a per-finding
 * shape must answer "where does this finding live?" in one read.
 *
 * The fixture at `tests/fixtures/real-world/findings-by-rule-null-path/`
 * provides the sanitized HTML source; this test drives the live MCP
 * tool against it and asserts:
 *
 *   1. Every finding carries a `path` field (string, non-empty).
 *   2. The `path` resolves to a real file on disk under the fixture
 *      source root.
 *   3. The shape uses `path` (not `file`) — matching `AgentFile.path`
 *      and the rest of the codebase's per-finding addressing
 *      convention, per "Sibling fields naming the same concept must
 *      use one shape."
 */

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { posixJoin } from "../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..");
const FIXTURE_ROOT = posixJoin(
  PROJECT_ROOT,
  "tests",
  "fixtures",
  "real-world",
  "findings-by-rule-null-path",
  "source",
);

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

describe("findings_by_rule: per-finding path is populated and addressable", () => {
  it("emits a non-null `path` field on every finding that resolves to a real file", async () => {
    // Sanity guard: the fixture must exist on disk. If someone moves
    // or renames the fixture, the test fails loudly here rather than
    // silently shipping an empty findings list.
    expect(existsSync(FIXTURE_ROOT)).toBe(true);

    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "findings_by_rule", {
        ruleId: "navigation/href-empty-fragment",
        cwd: FIXTURE_ROOT,
      }),
    ]);
    const drill = responses.find((r) => r.id === 2);
    expect(drill).toBeDefined();
    const body = bodyOf(drill as JsonRpcResponse);

    // The fixture has three <a href="#"> anchors so the per-rule walk
    // must surface multiple findings — guarding that the field report's
    // canonical workflow ("findings_by_rule reveals N findings, agent
    // routes to suggest_fix on each") has more than one entry to walk.
    const findings = body["findings"] as readonly Record<string, unknown>[] | undefined;
    expect(findings).toBeDefined();
    if (!findings) throw new Error("findings missing on response");
    expect(findings.length).toBeGreaterThanOrEqual(3);

    for (const f of findings) {
      // Per AI-first doctrine: the shape must use `path` (matching
      // `AgentFile.path` and the rest of the codebase's per-finding
      // addressing convention). The bug report observed `path: null`
      // on every entry; this assertion is the regression guard.
      expect(f).toHaveProperty("path");
      const path = f["path"];
      expect(typeof path).toBe("string");
      expect((path as string).length).toBeGreaterThan(0);
      // The path must resolve to a real file on disk — the agent's
      // canonical use is "read this file to triage the finding."
      // Without this guard, a populated-but-bogus string would pass
      // the type check while still leaving the agent unable to read.
      expect(existsSync(path as string)).toBe(true);
    }
  });
});
