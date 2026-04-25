/**
 * Unit tests for {@link analyzeTopContributor} (Q7-RESPONSE-TOKEN-BUDGET-DETAIL).
 *
 * Invariants this exercises that survive refactors:
 *
 *   - Empty input → `{}` (no contributor fields). Conditional-spread
 *     at the call site keeps the wire payload honest per "ambiguous
 *     field shapes are dishonest."
 *   - Unambiguous winner → `topContributorRule` + byte count +
 *     dominant bucket all populated.
 *   - Ties at the top → `{}`. The analyzer never picks a "first one
 *     we saw" winner when two findings have identical byte counts;
 *     dishonest ranking is worse than no ranking.
 *   - Dominant-field classification picks the field whose serialized
 *     contribution exceeds 50% of the finding's bytes; balanced
 *     payloads collapse to `"other"` so the consumer never has to
 *     guess whether `"fix_description"` was a real majority or a
 *     33% / 33% / 33% three-way split.
 *   - Findings without a `ruleId` are skipped (the contributor
 *     payload would carry an unstable identity otherwise).
 */

import { describe, expect, it } from "bun:test";
import { analyzeTopContributor } from "../../../src/mcp/token-budget-contributor.ts";

describe("analyzeTopContributor", () => {
  it("returns empty object for an empty files list", () => {
    expect(analyzeTopContributor([])).toEqual({});
  });

  it("returns empty object when files have no findings", () => {
    expect(analyzeTopContributor([{ findings: [] }, { findings: [] }])).toEqual({});
  });

  it("identifies the single largest-byte finding when there is an unambiguous winner", () => {
    const files = [
      {
        findings: [
          { ruleId: "small/rule", message: "x" },
          {
            ruleId: "big/rule",
            message: "x",
            // Long fix description ensures this finding is the largest
            // by a clear margin — the analyzer should pick it.
            fix: { description: "y".repeat(2000) },
          },
        ],
      },
      {
        findings: [{ ruleId: "tiny/rule", message: "z" }],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("big/rule");
    expect(out.topContributorByteCount).toBeGreaterThan(2000);
    expect(out.dominantContributor).toBe("fix_description");
  });

  it("omits all contributor fields when the top is tied between two findings", () => {
    // Two findings with identical serialized bytes — analyzer must
    // refuse to rank rather than pick one arbitrarily.
    const finding = { ruleId: "tied/rule", message: "x".repeat(500) };
    const out = analyzeTopContributor([{ findings: [finding, finding] }]);
    expect(out).toEqual({});
  });

  it("classifies criteria-heavy findings as `criteria`", () => {
    const files = [
      {
        findings: [
          {
            ruleId: "multi-standard/rule",
            message: "x",
            // Long criteria array dwarfs everything else.
            criteria: Array.from({ length: 50 }, (_, i) => `wcag22:${i}.${i}.${i}`),
            criteriaTitles: Array.from({ length: 50 }, () => "Criterion title".repeat(5)),
          },
          { ruleId: "tiny/rule", message: "z" },
        ],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("multi-standard/rule");
    expect(out.dominantContributor).toBe("criteria");
  });

  it("classifies snippet-heavy findings as `snippet`", () => {
    const files = [
      {
        findings: [
          {
            ruleId: "wide/rule",
            message: "x",
            snippet: "<div ".concat("attr='value' ".repeat(200), "/>"),
          },
          { ruleId: "tiny/rule", message: "z" },
        ],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("wide/rule");
    expect(out.dominantContributor).toBe("snippet");
  });

  it("classifies vendor-occurrence-heavy findings as `vendor_occurrences`", () => {
    const files = [
      {
        findings: [
          {
            ruleId: "vendor/rule",
            message: "x",
            vendorOccurrences: Array.from({ length: 200 }, (_, i) => ({
              path: `vendor/copy-${i}.css`,
              line: i + 1,
            })),
          },
          { ruleId: "tiny/rule", message: "z" },
        ],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("vendor/rule");
    expect(out.dominantContributor).toBe("vendor_occurrences");
  });

  it("classifies message-heavy findings as `message`", () => {
    const files = [
      {
        findings: [
          {
            ruleId: "long-message/rule",
            // Pure-message giant — no fix, no snippet, no criteria.
            message: "m".repeat(3000),
          },
          { ruleId: "tiny/rule", message: "z" },
        ],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("long-message/rule");
    expect(out.dominantContributor).toBe("message");
  });

  it("collapses balanced payloads to `other` when no field crosses 50%", () => {
    // Roughly equal contributions across fix / criteria / snippet.
    // Each ~300 chars; total ~900; no field crosses the half-bytes
    // threshold so the analyzer reports `"other"` rather than picking
    // whichever field hit the deterministic insertion-order tiebreak.
    const files = [
      {
        findings: [
          {
            ruleId: "balanced/rule",
            message: "x",
            fix: { description: "f".repeat(300) },
            criteria: Array.from({ length: 30 }, () => "wcag22:1.1.1"),
            snippet: "s".repeat(300),
          },
          { ruleId: "tiny/rule", message: "z" },
        ],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("balanced/rule");
    expect(out.dominantContributor).toBe("other");
  });

  it("skips findings without a string ruleId so the contributor identity stays stable", () => {
    const files = [
      {
        findings: [
          // Largest by bytes but lacks a ruleId — analyzer should
          // refuse to emit the triple rather than ship `topContributorRule:
          // undefined` as a payload key (which would defeat the
          // "present-when-meaningful" contract).
          { message: "x".repeat(5000) },
        ],
      },
    ];
    expect(analyzeTopContributor(files)).toEqual({});
  });

  it("walks all files (not just the first) when finding the winner", () => {
    const files = [
      { findings: [{ ruleId: "first/file", message: "x" }] },
      {
        findings: [
          {
            ruleId: "second/file/winner",
            message: "x",
            fix: { description: "y".repeat(3000) },
          },
        ],
      },
    ];
    const out = analyzeTopContributor(files);
    expect(out.topContributorRule).toBe("second/file/winner");
  });
});
