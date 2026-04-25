/**
 * Unit tests for `src/mcp/bulk-catalog.ts` — the perf-class detector
 * that fires the `bulk_catalog_detected` warning code on
 * vendor-template catalogs running over the documented 3s/1k-file
 * budget.
 *
 * Two invariants per the doctrine surface in the module header:
 *   1. The detector is additive — emitting the warning never
 *      modifies findings, severities, or response file content. We
 *      cover this indirectly by asserting `detectBulkCatalog` returns
 *      `undefined` on every below-threshold input shape so the
 *      caller's conditional-spread cleanly omits the warning channel.
 *   2. `suggestedExcludes` reflects the actual top vendor basenames
 *      in the input — no canned `bootstrap*.css` literals fire on
 *      every catalog. We pin this with a fixture whose dominant
 *      basenames are not bootstrap/font-awesome so the detector's
 *      output tracks the input rather than a default list.
 */

import { describe, expect, it } from "bun:test";
import type { ScannedBuildArtifact } from "../../../src/mcp/build-artifacts.ts";
import {
  BULK_BUILD_ARTIFACTS_FLOOR,
  BULK_FILES_SCANNED_FLOOR,
  detectBulkCatalog,
  SLOW_DURATION_MS,
  SUGGESTED_EXCLUDES_CAP,
} from "../../../src/mcp/bulk-catalog.ts";

function vendorBundle(path: string): ScannedBuildArtifact {
  return {
    path,
    classification: "likely-bundler-output-dir",
    signal: { kind: "build-dir-segment", value: "templates" },
  };
}

function manyVendorEntries(
  count: number,
  basename: string,
  prefix = "templates",
): ScannedBuildArtifact[] {
  const out: ScannedBuildArtifact[] = [];
  for (let i = 0; i < count; i++) {
    out.push(vendorBundle(`${prefix}/site-${i}/${basename}`));
  }
  return out;
}

describe("detectBulkCatalog", () => {
  it("returns undefined on a clean fast scan (every threshold below)", () => {
    const detection = detectBulkCatalog({
      durationMs: 800,
      filesScanned: 200,
      buildArtifacts: [],
    });
    expect(detection).toBeUndefined();
  });

  it("returns undefined when the duration is over budget but the build-artifact count is at the floor", () => {
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 500,
      filesScanned: 200,
      // exactly at the floor: predicate requires strictly greater
      buildArtifacts: manyVendorEntries(BULK_BUILD_ARTIFACTS_FLOOR, "bootstrap.css"),
    });
    expect(detection).toBeUndefined();
  });

  it("fires `slow_and_vendor_heavy` when durationMs is over budget AND build-artifact count clears the floor", () => {
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 3000,
      filesScanned: 1000,
      buildArtifacts: manyVendorEntries(BULK_BUILD_ARTIFACTS_FLOOR + 5, "bootstrap.css"),
    });
    expect(detection).toBeDefined();
    expect(detection?.trigger).toBe("slow_and_vendor_heavy");
    expect(detection?.durationMs).toBe(SLOW_DURATION_MS + 3000);
    expect(detection?.buildArtifactsCount).toBe(BULK_BUILD_ARTIFACTS_FLOOR + 5);
  });

  it("fires `bulk_and_vendor_heavy` when filesScanned is above the bulk floor AND build-artifact count clears the floor (without slow duration)", () => {
    const detection = detectBulkCatalog({
      durationMs: 2000, // below SLOW_DURATION_MS
      filesScanned: BULK_FILES_SCANNED_FLOOR + 100,
      buildArtifacts: manyVendorEntries(BULK_BUILD_ARTIFACTS_FLOOR + 5, "bootstrap.css"),
    });
    expect(detection).toBeDefined();
    expect(detection?.trigger).toBe("bulk_and_vendor_heavy");
  });

  it("prefers `slow_and_vendor_heavy` when both trigger paths fire (slowness is the more direct lever)", () => {
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 1,
      filesScanned: BULK_FILES_SCANNED_FLOOR + 1,
      buildArtifacts: manyVendorEntries(BULK_BUILD_ARTIFACTS_FLOOR + 1, "bootstrap.css"),
    });
    expect(detection?.trigger).toBe("slow_and_vendor_heavy");
  });

  it("returns undefined when files-scanned alone clears the bulk floor but the build-artifact count is below the floor (legitimate hand-authored corpus)", () => {
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 3000,
      filesScanned: BULK_FILES_SCANNED_FLOOR + 100,
      buildArtifacts: [],
    });
    expect(detection).toBeUndefined();
  });

  it("`suggestedExcludes` reflects the actual top vendor basenames (not a canned bootstrap/font-awesome list)", () => {
    // Build a corpus where `custom-template.css` dominates — agents
    // reading `suggestedExcludes` should see `**/custom-template.css`,
    // NOT `**/bootstrap*.css` (which would mean the detector ignored
    // its inputs and emitted a default).
    const buildArtifacts: ScannedBuildArtifact[] = [
      ...manyVendorEntries(60, "custom-template.css"),
      ...manyVendorEntries(20, "secondary.css"),
      ...manyVendorEntries(5, "tertiary.css"),
    ];
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 3000,
      filesScanned: 4000,
      buildArtifacts,
    });
    expect(detection).toBeDefined();
    expect(detection?.suggestedExcludes[0]).toBe("**/custom-template.css");
    expect(detection?.suggestedExcludes[1]).toBe("**/secondary.css");
    expect(detection?.suggestedExcludes[2]).toBe("**/tertiary.css");
  });

  it("`suggestedExcludes` is capped at SUGGESTED_EXCLUDES_CAP entries even when many basenames clear the floor", () => {
    const buildArtifacts: ScannedBuildArtifact[] = [];
    // Ten distinct dominant basenames — each with 6 instances so they
    // sort by alphabetical tie-break.
    const basenames = [
      "a.css",
      "b.css",
      "c.css",
      "d.css",
      "e.css",
      "f.css",
      "g.css",
      "h.css",
      "i.css",
      "j.css",
    ];
    for (const b of basenames) {
      buildArtifacts.push(...manyVendorEntries(6, b));
    }
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 1000,
      filesScanned: 4000,
      buildArtifacts,
    });
    expect(detection?.suggestedExcludes.length).toBe(SUGGESTED_EXCLUDES_CAP);
  });

  it("`topVendorFile` is the first build-artifact path (densest vendor signal)", () => {
    const detection = detectBulkCatalog({
      durationMs: SLOW_DURATION_MS + 1000,
      filesScanned: 1000,
      buildArtifacts: [
        vendorBundle("templates/site-0/bootstrap.css"),
        ...manyVendorEntries(BULK_BUILD_ARTIFACTS_FLOOR + 5, "other.css"),
      ],
    });
    expect(detection?.topVendorFile).toBe("templates/site-0/bootstrap.css");
  });

  it("matches the canonical V1-BULK-CATALOG-SCAN-PERF-12S repro shape (4043 files / 12188ms / 172 vendor templates)", () => {
    // Sanitized echo of the field-report numbers from the backlog
    // item: `durationMs: 12188`, 4043 files scanned, vendor bundles
    // across 172 templates. The detector should fire
    // `slow_and_vendor_heavy` because both trigger paths apply but
    // slowness wins.
    const detection = detectBulkCatalog({
      durationMs: 12188,
      filesScanned: 4043,
      buildArtifacts: [
        ...manyVendorEntries(172, "bootstrap.css"),
        ...manyVendorEntries(172, "animate.css"),
        ...manyVendorEntries(172, "font-awesome.min.css"),
      ],
    });
    expect(detection).toBeDefined();
    expect(detection?.trigger).toBe("slow_and_vendor_heavy");
    expect(detection?.durationMs).toBe(12188);
    expect(detection?.filesScanned).toBe(4043);
    expect(detection?.buildArtifactsCount).toBe(516);
    expect(detection?.suggestedExcludes).toContain("**/animate.css");
    expect(detection?.suggestedExcludes).toContain("**/bootstrap.css");
    expect(detection?.suggestedExcludes).toContain("**/font-awesome.min.css");
  });
});
