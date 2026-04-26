/**
 * End-to-end tests for `scan_file`'s single-file extension filter on
 * `meta.perRuleCoverage` / `meta.perRuleCoverageSummary`.
 *
 * On `scan_file` the input is one file whose extension is known
 * up-front, so rules whose `appliesTo.fileExtensions` gate doesn't
 * intersect produced no signal AT ALL on the scanned file (by
 * definition of an extension gate). Reporting them in
 * `meta.perRuleCoverage` (or in the default-verbosity
 * `meta.perRuleCoverageSummary.ruleIds` list) with a "no files matching
 * .css were scanned" reason inflates the array (~half the rows on a
 * single-file scan) without telling the agent anything actionable the
 * simpler `meta.rulesSkippedExtensionMismatch` counter doesn't already
 * carry.
 *
 * The filter operates AFTER the assembler builds the meta block, so
 * other consumers of the un-filtered `perRuleCoverage` (the top-level
 * `ruleCoverage` derivative, `meta.rulesEvaluated.{loaded,
 * withEligibleInputs, fired}`) still see the full set — those counters
 * describe the WHOLE rule set's interaction with the file and an
 * extension-mismatched rule legitimately counts as "loaded but not
 * eligible on this file."
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

interface ScanFileBody {
  readonly meta: {
    readonly perRuleCoverage?: ReadonlyArray<{ readonly ruleId: string }>;
    readonly perRuleCoverageSummary?: {
      readonly ruleCount: number;
      readonly ruleIds: readonly string[];
    };
    readonly rulesSkippedExtensionMismatch: number;
    readonly rulesNotEvaluatedDueToInputType?: unknown;
  };
}

describe("scan_file: meta.perRuleCoverage extension filter", () => {
  it("verbose mode: drops rows whose extension gate doesn't match the scanned .tsx file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-ext-filter-tsx-"));
    const filePath = join(dir, "App.tsx");
    await writeFile(
      filePath,
      ["export function App() {", "  return <div onClick={() => {}}>Click</div>;", "}", ""].join(
        "\n",
      ),
    );

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: filePath, verboseMeta: true }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as ScanFileBody;
    const rows = data.meta.perRuleCoverage;
    expect(rows).toBeDefined();
    // No row should carry a CSS-only or HTML-only extension gate; we
    // assert the negative by checking a known CSS-gated rule never
    // appears on a `.tsx` scan.
    const ruleIds = (rows ?? []).map((r) => r.ruleId);
    expect(ruleIds).not.toContain("contrast/minimum");
    expect(ruleIds).not.toContain("document/lang-attribute");
    expect(ruleIds).not.toContain("layout/text-spacing");
    // Counter is always present as scan-confidence telemetry — even
    // when the filter dropped rows, the count must be non-zero. The
    // exact number is rule-set-size-dependent (would brittle-test if
    // pinned), so we assert >0.
    expect(data.meta.rulesSkippedExtensionMismatch).toBeGreaterThan(0);
    // The legacy `rulesNotEvaluatedDueToInputType` counter is dropped
    // on `scan_file` — `rulesSkippedExtensionMismatch` subsumes it
    // with cleaner semantics for the single-file shape.
    expect(Object.hasOwn(data.meta, "rulesNotEvaluatedDueToInputType")).toBe(false);
  });

  it("default verbosity: narrows perRuleCoverageSummary.ruleIds to extension-matching rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-ext-filter-default-"));
    const filePath = join(dir, "App.tsx");
    await writeFile(filePath, "export function App() { return <div />; }\n");

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: filePath }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as ScanFileBody;
    // Default verbosity ships the summary, not the verbose array.
    expect(data.meta.perRuleCoverage).toBeUndefined();
    const summary = data.meta.perRuleCoverageSummary;
    expect(summary).toBeDefined();
    expect(summary?.ruleIds).toBeDefined();
    expect(summary?.ruleIds.length).toBe(summary?.ruleCount);
    // The narrowed list excludes CSS/HTML-only rules.
    expect(summary?.ruleIds ?? []).not.toContain("contrast/minimum");
    expect(summary?.ruleIds ?? []).not.toContain("document/lang-attribute");
    // Counter is always present.
    expect(data.meta.rulesSkippedExtensionMismatch).toBeGreaterThan(0);
  });

  it("HTML file: filter retains HTML-routing rules and drops TSX/CSS-only rules", async () => {
    // Mirror case for the .html substrate — the canonical signal that
    // the filter operates on the alias-aware extension match (.html →
    // [".html", ".htm"]) rather than literal string equality.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-ext-filter-html-"));
    const filePath = join(dir, "page.html");
    await writeFile(
      filePath,
      `<!DOCTYPE html><html lang="en"><head><title>x</title></head><body><h1>Hi</h1></body></html>\n`,
    );

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: filePath, verboseMeta: true }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as ScanFileBody;
    const ruleIds = (data.meta.perRuleCoverage ?? []).map((r) => r.ruleId);
    // HTML-routing rules SHOULD be present on a .html scan.
    expect(ruleIds).toContain("document/lang-attribute");
    expect(ruleIds).toContain("document/page-titled");
    // CSS-only rules SHOULD be filtered out (no .html / .htm in their
    // `appliesTo.fileExtensions`).
    expect(ruleIds).not.toContain("layout/text-spacing");
    expect(ruleIds).not.toContain("focus/not-obscured");
    // TSX/JSX-only rules SHOULD also be filtered out (no .html / .htm
    // in their gate). `forms/required-indicator-missing` is the
    // canonical case — its gate is purely `.tsx` / `.jsx` because the
    // rule keys off the `required` JSX prop, which has no HTML
    // analogue (HTML uses `required="required"` and the rule is
    // typed for the JSX boolean shape).
    expect(ruleIds).not.toContain("forms/required-indicator-missing");
    expect(data.meta.rulesSkippedExtensionMismatch).toBeGreaterThan(0);
  });

  it("rulesSkippedExtensionMismatch is always present as scan-confidence telemetry", async () => {
    // Even when no rows would be dropped (theoretical), the counter
    // rides at zero so the agent has a deterministic field to read on
    // every scan-file response shape.
    const dir = await mkdtemp(join(tmpdir(), "ra11y-scan-file-ext-filter-presence-"));
    const filePath = join(dir, "App.tsx");
    await writeFile(filePath, "export const x = 1;\n");

    const tool = findTool("scan_file");
    const session = new McpSession();
    const result = await tool.handler({ path: filePath }, session);

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text) as ScanFileBody;
    expect(typeof data.meta.rulesSkippedExtensionMismatch).toBe("number");
  });
});
