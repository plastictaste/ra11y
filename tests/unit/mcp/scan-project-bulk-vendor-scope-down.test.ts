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
    ungrouped: [],
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
      ungrouped: [],
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
});
