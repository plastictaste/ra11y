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
    // `truncated: true` + `totalFilesWithFindings` are load-bearing on
    // the slim path: the response dropped per-file findings to fit
    // under the host ceiling, so the truncation flag must reflect that
    // (an agent reading `files: []` with `truncated: null/absent`
    // cannot distinguish "clean scan" from "envelope clipped"). Inventory
    // size rides alongside so the agent knows how many files were
    // dropped, not just that some were. Symmetric to the density-cap
    // path's stamping of the same flag in `mergeBudgetedFields`.
    expect(response.truncated).toBe(true);
    expect(response.totalFilesWithFindings).toBe(formatted.files.length);
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

  it("preserves prior warning codes (density-cap chain) and stamps `truncated: true` on the slim envelope", () => {
    // Combined regime — token-budget cap fires AND the post-density
    // envelope still exceeds the host ceiling. The slim builder runs
    // off the post-density `original`, which already carries
    // `response_token_budget_truncated` in `warnings[]` and `truncated:
    // true` from `mergeBudgetedFields`. The slim shape MUST preserve
    // both signals — drop them and the agent loses visibility into
    // which clip pass produced the empty `files[]`. Equivalent to the
    // doctrine's "Oversize-success is ambiguous failure" applied to
    // the warning chain: every code that fired earlier in the assembly
    // remains in the wire `warnings`. Assertion on the flag covers the
    // `response_token_budget_truncated`/`truncated: null` regression
    // the slim builder used to introduce by stripping pagination
    // fields when it rebuilt the envelope from scratch.
    const session = new McpSession();
    const formatted = buildMinimalFormatted();
    // Synthetic bloat plus a baseWarnings surface on `original` —
    // simulates the density-cap having fired before the slim guard
    // kicks in by passing `response_token_budget_truncated` through
    // `baseWarnings` so `assembleScanProjectResponse`'s spread merges
    // it onto the tentative response.
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
          truncated: true,
          totalFilesWithFindings: 50,
          requestedLimit: 50,
          effectiveLimit: 1,
          pageClipReason: "token_density",
          nextOffset: 1,
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
        bloatedField: hugePayload,
      },
      baseWarnings: ["response_token_budget_truncated"],
      baseWarningsDetails: {
        response_token_budget_truncated: {
          requestedLimit: 50,
          effectiveLimit: 1,
          reason: "token_density",
        },
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // The slim path engaged (oversize fallback) so files[] is empty.
    expect(response.files).toEqual([]);
    // `truncated: true` is required regardless of which clip pass
    // fired first — Q10 invariant: whenever
    // `response_token_budget_truncated` OR `response_dropped_files_oversize`
    // is in `warnings[]`, the top-level flag must be `true`.
    expect(response.truncated).toBe(true);

    const warnings = response.warnings as readonly string[];
    // Both codes ride together on the wire — the density cap fired
    // first (carried in via `baseWarnings`), the oversize guard fired
    // second. Order isn't asserted, only co-presence.
    expect(warnings).toContain("response_token_budget_truncated");
    expect(warnings).toContain("response_dropped_files_oversize");

    // The structured `warningsDetails` payload preserves the prior
    // density-cap settlement and stamps the new oversize byte-arithmetic
    // alongside it — both keys present, neither overwriting the other.
    const details = response.warningsDetails as Record<string, unknown>;
    expect(details.response_token_budget_truncated).toBeDefined();
    expect(details.response_dropped_files_oversize).toBeDefined();
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
    // Symmetric Q10 assertion: when neither clip pass fires, the
    // top-level `truncated` flag rides as `false` — the paginator's
    // negative answer survives untouched ("this IS the full inventory").
    expect(response.truncated).toBe(false);
  });
});
