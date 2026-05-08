/**
 * Integration test for the `scan_project` `collapseByGroupKey`
 * parameter.
 *
 * Pins the agent-facing contract end-to-end:
 *
 *   1. Default false — response shape is unchanged from the per-file
 *      view (`files[]` ships, `collapsedGroups` does not).
 *   2. True — response replaces `files[]` with `collapsedGroups[]`.
 *      Each group entry carries a canonical `findingId` plus an
 *      `occurrences[]` enumeration so `suggest_fix(findingId)` and
 *      per-occurrence `(path, line)` triples both stay addressable.
 *   3. Cross-surface count invariant — `plan.collapsedGroupCount`
 *      ships alongside the un-collapsed `plan.fixesByClass` headlines
 *      so the agent reconciles the two views in one read.
 *   4. The collapsed total is ≤ the per-file finding total on the
 *      same fixture (the whole point of the flag).
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpSession } from "../../src/mcp/session.ts";
import { scanProjectTool } from "../../src/mcp/tool-scan-project.ts";

async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ra11y-collapse-by-group-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Build a POSIX-shaped expected absolute path. Mirrors `join(dir, ...segments)`
 * but normalizes the result so it matches the POSIX-shaped paths the
 * scanner emits on Windows.
 */
function posixJoin(dir: string, ...segments: string[]): string {
  return [dir.split(/[\\/]/).join("/"), ...segments.flatMap((s) => s.split(/[\\/]/))].join("/");
}

interface ScanProjectResponse {
  readonly plan: Record<string, unknown>;
  readonly files?: ReadonlyArray<Record<string, unknown>>;
  readonly collapsedGroups?: ReadonlyArray<{
    readonly ruleId: string;
    readonly groupKey: string;
    readonly findingId: string;
    readonly occurrences: ReadonlyArray<{
      readonly path: string;
      readonly line: number;
      readonly column: number;
    }>;
    readonly occurrenceCount: number;
  }>;
  readonly totalCollapsedGroups?: number;
  readonly totalFilesWithFindings?: number;
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
 * Three sibling sub-sites each carrying the same `<img>`-without-alt
 * pattern — the canonical bulk-template shape (Bootstrap navbar copied
 * across N sites). With three files and one `<img>` each, the per-file
 * view ships 3 finding entries; the collapsed view ships one
 * `(media/alt-text-missing, <groupKey>)` entry with 3 occurrences.
 */
async function writeRepeatedTemplateFixture(dir: string): Promise<void> {
  for (const site of ["site-a", "site-b", "site-c"]) {
    await mkdir(join(dir, "templates", site), { recursive: true });
    await writeFile(
      join(dir, "templates", site, "index.html"),
      [
        "<!DOCTYPE html>",
        '<html lang="en"><head><title>Site</title></head>',
        "<body>",
        // Same shape across all three sites — produces the same
        // `(ruleId, groupKey)` pair on every emission.
        '  <img src="hero.jpg">',
        "</body></html>",
      ].join("\n"),
    );
  }
}

describe("scan_project — collapseByGroupKey parameter", () => {
  it("preserves the per-file shape when the flag is omitted (default false)", async () => {
    await withScratch(async (dir) => {
      await writeRepeatedTemplateFixture(dir);
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir }, session);
      expect(Array.isArray(response.files)).toBe(true);
      expect(response.collapsedGroups).toBeUndefined();
      expect(response.totalCollapsedGroups).toBeUndefined();
      // The fixture has three sibling files; per-file view ships three
      // entries even though they share the same predicate.
      expect(response.files?.length).toBe(3);
    });
  });

  it("swaps files[] for collapsedGroups[] when collapseByGroupKey: true", async () => {
    await withScratch(async (dir) => {
      await writeRepeatedTemplateFixture(dir);
      const session = new McpSession();
      const response = await callScanProject({ cwd: dir, collapseByGroupKey: true }, session);
      expect(response.files).toBeUndefined();
      expect(Array.isArray(response.collapsedGroups)).toBe(true);
      // The three sibling sites share the same `<img>` AST shape, so
      // the alt-text-missing rule emits one collapsed group with three
      // occurrences. `landmark-main` and `heading-hierarchy` (etc.)
      // also fire on every HTML envelope and may collapse similarly,
      // so the total group count is bounded by the rule count, not
      // the file count.
      const altGroup = response.collapsedGroups?.find((g) => g.ruleId === "media/alt-text-missing");
      expect(altGroup).toBeDefined();
      expect(altGroup?.occurrenceCount).toBe(3);
      expect(altGroup?.occurrences.map((o) => o.path).sort()).toEqual([
        posixJoin(dir, "templates", "site-a", "index.html"),
        posixJoin(dir, "templates", "site-b", "index.html"),
        posixJoin(dir, "templates", "site-c", "index.html"),
      ]);
      // Canonical findingId is non-empty so suggest_fix can address
      // the group via its first occurrence.
      expect(altGroup?.findingId.length).toBeGreaterThan(0);
    });
  });

  it("stamps plan.collapsedGroupCount alongside the un-collapsed headline counters (cross-surface invariant)", async () => {
    await withScratch(async (dir) => {
      await writeRepeatedTemplateFixture(dir);
      const session = new McpSession();
      const collapsed = await callScanProject({ cwd: dir, collapseByGroupKey: true }, session);
      const flat = await callScanProject({ cwd: dir }, session);
      const planCollapsed = collapsed.plan as Record<string, unknown>;
      expect(typeof planCollapsed["collapsedGroupCount"]).toBe("number");
      // The un-collapsed plan headlines (`fixesByClass`) ride
      // unchanged across both views — agents budget against the real
      // finding count, then read `collapsedGroupCount` to learn the
      // per-group view's inventory size.
      const flatPlan = flat.plan as Record<string, unknown>;
      expect(planCollapsed["fixesByClass"]).toEqual(flatPlan["fixesByClass"] as object);
      // The collapsed group count must be ≤ the original
      // files-with-findings count when the corpus shares predicates
      // across files (the canonical use case for the flag).
      const totalCollapsed = planCollapsed["collapsedGroupCount"] as number;
      expect(totalCollapsed).toBeGreaterThan(0);
      expect(totalCollapsed).toBeLessThanOrEqual(flat.files?.length ?? 0);
      // Pagination headline ships the per-group total counter.
      expect(collapsed.totalCollapsedGroups).toBe(totalCollapsed);
    });
  });
});
