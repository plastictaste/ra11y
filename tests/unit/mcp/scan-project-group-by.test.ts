/**
 * Integration tests for the `scan_project` `groupBy` parameter.
 *
 * Doctrine: bulk-template repos with N parallel sub-project subdirs at
 * the top level had no first-class workflow for "scan all sub-projects
 * but aggregate per-sub-project." `groupBy: "firstChildDir"` rolls up
 * findings into a `plan.byGroup` map keyed by the relative-to-cwd first
 * path segment, in one whole-tree scan response. The flat `files[]`
 * list still ships in full — `byGroup` is an additive aggregator, not
 * a replacement (surface, don't suppress).
 *
 * Test corpus: a scratch tree with two sub-project subdirs, each
 * containing an HTML file with deterministic violations, plus a
 * root-level fragment file. The fixture is small enough that the
 * scan emits more than one rule per group, so `mostCommonRule` is
 * exercised.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../../src/mcp/session.ts";
import { scanProjectTool } from "../../../src/mcp/tool-scan-project.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-group-by-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface ByGroupEntry {
  readonly violations: number;
  readonly filesWithFindings: number;
  readonly mostCommonRule?: string;
  readonly mostCommonCriterion?: string;
}

interface ScanProjectResponse {
  readonly plan: {
    readonly notes: number;
    readonly byGroup?: Record<string, ByGroupEntry>;
  };
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

async function callScanProject(
  params: Record<string, unknown>,
  session: McpSession,
): Promise<ScanProjectResponse> {
  const result = await scanProjectTool.handler(params, session);
  expect(result.isError).toBeUndefined();
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text) as ScanProjectResponse;
}

/**
 * Two sub-project subdirs each with deterministic violations, plus a
 * clean root-level file the scanner finds but emits no findings on.
 * Each subdir's HTML carries `<img>` without `alt` (alt-text/missing)
 * so the rollup has finding density to rank. `site-a` adds an extra
 * `<img>` so it dominates the `mostCommonRule` tally for
 * `firstChildDir: "templates"`.
 */
async function writeCatalogFixture(dir: string): Promise<void> {
  await mkdir(join(dir, "templates", "site-a"), { recursive: true });
  await mkdir(join(dir, "templates", "site-b"), { recursive: true });
  await writeFile(
    join(dir, "templates", "site-a", "index.html"),
    [
      "<!DOCTYPE html>",
      '<html lang="en"><head><title>Site A</title></head>',
      "<body>",
      '  <img src="hero.jpg">',
      '  <img src="logo.png">',
      '  <img src="banner.jpg">',
      "</body></html>",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "templates", "site-b", "index.html"),
    [
      "<!DOCTYPE html>",
      '<html lang="en"><head><title>Site B</title></head>',
      "<body>",
      '  <img src="hero.jpg">',
      "</body></html>",
    ].join("\n"),
  );
}

describe("scan_project — groupBy parameter", () => {
  it("does not emit `plan.byGroup` when groupBy is not set (existing shape)", async () => {
    await withScratch(async (dir) => {
      await writeCatalogFixture(dir);
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir }, session);
      expect(response.plan.byGroup).toBeUndefined();
      // Sanity — the scan did emit findings so byGroup would
      // be populated if the caller had requested it.
      expect(response.files.length).toBeGreaterThan(0);
    });
  });

  it("populates `plan.byGroup` keyed by firstChildDir when groupBy: 'firstChildDir'", async () => {
    await withScratch(async (dir) => {
      await writeCatalogFixture(dir);
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir, groupBy: "firstChildDir" }, session);
      expect(response.plan.byGroup).toBeDefined();
      // The catalog fixture lives entirely under `templates/`, so the
      // rollup has exactly one bucket. The per-group entry surfaces
      // the headline aggregate without forcing the agent to walk the
      // flat `files[]` list.
      const byGroup = response.plan.byGroup ?? {};
      expect(Object.keys(byGroup)).toEqual(["templates"]);
      const templates = byGroup["templates"];
      expect(templates).toBeDefined();
      expect(templates?.violations).toBeGreaterThanOrEqual(4);
      expect(templates?.filesWithFindings).toBe(2);
      expect(templates?.mostCommonRule).toBe("media/alt-text-missing");
      // Findings still ship in the flat `files[]` list — byGroup is
      // additive, not a replacement.
      expect(response.files.length).toBe(2);
    });
  });

  it("populates `plan.byGroup` keyed by extension when groupBy: 'extension'", async () => {
    await withScratch(async (dir) => {
      await writeCatalogFixture(dir);
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir, groupBy: "extension" }, session);
      const byGroup = response.plan.byGroup ?? {};
      expect(byGroup["html"]).toBeDefined();
      expect(byGroup["html"]?.filesWithFindings).toBe(2);
      expect(byGroup["html"]?.mostCommonRule).toBe("media/alt-text-missing");
    });
  });

  it("omits `plan.byGroup` on a clean (zero-violations) corpus — caller conditional-spreads", async () => {
    await withScratch(async (dir) => {
      // A correctly-formed HTML page with no violations — the rollup
      // would be `{}` and is dropped per "Ambiguous field shapes are
      // dishonest" (no sentinel-empty container).
      await writeFile(
        join(dir, "ok.html"),
        [
          "<!DOCTYPE html>",
          '<html lang="en">',
          '<head><meta charset="utf-8"><title>OK</title></head>',
          "<body><p>Clean page.</p></body></html>",
        ].join("\n"),
      );
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir, groupBy: "firstChildDir" }, session);
      expect(response.plan.byGroup).toBeUndefined();
    });
  });

  it("ignores unknown groupBy values rather than erroring (caller treats as 'not requested')", async () => {
    await withScratch(async (dir) => {
      await writeCatalogFixture(dir);
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir, groupBy: "byFile" }, session);
      // Unknown strategy resolves to undefined upstream — same shape as
      // omitting the param. Schema validation at the MCP-host layer
      // already rejects bad enums, but the in-handler reader is the
      // last line of defense.
      expect(response.plan.byGroup).toBeUndefined();
    });
  });
});
