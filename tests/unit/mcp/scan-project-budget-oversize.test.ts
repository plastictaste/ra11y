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
      fixesByClass: {
        mechanical: { source: 1, buildArtifact: 0 },
        guidance: { source: 0, buildArtifact: 0 },
        runtimeOnly: { source: 0, buildArtifact: 0 },
        verifyInSource: { source: 0, buildArtifact: 0 },
      },
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
    // `filesArrayDropped: true` disambiguates the slim path's empty
    // `files[]` from the density-cap path's surviving-head shape: both
    // stamp `truncated: true` but only the slim path drops every per-
    // file entry. Without this flag an agent cannot tell "envelope
    // dropped all per-file detail" from "envelope kept some, trimmed
    // others" by reading the truncation pair alone — the canonical
    // "Truncated containers must rename or sentinel" silent-distinction
    // failure mode.
    expect(response.filesArrayDropped).toBe(true);
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
      droppedFileCountFromRequestedLimit: number;
      totalFilesWithFindings: number;
    };
    expect(dropPayload).toBeDefined();
    expect(dropPayload.preDropBytes).toBeGreaterThan(dropPayload.hardCeilingBytes);
    expect(dropPayload.hardCeilingBytes).toBeGreaterThan(0);
    expect(dropPayload.droppedFileCountFromRequestedLimit).toBeGreaterThanOrEqual(0);
    // The pre-cap inventory denominator must always ship — without
    // it, an agent seeing only the post-cap drop count would silently
    // underread the corpus on a bulk-vendor scan where the density
    // cap clipped most of the inventory before the slim guard fired.
    // The synthetic fixture has 1 file in `formatted.files`, so the
    // sibling counter ships 1 here; the integration assertion that
    // pins `total >= dropped + emitted` lives in
    // `tests/integration/mcp-tools.test.ts`.
    expect(dropPayload.totalFilesWithFindings).toBeGreaterThanOrEqual(
      dropPayload.droppedFileCountFromRequestedLimit,
    );

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
        fixesByClass: {
          mechanical: { source: 2, buildArtifact: 0 },
          guidance: { source: 0, buildArtifact: 0 },
          runtimeOnly: { source: 0, buildArtifact: 0 },
          verifyInSource: { source: 0, buildArtifact: 0 },
        },
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
        fixesByClass: {
          mechanical: { source: 1, buildArtifact: 0 },
          guidance: { source: 0, buildArtifact: 0 },
          runtimeOnly: { source: 0, buildArtifact: 0 },
          verifyInSource: { source: 0, buildArtifact: 0 },
        },
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
          sortOrder: "alphabetical-by-path",
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
    // The slim path's empty `files[]` is structurally distinct from
    // the density-cap path's surviving-head shape: the
    // `filesArrayDropped: true` sibling flag rides on the slim
    // envelope even when the density cap fired first, so the agent
    // can tell which clip pass produced the empty `files[]` without
    // counting entries.
    expect(response.filesArrayDropped).toBe(true);

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

  it("trims verbose plan and warningsDetails arrays so the slim envelope serializes under 50 KB on a synthetic bulk corpus", () => {
    // Synthetic bulk-corpus repro: even with `files[]` dropped and the
    // top-level meta keys slimmed via SLIM_META_KEYS, the surviving
    // envelope can still serialize over the minimum-envelope target on
    // bulk-vendor corpora because verbose arrays accrete past the
    // budget — `plan.topRules` (10 long ruleId entries), warning-details
    // payloads carrying scanner-derived path lists
    // (`bulk_catalog_detected.suggestedExcludes`,
    // `scanned_minified_file.files`, `scss_unresolved_variables.files`).
    // The slim path now head-slices each of these to a small
    // deterministic prefix and stamps the pre-trim length on
    // `warningsDetails.response_dropped_files_oversize.slimTruncations`
    // so the agent reads the truncation gap.
    //
    // Assertion: the post-slim envelope JSON.stringify length is
    // ≤ 50000 chars — well under the MCP host's ~25k-token (~96000
    // char) wall, and under the minimum-envelope target the doctrine
    // names. Without the trim, the same fixture serializes past the
    // target on the verbose-array tail.
    const session = new McpSession();
    // Build a `formatted.plan` with a populated topRules tail
    // (10 entries, ~250 chars each by docstring). Use deterministic
    // long-ish ruleIds so the wire shape stays reproducible.
    const longRuleIds = Array.from(
      { length: 10 },
      (_, i) => `aria/longish-rule-name-with-suffix-token-number-${i.toString().padStart(2, "0")}`,
    );
    const formatted: Parameters<typeof assembleScanProjectResponse>[0]["formatted"] = {
      plan: {
        notes: 0,
        fixesByClass: {
          mechanical: { source: 250, buildArtifact: 0 },
          guidance: { source: 100, buildArtifact: 0 },
          runtimeOnly: { source: 0, buildArtifact: 0 },
          verifyInSource: { source: 50, buildArtifact: 0 },
        },
        reviewNeeded: 17,
        manualOnly: 5,
        estimatedEffort: "large",
        summary: longRuleIds.map((id, i) => `${id} (${(10 - i) * 30})`).join(", "),
        topRules: longRuleIds.map((id, i) => ({
          ruleId: id,
          count: (10 - i) * 30,
          topFile: `vendor/bootstrap/components/${id.replace(/\//g, "-")}-densest-fixture-file.css`,
        })),
      },
      // Single tiny file in the inventory — the slim path drops files
      // anyway, so its size doesn't affect the post-slim envelope.
      files: [{ path: "src/example.tsx", findings: [] }],
      meta: {},
    };
    // Synthetic bulk warning-details: each long-ish list-bearing payload
    // mirrors what a bulk-vendor corpus would emit — 50+ entries per
    // array, ~70 chars/entry, multiple list payloads riding together.
    const minifiedFiles = Array.from(
      { length: 60 },
      (_, i) => `vendor/bundles/dist/widget-${i.toString().padStart(3, "0")}.min.js`,
    );
    const scssFiles = Array.from(
      { length: 40 },
      (_, i) => `themes/legacy/scss/_partials/_variables-${i.toString().padStart(3, "0")}.scss`,
    );
    const suggestedExcludes = Array.from(
      { length: 12 },
      (_, i) => `**/vendor-pattern-${i.toString().padStart(2, "0")}-glob/**`,
    );
    // Synthetic bloat: push the response into the slim path. The
    // bloat field gets dropped on the slim path (it lives outside
    // SLIM_META_KEYS), so the post-slim envelope only carries the
    // verbose arrays the trim is supposed to cap.
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
        bloatedField: hugePayload,
      },
      baseWarnings: ["bulk_catalog_detected", "scanned_minified_file", "scss_unresolved_variables"],
      baseWarningsDetails: {
        bulk_catalog_detected: {
          trigger: "bulk_and_vendor_heavy",
          durationMs: 12000,
          filesScanned: 4000,
          buildArtifactsCount: 996,
          suggestedExcludes,
          topVendorFile: "vendor/bundles/dist/widget-000.min.js",
        },
        scanned_minified_file: { files: minifiedFiles },
        scss_unresolved_variables: { files: scssFiles },
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // The slim envelope engaged.
    expect(response.files).toEqual([]);
    expect(response.filesArrayDropped).toBe(true);

    // Post-slim envelope size is the load-bearing assertion. Without
    // the verbose-array trim, the envelope on this fixture serializes
    // around 80–90 KB; with the trim it lands under 50 KB.
    const serialized = JSON.stringify(response);
    expect(serialized.length).toBeLessThanOrEqual(50_000);

    // The trim left a deterministic head-slice on each verbose array.
    const slimPlan = response.plan as Record<string, unknown>;
    const slimTopRules = slimPlan.topRules as readonly unknown[];
    expect(slimTopRules.length).toBe(3);
    const details = response.warningsDetails as Record<string, Record<string, unknown>>;
    expect((details.bulk_catalog_detected.suggestedExcludes as readonly unknown[]).length).toBe(5);
    expect((details.scanned_minified_file.files as readonly unknown[]).length).toBe(3);
    expect((details.scss_unresolved_variables.files as readonly unknown[]).length).toBe(3);

    // The truncation summary names every trimmed array with shown/total
    // pairs. Without these, an agent reading the slim envelope cannot
    // tell "this array was trimmed" from "this array was always small"
    // — the canonical "Truncated containers must rename or sentinel,
    // not retain" silent-distinction failure mode.
    const dropPayload = details.response_dropped_files_oversize as {
      slimTruncations?: readonly { fieldPath: string; shown: number; total: number }[];
    };
    expect(dropPayload.slimTruncations).toBeDefined();
    const truncations = dropPayload.slimTruncations ?? [];
    const byPath = new Map(truncations.map((t) => [t.fieldPath, t]));
    expect(byPath.get("plan.topRules")).toEqual({
      fieldPath: "plan.topRules",
      shown: 3,
      total: 10,
    });
    expect(byPath.get("warningsDetails.bulk_catalog_detected.suggestedExcludes")).toEqual({
      fieldPath: "warningsDetails.bulk_catalog_detected.suggestedExcludes",
      shown: 5,
      total: 12,
    });
    expect(byPath.get("warningsDetails.scanned_minified_file.files")).toEqual({
      fieldPath: "warningsDetails.scanned_minified_file.files",
      shown: 3,
      total: 60,
    });
    expect(byPath.get("warningsDetails.scss_unresolved_variables.files")).toEqual({
      fieldPath: "warningsDetails.scss_unresolved_variables.files",
      shown: 3,
      total: 40,
    });
  });

  it("omits slimTruncations when no verbose array crossed its cap", () => {
    // When the slim path fires but every plan/warningsDetails array is
    // already under-cap, the truncation summary is absent —
    // present-when-meaningful per CLAUDE.md §1 "Ambiguous field shapes
    // are dishonest." The agent reading the slim envelope sees no
    // `slimTruncations` field and concludes "no verbose array was
    // trimmed" rather than "the empty array means anything specific."
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
        bloatedField: hugePayload,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    const details = response.warningsDetails as Record<string, Record<string, unknown>>;
    const dropPayload = details.response_dropped_files_oversize as {
      slimTruncations?: readonly unknown[];
    };
    expect(dropPayload.slimTruncations).toBeUndefined();
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
    // `filesArrayDropped` is present-when-meaningful — it only rides
    // on the slim envelope path. On a clean pass-through the field is
    // absent (not `false`); the agent reads `files[]` directly when
    // no truncation engaged.
    expect(response.filesArrayDropped).toBeUndefined();
  });

  it("emits `truncated_files_dropped` with rule-level arithmetic on the slim envelope path when files-with-findings get dropped", () => {
    // Q9 — the slim envelope ships
    // `files: []`, dropping the entire `formatted.files` set from the
    // wire. The agent reading the byte-level
    // `response_dropped_files_oversize` payload knows files were
    // dropped but has zero signal about which rule families just
    // disappeared. The new code closes the silent-miss gap with a
    // per-rule tally.
    const session = new McpSession();
    const formatted: Parameters<typeof assembleScanProjectResponse>[0]["formatted"] = {
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
            { ruleId: "keyboard/handler-missing" } as never,
            { ruleId: "keyboard/handler-missing" } as never,
          ],
        },
        {
          path: "src/b.tsx",
          findings: [{ ruleId: "aria/icon-child-missing-aria-hidden" } as never],
        },
        {
          path: "src/c.tsx",
          findings: [{ ruleId: "forms/labels-required" } as never],
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

    // Slim envelope engaged.
    expect(response.files).toEqual([]);
    expect(response.filesArrayDropped).toBe(true);

    const warnings = response.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    expect(warnings).toContain("truncated_files_dropped");

    const details = response.warningsDetails as Record<string, Record<string, unknown>>;
    const tfdPayload = details.truncated_files_dropped as {
      droppedFileCount: number;
      ruleFamiliesAffected: readonly string[];
      topDroppedRules: readonly { ruleId: string; droppedCount: number }[];
    };
    expect(tfdPayload.droppedFileCount).toBe(3);
    // Sorted alphabetically.
    expect(tfdPayload.ruleFamiliesAffected).toEqual(["aria", "forms", "keyboard"]);
    // Top by count, alphabetical tie-break.
    expect(tfdPayload.topDroppedRules).toEqual([
      { ruleId: "keyboard/handler-missing", droppedCount: 2 },
      { ruleId: "aria/icon-child-missing-aria-hidden", droppedCount: 1 },
      { ruleId: "forms/labels-required", droppedCount: 1 },
    ]);
  });

  it("emits `truncated_files_dropped` on the density-cap path with rule-level arithmetic of the dropped tail", () => {
    // Q9 — the density cap drops trailing
    // files when the assembled response crosses
    // `DEFAULT_TOKEN_BUDGET_CHARS`. The dropped tail's per-rule
    // arithmetic ships alongside the byte-level
    // `response_token_budget_truncated` payload so the agent can
    // decide whether to widen `limit` or scope down based on which
    // rule families just disappeared from the wire.
    //
    // Synthetic bloat strategy: each file carries one finding with a
    // long-string `message` that pushes the per-file payload to ~10
    // KB, and ten files in the inventory. The assembled response
    // crosses 88 KB, the density cap drops the tail, and the
    // surviving head plus the dropped tail give the assertion fixtures
    // a deterministic shape to read.
    const session = new McpSession();
    // ~10 KB of bloat per finding — enough to ensure dropped tail
    // crosses the budget when the inventory is large enough.
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
    // Files alphabetical-by-path so the density cap drops tail (z*)
    // before head (a*) — matches `discoverFiles` ordering.
    const files: Parameters<typeof assembleScanProjectResponse>[0]["formatted"]["files"] =
      Array.from({ length: 10 }, (_, i) => ({
        path: `src/${String.fromCharCode(97 + i)}.tsx`,
        findings: [
          buildFinding(
            i < 5 ? "keyboard/handler-missing" : "aria/icon-child-missing-aria-hidden",
            i + 1,
          ) as never,
        ],
      }));
    const formatted: Parameters<typeof assembleScanProjectResponse>[0]["formatted"] = {
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
      files,
      meta: {},
    };
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
        filesScanned: 10,
        durationMs: 5,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // The density cap fired (some files dropped); the slim envelope
    // did NOT fire (post-density envelope fits under the host
    // ceiling). Both warnings ride together.
    const warnings = response.warnings as readonly string[];
    expect(warnings).toContain("response_token_budget_truncated");
    expect(warnings).toContain("truncated_files_dropped");
    // Slim path NOT engaged on this fixture — files[] still carries
    // the surviving head, not the dropped-everything sentinel.
    const survivingFiles = response.files as readonly unknown[];
    expect(survivingFiles.length).toBeGreaterThan(0);
    expect(survivingFiles.length).toBeLessThan(formatted.files.length);
    expect(response.filesArrayDropped).toBeUndefined();

    const details = response.warningsDetails as Record<string, Record<string, unknown>>;
    const tfdPayload = details.truncated_files_dropped as {
      droppedFileCount: number;
      ruleFamiliesAffected: readonly string[];
      topDroppedRules: readonly { ruleId: string; droppedCount: number }[];
    };
    expect(tfdPayload).toBeDefined();
    // The dropped count equals the number of files trimmed off the
    // tail (alphabetical-by-path order). Survivor count + dropped
    // count = full inventory.
    expect(tfdPayload.droppedFileCount).toBe(formatted.files.length - survivingFiles.length);
    // The dropped tail is z..f (0-indexed positions 5..9 in the
    // alphabetical inventory) — those are the `aria/*` rule, matching
    // the fixture's split. Assertion is on family membership rather
    // than exact count because the density cap's drop count is a
    // function of `applyTokenBudget`'s greedy trim regime.
    expect(tfdPayload.ruleFamiliesAffected).toContain("aria");
    expect(tfdPayload.topDroppedRules.length).toBeGreaterThan(0);
    expect(tfdPayload.topDroppedRules[0]?.ruleId).toBe("aria/icon-child-missing-aria-hidden");
  });

  it("does not emit `truncated_files_dropped` when the slim envelope drops zero files-with-findings (synthetic empty-findings inventory)", () => {
    // Defensive: when the dropped subset carries zero findings (the
    // single file in the inventory had `findings: []`), the warning
    // is suppressed alongside its payload — "Ambiguous field shapes
    // are dishonest" applied to the rule-level surface.
    const session = new McpSession();
    const formatted = buildMinimalFormatted();
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
        bloatedField: hugePayload,
      },
      nextStep: "Call suggest_fix on the first finding.",
    }) as Record<string, unknown>;

    // Slim envelope engaged.
    expect(response.filesArrayDropped).toBe(true);
    const warnings = response.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    expect(warnings).not.toContain("truncated_files_dropped");
    const details = response.warningsDetails as Record<string, unknown>;
    expect(details.truncated_files_dropped).toBeUndefined();
  });
});
