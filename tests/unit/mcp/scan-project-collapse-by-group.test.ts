/**
 * Unit tests for `src/mcp/scan-project-collapse-by-group.ts` — the
 * collapsed-by-(ruleId, groupKey) view for `scan_project` responses.
 *
 * Doctrine: bulk-template catalogs (174-template website-templates
 * dump, etc.) emit ~40k findings that round to <500 unique
 * `(ruleId, groupKey)` pairs. The flat `files[]` view forces the
 * agent through paged iteration to learn "what kinds of problems
 * exist"; the per-group view ships one entry per kind with the file
 * list inline. Default false preserves the per-file shape; the flag
 * is additive.
 */

import { describe, expect, it } from "bun:test";
import {
  type CollapsedGroup,
  collapseFilesByGroupKey,
  paginateCollapsedGroups,
  rewriteResponseToCollapsed,
} from "../../../src/mcp/scan-project-collapse-by-group.ts";

type FindingShape = Parameters<typeof collapseFilesByGroupKey>[0][number]["findings"][number];

const F = (overrides: {
  ruleId: string;
  groupKey: string;
  line: number;
  column: number;
  findingId?: string;
  message?: string;
  snippet?: string;
}): FindingShape => {
  const base: Record<string, unknown> = {
    ruleId: overrides.ruleId,
    groupKey: overrides.groupKey,
    line: overrides.line,
    column: overrides.column,
    findingId:
      overrides.findingId ?? `fid-${overrides.ruleId}-${overrides.groupKey}-${overrides.line}`,
    findingGroupId: `fgid-${overrides.ruleId}-${overrides.groupKey}`,
    fixClass: "mechanical",
    criteria: ["wcag22:1.1.1"],
    severity: "error",
    confidence: "high",
    message: overrides.message ?? "Missing alt",
    effort: "low",
    category: "media",
    suppressWith: "media/alt-text-missing",
  };
  if (overrides.snippet !== undefined) base["snippet"] = overrides.snippet;
  return base as unknown as FindingShape;
};

describe("collapseFilesByGroupKey — per-group rollup", () => {
  it("collapses N copies of the same (ruleId, groupKey) into one entry with full occurrences[]", () => {
    const out = collapseFilesByGroupKey([
      {
        path: "/repo/a.html",
        findings: [F({ ruleId: "media/alt-text-missing", groupKey: "g1", line: 5, column: 1 })],
      },
      {
        path: "/repo/b.html",
        findings: [F({ ruleId: "media/alt-text-missing", groupKey: "g1", line: 9, column: 3 })],
      },
      {
        path: "/repo/c.html",
        findings: [F({ ruleId: "media/alt-text-missing", groupKey: "g1", line: 12, column: 1 })],
      },
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.ruleId).toBe("media/alt-text-missing");
    expect(out[0]?.groupKey).toBe("g1");
    expect(out[0]?.occurrenceCount).toBe(3);
    expect(out[0]?.occurrences).toEqual([
      { path: "/repo/a.html", line: 5, column: 1 },
      { path: "/repo/b.html", line: 9, column: 3 },
      { path: "/repo/c.html", line: 12, column: 1 },
    ]);
  });

  it("surfaces one entry per unique (ruleId, groupKey) pair", () => {
    const out = collapseFilesByGroupKey([
      {
        path: "/repo/a.html",
        findings: [
          F({ ruleId: "media/alt-text-missing", groupKey: "g1", line: 1, column: 1 }),
          F({ ruleId: "media/alt-text-missing", groupKey: "g2", line: 2, column: 1 }),
          F({ ruleId: "contrast/minimum", groupKey: "g1", line: 3, column: 1 }),
        ],
      },
      {
        path: "/repo/b.html",
        findings: [F({ ruleId: "media/alt-text-missing", groupKey: "g1", line: 4, column: 1 })],
      },
    ]);
    expect(out.length).toBe(3);
    // Sorted by (ruleId, groupKey) ascending for deterministic output.
    expect(out.map((g) => `${g.ruleId}|${g.groupKey}`)).toEqual([
      "contrast/minimum|g1",
      "media/alt-text-missing|g1",
      "media/alt-text-missing|g2",
    ]);
    const altG1 = out.find((g) => g.ruleId === "media/alt-text-missing" && g.groupKey === "g1");
    expect(altG1?.occurrenceCount).toBe(2);
  });

  it("preserves the canonical finding's identity fields on the collapsed entry", () => {
    const canonical = F({
      ruleId: "media/alt-text-missing",
      groupKey: "g1",
      line: 5,
      column: 1,
      findingId: "canonical-id",
      message: "Canonical message",
      snippet: "<img src='hero.jpg'>",
    });
    const sibling = F({
      ruleId: "media/alt-text-missing",
      groupKey: "g1",
      line: 9,
      column: 3,
      findingId: "sibling-id",
      message: "Sibling message",
      snippet: "<img src='other.jpg'>",
    });
    const out = collapseFilesByGroupKey([
      { path: "/repo/a.html", findings: [canonical] },
      { path: "/repo/b.html", findings: [sibling] },
    ]);
    expect(out[0]?.findingId).toBe("canonical-id");
    expect(out[0]?.message).toBe("Canonical message");
    expect(out[0]?.snippet).toBe("<img src='hero.jpg'>");
  });

  it("omits optional fields (snippet, fix, criteriaTitles) when the canonical finding lacks them", () => {
    const out = collapseFilesByGroupKey([
      {
        path: "/repo/a.html",
        findings: [F({ ruleId: "r", groupKey: "g", line: 1, column: 1 })],
      },
    ]);
    const group = out[0];
    expect(group).toBeDefined();
    expect("snippet" in (group as object)).toBe(false);
    expect("fix" in (group as object)).toBe(false);
    expect("criteriaTitles" in (group as object)).toBe(false);
  });

  it("returns an empty array when there are no findings (pure clean scan)", () => {
    expect(collapseFilesByGroupKey([])).toEqual([]);
    expect(collapseFilesByGroupKey([{ path: "/repo/a.html", findings: [] }])).toEqual([]);
  });

  it("groups defensively when groupKey is missing or empty (under <no-group>)", () => {
    const out = collapseFilesByGroupKey([
      {
        path: "/repo/a.html",
        findings: [F({ ruleId: "r", groupKey: "", line: 1, column: 1 })],
      },
      {
        path: "/repo/b.html",
        findings: [F({ ruleId: "r", groupKey: "", line: 2, column: 1 })],
      },
    ]);
    // Both findings share the empty-groupKey synthetic bucket and
    // collapse into one entry rather than duplicating per file.
    expect(out.length).toBe(1);
    expect(out[0]?.occurrenceCount).toBe(2);
  });
});

describe("paginateCollapsedGroups — limit/offset semantics mirror per-file pagination", () => {
  const sample = (n: number): readonly CollapsedGroup[] =>
    Array.from({ length: n }, (_, i) => ({
      ruleId: "r",
      groupKey: `g${i.toString().padStart(3, "0")}`,
      findingId: `fid-${i}`,
      findingGroupId: `fgid-${i}`,
      fixClass: "mechanical",
      criteria: [],
      severity: "error",
      confidence: "high",
      message: "msg",
      effort: "low",
      category: "media",
      suppressWith: "r",
      occurrences: [{ path: "/r/a.html", line: 1, column: 1 }],
      occurrenceCount: 1,
    })) as unknown as readonly CollapsedGroup[];

  it("returns the full list when offset=0 and the page fits", () => {
    const groups = sample(3);
    const out = paginateCollapsedGroups(groups, { limit: 25, offset: 0 });
    expect(out.groups.length).toBe(3);
    expect(out.paginationFields.truncated).toBe(false);
    expect(out.paginationFields.totalCollapsedGroups).toBe(3);
    expect(out.paginationFields.nextOffset).toBeUndefined();
  });

  it("emits truncated/nextOffset when more groups exist beyond the page", () => {
    const groups = sample(50);
    const out = paginateCollapsedGroups(groups, { limit: 25, offset: 0 });
    expect(out.groups.length).toBe(25);
    expect(out.paginationFields.truncated).toBe(true);
    expect(out.paginationFields.nextOffset).toBe(25);
    expect(out.paginationFields.totalCollapsedGroups).toBe(50);
    expect(out.paginationFields.requestedLimit).toBe(25);
    expect(out.paginationFields.effectiveLimit).toBe(25);
  });

  it("flags end_of_results when the last page comes up short", () => {
    const groups = sample(50);
    const out = paginateCollapsedGroups(groups, { limit: 25, offset: 40 });
    expect(out.groups.length).toBe(10);
    expect(out.paginationFields.truncated).toBe(false);
    expect(out.paginationFields.pageClipReason).toBe("end_of_results");
    expect(out.paginationFields.totalCollapsedGroups).toBe(50);
  });
});

describe("rewriteResponseToCollapsed — top-level shape swap", () => {
  it("replaces files[] with collapsedGroups[] and stamps plan.collapsedGroupCount", () => {
    const original: Record<string, unknown> = {
      plan: { fixesByClass: { mechanical: 4 } },
      files: [
        {
          path: "/repo/a.html",
          findings: [F({ ruleId: "r", groupKey: "g1", line: 1, column: 1 })],
        },
      ],
      truncated: false,
      totalFilesWithFindings: 1,
      meta: { tool: "ra11y" },
      nextStep: "Read the first finding.",
    };
    const out = rewriteResponseToCollapsed(original, {
      fullFiles: [
        {
          path: "/repo/a.html",
          findings: [
            F({ ruleId: "r", groupKey: "g1", line: 1, column: 1 }),
            F({ ruleId: "r", groupKey: "g1", line: 2, column: 1 }),
          ],
        },
        {
          path: "/repo/b.html",
          findings: [F({ ruleId: "r", groupKey: "g2", line: 5, column: 1 })],
        },
      ],
      pageParams: { limit: 25, offset: 0 },
    });
    expect(out["files"]).toBeUndefined();
    expect(out["totalFilesWithFindings"]).toBeUndefined();
    expect(Array.isArray(out["collapsedGroups"])).toBe(true);
    const groups = out["collapsedGroups"] as readonly CollapsedGroup[];
    expect(groups.length).toBe(2);
    // Cross-surface count invariant: plan.collapsedGroupCount is the
    // post-collapse count, alongside the un-collapsed
    // plan.fixesByClass tally already on `plan`.
    expect((out["plan"] as Record<string, unknown>)["collapsedGroupCount"]).toBe(2);
    expect((out["plan"] as Record<string, unknown>)["fixesByClass"]).toEqual({ mechanical: 4 });
    // Pagination fields ship at the top level, with the per-group counter.
    expect(out["totalCollapsedGroups"]).toBe(2);
    expect(out["truncated"]).toBe(false);
    // Sibling fields untouched.
    expect(out["meta"]).toEqual({ tool: "ra11y" });
    expect(out["nextStep"]).toBe("Read the first finding.");
  });

  it("drops referenceGuide on the collapsed shape (per-file hoist target does not apply)", () => {
    const original: Record<string, unknown> = {
      plan: { fixesByClass: {} },
      files: [],
      truncated: false,
      totalFilesWithFindings: 0,
      referenceGuide: { fixDescriptions: { r: { abc: "long prose" } } },
      meta: {},
      nextStep: "...",
    };
    const out = rewriteResponseToCollapsed(original, {
      fullFiles: [],
      pageParams: { limit: 25, offset: 0 },
    });
    expect(out["referenceGuide"]).toBeUndefined();
  });

  it("leaves slim envelopes alone (filesArrayDropped: true)", () => {
    const slim: Record<string, unknown> = {
      plan: {},
      files: [],
      filesArrayDropped: true,
      truncated: true,
      totalFilesWithFindings: 5000,
      meta: {},
      warnings: ["response_dropped_files_oversize"],
      nextStep: "Scope down.",
    };
    const out = rewriteResponseToCollapsed(slim, {
      fullFiles: [],
      pageParams: { limit: 25, offset: 0 },
    });
    expect(out).toBe(slim);
  });
});
