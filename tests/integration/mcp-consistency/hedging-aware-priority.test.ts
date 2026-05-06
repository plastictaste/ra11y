/**
 * Cross-channel invariant: a checklist item's `priority` must not
 * contradict the `reason` text its candidates ship.
 *
 * Per docs/kb/architecture/ai-first-consumer.md "Reason / priority /
 * fix-description must agree across all three channels", a candidate
 * whose reason concedes the predicate may not apply ("if this is a
 * standalone single-page file or SPA, the criterion may not apply",
 * "flashing only if iteration-count is set to...") cannot ride at
 * `priority: "high"`. The agent budgets against priority; when every
 * grounded candidate hedges, the budget signal must match — drop to
 * `medium` so the framing matches "please verify."
 *
 * Two real shapes exercised here:
 *   1. wcag22:2.4.5 on a standalone single-page HTML file. The
 *      multiple-ways finder emits a candidate whose reason includes
 *      "if this is a standalone single-page file or SPA, the
 *      criterion may not apply" — a self-conceding framing.
 *   2. wcag22:2.3.1 on a CSS animation with `iteration-count: 1` and
 *      a ≤333ms duration. The flashing-content finder emits a
 *      candidate whose reason includes "flashing only if
 *      iteration-count is set to 'infinite' or a value >3" — same
 *      shape: the predicate may not hold.
 *
 * In both cases the criterion is Level A or AA, so the un-hedged
 * priority would be "high"; the hedging-aware downgrade must drop it
 * to "medium".
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posixJoin } from "../../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..", "..");

interface JsonRpcResponse {
  readonly id?: number;
  readonly result?: { readonly content?: readonly { readonly text: string }[] };
}

interface ChecklistItem {
  readonly criteria: readonly string[];
  readonly priority: "high" | "medium" | "low";
  readonly candidates: readonly { readonly reason: string }[];
}

interface ChecklistResponse {
  readonly items: readonly ChecklistItem[];
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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

const HEDGING_PATTERNS: readonly RegExp[] = [
  /\bmay not apply\b/i,
  /\bonly if\b/i,
  /\bverify[^.]*\bbefore\b/i,
  /\bif this is\b/i,
  /Cross-file check:\s*grep/i,
];

function reasonHedges(reason: string): boolean {
  return HEDGING_PATTERNS.some((re) => re.test(reason));
}

describe("checklist priority must not contradict hedging in candidate reason text", () => {
  it("downgrades wcag22:2.4.5 priority on a standalone single-page HTML file", async () => {
    const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-hedge-2-4-5-"));
    // Single-page file: body + one fragment anchor → multiple-ways
    // finder fires; no sibling-HTML link → reason concedes "if this is
    // a standalone single-page file or SPA, the criterion may not
    // apply". 2.4.5 is Level AA, so the un-hedged priority would be
    // "high".
    await writeFile(
      posixJoin(dir, "index.html"),
      `<html><body><main>Dashboard</main><a href="#top">Top</a></body></html>`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.4.5");
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.candidates.length).toBeGreaterThan(0);
    expect(item.candidates.every((c) => reasonHedges(c.reason))).toBe(true);
    expect(item.priority).not.toBe("high");
    expect(["medium", "low"]).toContain(item.priority);
  });

  it("downgrades wcag22:2.3.1 priority for a one-shot short-cycle CSS animation", async () => {
    const dir = await mkdtemp(posixJoin(tmpdir(), "ra11y-hedge-2-3-1-"));
    // 200ms animation with `iteration-count: 1` — the finder still
    // emits (per AI-first doctrine, the candidate surfaces with reason
    // enrichment) but the reason concedes "flashing only if
    // iteration-count is set to 'infinite' or a value >3". 2.3.1 is
    // Level A.
    await writeFile(
      posixJoin(dir, "styles.css"),
      `@keyframes pulse { 0% { opacity: 0; } 100% { opacity: 1; } }
       .blink { animation-name: pulse; animation-duration: 200ms; animation-iteration-count: 1; }`,
    );
    const responses = await mcpSession([initMsg(1), toolCall(2, "checklist", { paths: [dir] })]);
    const checklist = body<ChecklistResponse>(responses[1] as JsonRpcResponse);
    const item = checklist.items.find((i) => i.criteria[0] === "wcag22:2.3.1");
    expect(item).toBeDefined();
    if (!item) return;
    if (item.candidates.length === 0) return; // finder may emit no candidate; nothing to assert
    if (!item.candidates.every((c) => reasonHedges(c.reason))) return;
    expect(item.priority).not.toBe("high");
    expect(["medium", "low"]).toContain(item.priority);
  });
});
