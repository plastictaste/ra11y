/**
 * wire-path test for
 * `assembleScanProjectResponse` — verifies the assembler engages the
 * minimum-honest envelope fallback when the post-density-cap response
 * still crosses the host-ceiling sentinel.
 *
 * The unit tests in `oversize-envelope.test.ts` cover the helper's
 * invariants in isolation. This file exercises the wiring at the
 * assembler seam: confirms that on a synthetic full-meta block large
 * enough to keep the response over the hard ceiling regardless of
 * file-count trim, the assembler returns the slim envelope with
 * `warnings: ["response_dropped_files_oversize"]`,
 * `warningsDetails.response_dropped_files_oversize` carrying the
 * byte-arithmetic, and `files: []`.
 *
 * No subprocess spawn — calls the assembler directly with a synthetic
 * `McpSession` + minimal `formatted` shape so the test stays fast and
 * focused on the response-shape contract.
 */

import { describe, expect, it } from "bun:test";
import { assembleScanProjectResponse } from "../../../src/mcp/scan-project-budget.ts";
import { McpSession } from "../../../src/mcp/session.ts";
import type { ScanFormatted } from "../../../src/mcp/tools-helpers.ts";

function buildMinimalFormatted(): ScanFormatted {
  return {
    plan: {
      notes: 0,
      fixesByClass: { mechanical: 1, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
      reviewNeeded: 0,
      manualOnly: 0,
      estimatedEffort: "trivial",
      summary: "1 finding",
    },
    files: [
      {
        path: "src/example.tsx",
        findings: [],
      },
    ],
    meta: {},
  };
}

describe("assembleScanProjectResponse — Q8 oversize-envelope guard", () => {
  it("degrades to minimum-honest envelope when meta-dominated response exceeds host ceiling", () => {
    // Force the over-ceiling regime by stuffing the meta with a
    // synthetic field large enough to push the assembled envelope
    // over the hard ceiling. The slim path drops files[] entirely and
    // ships the warning code + payload.
    const session = new McpSession();
    const formatted = buildMinimalFormatted();
    const hugePayload = "x".repeat(200_000);
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: {
        files: formatted.files,
        referenceGuide: undefined,
      },
      page: {
        files: formatted.files,
        paginationFields: {
          truncated: false,
          totalFilesWithFindings: 1,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: 1,
        durationMs: 5,
        configSource: null,
        bloatedField: hugePayload,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // The slim shape keeps `plan` + `meta` (slimmed) + `nextStep` +
    // the warnings channel. `files[]` ships as `[]` (the agent's
    // recovery path is to re-call with narrower scope; the per-file
    // findings come back on that call).
    expect(response.plan).toEqual(formatted.plan);
    expect(response.files).toEqual([]);
    expect(typeof response.nextStep).toBe("string");
    expect((response.nextStep as string).length).toBeGreaterThan(0);
    expect(response.nextStepStructured).toBeDefined();
    const structured = response.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_project");
    // The structured next-call must NOT echo the caller's cwd unchanged
    // — that would re-issue the same scope that just over-flowed. The
    // narrower target is derived from `formatted.files`: the single
    // authored `src/example.tsx` resolves the top-level dir `src`, so
    // `restrictToPaths: ["src"]` differs from the failing call's `cwd`.
    expect(structured.args).toEqual({ restrictToPaths: ["src"] });
    expect(structured.args.cwd).toBeUndefined();

    // Warnings channel carries the structured code + payload.
    const warnings = response.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = response.warningsDetails as Record<string, unknown>;
    const dropPayload = details["response_dropped_files_oversize"] as {
      preDropBytes: number;
      hardCeilingBytes: number;
      droppedFileCount: number;
    };
    expect(dropPayload).toBeDefined();
    expect(dropPayload.preDropBytes).toBeGreaterThan(dropPayload.hardCeilingBytes);
    expect(dropPayload.hardCeilingBytes).toBeGreaterThan(0);
    expect(dropPayload.droppedFileCount).toBeGreaterThanOrEqual(0);

    // Per "Truncated containers must rename or sentinel, not retain"
    // (doctrine): when the slim builder strips top-level `meta`
    // sub-fields to fit under budget, the wire must signal which keys
    // got dropped — name retention without sentinel is the worst-case
    // shape because the surviving `meta` looks like a populated
    // container. The `metaFieldsDropped` payload names every top-level
    // key the full meta carried that the slim builder discarded so an
    // agent reading the surviving slim block can distinguish
    // "no scan-confidence concerns" from "block was clipped."
    const droppedFields = (dropPayload as { metaFieldsDropped?: readonly string[] })
      .metaFieldsDropped;
    expect(droppedFields).toBeDefined();
    expect(droppedFields).toContain("bloatedField");

    // The slim meta dropped the bloat field (only known scan-confidence
    // keys survive). `bloatedField` was synthetic; verify it didn't
    // ride along.
    const meta = response.meta as Record<string, unknown>;
    expect(meta).not.toHaveProperty("bloatedField");
    // `tool` + `version` + `filesScanned` + `configSource` survive the
    // slim — they're the load-bearing scan-confidence telemetry.
    expect(meta.tool).toBe("scan_project");
    expect(meta.version).toBe("0.1.0");
    expect(meta.filesScanned).toBe(1);
  });

  it("derives a non-vendor restrictToPaths target when scannedBuildArtifacts marks vendor paths", () => {
    // When the slim envelope fires AND the file inventory mixes vendor
    // (classified) and non-vendor paths, the structured next-call must
    // point at the non-vendor subtree via `restrictToPaths` rather than
    // echoing the caller's cwd. The narrowing dir is the top-level dir
    // with the most non-vendor findings — `src` here, since the vendor
    // entries are routed through scannedBuildArtifacts.
    const session = new McpSession();
    const formatted: Parameters<typeof assembleScanProjectResponse>[0]["formatted"] = {
      plan: {
        notes: 0,
        fixesByClass: { mechanical: 2, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
        reviewNeeded: 0,
        manualOnly: 0,
        estimatedEffort: "small",
        summary: "2 findings",
      },
      files: [
        { path: "vendor/bootstrap/bootstrap.css", findings: [] },
        { path: "vendor/bootstrap/bootstrap.min.css", findings: [] },
        { path: "src/components/button.tsx", findings: [] },
        { path: "src/components/input.tsx", findings: [] },
      ],
      meta: {},
    };
    const hugePayload = "x".repeat(200_000);
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: {
        files: formatted.files,
        referenceGuide: undefined,
      },
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
        filesScanned: formatted.files.length,
        durationMs: 5,
        bloatedField: hugePayload,
        scannedBuildArtifacts: {
          grouped: [
            {
              basename: "bootstrap.css",
              count: 2,
              pathHint: "vendor/bootstrap",
              classifications: ["likely-bundler-output-dir"],
              suggestedGlob: "vendor/bootstrap/**",
            },
          ],
          ungrouped: [],
        },
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    const structured = response.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_project");
    // The structured args target a strictly narrower scope than the
    // caller's cwd. `restrictToPaths` names the non-vendor top-level
    // dir derived from the file inventory; `cwd` is dropped (echoing
    // it would re-issue the failing call).
    expect(structured.args).toEqual({ restrictToPaths: ["src"] });
    expect(structured.args.cwd).toBeUndefined();
  });

  it("ships empty args when every file in the inventory is vendor-classified", () => {
    // All-vendor edge case: no non-vendor narrowing target exists, so
    // the args degrade to `{}` rather than echo the caller's cwd. The
    // agent reads the prose and picks a recovery knob; the structured
    // form does NOT re-issue the failing call.
    const session = new McpSession();
    const formatted: Parameters<typeof assembleScanProjectResponse>[0]["formatted"] = {
      plan: {
        notes: 0,
        fixesByClass: { mechanical: 1, guidance: 0, runtimeOnly: 0, verifyInSource: 0 },
        reviewNeeded: 0,
        manualOnly: 0,
        estimatedEffort: "trivial",
        summary: "1 finding",
      },
      files: [
        { path: "dist/bundle.css", findings: [] },
        { path: "dist/bundle.min.css", findings: [] },
      ],
      meta: {},
    };
    const hugePayload = "x".repeat(200_000);
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: {
        files: formatted.files,
        referenceGuide: undefined,
      },
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
        filesScanned: formatted.files.length,
        durationMs: 5,
        bloatedField: hugePayload,
        scannedBuildArtifacts: {
          grouped: [
            {
              basename: "bundle.css",
              count: 2,
              pathHint: "dist",
              classifications: ["likely-bundler-output-dir"],
              suggestedGlob: "dist/**",
            },
          ],
          ungrouped: [],
        },
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    const structured = response.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_project");
    expect(structured.args).toEqual({});
    expect(structured.args.cwd).toBeUndefined();
  });

  it("passes through unchanged when the response fits under the host ceiling", () => {
    // No synthetic bloat — the natural response is well under the
    // ceiling. The fallback must NOT engage; the warnings channel
    // stays free of the `response_dropped_files_oversize` code.
    const session = new McpSession();
    const formatted = buildMinimalFormatted();
    const response = assembleScanProjectResponse({
      params: { cwd: "/tmp/example-project" },
      session,
      formatted,
      hoisted: {
        files: formatted.files,
        referenceGuide: undefined,
      },
      page: {
        files: formatted.files,
        paginationFields: {
          truncated: false,
          totalFilesWithFindings: 1,
        },
      },
      pageOffset: 0,
      fullMeta: {
        tool: "scan_project",
        version: "0.1.0",
        standards: ["wcag22"],
        level: "AA",
        filesScanned: 1,
        durationMs: 5,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // Files array survives intact (the assembler kept the per-file
    // entry). No oversize warning fired.
    const files = response.files as readonly unknown[];
    expect(files.length).toBe(1);
    const warnings = (response.warnings as readonly string[] | undefined) ?? [];
    expect(warnings).not.toContain("response_dropped_files_oversize");
  });
});
