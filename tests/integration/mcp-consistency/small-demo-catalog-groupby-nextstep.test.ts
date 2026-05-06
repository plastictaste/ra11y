/**
 * Pins the `small_demo_catalog` → `groupBy: "firstChildDir"` next-step
 * proposal end-to-end through the MCP server. The bulk-catalog detector
 * (`src/mcp/bulk-catalog.ts`) classifies a corpus as
 * `small_demo_catalog` when ≥30 sibling subdirs share the same per-dir
 * basename signature (e.g. each `<sibling>/` carrying `index.html` +
 * `style.css` + `script.js`). On that shape, the canonical narrowing
 * path is the existing `scan_project` `groupBy: "firstChildDir"`
 * aggregator: one whole-tree scan with per-sub-project rollup beats
 * paging through `files[]` file-by-file or running N round-trips with
 * `additionalPaths` per sub-project.
 *
 * The closure pins three invariants:
 *
 *   1. `nextStepStructured.tool === "scan_project"` AND
 *      `nextStepStructured.args.groupBy === "firstChildDir"` — the
 *      structured-form proposal names the catalog-shape narrowing
 *      lever explicitly so the agent never has to discover the
 *      existing `groupBy` capability out-of-band. Per the AI-first
 *      doctrine "One tool call should answer 'what next?'."
 *
 *   2. The `bulk_catalog_detected` warning ships alongside with
 *      `trigger: "small_demo_catalog"` — the detector runs once and
 *      both surfaces (warning + nextStep override) read the same
 *      classification. Same scan, same evidence, no drift.
 *
 *   3. When the caller already passes `groupBy: "firstChildDir"`, the
 *      override does NOT re-propose it — the proposal would echo the
 *      caller's own input.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { posixJoin } from "../../helpers/path.ts";

const PROJECT_ROOT = posixJoin(import.meta.dir, "..", "..", "..");

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

/**
 * Builds a corpus shaped as N parallel sibling subdirs, each carrying
 * `index.html` + `style.css` + `script.js`. Mirrors the canonical
 * `small_demo_catalog` shape the bulk-catalog detector pins.
 */
function buildSmallDemoCatalog(root: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const dir = `example-${String(i + 1).padStart(2, "0")}`;
    mkdirSync(posixJoin(root, dir));
    // Each sub-project carries a (broken) image so the scan emits at
    // least one finding per sibling — rules need real findings to
    // exercise the routing decision (`nextStep` falls through to a
    // clean-scan branch on zero findings).
    writeFileSync(
      posixJoin(root, dir, "index.html"),
      `<html><body><img src="hero-${i + 1}.png"></body></html>\n`,
    );
    writeFileSync(posixJoin(root, dir, "style.css"), `body { color: black; }\n`);
    writeFileSync(posixJoin(root, dir, "script.js"), `console.log("example ${i + 1}");\n`);
  }
}

describe("scan_project: small_demo_catalog → groupBy firstChildDir nextStep proposal", () => {
  it("proposes groupBy: firstChildDir on a 30-sibling small-demo catalog", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-small-demo-catalog-"));
    try {
      buildSmallDemoCatalog(root, 30);
      const responses = await mcpSession([initMsg(1), toolCall(2, "scan_project", { cwd: root })]);
      const scan = responses.find((r) => r.id === 2);
      expect(scan).toBeDefined();
      const body = bodyOf(scan as JsonRpcResponse);

      // Invariant 2: bulk-catalog detection fires on this shape.
      const warnings = body["warnings"] as readonly string[] | undefined;
      expect(warnings).toBeDefined();
      expect(warnings).toContain("bulk_catalog_detected");
      const warningsDetails = body["warningsDetails"] as Record<string, unknown> | undefined;
      const bulkCatalog = warningsDetails?.["bulk_catalog_detected"] as
        | { trigger: string }
        | undefined;
      expect(bulkCatalog).toBeDefined();
      expect(bulkCatalog?.trigger).toBe("small_demo_catalog");

      // Invariant 1: nextStepStructured proposes groupBy: firstChildDir.
      const nextStepStructured = body["nextStepStructured"] as
        | { tool: string; args: Record<string, unknown> }
        | undefined;
      expect(nextStepStructured).toBeDefined();
      expect(nextStepStructured?.tool).toBe("scan_project");
      expect(nextStepStructured?.args?.["groupBy"]).toBe("firstChildDir");

      // Prose names the groupBy lever so weak-LLM consumers reading
      // the prose-only field also see the recommendation.
      const nextStep = body["nextStep"] as string | undefined;
      expect(typeof nextStep).toBe("string");
      expect(nextStep).toContain("firstChildDir");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not echo groupBy when the caller already passed groupBy: firstChildDir", async () => {
    const root = mkdtempSync(posixJoin(tmpdir(), "ra11y-small-demo-catalog-callergroupby-"));
    try {
      buildSmallDemoCatalog(root, 30);
      const responses = await mcpSession([
        initMsg(1),
        toolCall(2, "scan_project", { cwd: root, groupBy: "firstChildDir" }),
      ]);
      const scan = responses.find((r) => r.id === 2);
      const body = bodyOf(scan as JsonRpcResponse);

      // The bulk-catalog detector still fires — the corpus shape is
      // unchanged, only the caller's params differ.
      const warnings = body["warnings"] as readonly string[] | undefined;
      expect(warnings).toContain("bulk_catalog_detected");

      // The override skipped re-proposing groupBy because the caller
      // already supplied it. The structured nextStep MUST NOT name
      // groupBy as the proposed lever (echoing the caller's own input
      // is dishonest per "Don't duplicate capability the agent
      // already has"). The override defers to the standard nextStep
      // hint built by `buildNextStep` — which on this corpus surfaces
      // a per-finding `suggest_fix` or `propose_config` route.
      const nextStepStructured = body["nextStepStructured"] as
        | { tool: string; args: Record<string, unknown> }
        | undefined;
      // Either the structured field is omitted (no concrete pick) or
      // it points at a different lever (suggest_fix / explain_rule /
      // propose_config) — the load-bearing assertion is that we are
      // NOT echoing the caller's `groupBy: "firstChildDir"` back.
      const proposedGroupBy = nextStepStructured?.args?.["groupBy"];
      expect(proposedGroupBy).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
