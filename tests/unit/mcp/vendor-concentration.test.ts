/**
 * Unit tests for the vendor-aware per-rule-coverage enrichment helper.
 *
 * Scope:
 *   - Engine-emitted `concentration: { file, count }` is the input;
 *     the MCP-layer helper stamps `kind: "vendor"` when the densest
 *     file is in the vendor path set AND the count clears the
 *     stricter vendor-only floor.
 *   - Findings stay on every row unchanged — this is additive
 *     telemetry, not a filter. The tests pin the additive property
 *     at the row-level (other fields pass through).
 *   - Empty vendor set short-circuits to identity.
 *   - Rows below the floor (even on a vendor file) stay unkinded —
 *     the base concentration still surfaces, vendor awareness only
 *     fires when the cluster is big enough to be unambiguous noise.
 *   - Rows on authored files stay unkinded regardless of count.
 */

import { describe, expect, it } from "bun:test";
import {
  enrichPerRuleCoverageWithVendorConcentration,
  VENDOR_CONCENTRATION_MIN_TOTAL,
} from "../../../src/mcp/vendor-concentration.ts";
import type { PerRuleCoverage } from "../../../src/types/violation.ts";

function row(
  ruleId: string,
  concentration?: { file: string; count: number; kind?: "vendor" },
): PerRuleCoverage {
  const findingsEmitted = concentration?.count ?? 0;
  return {
    ruleId,
    filesEvaluated: 10,
    filesEligible: 10,
    findingsEmitted,
    fired: findingsEmitted > 0,
    coverageConfidence: "high",
    ...(concentration === undefined ? {} : { concentration }),
  };
}

describe("enrichPerRuleCoverageWithVendorConcentration", () => {
  it("stamps kind: vendor when the densest file is vendor AND count >= floor", () => {
    const input: readonly PerRuleCoverage[] = [
      row("motion/pause-stop-hide", { file: "vendor/bootstrap.css", count: 8940 }),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched[0]!.concentration).toEqual({
      file: "vendor/bootstrap.css",
      count: 8940,
      kind: "vendor",
    });
  });

  it("leaves the row unkinded when the count is below the vendor floor", () => {
    // Below the floor, the base concentration still surfaces —
    // vendor awareness is additive, not a new gate.
    const input: readonly PerRuleCoverage[] = [
      row("motion/pause-stop-hide", {
        file: "vendor/bootstrap.css",
        count: VENDOR_CONCENTRATION_MIN_TOTAL - 1,
      }),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched[0]!.concentration).toEqual({
      file: "vendor/bootstrap.css",
      count: VENDOR_CONCENTRATION_MIN_TOTAL - 1,
    });
    expect(enriched[0]!.concentration?.kind).toBeUndefined();
  });

  it("stamps at the inclusive boundary (exactly VENDOR_CONCENTRATION_MIN_TOTAL)", () => {
    const input: readonly PerRuleCoverage[] = [
      row("motion/pause-stop-hide", {
        file: "vendor/bootstrap.css",
        count: VENDOR_CONCENTRATION_MIN_TOTAL,
      }),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched[0]!.concentration?.kind).toBe("vendor");
  });

  it("leaves authored-file concentration unkinded regardless of count", () => {
    // A rule that fires 200 times on `src/app.tsx` is authored —
    // the densest file isn't in the vendor set, so no vendor tag.
    const input: readonly PerRuleCoverage[] = [
      row("forms/autocomplete-missing", { file: "src/app.tsx", count: 200 }),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched[0]!.concentration).toEqual({
      file: "src/app.tsx",
      count: 200,
    });
    expect(enriched[0]!.concentration?.kind).toBeUndefined();
  });

  it("short-circuits to the input reference when the vendor set is empty", () => {
    const input: readonly PerRuleCoverage[] = [
      row("motion/pause-stop-hide", { file: "vendor/bootstrap.css", count: 8940 }),
    ];
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, new Set());
    expect(enriched).toBe(input);
  });

  it("returns the input reference when no row was rewritten", () => {
    // Vendor set is populated but no concentration row matches —
    // helper returns the input by identity so downstream consumers
    // can cheap-check "nothing changed."
    const input: readonly PerRuleCoverage[] = [
      row("forms/autocomplete-missing", { file: "src/app.tsx", count: 200 }),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched).toBe(input);
  });

  it("handles rows without concentration as pass-through", () => {
    const input: readonly PerRuleCoverage[] = [row("no-concentration/rule")];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched).toBe(input);
    expect(enriched[0]!.concentration).toBeUndefined();
  });

  it("enriches a mixed array — vendor dominant + authored dominant + below-floor vendor + no concentration", () => {
    // Mirrors a real scan: one rule clusters on vendor CSS (tagged),
    // one on authored code (unkinded, high count), one on vendor but
    // below the floor (unkinded), and one with no concentration at
    // all (passes through). Pins the per-row independence.
    const input: readonly PerRuleCoverage[] = [
      row("motion/pause-stop-hide", { file: "vendor/bootstrap.css", count: 8940 }),
      row("forms/autocomplete-missing", { file: "src/app.tsx", count: 150 }),
      row("aria/icon-font-hidden", { file: "vendor/fa.css", count: 30 }),
      row("wrapper/drift"),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css", "vendor/fa.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    // Vendor-dominant — kind stamped.
    expect(enriched[0]!.concentration).toEqual({
      file: "vendor/bootstrap.css",
      count: 8940,
      kind: "vendor",
    });
    // Authored-dominant — no stamp.
    expect(enriched[1]!.concentration?.kind).toBeUndefined();
    // Vendor file, below floor — no stamp but base concentration survives.
    expect(enriched[2]!.concentration).toEqual({ file: "vendor/fa.css", count: 30 });
    // No concentration — row passes through untouched.
    expect(enriched[3]!.concentration).toBeUndefined();
  });

  it("idempotent on an already-annotated row", () => {
    // Defensive — if the helper runs twice (e.g. during migration
    // of call sites), the second pass must not mutate or re-stamp.
    const input: readonly PerRuleCoverage[] = [
      row("motion/pause-stop-hide", {
        file: "vendor/bootstrap.css",
        count: 8940,
        kind: "vendor",
      }),
    ];
    const vendorPaths = new Set(["vendor/bootstrap.css"]);
    const enriched = enrichPerRuleCoverageWithVendorConcentration(input, vendorPaths);
    expect(enriched).toBe(input);
    expect(enriched[0]!.concentration?.kind).toBe("vendor");
  });
});
