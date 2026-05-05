/**
 * Cross-surface guard: `scan_file` on a minimal CSS fixture containing
 * the canonical `focus/outline-visible` predicate must report
 * `meta.rulesEvaluated.fired >= 1` AND emit at least one finding.
 *
 * The rule's CSS-only path is the canonical 2.4.7 (Focus Visible)
 * failure-pattern detector — `outline: 0` / `outline: none` /
 * `outline-style: none` inside a `:focus` or `:focus-visible` selector,
 * with no replacement indicator in the same rule block. A regression
 * where the rule does not fire on this exact shape produces a
 * `rulesEvaluated.fired: 0` response with zero findings, which an agent
 * reads as "scan ran clean" — the canonical zero-output-success
 * silent-miss failure mode (see ai-first-consumer.md).
 *
 * Pins the end-to-end MCP path (parser → scanner → afterProject hook
 * → response assembly) so a refactor that drops the predicate at any
 * layer surfaces here, complementing the rule's unit tests in
 * `tests/unit/rules/focus/outline-visible.test.ts` which exercise the
 * scanner directly.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

async function mcpSession(
  messages: readonly Record<string, unknown>[],
): Promise<JsonRpcResponse[]> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "--mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: PROJECT_ROOT,
  });
  proc.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  proc.stdin.end();
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

const initMsg = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

const toolCall = (id: number, name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

interface ScanFileBody {
  readonly findings: ReadonlyArray<{ readonly ruleId: string; readonly severity: string }>;
  readonly meta: {
    readonly rulesEvaluated: {
      readonly loaded: number;
      readonly withEligibleInputs?: number;
      readonly fired?: number;
    };
  };
}

function parseBody(resp: JsonRpcResponse | undefined): ScanFileBody {
  const text = resp?.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as ScanFileBody;
}

async function scanFileWithCss(css: string): Promise<ScanFileBody> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-q15-"));
  const cssPath = join(dir, "style.css");
  await writeFile(cssPath, css);
  const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: cssPath })]);
  return parseBody(responses.find((r) => r.id === 2));
}

describe("scan_file pins the focus/outline-visible canonical predicate", () => {
  // Each case is a minimal CSS reproducer for one shape of the predicate
  // the rule names. Anything less than `fired >= 1` here is a silent
  // false-negative — the agent sees "scan ran clean" on a textbook
  // 2.4.7 violation. The rule's severity may resolve to `info` on a
  // bare class-scoped selector with no JSX/HTML evidence in the scan,
  // but a single emission is still required.
  const cases: ReadonlyArray<{ name: string; css: string }> = [
    { name: "outline: 0 inside :focus", css: ".btn:focus { outline: 0 }" },
    { name: "outline: none inside :focus", css: ".btn:focus { outline: none }" },
    {
      name: "outline: 0 inside :focus-visible",
      css: ".btn:focus-visible { outline: 0 }",
    },
    {
      name: "outline: none inside :focus-visible",
      css: ".btn:focus-visible { outline: none }",
    },
    {
      name: "outline-style: none inside :focus",
      css: ".btn:focus { outline-style: none }",
    },
  ];

  for (const { name, css } of cases) {
    it(`fires on ${name}`, async () => {
      const result = await scanFileWithCss(css);
      // The rule must emit at least one finding on this exact shape.
      const ovFindings = result.findings.filter((f) => f.ruleId === "focus/outline-visible");
      expect(ovFindings.length).toBeGreaterThanOrEqual(1);
      // The cross-surface telemetry counter must agree: at least one
      // rule fired in this scan. A `fired: 0` here is the canonical
      // regression Q15 named.
      expect(result.meta.rulesEvaluated.fired).toBeGreaterThanOrEqual(1);
    });
  }
});
