/**
 * Integration test: a low-confidence verify-token finding contributes
 * to `actionableManualItems` (and the cross-surface siblings on
 * `coverage.summary.actionable.criteria` and
 * `checklist.summary.actionable.criteria`).
 *
 * Pre-fix the manual-review tally only walked `reviewCandidates[]`,
 * so a `scan_file` response shipping a `confidence: "low"`
 * `semantics/landmark-main` finding with
 * `couldBeWrongBecause: ["isolated_component_demo_page"]` read as
 * `actionableManualItems: 0` while explicitly asking the agent to
 * verify the page composition — the canonical Composite-Headline-
 * Counts-Are-Dishonest miss the AI-first doctrine warns against.
 *
 * Fixture: a single HTML file whose body shape (`<h1>` plus a
 * `<script>`) matches the isolated-component-demo predicate in
 * `src/rules/semantics/landmark-main.ts` AND clears
 * `looksLikeFullPage` (heading + body-script branch). The rule
 * downgrades to severity `info` and tags the finding with
 * `isolated_component_demo_page` — the canonical verify-token shape.
 *
 * Asserts:
 *
 *   - `scan_file` ships at least one finding with `confidence: "low"`
 *     and a verify-token in `couldBeWrongBecause`.
 *   - `scan_file.plan.actionableManualItems > 0` on this fixture.
 *   - Cross-surface count agreement holds across `scan_file`,
 *     `scan_project`, `coverage.summary.actionable.criteria`, and
 *     `checklist.summary.actionable.criteria` on identical input — the
 *     verify-token criterion contributes to every project-rooted
 *     surface's actionable headline.
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

interface Finding {
  readonly ruleId: string;
  readonly severity: string;
  readonly confidence: string;
  readonly criteria: readonly string[];
  readonly couldBeWrongBecause?: readonly string[];
}

interface ScanFileBody {
  readonly findings?: readonly Finding[];
  readonly plan: {
    readonly actionableManualItems: number;
    // scan_file is per-file scope — emits the per-file slice name.
    readonly untargetedCriteriaForFile: number;
  };
}

interface ScanProjectBody {
  readonly plan: {
    readonly actionableManualItems: number;
    readonly untargetedCriteriaForProject: number;
  };
}

interface ChecklistBody {
  readonly summary: {
    readonly actionable: { readonly criteria: number };
    readonly untargetedCriteriaForProject: number;
  };
}

interface CoverageBody {
  readonly summary: {
    readonly actionable: { readonly criteria: number };
  };
  readonly untargetedCriteriaForProject: number;
}

/**
 * Builds a fixture whose body shape (`<h1>` plus `<script>`) clears
 * `looksLikeFullPage` (branch D — heading plus body-script) AND
 * matches `isIsolatedComponentBodyShape` (≤2 children with ≤1
 * non-script). Result: `semantics/landmark-main` fires with
 * severity `info`, confidence `low`, and
 * `couldBeWrongBecause: ["isolated_component_demo_page"]` — the
 * canonical Q15 verify-token shape.
 */
async function makeIsolatedComponentDemoFixture(): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-q15-isolated-demo-"));
  const page = join(dir, "page.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo</title></head>
<body>
<h1>Demo Page</h1>
<script src="bundle.js"></script>
</body>
</html>
`,
  );
  return { dir, page };
}

describe("low-confidence verify-token finding contributes to actionableManualItems", () => {
  it("scan_file ships the verify-token finding at confidence:low and counts its criterion in actionableManualItems", async () => {
    const { page } = await makeIsolatedComponentDemoFixture();
    const responses = await mcpSession([initMsg(1), toolCall(2, "scan_file", { path: page })]);
    const scanFileBody = body<ScanFileBody>(responses[1]);
    // Sanity: the fixture ships the canonical verify-token finding —
    // the test would pass vacuously if the rule's downgrade predicate
    // changed and the finding stopped firing as a verify-token shape.
    const verifyTokenFindings = (scanFileBody.findings ?? []).filter(
      (f) =>
        f.severity === "info" &&
        f.confidence === "low" &&
        (f.couldBeWrongBecause?.includes("isolated_component_demo_page") ?? false),
    );
    expect(verifyTokenFindings.length).toBeGreaterThan(0);
    // Pre-fix this read 0 while one verify-token finding shipped —
    // the canonical Composite-Headline-Counts-Are-Dishonest miss.
    expect(scanFileBody.plan.actionableManualItems).toBeGreaterThan(0);
  });

  it("cross-surface invariant: scan_project / coverage / checklist all count the verify-token criterion in actionable", async () => {
    const { dir } = await makeIsolatedComponentDemoFixture();
    const responses = await mcpSession([
      initMsg(1),
      toolCall(2, "scan_project", { cwd: dir }),
      toolCall(3, "coverage", { cwd: dir }),
      toolCall(4, "checklist", { cwd: dir }),
    ]);
    const scanProjectBody = body<ScanProjectBody>(responses[1]);
    const coverageBody = body<CoverageBody>(responses[2]);
    const checklistBody = body<ChecklistBody>(responses[3]);
    // All three project-rooted surfaces compute the actionable count
    // through the shared `tallyManualCriteriaFromCoverage` helper /
    // `actionableCriteria` set so the verify-token criterion folds
    // into every surface's headline. Pre-Q15 they all read 0 on this
    // fixture; post-Q15 they all read >= 1 and agree.
    expect(scanProjectBody.plan.actionableManualItems).toBeGreaterThan(0);
    expect(scanProjectBody.plan.actionableManualItems).toBe(
      coverageBody.summary.actionable.criteria,
    );
    expect(scanProjectBody.plan.actionableManualItems).toBe(
      checklistBody.summary.actionable.criteria,
    );
  });
});
