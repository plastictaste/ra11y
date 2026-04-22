/**
 * Cross-tool invariant: VPAT rows honor the scan's conformance level.
 *
 * Q-SHARED-VPAT-HONESTY-PACK fix (2): when `vpat` runs against a scan
 * at level AA (the session default), every evaluated VPAT entry —
 * i.e. an entry whose `evidenceStatus` is NOT `"out-of-scope"` — must
 * reference a criterion whose own level is ≤ AA. AAA-only criteria
 * appear in the response as `Not Applicable` with
 * `evidenceStatus: "out-of-scope"` and a remark citing the scan level.
 *
 * The pre-fix shape collapsed AAA criteria into `Not Evaluated`
 * alongside un-evaluated manual ones — three categorically different
 * kinds of "we didn't check" under one headline count. That ambiguity
 * is what this invariant test guards against.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

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

async function makeFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-vpat-scope-invariant-"));
  await writeFile(
    join(dir, "page.html"),
    `<!DOCTYPE html>
<html lang="en"><body><h1>OK</h1><p>Content</p></body></html>
`,
  );
  return dir;
}

interface VpatEntryBody {
  readonly criterionId: string;
  readonly level: string;
  readonly conformance: string;
  readonly evidenceStatus?: "out-of-scope" | "untested";
}
interface VpatStandardBody {
  readonly standardId: string;
  readonly entries: readonly VpatEntryBody[];
  readonly summary: {
    readonly outOfScope: number;
    readonly untested: number;
  };
}
interface VpatBody {
  readonly evaluator: { readonly name: string; readonly scanLevel?: "A" | "AA" | "AAA" };
  readonly standards: readonly VpatStandardBody[];
}

describe("Q-SHARED-VPAT-HONESTY-PACK — VPAT rows respect scan level", () => {
  it("AA scan produces out-of-scope rows for AAA criteria with evidenceStatus set", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        cwd: dir,
        productName: "Test",
        productVersion: "0.0.1",
        level: "AA",
      }),
    ]);
    const v = body<VpatBody>(responses[1]);
    expect(v.evaluator.scanLevel).toBe("AA");
    const wcag22 = v.standards.find((s) => s.standardId === "wcag22");
    expect(wcag22).toBeDefined();
    if (!wcag22) return;
    // The invariant: every evaluated entry (not out-of-scope) must be
    // at a level ≤ scanLevel. Out-of-scope entries must be exactly
    // those above scanLevel.
    for (const entry of wcag22.entries) {
      if (entry.evidenceStatus === "out-of-scope") {
        expect(entry.level).toBe("AAA");
        expect(entry.conformance).toBe("Not Applicable");
      } else {
        expect(["A", "AA"]).toContain(entry.level);
      }
    }
    // At least one AAA criterion must route to out-of-scope — if this
    // count drops to zero, the scope-routing isn't doing anything.
    expect(wcag22.summary.outOfScope).toBeGreaterThan(0);
  });

  it("AAA scan produces zero out-of-scope rows (everything is in scope)", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        cwd: dir,
        productName: "Test",
        productVersion: "0.0.1",
        level: "AAA",
      }),
    ]);
    const v = body<VpatBody>(responses[1]);
    expect(v.evaluator.scanLevel).toBe("AAA");
    for (const section of v.standards) {
      expect(section.summary.outOfScope).toBe(0);
      for (const entry of section.entries) {
        expect(entry.evidenceStatus).not.toBe("out-of-scope");
      }
    }
  });

  it("A scan routes both AA and AAA criteria to out-of-scope", async () => {
    const dir = await makeFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "vpat", {
        cwd: dir,
        productName: "Test",
        productVersion: "0.0.1",
        level: "A",
      }),
    ]);
    const v = body<VpatBody>(responses[1]);
    expect(v.evaluator.scanLevel).toBe("A");
    const wcag22 = v.standards.find((s) => s.standardId === "wcag22");
    expect(wcag22).toBeDefined();
    if (!wcag22) return;
    for (const entry of wcag22.entries) {
      if (entry.evidenceStatus === "out-of-scope") {
        expect(["AA", "AAA"]).toContain(entry.level);
      } else {
        expect(entry.level).toBe("A");
      }
    }
  });
});
