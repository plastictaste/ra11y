/**
 * Unit tests for `applyBulkVendorScopeDownOverride` — the seam in
 * `src/mcp/tool-scan-project.ts` that swaps `nextStep` from the
 * standard `suggest_fix` first call to a structural scope-down hint
 * when the corpus shape (≥ 10 build-artifact basename groups AND
 * > 50 files-with-findings) tells us the agent's first action belongs
 * in `propose_config` / `additionalPaths` narrowing rather than in a
 * per-finding fix.
 *
 * The reroute helpers themselves are unit-tested in
 * `next-step.test.ts`; this file pins the wiring at the
 * `tool-scan-project` seam: feed the override a baseline next-step
 * plus a mock `buildArtifacts.metaField`, confirm that the override
 * fires only when both thresholds clear, and that the structured
 * hint switches to `propose_config` while the prose names the top
 * suggestedGlobs inline.
 */

import { describe, expect, it } from "bun:test";
import type { BuildArtifactsGrouped } from "../../../src/mcp/build-artifacts.ts";
import { applyBulkVendorScopeDownOverride } from "../../../src/mcp/tool-scan-project.ts";

const BASE_NEXT_STEP = {
  prose: "Call suggest_fix on vendor/bootstrap.css:42 (rule contrast/minimum).",
  structured: {
    tool: "suggest_fix",
    args: { ruleId: "contrast/minimum", file: "vendor/bootstrap.css", line: 42 },
  },
} as const;

function syntheticGrouped(count: number): BuildArtifactsGrouped {
  // Deterministic count-descending order matches what the production
  // grouper emits — `bulkVendorScopeDownNextStep` trusts that order.
  return {
    grouped: Array.from({ length: count }, (_, i) => ({
      basename: `vendor-${i}.css`,
      count: 50 - i,
      pathHint: `vendor/lib-${i}/`,
      classifications: ["likely-bundler-output-dir" as const],
      suggestedGlob: `**/vendor-${i}.css`,
    })),
    classified: [],
  };
}

describe("applyBulkVendorScopeDownOverride", () => {
  it("returns baseNextStep unchanged when no build-artifact groups exist", () => {
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: { metaField: {} },
      totalFilesWithFindings: 100,
    });
    expect(result).toEqual(BASE_NEXT_STEP);
  });

  it("returns baseNextStep unchanged on a small vendor-light scan", () => {
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(2) },
      },
      totalFilesWithFindings: 8,
    });
    expect(result).toEqual(BASE_NEXT_STEP);
  });

  it("returns baseNextStep unchanged when groupedCount clears but inventory does not", () => {
    // 12 vendor groups in a 30-file authored repo — small enough that
    // standard suggest_fix routing remains the right first call.
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(12) },
      },
      totalFilesWithFindings: 30,
    });
    expect(result).toEqual(BASE_NEXT_STEP);
  });

  it("returns baseNextStep unchanged when inventory clears but groupedCount does not", () => {
    // 800-file corpus with only 5 vendor groups — still a non-bulk-
    // vendor regime; the standard nextStep wins.
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(5) },
      },
      totalFilesWithFindings: 800,
    });
    expect(result).toEqual(BASE_NEXT_STEP);
  });

  it("overrides to propose_config + scope-down prose when both thresholds clear", () => {
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(12) },
      },
      totalFilesWithFindings: 800,
    });
    // Structured switches to propose_config — the deterministic
    // exclude-emission tool, not a per-finding suggest_fix.
    expect(result.structured).toEqual({ tool: "propose_config", args: {} });
    // Prose names the top suggestedGlob entries inline so the agent
    // has paste-ready exclude paths even without the round-trip.
    expect(result.prose).toContain("**/vendor-0.css");
    expect(result.prose).toContain("ra11y.config.ts");
    expect(result.prose).toContain("exclude");
    expect(result.prose).toContain("additionalPaths");
    // Inventory + group total visible in prose so the agent reads
    // the corpus shape that triggered the reroute.
    expect(result.prose).toContain("800");
    expect(result.prose).toContain("12");
  });

  it("hands through suggestedGlob entries from the grouped meta in count-descending order", () => {
    // The grouper sorts groups by count descending; the helper trusts
    // that order. The first grouped row should be the first inline
    // glob; below-cap rows should still be available via the meta
    // pointer named in prose.
    const grouped: BuildArtifactsGrouped = {
      grouped: [
        {
          basename: "bootstrap.css",
          count: 80,
          pathHint: "vendor/bootstrap/",
          classifications: ["likely-bundler-output-dir"],
          suggestedGlob: "**/bootstrap.css",
        },
        {
          basename: "fontawesome.css",
          count: 40,
          pathHint: "vendor/fa/",
          classifications: ["likely-bundler-output-dir"],
          suggestedGlob: "**/fontawesome.css",
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          basename: `extra-${i}.css`,
          count: 5,
          pathHint: `vendor/extra-${i}/`,
          classifications: ["likely-bundler-output-dir" as const],
          suggestedGlob: `**/extra-${i}.css`,
        })),
      ],
      classified: [],
    };
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: { metaField: { scannedBuildArtifacts: grouped } },
      totalFilesWithFindings: 1500,
    });
    expect(result.prose).toContain("**/bootstrap.css");
    expect(result.prose).toContain("**/fontawesome.css");
    // Above the 5-entry inline cap, residue gets pointed at via meta.
    expect(result.prose).toContain("scannedBuildArtifacts.grouped");
  });

  it("promotes structured target to scan_project restrictToPaths when a dominant non-vendor subtree exists", () => {
    // Bulk-vendor regime fires (12 grouped basename clusters, 800
    // files-with-findings) AND the inventory carries a clear non-
    // vendor dominant top-level dir (`src/` with 3 authored files vs.
    // the vendor pathHints `vendor/lib-N/`). The structured args
    // advance from the existing `propose_config` route to the direct
    // `scan_project` re-scan with `restrictToPaths: ["src"]` so the
    // agent's next call directly scopes down without reading prose
    // and without round-tripping through `propose_config`. Per the
    // backlog item: `suggestedExcludes` is shaped for config edits;
    // `nextStepStructured.args` should propagate the inverse — a
    // concrete narrowing path — for the immediate next call.
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(12) },
      },
      totalFilesWithFindings: 800,
      files: [
        { path: "src/components/button.tsx", findings: [{ ruleId: "color/contrast" }] },
        { path: "src/pages/home.tsx", findings: [{ ruleId: "alt/missing" }] },
        { path: "src/utils/format.tsx", findings: [{ ruleId: "color/contrast" }] },
        // vendor entry (matches the synthetic `vendor/lib-0/` pathHint)
        // — must be excluded from the non-vendor tally.
        { path: "vendor/lib-0/bundle.css", findings: [{ ruleId: "color/contrast" }] },
      ] as never,
    });
    expect(result.structured).toEqual({
      tool: "scan_project",
      args: { restrictToPaths: ["src"] },
    });
    // Prose stays unchanged from the propose_config override — both
    // levers are still named so the agent retains full flexibility.
    expect(result.prose).toContain("ra11y.config.ts");
    expect(result.prose).toContain("propose_config");
  });

  it("falls back to propose_config when every top-level dir resolves to vendor (no honest narrowing target)", () => {
    // Bulk-vendor regime fires but the inventory itself is all-
    // vendor: every top-level dir matches a `pathHint` prefix, so
    // `pickNonVendorNarrowingDir` honestly returns `undefined` rather
    // than fabricating a narrowing target on weaker evidence (per the
    // doctrine "Heuristic emission is the symmetric twin of heuristic
    // suppression"). The override degrades to the existing
    // `propose_config` route — the prose still names paste-ready
    // suggestedGlob entries for the agent to act on.
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(12) },
      },
      totalFilesWithFindings: 800,
      files: [
        // every file lives under a `vendor/lib-N/` pathHint matched
        // by the synthetic grouped fixture — no non-vendor subtree.
        { path: "vendor/lib-0/bundle.css", findings: [] },
        { path: "vendor/lib-1/bundle.css", findings: [] },
        { path: "vendor/lib-2/bundle.css", findings: [] },
      ] as never,
    });
    expect(result.structured).toEqual({ tool: "propose_config", args: {} });
  });

  it("falls back to propose_config when non-vendor file inventory has no clear dominant top-level dir", () => {
    // Bulk-vendor regime fires but the non-vendor file inventory
    // ties at the top — two top-level dirs each carry one authored
    // file with one finding. `pickNonVendorNarrowingDir` returns
    // `undefined` on a clean tie (alphabetical-winner routing is the
    // failure mode the AI-first doctrine "NextStep prioritization on
    // truncated/bulk responses must avoid first-by-filename routing"
    // guards against). The override degrades to `propose_config`.
    const result = applyBulkVendorScopeDownOverride({
      baseNextStep: BASE_NEXT_STEP,
      buildArtifacts: {
        metaField: { scannedBuildArtifacts: syntheticGrouped(12) },
      },
      totalFilesWithFindings: 800,
      files: [
        { path: "src/foo.tsx", findings: [{ ruleId: "color/contrast" }] },
        { path: "lib/bar.tsx", findings: [{ ruleId: "color/contrast" }] },
      ] as never,
    });
    expect(result.structured).toEqual({ tool: "propose_config", args: {} });
  });
});
