/**
 * Pins the canonical drop-count formulation on
 * `warningsDetails.truncated_files_dropped`. Per the AI-first doctrine
 * "Truncation reporters must reconcile across warnings" and the
 * field-doc on `truncated_files_dropped.droppedFileCount` in
 * `warnings.ts`, the canonical drop count is
 *
 *   droppedFileCount === totalFilesWithFindings - files.length
 *
 * — the count of files-with-findings the response kept off the wire,
 * NOT just the page-internal tail-trim. On a paginated bulk-vendor scan
 * where the paginator restricted the page below the full inventory AND
 * the density cap further trimmed the page, the older
 * `droppedFiles.length` formulation undercounted by the paginator-
 * skipped sub-inventory. The canonical formulation reconciles with the
 * `totalFilesWithFindings` denominator on the same response so the
 * agent reads "shipped vs. unshipped" by subtracting `files.length`
 * directly.
 *
 * The page-internal trim count survives as a separate
 * `pageClipFromRequestedLimit` scalar — present-when-meaningful — so
 * the agent can still distinguish "this page's tail trim" (recoverable
 * by narrower scope) from "paginator-skipped inventory" (recoverable
 * by `nextOffset`) without re-deriving from cross-reading.
 *
 * Synthetic fixture: 71 files-with-findings, page restricted to 25,
 * density cap trims to 1. Older formulation reported
 * `droppedFileCount: 24` (page-tail subset only); canonical
 * formulation reports `droppedFileCount: 70` (= 71 - 1). The
 * `pageClipFromRequestedLimit: 24` rides alongside as the page-tail
 * decomposition. This is the exact scenario named in the field report
 * — a 3× undercount on the silent-drop counter.
 */

import { describe, expect, it } from "bun:test";
import { assembleScanProjectResponse } from "../../src/mcp/scan-project-budget.ts";
import { McpSession } from "../../src/mcp/session.ts";
import type { ScanFormatted } from "../../src/mcp/tools-helpers.ts";

interface TruncatedFilesDroppedPayload {
  readonly droppedFileCount: number;
  readonly pageClipFromRequestedLimit?: number;
  readonly ruleFamiliesAffected: readonly string[];
  readonly topDroppedRules: readonly { readonly ruleId: string; readonly droppedCount: number }[];
}

function readTruncatedFilesDropped(
  response: Record<string, unknown>,
): TruncatedFilesDroppedPayload | undefined {
  const details = response["warningsDetails"] as Record<string, unknown> | undefined;
  if (details === undefined) return undefined;
  return details["truncated_files_dropped"] as TruncatedFilesDroppedPayload | undefined;
}

describe("warningsDetails.truncated_files_dropped — canonical drop-count formulation", () => {
  it("density-cap path: droppedFileCount === totalFilesWithFindings - files.length on a paginated bulk scan", () => {
    // Synthetic bulk-vendor regime: 71 files-with-findings in the full
    // inventory; the paginator already sliced the page to the first 25;
    // the density cap further trims the page to a small head when
    // bloated finding payloads push the assembled response over
    // `DEFAULT_TOKEN_BUDGET_CHARS`. The combined unshipped subset is
    // (71 - shipped). The page-internal trim (25 - shipped) is the
    // smaller subset previously reported as the drop count.
    const session = new McpSession();
    const bloat = "x".repeat(10_000);
    const buildFinding = (ruleId: string, line: number) => ({
      findingId: `${ruleId}@${line}`,
      groupKey: ruleId,
      ruleId,
      fixClass: "guidance",
      criteria: ["wcag22:2.1.1"],
      severity: "error",
      confidence: "high",
      line,
      column: 1,
      message: `${bloat} ${ruleId}`,
    });
    const TOTAL_FILES = 71;
    const PAGE_SIZE = 25;
    const fullInventory: ScanFormatted["files"] = Array.from({ length: TOTAL_FILES }, (_, i) => ({
      path: `src/file-${String(i).padStart(3, "0")}.tsx`,
      findings: [
        buildFinding(
          i % 2 === 0 ? "keyboard/handler-missing" : "aria/icon-child-missing-aria-hidden",
          i + 1,
        ) as never,
      ],
    }));
    const page = fullInventory.slice(0, PAGE_SIZE);
    const formatted: ScanFormatted = {
      plan: {
        notes: 0,
        fixesByClass: {
          mechanical: { source: 0, buildArtifact: 0 },
          guidance: { source: TOTAL_FILES, buildArtifact: 0 },
          runtimeOnly: { source: 0, buildArtifact: 0 },
          verifyInSource: { source: 0, buildArtifact: 0 },
        },
        reviewNeeded: 0,
        manualOnly: 0,
        estimatedEffort: "small",
        summary: `${TOTAL_FILES} findings`,
      },
      files: fullInventory,
      meta: {},
    };
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: { files: page, referenceGuide: undefined },
      page: {
        files: page,
        paginationFields: {
          truncated: true,
          totalFilesWithFindings: TOTAL_FILES,
          requestedLimit: PAGE_SIZE,
          effectiveLimit: PAGE_SIZE,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: TOTAL_FILES,
        durationMs: 5,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // Slim envelope must NOT engage on this fixture — files[] should
    // still carry a non-empty surviving head so the test exercises the
    // density-cap path, not the slim path. (The slim path's drop count
    // is already canonical on its own — it drops the entire inventory.)
    expect(response.filesArrayDropped).toBeUndefined();
    const survivingFiles = response.files as readonly unknown[];
    expect(survivingFiles.length).toBeGreaterThan(0);
    expect(survivingFiles.length).toBeLessThan(PAGE_SIZE);

    const warnings = response.warnings as readonly string[];
    expect(warnings).toContain("response_token_budget_truncated");
    expect(warnings).toContain("truncated_files_dropped");

    const tfdPayload = readTruncatedFilesDropped(response);
    expect(tfdPayload).toBeDefined();
    if (tfdPayload === undefined) return;

    // CANONICAL drop count: the response's totalFilesWithFindings
    // minus the response's actually-shipped files.length. This is the
    // headline equality the field-report bug regressed: the older
    // formulation reported just the page-internal tail-trim
    // (PAGE_SIZE - survivingFiles.length), undercounting by the
    // paginator-skipped sub-inventory (TOTAL_FILES - PAGE_SIZE).
    expect(tfdPayload.droppedFileCount).toBe(TOTAL_FILES - survivingFiles.length);
    // Page-internal trim count rides as a separate scalar — distinct
    // from the canonical headline so the agent has both axes without
    // re-deriving. On this fixture, the gap between
    // `droppedFileCount` and `pageClipFromRequestedLimit` equals the
    // paginator-skipped subset (TOTAL_FILES - PAGE_SIZE).
    expect(tfdPayload.pageClipFromRequestedLimit).toBe(PAGE_SIZE - survivingFiles.length);
    expect(tfdPayload.droppedFileCount - (tfdPayload.pageClipFromRequestedLimit ?? 0)).toBe(
      TOTAL_FILES - PAGE_SIZE,
    );
  });

  it("slim-envelope path: droppedFileCount === totalFilesWithFindings; pageClipFromRequestedLimit omitted (would equal canonical)", () => {
    // The slim envelope drops the full inventory (`files: []`), so the
    // page-internal trim equals the canonical drop count. Per
    // "Sibling fields naming the same concept must use one shape," the
    // helper omits `pageClipFromRequestedLimit` when it would carry
    // the same value as `droppedFileCount` — present-when-meaningful.
    const session = new McpSession();
    const formatted: ScanFormatted = {
      plan: {
        notes: 0,
        fixesByClass: {
          mechanical: { source: 4, buildArtifact: 0 },
          guidance: { source: 0, buildArtifact: 0 },
          runtimeOnly: { source: 0, buildArtifact: 0 },
          verifyInSource: { source: 0, buildArtifact: 0 },
        },
        reviewNeeded: 0,
        manualOnly: 0,
        estimatedEffort: "small",
        summary: "4 findings",
      },
      files: [
        {
          path: "src/a.tsx",
          findings: [
            { ruleId: "keyboard/handler-missing", severity: "error" } as never,
            { ruleId: "keyboard/handler-missing", severity: "error" } as never,
          ],
        },
        {
          path: "src/b.tsx",
          findings: [{ ruleId: "aria/icon-child-missing-aria-hidden", severity: "error" } as never],
        },
        {
          path: "src/c.tsx",
          findings: [{ ruleId: "forms/labels-required", severity: "error" } as never],
        },
      ],
      meta: {},
    };
    const hugePayload = "x".repeat(200_000);
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: { files: formatted.files, referenceGuide: undefined },
      page: {
        files: formatted.files,
        paginationFields: {
          truncated: false,
          totalFilesWithFindings: formatted.files.length,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: 3,
        durationMs: 5,
        configSource: null,
        bloatedField: hugePayload,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // Slim envelope must engage on this fixture so the test exercises
    // the slim path (not the density-cap path).
    expect(response.filesArrayDropped).toBe(true);
    expect((response.files as readonly unknown[]).length).toBe(0);

    const tfdPayload = readTruncatedFilesDropped(response);
    expect(tfdPayload).toBeDefined();
    if (tfdPayload === undefined) return;

    // Canonical drop count equals the entire inventory (slim shipped 0
    // files, totalFilesWithFindings = 3).
    expect(tfdPayload.droppedFileCount).toBe(formatted.files.length);
    // pageClipFromRequestedLimit omitted because it would equal
    // droppedFileCount — sibling fields naming the same concept.
    expect(tfdPayload.pageClipFromRequestedLimit).toBeUndefined();
  });

  it("density-cap on a full-inventory page: pageClipFromRequestedLimit omitted (page == total)", () => {
    // When the paginator restricted the page to exactly the full
    // inventory size (no paginator-skipped subset) AND the density cap
    // trims, the canonical drop count equals the page-internal trim;
    // the helper omits `pageClipFromRequestedLimit` to satisfy the
    // "no sibling fields naming the same concept" rule.
    const session = new McpSession();
    const bloat = "x".repeat(10_000);
    const buildFinding = (ruleId: string, line: number) => ({
      findingId: `${ruleId}@${line}`,
      groupKey: ruleId,
      ruleId,
      fixClass: "guidance",
      criteria: ["wcag22:2.1.1"],
      severity: "error",
      confidence: "high",
      line,
      column: 1,
      message: `${bloat} ${ruleId}`,
    });
    const inventory: ScanFormatted["files"] = Array.from({ length: 10 }, (_, i) => ({
      path: `src/${String.fromCharCode(97 + i)}.tsx`,
      findings: [
        buildFinding(
          i < 5 ? "keyboard/handler-missing" : "aria/icon-child-missing-aria-hidden",
          i + 1,
        ) as never,
      ],
    }));
    const formatted: ScanFormatted = {
      plan: {
        notes: 0,
        fixesByClass: {
          mechanical: { source: 0, buildArtifact: 0 },
          guidance: { source: 10, buildArtifact: 0 },
          runtimeOnly: { source: 0, buildArtifact: 0 },
          verifyInSource: { source: 0, buildArtifact: 0 },
        },
        reviewNeeded: 0,
        manualOnly: 0,
        estimatedEffort: "small",
        summary: "10 findings",
      },
      files: inventory,
      meta: {},
    };
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: { files: inventory, referenceGuide: undefined },
      page: {
        files: inventory,
        paginationFields: {
          truncated: false,
          totalFilesWithFindings: inventory.length,
          requestedLimit: 10,
          effectiveLimit: 10,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: inventory.length,
        durationMs: 5,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    expect(response.filesArrayDropped).toBeUndefined();
    const surviving = response.files as readonly unknown[];
    expect(surviving.length).toBeGreaterThan(0);
    expect(surviving.length).toBeLessThan(inventory.length);

    const tfdPayload = readTruncatedFilesDropped(response);
    expect(tfdPayload).toBeDefined();
    if (tfdPayload === undefined) return;
    expect(tfdPayload.droppedFileCount).toBe(inventory.length - surviving.length);
    // No paginator-skipped subset (page == total inventory), so the
    // canonical and page-internal counts agree; the helper omits the
    // page-internal field to satisfy "Sibling fields naming the same
    // concept must use one shape."
    expect(tfdPayload.pageClipFromRequestedLimit).toBeUndefined();
  });
});
