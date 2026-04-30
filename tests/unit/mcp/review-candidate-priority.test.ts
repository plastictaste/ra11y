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
  redirectTo: "consumer-override",
};

const PREDICATE_CONCEDED: ReviewCandidatePredicateConceded = {
  signal: { kind: "logotype-pattern" },
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
});
