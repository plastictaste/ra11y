/**
 * Unit tests for the shared `review-candidate-priority` resolver.
 * Pinned per `docs/kb/architecture/ai-first-consumer.md` "Per-tool
 * review-candidate shape must agree across surfaces" — `scan_file`
 * and `checklist` both consume this module so the same conceptual
 * candidate ranks identically across the two surfaces.
 *
 * Three axes the resolver covers:
 *   - level → base priority (A/AA → high, AAA → medium, fallback → medium)
 *   - per-candidate downgrade gates (hedging, vendorContext, predicateConceded)
 *   - cross-criterion union → strongest-attention level
 */

import { describe, expect, it } from "bun:test";
import {
  buildCriterionLevelMap,
  candidateHedges,
  couldBeWrongBecauseForVendorBuildArtifact,
  highestCandidateConfidence,
  resolvePriorityForCandidate,
  resolvePriorityForReviewCandidate,
  strongestAttentionLevel,
} from "../../../src/mcp/review-candidate-priority.ts";
import type {
  ReviewCandidate,
  ReviewCandidatePredicateConceded,
  ReviewCandidateVendorContext,
} from "../../../src/types/review.ts";

const VENDOR_CONTEXT: ReviewCandidateVendorContext = {
  signal: { kind: "vendor-bundle-basename" },
};

const PREDICATE_CONCEDED: ReviewCandidatePredicateConceded = {
  evidence: 'alt="Acme logo"',
};

describe("resolvePriorityForCandidate — level → base priority", () => {
  it("level A → high", () => {
    expect(
      resolvePriorityForCandidate({ level: "A", evidence: { reason: "ordinary reason" } }),
    ).toBe("high");
  });

  it("level AA → high", () => {
    expect(
      resolvePriorityForCandidate({ level: "AA", evidence: { reason: "ordinary reason" } }),
    ).toBe("high");
  });

  it("level AAA → medium (no downgrade applies because base is already medium)", () => {
    expect(
      resolvePriorityForCandidate({ level: "AAA", evidence: { reason: "ordinary reason" } }),
    ).toBe("medium");
  });

  it("undefined level → medium (default-down posture)", () => {
    expect(
      resolvePriorityForCandidate({ level: undefined, evidence: { reason: "ordinary reason" } }),
    ).toBe("medium");
  });

  it("unknown level (e.g. 'base') → medium", () => {
    expect(
      resolvePriorityForCandidate({ level: "base", evidence: { reason: "ordinary reason" } }),
    ).toBe("medium");
  });
});

describe("resolvePriorityForCandidate — downgrade gates", () => {
  it("hedging reason text downgrades AA from high to medium", () => {
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: {
          reason: "if this is a standalone single-page file the criterion may not apply",
        },
      }),
    ).toBe("medium");
  });

  it("vendorContext downgrades AA from high to medium", () => {
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: { reason: "ordinary reason", vendorContext: VENDOR_CONTEXT },
      }),
    ).toBe("medium");
  });

  it("predicateConceded downgrades A from high to medium", () => {
    expect(
      resolvePriorityForCandidate({
        level: "A",
        evidence: { reason: "ordinary reason", predicateConceded: PREDICATE_CONCEDED },
      }),
    ).toBe("medium");
  });

  it("downgrade gates do not apply when base is already medium (AAA stays medium)", () => {
    expect(
      resolvePriorityForCandidate({
        level: "AAA",
        evidence: { reason: "ordinary reason", vendorContext: VENDOR_CONTEXT },
      }),
    ).toBe("medium");
  });

  it("low-confidence downgrades AA from high to medium", () => {
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: { reason: "ordinary reason", confidence: "low" },
      }),
    ).toBe("medium");
  });

  it("low-confidence downgrades A from high to medium", () => {
    expect(
      resolvePriorityForCandidate({
        level: "A",
        evidence: { reason: "ordinary reason", confidence: "low" },
      }),
    ).toBe("medium");
  });

  it("medium confidence keeps high (no downgrade applies)", () => {
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: { reason: "ordinary reason", confidence: "medium" },
      }),
    ).toBe("high");
  });

  it("high confidence keeps high (no downgrade applies)", () => {
    expect(
      resolvePriorityForCandidate({
        level: "A",
        evidence: { reason: "ordinary reason", confidence: "high" },
      }),
    ).toBe("high");
  });

  it("low confidence has no effect when base is already medium (AAA stays medium)", () => {
    expect(
      resolvePriorityForCandidate({
        level: "AAA",
        evidence: { reason: "ordinary reason", confidence: "low" },
      }),
    ).toBe("medium");
  });
});

describe("resolvePriorityForCandidate — minified-vendor-no-sourcemap downgrade-to-low", () => {
  it("vendorPathHint + isBuildArtifact on AA drops to low (not medium)", () => {
    // The two-component co-occurrence gate runs ahead of the existing
    // vendorContext / hedging / low-confidence gates so a candidate
    // whose evidence concedes BOTH vendor-path-shape AND build-
    // artifact-confirmed-bytes drops attention budget all the way to
    // "low" — the doctrine line "Reason / priority / fix-description
    // must agree across all three channels" applied at the limit case
    // where the cited evidence (a single-letter identifier in minified
    // bundle) cannot be resolved without a sourcemap.
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: { reason: "setTimeout call", vendorPathHint: true, isBuildArtifact: true },
      }),
    ).toBe("low");
  });

  it("vendorPathHint + isBuildArtifact on A drops to low", () => {
    expect(
      resolvePriorityForCandidate({
        level: "A",
        evidence: { reason: "setTimeout call", vendorPathHint: true, isBuildArtifact: true },
      }),
    ).toBe("low");
  });

  it("vendorPathHint alone (no build-artifact classification) keeps existing gate behavior", () => {
    // First leg fires but the second does not — the existing fallthrough
    // logic applies. Without vendorContext / hedging / low confidence, the
    // candidate stays at "high" so the vendorPathHint-only case (a hand-
    // readable jquery-1.10.2.js with a real session-timeout setTimeout)
    // doesn't get silently demoted just because the basename pattern matched.
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: { reason: "setTimeout call", vendorPathHint: true },
      }),
    ).toBe("high");
  });

  it("isBuildArtifact alone (no vendorPathHint) keeps existing gate behavior", () => {
    // Symmetric: a build-artifact classification on a non-vendor file
    // (e.g. an authored CSS file the build pipeline tagged) does not
    // trigger the gate by itself — the vendor-path-shape evidence is
    // what shifts the predicate-strength from "agent reads the file" to
    // "agent needs a sourcemap." Stays at "high" pending other gates.
    expect(
      resolvePriorityForCandidate({
        level: "A",
        evidence: { reason: "setTimeout call", isBuildArtifact: true },
      }),
    ).toBe("high");
  });

  it("both flags present on AAA stays medium (base never qualifies for low)", () => {
    // AAA defaults to base "medium"; the gate only fires when base is
    // "high" so AAA candidates are unaffected even when both axes hold.
    expect(
      resolvePriorityForCandidate({
        level: "AAA",
        evidence: { reason: "setTimeout call", vendorPathHint: true, isBuildArtifact: true },
      }),
    ).toBe("medium");
  });

  it("gate runs ahead of vendorContext gate (drops to low, not medium)", () => {
    // Both conditions hold AND vendorContext is present (the canonical
    // case for a minified bundle: the timing finder populates BOTH
    // vendorContext via buildVendorContext AND vendorPathHint via the
    // same predicate). The minified-vendor-no-sourcemap gate must run
    // first so the priority drops to "low" rather than the
    // vendorContext gate intercepting and stopping at "medium".
    expect(
      resolvePriorityForCandidate({
        level: "AA",
        evidence: {
          reason: "setTimeout call",
          vendorContext: { signal: { kind: "minified-shape" } },
          vendorPathHint: true,
          isBuildArtifact: true,
        },
      }),
    ).toBe("low");
  });
});

describe("couldBeWrongBecauseForVendorBuildArtifact — paired evidence stamp", () => {
  it("returns ['minified_vendor_no_sourcemap'] when both axes fire", () => {
    expect(
      couldBeWrongBecauseForVendorBuildArtifact({
        reason: "setTimeout call",
        vendorPathHint: true,
        isBuildArtifact: true,
      }),
    ).toEqual(["minified_vendor_no_sourcemap"]);
  });

  it("returns null when vendorPathHint absent", () => {
    expect(
      couldBeWrongBecauseForVendorBuildArtifact({
        reason: "setTimeout call",
        isBuildArtifact: true,
      }),
    ).toBeNull();
  });

  it("returns null when isBuildArtifact absent", () => {
    expect(
      couldBeWrongBecauseForVendorBuildArtifact({
        reason: "setTimeout call",
        vendorPathHint: true,
      }),
    ).toBeNull();
  });

  it("returns null on neither axis", () => {
    // Ordinary authored-source candidate — the helper returns null so
    // the materializer's conditional spread leaves the
    // `couldBeWrongBecause` field omitted (per CLAUDE.md §1 "Ambiguous
    // field shapes are dishonest" — never sentinel-empty).
    expect(
      couldBeWrongBecauseForVendorBuildArtifact({
        reason: "ordinary",
      }),
    ).toBeNull();
  });
});

describe("candidateHedges — token list", () => {
  it("matches 'may not apply' (case-insensitive)", () => {
    expect(candidateHedges({ reason: "this MAY NOT APPLY here" })).toBe(true);
  });

  it("matches 'only if'", () => {
    expect(candidateHedges({ reason: "fires only if iteration-count is set" })).toBe(true);
  });

  it("matches 'verify…before'", () => {
    expect(candidateHedges({ reason: "verify the inheritance chain before relying on this" })).toBe(
      true,
    );
  });

  it("matches 'if this is'", () => {
    expect(candidateHedges({ reason: "if this is a single-page app the criterion …" })).toBe(true);
  });

  it("matches 'Cross-file check: grep'", () => {
    expect(candidateHedges({ reason: "Cross-file check: grep the selector in your HTML" })).toBe(
      true,
    );
  });

  it("does not match generic 'verify' guidance without 'before'", () => {
    expect(candidateHedges({ reason: "verify the heading order is logical" })).toBe(false);
  });
});

describe("strongestAttentionLevel — cross-criterion union", () => {
  const levels = new Map<string, string>([
    ["wcag22:1.1.1", "A"],
    ["wcag22:1.4.3", "AA"],
    ["wcag22:1.4.6", "AAA"],
    ["section508:1194.22(c)", "base"],
  ]);

  it("returns A when any criterion is A", () => {
    expect(strongestAttentionLevel(["wcag22:1.4.6", "wcag22:1.1.1"], levels)).toBe("A");
  });

  it("returns AA when AA is present and no A", () => {
    expect(strongestAttentionLevel(["wcag22:1.4.6", "wcag22:1.4.3"], levels)).toBe("AA");
  });

  it("returns AAA when only AAA is present", () => {
    expect(strongestAttentionLevel(["wcag22:1.4.6"], levels)).toBe("AAA");
  });

  it("returns the first non-WCAG level when no A/AA/AAA present", () => {
    expect(strongestAttentionLevel(["section508:1194.22(c)"], levels)).toBe("base");
  });

  it("returns undefined when no criterion is in the lookup map", () => {
    expect(strongestAttentionLevel(["unknown:9.9.9"], levels)).toBeUndefined();
  });

  it("ignores unknown criteria when others resolve", () => {
    expect(strongestAttentionLevel(["unknown:1", "wcag22:1.1.1"], levels)).toBe("A");
  });
});

describe("highestCandidateConfidence — folded confidence rollup", () => {
  it("returns null on an empty list", () => {
    expect(highestCandidateConfidence([])).toBeNull();
  });

  it("returns the only confidence when one candidate", () => {
    expect(highestCandidateConfidence([{ confidence: "medium" }])).toBe("medium");
  });

  it("takes the highest across the union", () => {
    expect(
      highestCandidateConfidence([
        { confidence: "low" },
        { confidence: "high" },
        { confidence: "medium" },
      ]),
    ).toBe("high");
  });
});

describe("buildCriterionLevelMap — single-pass over standards", () => {
  it("flattens criteria from multiple standards into one lookup", () => {
    const map = buildCriterionLevelMap([
      {
        criteria: [
          { id: "wcag22:1.1.1", level: "A" },
          { id: "wcag22:1.4.3", level: "AA" },
        ],
      },
      {
        criteria: [{ id: "section508:1194.22(c)", level: "base" }],
      },
    ]);
    expect(map.get("wcag22:1.1.1")).toBe("A");
    expect(map.get("wcag22:1.4.3")).toBe("AA");
    expect(map.get("section508:1194.22(c)")).toBe("base");
    expect(map.size).toBe(3);
  });
});

describe("resolvePriorityForReviewCandidate — single-criterion convenience", () => {
  it("looks up the candidate's own criterionId for level resolution", () => {
    const candidate: ReviewCandidate = {
      criterionId: "wcag22:1.4.3",
      location: { filePath: "/p", line: 1, column: 0 },
      reason: "ordinary",
      confidence: "medium",
    };
    const levels = new Map<string, string>([["wcag22:1.4.3", "AA"]]);
    expect(resolvePriorityForReviewCandidate({ candidate, criterionLevels: levels })).toBe("high");
  });

  it("downgrades when the candidate carries vendorContext", () => {
    const candidate: ReviewCandidate = {
      criterionId: "wcag22:1.4.3",
      location: { filePath: "/p", line: 1, column: 0 },
      reason: "ordinary",
      confidence: "medium",
      vendorContext: VENDOR_CONTEXT,
    };
    const levels = new Map<string, string>([["wcag22:1.4.3", "AA"]]);
    expect(resolvePriorityForReviewCandidate({ candidate, criterionLevels: levels })).toBe(
      "medium",
    );
  });

  it("downgrades when the candidate ships confidence: low (heuristic evidence)", () => {
    const candidate: ReviewCandidate = {
      criterionId: "wcag22:1.4.3",
      location: { filePath: "/p", line: 1, column: 0 },
      reason: "ordinary",
      confidence: "low",
    };
    const levels = new Map<string, string>([["wcag22:1.4.3", "AA"]]);
    expect(resolvePriorityForReviewCandidate({ candidate, criterionLevels: levels })).toBe(
      "medium",
    );
  });

  it("drops to 'low' when vendorPathHint candidate's path is in buildArtifactPaths", () => {
    // Two-component minified-vendor-no-sourcemap gate via the convenience
    // overload: the candidate carries `vendorPathHint: true` and the
    // caller-supplied set lists the candidate's filePath as a build
    // artifact. Mirrors the per-candidate gate the dedup materializer
    // runs so `resolvePriorityForReviewCandidate` agrees with the path
    // scan_file/scan_project take through `dedupeReviewCandidatesForSingleFile`.
    const candidate: ReviewCandidate = {
      criterionId: "wcag22:2.2.1",
      location: { filePath: "/vendor/jquery.min.js", line: 1, column: 0 },
      reason: "setTimeout call",
      confidence: "medium",
      vendorPathHint: true,
    };
    const levels = new Map<string, string>([["wcag22:2.2.1", "A"]]);
    const buildArtifactPaths = new Set(["/vendor/jquery.min.js"]);
    expect(
      resolvePriorityForReviewCandidate({ candidate, criterionLevels: levels, buildArtifactPaths }),
    ).toBe("low");
  });

  it("stays 'high' when vendorPathHint set but path NOT in buildArtifactPaths", () => {
    // First leg fires but the second does not — a hand-readable
    // jquery-1.10.2.js whose basename matches the vendor pattern but
    // whose content didn't trip the build-artifact classifier (no
    // `.min.` infix, no long-line predicate). Stays "high" so the agent
    // still budgets attention against grounded vendor candidates whose
    // evidence is honestly readable.
    const candidate: ReviewCandidate = {
      criterionId: "wcag22:2.2.1",
      location: { filePath: "/vendor/jquery.js", line: 1, column: 0 },
      reason: "setTimeout call",
      confidence: "medium",
      vendorPathHint: true,
    };
    const levels = new Map<string, string>([["wcag22:2.2.1", "A"]]);
    const buildArtifactPaths = new Set(["/something/else.min.js"]);
    expect(
      resolvePriorityForReviewCandidate({ candidate, criterionLevels: levels, buildArtifactPaths }),
    ).toBe("high");
  });
});
