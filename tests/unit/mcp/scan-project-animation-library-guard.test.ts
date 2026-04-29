/**
 * Unit tests for the animation-library guard detector
 * (`computeAnimationLibraryGuardCandidates`) in
 * `src/mcp/tool-scan-project.ts`.
 *
 * Doctrine: the detector is the deterministic cross-reference between
 * the banner-detected vendor-library list and the per-rule per-file
 * finding tally. Both predicate halves must hold (file in vendor list
 * AND rule fires ≥ floor on that file) before the
 * `animation_library_without_reduced_motion_guard` code earns its
 * structured payload. Surface-don't-suppress: every finding stays in
 * `files[]` regardless of the warning's emission.
 */

import { describe, expect, it } from "bun:test";
import { computeAnimationLibraryGuardCandidates } from "../../../src/mcp/scan-time-warnings.ts";

function finding(ruleId: string, severity = "error") {
  return {
    findingId: `${ruleId}#1`,
    groupKey: `${ruleId}#1`,
    ruleId,
    fixClass: "guidance" as const,
    criteria: ["wcag22:2.2.2"] as const,
    severity: severity as "error" | "warning" | "info",
    confidence: "high" as const,
    line: 1,
    column: 1,
    message: "synthetic for test",
    effort: "trivial" as const,
    // `category: "review"` is the honest pairing for `fixClass:
    // "guidance"` — no mechanical edit, so no auto-fix. See
    // {@link categorize} in src/output/agent-response/build-finding.ts.
    category: "review" as const,
    suppressWith: "ra11y-disable",
  };
}

function fileBucket(path: string, ruleId: string, count: number) {
  return {
    path,
    findings: Array.from({ length: count }, () => finding(ruleId)),
  };
}

const FLOOR = 21; // mirrors ANIMATION_LIB_GUARD_FINDING_FLOOR

describe("computeAnimationLibraryGuardCandidates", () => {
  it("emits a candidate when one rule fires ≥ floor times on a banner-detected vendor library", () => {
    // Canonical case: 27 motion/pause-stop-hide findings on an
    // animate.css clone — one finding per `.animate__*` keyframe.
    const out = computeAnimationLibraryGuardCandidates({
      vendorLibraries: [{ path: "vendor/animate.css", library: "animate.css" }],
      files: [fileBucket("vendor/animate.css", "motion/pause-stop-hide", 27)],
    });
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      ruleId: "motion/pause-stop-hide",
      file: "vendor/animate.css",
      findingCount: 27,
      library: "animate.css",
    });
    // Library-aware suggestion names the concrete edit pivot for
    // motion rules — the prefers-reduced-motion media query.
    expect(out[0]?.suggestion).toContain("prefers-reduced-motion");
    expect(out[0]?.suggestion).toContain("animate.css");
  });

  it("does NOT emit a candidate when the same finding count is split across multiple files", () => {
    // 27 findings spread across three vendor files, each ≤ 9 findings —
    // none clears the floor on its own. The (ruleId, file) granularity
    // is the load-bearing axis: the wrap-the-import remediation
    // operates per-import, so the predicate must hold per-file too.
    const out = computeAnimationLibraryGuardCandidates({
      vendorLibraries: [
        { path: "vendor/animate-a.css", library: "animate.css" },
        { path: "vendor/animate-b.css", library: "animate.css" },
        { path: "vendor/animate-c.css", library: "animate.css" },
      ],
      files: [
        fileBucket("vendor/animate-a.css", "motion/pause-stop-hide", 9),
        fileBucket("vendor/animate-b.css", "motion/pause-stop-hide", 9),
        fileBucket("vendor/animate-c.css", "motion/pause-stop-hide", 9),
      ],
    });
    expect(out).toEqual([]);
  });

  it("does NOT emit a candidate when the file is NOT in vendorLibraries (banner predicate fails)", () => {
    // Hand-authored CSS with a 27-finding spike doesn't trip the code.
    // The vendor-library banner predicate is the deterministic half;
    // without a banner match, the floor alone is not enough — encoding
    // a path-shape heuristic here would re-create the labeled-buckets
    // mistake the doctrine warns against.
    const out = computeAnimationLibraryGuardCandidates({
      vendorLibraries: [],
      files: [fileBucket("src/app.css", "motion/pause-stop-hide", 27)],
    });
    expect(out).toEqual([]);
  });

  it("does NOT emit a candidate when the count is exactly one below the floor", () => {
    const out = computeAnimationLibraryGuardCandidates({
      vendorLibraries: [{ path: "vendor/animate.css", library: "animate.css" }],
      files: [fileBucket("vendor/animate.css", "motion/pause-stop-hide", FLOOR - 1)],
    });
    expect(out).toEqual([]);
  });

  it("emits one candidate per (ruleId, file) pair when multiple rules cross the floor on the same file", () => {
    // A single vendor library that emits findings from two distinct
    // rules — each rule's tally is evaluated independently because the
    // remediation might differ (motion gets the @media wrap; another
    // rule might be a propose_config exclude). One code, multiple
    // payload candidates; the warnings dispatcher picks the densest
    // for the headline and packs the rest under additionalMatches.
    const out = computeAnimationLibraryGuardCandidates({
      vendorLibraries: [{ path: "vendor/animate.css", library: "animate.css" }],
      files: [
        {
          path: "vendor/animate.css",
          findings: [
            ...Array.from({ length: 27 }, () => finding("motion/pause-stop-hide")),
            ...Array.from({ length: 25 }, () => finding("contrast/minimum")),
          ],
        },
      ],
    });
    expect(out.length).toBe(2);
    const ruleIds = out.map((c) => c.ruleId).sort();
    expect(ruleIds).toEqual(["contrast/minimum", "motion/pause-stop-hide"]);
  });

  it("returns an empty array on empty inputs (no vendor libraries OR no files)", () => {
    expect(computeAnimationLibraryGuardCandidates({ vendorLibraries: [], files: [] })).toEqual([]);
    expect(
      computeAnimationLibraryGuardCandidates({
        vendorLibraries: [{ path: "vendor/animate.css", library: "animate.css" }],
        files: [],
      }),
    ).toEqual([]);
  });

  it("uses a generic remediation pointer for non-motion rules — the @media wrap doesn't apply", () => {
    // motion-specific rules earn the `prefers-reduced-motion` wrap;
    // other rules (canonically a contrast finding on a vendor
    // stylesheet) earn a generic exclude/suppress pointer because the
    // remediation isn't a media query.
    const out = computeAnimationLibraryGuardCandidates({
      vendorLibraries: [{ path: "vendor/bootstrap.css", library: "bootstrap" }],
      files: [fileBucket("vendor/bootstrap.css", "contrast/minimum", 30)],
    });
    expect(out.length).toBe(1);
    expect(out[0]?.suggestion).not.toContain("prefers-reduced-motion");
    expect(out[0]?.suggestion).toContain("exclude");
  });
});
