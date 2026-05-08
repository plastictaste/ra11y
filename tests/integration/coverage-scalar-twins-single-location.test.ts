/**
 * Cross-field-redundancy invariant for the `coverage` response: the
 * four conceptual scalars below must each appear at exactly one
 * location on the response, never twin-shipped at both top-level and
 * nested under `summary.*` / `meta.*`.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Sibling fields
 * naming the same concept must use one shape": shipping the same
 * scalar at two locations forces an agent reading the response to
 * silently reconcile which is canonical, and the failure mode is the
 * canonical "cross-field-redundancy axis" the doctrine warns against.
 *
 * Pre-closure, the coverage response shipped four scalar pairs at
 * both top-level and nested locations:
 *
 *   - `manualCandidateEmissionsTotal`            ↔ `summary.actionable.emissionsTotal`
 *   - `automatedCriteriaPassRate`                ↔ `summary.automatedCoverage.automatedCriteriaPassRate`
 *   - `untargetedCriteriaForProject`             ↔ `summary.untargetedCriteriaForProject`
 *   - `scanned`                                  ↔ `meta.scanned`
 *
 * Closure: drop the top-level twin in each pair; keep the nested
 * canonical location. This test pins that single-location property so
 * a future regression cannot silently re-introduce the duplication.
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

function body(resp: JsonRpcResponse): Record<string, unknown> {
  const text = resp.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool result text");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Builds a fixture with at least one parseable file so the response
 * carries populated `summary.automatedCoverage.automatedCriteriaPassRate`
 * (it's omitted under present-when-meaningful on a zero-file scan).
 */
async function makePopulatedFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-coverage-twins-"));
  await writeFile(join(dir, "page.html"), "<html><body><p>hi</p></body></html>");
  return dir;
}

interface CoverageResponse {
  readonly [key: string]: unknown;
  readonly summary?: {
    readonly actionable?: { readonly criteria?: number; readonly emissionsTotal?: number };
    readonly untargetedCriteriaForProject?: number;
    readonly automatedCoverage?: { readonly automatedCriteriaPassRate?: number };
  };
  readonly meta?: {
    readonly scanned?: { readonly mode?: string; readonly root?: string };
  };
}

describe("coverage response: four scalar pairs each appear at exactly one location", () => {
  it("manualCandidateEmissionsTotal lives only under summary.actionable.emissionsTotal", async () => {
    const dir = await makePopulatedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body(responses[1]) as CoverageResponse;
    // Nested canonical location is populated.
    expect(typeof coverage.summary?.actionable?.emissionsTotal).toBe("number");
    // Top-level twin must NOT appear — the cross-field-redundancy
    // axis closure landed.
    expect(coverage).not.toHaveProperty("manualCandidateEmissionsTotal");
  });

  it("automatedCriteriaPassRate lives only under summary.automatedCoverage.automatedCriteriaPassRate", async () => {
    const dir = await makePopulatedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body(responses[1]) as CoverageResponse;
    // Nested canonical location is populated under
    // present-when-meaningful (the fixture has at least one parseable
    // file, so the rate is meaningful).
    expect(typeof coverage.summary?.automatedCoverage?.automatedCriteriaPassRate).toBe("number");
    // Top-level twin must NOT appear.
    expect(coverage).not.toHaveProperty("automatedCriteriaPassRate");
  });

  it("untargetedCriteriaForProject lives only under summary.untargetedCriteriaForProject", async () => {
    const dir = await makePopulatedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body(responses[1]) as CoverageResponse;
    // Nested canonical location is populated.
    expect(typeof coverage.summary?.untargetedCriteriaForProject).toBe("number");
    // Top-level twin must NOT appear.
    expect(coverage).not.toHaveProperty("untargetedCriteriaForProject");
  });

  it("scanned lives only under meta.scanned", async () => {
    const dir = await makePopulatedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body(responses[1]) as CoverageResponse;
    // Nested canonical location is populated.
    expect(coverage.meta?.scanned).toBeDefined();
    expect(coverage.meta?.scanned?.mode).toBe("project");
    // Top-level twin must NOT appear.
    expect(coverage).not.toHaveProperty("scanned");
  });

  it("enumerates the four pairs and asserts each maps to one canonical location", async () => {
    // Aggregate guard — encodes the invariant for the closure as a
    // single readable matrix so a future field addition lands here
    // explicitly. Each row names (a) the conceptual scalar, (b) the
    // canonical access path, and (c) the dropped top-level twin.
    const dir = await makePopulatedFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "coverage", { cwd: dir })]);
    const coverage = body(responses[1]) as CoverageResponse;

    const pairs: ReadonlyArray<{
      readonly concept: string;
      readonly canonical: () => unknown;
      readonly droppedTopLevel: string;
    }> = [
      {
        concept: "manualCandidateEmissionsTotal",
        canonical: () => coverage.summary?.actionable?.emissionsTotal,
        droppedTopLevel: "manualCandidateEmissionsTotal",
      },
      {
        concept: "automatedCriteriaPassRate",
        canonical: () => coverage.summary?.automatedCoverage?.automatedCriteriaPassRate,
        droppedTopLevel: "automatedCriteriaPassRate",
      },
      {
        concept: "untargetedCriteriaForProject",
        canonical: () => coverage.summary?.untargetedCriteriaForProject,
        droppedTopLevel: "untargetedCriteriaForProject",
      },
      {
        concept: "scanned",
        canonical: () => coverage.meta?.scanned,
        droppedTopLevel: "scanned",
      },
    ];

    for (const { canonical, droppedTopLevel } of pairs) {
      // Canonical location must exist (typeof number / typeof object,
      // never undefined — the populated fixture guarantees each
      // present-when-meaningful field is present).
      expect(canonical()).toBeDefined();
      // Top-level twin must NOT appear.
      expect(coverage).not.toHaveProperty(droppedTopLevel);
    }
  });
});
