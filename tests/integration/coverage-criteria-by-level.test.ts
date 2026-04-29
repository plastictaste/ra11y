/**
 * Invariant: `coverage` tool's `criteriaTotalForProfile` equals the sum
 * of values in the sibling `criteriaByLevel` map.
 *
 * The rename from the bare `criteriaTotal` was driven by the
 * "Ambiguous field shapes are dishonest" doctrine in
 * `docs/kb/architecture/ai-first-consumer.md`: an unanchored counter
 * could over-count or under-count relative to the conformance level
 * the agent asked for, with no way to verify the shape from the
 * response. The sibling `criteriaByLevel` is the anchor — its values
 * sum to `criteriaTotalForProfile` exactly, by construction. This test
 * pins that equality so a future refactor that populates one without
 * the other (or filters one map but not the other under a `level`
 * narrowing) fails loudly.
 *
 * Verified at WCAG 2.2 default level (which materializes both `A` and
 * `AA` keys) and at level `A` (which narrows to a single key) — the
 * narrowing path is the one most likely to drift if the per-level tally
 * is computed from the unfiltered source standard.
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

function body<T>(resp: JsonRpcResponse): T {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as T;
}

interface CoverageBody {
  readonly standardId: string;
  readonly criteriaTotalForProfile: number;
  readonly criteriaByLevel: Record<string, number>;
}

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-criteria-by-level-"));
  await writeFile(join(dir, "page.html"), "<html><body><p>hello</p></body></html>");
  return dir;
}

describe("coverage tool: criteriaByLevel sums to criteriaTotalForProfile", () => {
  it("default level (AA) — sum of per-level values equals the headline", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir, standard: "wcag22" }),
    ]);
    const data = body<CoverageBody>(responses[1]);

    expect(data.standardId).toBe("wcag22");
    expect(data.criteriaTotalForProfile).toBeGreaterThan(0);
    // Per-level map is populated and uses level keys WCAG declares.
    const keys = Object.keys(data.criteriaByLevel);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k === "A" || k === "AA" || k === "AAA")).toBe(true);
    // At default level "AA" the filtered standard contains both A and
    // AA criteria — both keys must be populated.
    expect(typeof data.criteriaByLevel["A"]).toBe("number");
    expect(typeof data.criteriaByLevel["AA"]).toBe("number");
    expect(data.criteriaByLevel["A"]).toBeGreaterThan(0);
    expect(data.criteriaByLevel["AA"]).toBeGreaterThan(0);
    // AAA is filtered out at the default scope.
    expect(data.criteriaByLevel["AAA"]).toBeUndefined();

    const sum = Object.values(data.criteriaByLevel).reduce((a, b) => a + b, 0);
    expect(sum).toBe(data.criteriaTotalForProfile);
  });

  it("level=A narrows criteriaByLevel to the single A bucket and the sum still holds", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir, standard: "wcag22", level: "A" }),
    ]);
    const data = body<CoverageBody>(responses[1]);

    expect(data.standardId).toBe("wcag22");
    // The A-only narrowing must drop AA / AAA keys entirely
    // (present-when-meaningful — no zero-sentinel buckets per
    // doctrine).
    expect(Object.keys(data.criteriaByLevel)).toEqual(["A"]);
    expect(data.criteriaByLevel["A"]).toBe(data.criteriaTotalForProfile);

    const sum = Object.values(data.criteriaByLevel).reduce((a, b) => a + b, 0);
    expect(sum).toBe(data.criteriaTotalForProfile);
  });

  it("level=AAA includes all three keys and the sum still holds", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "coverage", { cwd: dir, standard: "wcag22", level: "AAA" }),
    ]);
    const data = body<CoverageBody>(responses[1]);

    expect(data.standardId).toBe("wcag22");
    const keys = Object.keys(data.criteriaByLevel).sort();
    expect(keys).toEqual(["A", "AA", "AAA"]);
    expect(data.criteriaByLevel["A"]).toBeGreaterThan(0);
    expect(data.criteriaByLevel["AA"]).toBeGreaterThan(0);
    expect(data.criteriaByLevel["AAA"]).toBeGreaterThan(0);

    const sum = Object.values(data.criteriaByLevel).reduce((a, b) => a + b, 0);
    expect(sum).toBe(data.criteriaTotalForProfile);
  });
});
