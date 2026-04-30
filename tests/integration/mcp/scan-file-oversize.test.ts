/**
 * Integration test for `scan_file` oversize-envelope wiring
 * (Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION).
 *
 * Exercises the wired `scanFileTool.handler` end-to-end against a
 * dense synthetic HTML page that produces enough findings to cross
 * the host ceiling under a tight `maxBytes` override. Pinning the
 * wiring through the handler (rather than the budget helper alone)
 * catches regressions where the budget pass is silently disabled at
 * the call site or wired in a way that bypasses the slim guard.
 *
 * Two regressions this test prevents:
 *
 *   1. The handler returning the un-budgeted response on a dense page
 *      — the host would drop the envelope and the agent would see
 *      only a transport error indistinguishable from "tool never ran"
 *      (the canonical "Oversize-success is ambiguous failure" shape).
 *
 *   2. The `limit` / `offset` params being ignored — agents iterating
 *      the fix-verify loop on a dense page would have no way to
 *      narrow the response without re-routing through `scan_project`.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findScanFileTool() {
  const tool = MCP_TOOLS.find((t) => t.def.name === "scan_file");
  if (tool === undefined) throw new Error("scan_file tool not found");
  return tool;
}

/**
 * Builds a synthetic HTML page guaranteed to surface many findings —
 * one `<img>` without alt per row, repeated. The `a11y/img-alt-missing`
 * rule fires deterministically on each, so the response carries a flat
 * findings list whose density scales with row count.
 */
async function makeDenseHtmlFixture(rowCount: number): Promise<{ dir: string; page: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-oversize-"));
  const rows = Array.from({ length: rowCount }, (_, i) => `<img src="row-${i}.png">`).join("\n");
  const page = join(dir, "dense-page.html");
  await writeFile(
    page,
    `<!doctype html>
<html lang="en">
<head><title>Dense</title></head>
<body><main>
${rows}
</main></body>
</html>
`,
  );
  return { dir, page };
}

describe("scan_file Q10 oversize-envelope wiring", () => {
  it("paginates a dense findings list when caller passes `limit`", async () => {
    // 50 rows of img-without-alt → 50 deterministic findings, plus
    // possibly a small handful from sibling rules running on the HTML
    // envelope (page-titled, lang-attribute, etc.). Assert the page
    // primitive caps at `limit` and reports an inventory ≥ row count.
    const { page } = await makeDenseHtmlFixture(50);
    const tool = findScanFileTool();
    const session = new McpSession();
    const result = await tool.handler({ path: page, limit: 10 }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const findings = data["findings"] as readonly unknown[];
    expect(findings.length).toBe(10);
    expect(data["truncated"]).toBe(true);
    const total = data["totalFindings"] as number;
    expect(total).toBeGreaterThanOrEqual(50);
    expect(data["nextOffset"]).toBe(10);
    expect(data["pageClipReason"]).toBe("limit_offset");
    expect(data["requestedLimit"]).toBe(10);
    expect(data["effectiveLimit"]).toBe(10);
  });

  it("resumes pagination via `offset`", async () => {
    const { page } = await makeDenseHtmlFixture(50);
    const tool = findScanFileTool();
    const session = new McpSession();
    // Use offset = totalFindings - limit so the slice lands exactly on
    // the last page regardless of any sibling-rule findings the
    // envelope picked up. The first call discovers the inventory.
    const probe = await tool.handler({ path: page, limit: 1 }, session);
    const probeData = JSON.parse(probe.content[0].text) as Record<string, unknown>;
    const total = probeData["totalFindings"] as number;
    expect(total).toBeGreaterThanOrEqual(50);

    const result = await tool.handler({ path: page, limit: 10, offset: total - 10 }, session);
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const findings = data["findings"] as readonly unknown[];
    expect(findings.length).toBe(10);
    expect(data["totalFindings"]).toBe(total);
    // Last page — no nextOffset.
    expect(data).not.toHaveProperty("nextOffset");
  });

  it("returns un-paged response unchanged when findings fit under the default limit", async () => {
    // 5 findings is well under DEFAULT_SCAN_FILE_LIMIT (200) — even
    // with the small handful of sibling-rule findings the HTML
    // envelope adds, the total stays well under the cap.
    const { page } = await makeDenseHtmlFixture(5);
    const tool = findScanFileTool();
    const session = new McpSession();
    const result = await tool.handler({ path: page }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const findings = data["findings"] as readonly unknown[];
    expect(findings.length).toBeGreaterThanOrEqual(5);
    expect(findings.length).toBeLessThan(200);
    // Pass-through: paging-state fields stay absent.
    expect(data).not.toHaveProperty("truncated");
    expect(data).not.toHaveProperty("totalFindings");
    expect(data).not.toHaveProperty("nextOffset");
    expect(data).not.toHaveProperty("findingsArrayDropped");
  });

  it("engages the slim envelope when post-paging response crosses `maxBytes`", async () => {
    // 50 findings → pages to 200 default, all fit. Override `maxBytes`
    // to force the slim guard on a tractable fixture.
    const { page } = await makeDenseHtmlFixture(50);
    const tool = findScanFileTool();
    const session = new McpSession();
    const result = await tool.handler({ path: page, maxBytes: 8000 }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;
    // Slim shape: findings dropped, sentinel flag set.
    expect(data["findings"]).toEqual([]);
    expect(data["findingsArrayDropped"]).toBe(true);
    expect(data["truncated"]).toBe(true);
    expect(data["totalFindings"] as number).toBeGreaterThanOrEqual(50);

    // Warnings channel: the byte-level oversize code rides with payload.
    const warnings = data["warnings"] as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = data["warningsDetails"] as Record<string, unknown>;
    const dropPayload = details["response_dropped_files_oversize"] as {
      preDropBytes: number;
      hardCeilingBytes: number;
      droppedFileCountFromRequestedLimit: number;
      totalFilesWithFindings: number;
    };
    expect(dropPayload.preDropBytes).toBeGreaterThan(dropPayload.hardCeilingBytes);
    expect(dropPayload.hardCeilingBytes).toBe(8000);

    // Structured nextStep carries callable args (not empty {}).
    const structured = data["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_file");
    expect(structured.args).not.toEqual({});
    expect(typeof structured.args["limit"]).toBe("number");
  });

  it("plan + meta survive the slim envelope so the agent can route once", async () => {
    // Doctrine bullet "Oversize-success is ambiguous failure": when
    // the slim path engages, the agent must still receive the load-
    // bearing routing channel — `plan` (per-class fix tally) + slim
    // `meta` (scan-confidence telemetry) + `nextStep`. Without these,
    // the slim path is no better than a transport drop.
    const { page } = await makeDenseHtmlFixture(50);
    const tool = findScanFileTool();
    const session = new McpSession();
    const result = await tool.handler({ path: page, maxBytes: 8000 }, session);
    const data = JSON.parse(result.content[0].text) as Record<string, unknown>;

    // Plan rides through.
    const plan = data["plan"] as Record<string, unknown>;
    expect(plan).toBeDefined();
    expect(plan["fixesByClass"]).toBeDefined();

    // Slim meta keeps the scan-confidence telemetry the agent reads
    // to verify the scan ran for real.
    const meta = data["meta"] as Record<string, unknown>;
    expect(meta).toBeDefined();
    expect(meta["scanned"]).toBeDefined();
    expect(typeof meta["filesScanned"]).toBe("number");

    // Top-level next-step prose names the recovery the agent needs.
    expect(typeof data["nextStep"]).toBe("string");
    expect((data["nextStep"] as string).length).toBeGreaterThan(0);
  });
});
