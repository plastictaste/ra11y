/**
 * Unit tests for the corpus-aggregation per-rule-coverage adjuster.
 *
 * Pins the threshold cascade behavior the AI-first doctrine "Parser-
 * failure invalidates per-file confidence" names at the corpus axis:
 * the per-file adjuster intentionally lets a rule's aggregate stay
 * `"high"` as long as one cleanly-parsed file survives, but on bulk
 * corpora (12% parse-error rate across thousands of files) the
 * aggregate scalar is the field an agent budgets against and hundreds
 * of invisible files would otherwise read as "high."
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import { parseHtml } from "../../../src/input/parsers/html.ts";
import { applyCorpusParseErrorRateAdjustment } from "../../../src/mcp/corpus-parse-error-rate-adjustment.ts";
import { buildSharedPerRuleCoverageMeta } from "../../../src/mcp/per-rule-coverage-shared.ts";
import type { Rule } from "../../../src/types/rule.ts";
import type { PerRuleCoverage } from "../../../src/types/violation.ts";

function makeRow(overrides: Partial<PerRuleCoverage>): PerRuleCoverage {
  return {
    ruleId: "r/test",
    filesEvaluated: 100,
    filesEligible: 100,
    findingsEmitted: 0,
    fired: false,
    coverageConfidence: "high",
    ...overrides,
  };
}

function makeByFile(
  count: number,
  reason: "file-parse-error" | "partial-parse" = "file-parse-error",
): readonly { path: string; confidence: "low"; reason: "file-parse-error" | "partial-parse" }[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `/file${i}.html`,
    confidence: "low" as const,
    reason,
  }));
}

describe("applyCorpusParseErrorRateAdjustment — threshold cascade", () => {
  it("returns input identity when no row has byFile entries (no-op fast path)", () => {
    const rows = [makeRow({ filesEligible: 100 })];
    const out = applyCorpusParseErrorRateAdjustment(rows);
    expect(out).toBe(rows);
  });

  it("passes through a row whose byFile rate is below 10% (sub-threshold)", () => {
    // 9 of 100 eligible = 9% → below medium threshold; aggregate stays high.
    const row = makeRow({ filesEligible: 100, byFile: makeByFile(9) });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("high");
    expect(out?.coverageConfidenceReason).toBeUndefined();
  });

  it("drops a row to 'medium' when the byFile rate is exactly 10%", () => {
    // 10 of 100 eligible = 10% → medium threshold (≥10%, <25%).
    const row = makeRow({ filesEligible: 100, byFile: makeByFile(10) });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("medium");
    expect(out?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
    expect(out?.reason).toContain("10");
    expect(out?.reason).toContain("100");
    // Per-file `byFile` survives — agent still reads which files were degraded.
    expect(out?.byFile?.length).toBe(10);
  });

  it("drops a row to 'medium' on a 12.4% rate (canonical bulk-templates corpus shape)", () => {
    // 501 of 4043 eligible ≈ 12.4% → medium.
    const row = makeRow({ filesEligible: 4043, byFile: makeByFile(501) });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("medium");
    expect(out?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
    expect(out?.reason).toMatch(/12\.4%/u);
  });

  it("drops a row to 'low' when the byFile rate is exactly 25%", () => {
    // 25 of 100 eligible = 25% → low threshold.
    const row = makeRow({ filesEligible: 100, byFile: makeByFile(25) });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("low");
    expect(out?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
  });

  it("drops a row to 'low' on a 50% rate (well above the low threshold)", () => {
    const row = makeRow({ filesEligible: 100, byFile: makeByFile(50) });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("low");
    expect(out?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
    expect(out?.reason).toMatch(/50\.0%/u);
  });

  it("passes through small corpora (filesEligible < 10) where ratio noise dominates", () => {
    // 3 of 5 eligible = 60% — but the per-file `byFile` channel is the
    // load-bearing surface for tiny corpora; the aggregate flip would
    // be misleading on this denominator.
    const row = makeRow({ filesEligible: 5, byFile: makeByFile(3) });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("high");
    expect(out?.coverageConfidenceReason).toBeUndefined();
  });

  it("passes through rows already at 'low' (cannot worsen aggregate label)", () => {
    const row = makeRow({
      filesEligible: 100,
      byFile: makeByFile(80),
      coverageConfidence: "low",
      coverageConfidenceReason: "file-parse-error",
    });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("low");
    // Existing reason wins — the corpus axis would have stamped the
    // same severity but the file-parse-error reason is more specific.
    expect(out?.coverageConfidenceReason).toBe("file-parse-error");
  });

  it("passes through rows already at 'medium' from a substrate-specific reason (more-specific wins)", () => {
    // A rule downgraded to "medium" by `applyScssUnresolvedVariablesAdjustment`
    // would lose its substrate-specific reason if the corpus axis
    // re-stamped. The doctrine "keep the most degraded label across
    // axes" applies on the strength axis, not the reason axis.
    const row = makeRow({
      filesEligible: 100,
      byFile: makeByFile(15),
      coverageConfidence: "medium",
      coverageConfidenceReason: "scss-unresolved-variables",
    });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.coverageConfidence).toBe("medium");
    expect(out?.coverageConfidenceReason).toBe("scss-unresolved-variables");
  });

  it("passes through level-gated rows even when filesEligible would qualify", () => {
    // Gated-by-level rows never ran; aggregating their eligible files
    // is meaningless. The per-file adjuster honors the same gate.
    const row = makeRow({
      filesEligible: 100,
      byFile: makeByFile(50),
      skipReason: "gated_by_level",
      requiredLevel: "AAA",
      requestedLevel: "AA",
    });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.skipReason).toBe("gated_by_level");
    // Skip-reason rows don't carry a corpus-axis downgrade.
    expect(out?.coverageConfidenceReason).toBeUndefined();
  });

  it("preserves additive fields (filesEvaluated, byFile, findingsEmitted) on a downgrade", () => {
    const row = makeRow({
      ruleId: "html/example",
      filesEligible: 100,
      filesEvaluated: 87,
      findingsEmitted: 3,
      fired: true,
      byFile: makeByFile(15, "partial-parse"),
    });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    expect(out?.ruleId).toBe("html/example");
    expect(out?.filesEvaluated).toBe(87);
    expect(out?.findingsEmitted).toBe(3);
    expect(out?.fired).toBe(true);
    expect(out?.byFile?.length).toBe(15);
    expect(out?.coverageConfidence).toBe("medium");
  });

  it("counts both file-parse-error and partial-parse entries toward the corpus rate", () => {
    // Mix the two byFile reason kinds; both contribute to the
    // degradation count the aggregate threshold reads from.
    const row = makeRow({
      filesEligible: 100,
      byFile: [...makeByFile(8, "file-parse-error"), ...makeByFile(20, "partial-parse")],
    });
    const [out] = applyCorpusParseErrorRateAdjustment([row]);
    // 28% rate → low threshold.
    expect(out?.coverageConfidence).toBe("low");
    expect(out?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
  });

  it("only mutates rows that qualify; unrelated rows pass through unchanged", () => {
    const cleanRow = makeRow({ ruleId: "clean/rule", filesEligible: 100 });
    const degradedRow = makeRow({
      ruleId: "degraded/rule",
      filesEligible: 100,
      byFile: makeByFile(30),
    });
    const out = applyCorpusParseErrorRateAdjustment([cleanRow, degradedRow]);
    // Clean row ships unchanged (object identity stable per row).
    expect(out[0]).toBe(cleanRow);
    expect(out[1]?.coverageConfidence).toBe("low");
  });
});

describe("corpus-parse-error-rate composes with the per-file parse-error adjuster (cascade integration)", () => {
  // Synthetic HTML rule — the cascade only reads `id` + extension gate.
  const htmlRule = {
    id: "html/example",
    satisfies: [],
    severity: "warning",
    scope: "node",
    fixClass: "guidance",
    appliesTo: { fileExtensions: [".html", ".htm"] },
    docs: { title: "html/example", rationale: "", goodExample: "", badExample: "" },
  } as unknown as Rule;

  function syntheticHtml(path: string, errored: boolean): ParsedFile {
    const parsed = parseHtml("<html><body><h1>x</h1></body></html>");
    return {
      filePath: path,
      source: "<html><body><h1>x</h1></body></html>",
      ast: {
        language: "html",
        root: parsed.root,
        errors: errored
          ? [
              {
                message: "synthetic",
                position: { line: 1, column: 1, offset: 0 },
                recoverable: false,
              },
            ]
          : [],
      },
    };
  }

  it("the shared cascade flips a 12.4% parse-error-rate row to 'medium' even though the per-file adjuster kept it 'high'", () => {
    // Synthesize a 50-file corpus where 7 files (14%) failed to parse —
    // above the 10% medium threshold, below the 25% low threshold. The
    // per-file adjuster keeps the aggregate `"high"` (43 clean files
    // dominate) and lists the 7 broken ones in `byFile`; the corpus-
    // rate adjuster then flips the aggregate to `"medium"` because the
    // bulk-corpus invisibility has crossed the threshold.
    const cleanFiles = Array.from({ length: 43 }, (_, i) =>
      syntheticHtml(`/clean${i}.html`, false),
    );
    const brokenFiles = Array.from({ length: 7 }, (_, i) =>
      syntheticHtml(`/broken${i}.html`, true),
    );
    const files = [...cleanFiles, ...brokenFiles];
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 50,
        filesEligible: 50,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const { adjustedPerRuleCoverage } = buildSharedPerRuleCoverageMeta({
      perRuleCoverage: rows,
      parsedFiles: files,
      activeRules: [htmlRule],
      violationFilePaths: new Set(),
      verboseMeta: true,
    });
    const [row] = adjustedPerRuleCoverage;
    expect(row?.ruleId).toBe("html/example");
    // Per-file adjuster's evidence still rides on `byFile` — agent
    // can triage which 7 files were degraded.
    expect(row?.byFile?.length).toBe(7);
    // Corpus-rate adjuster flipped the aggregate (14% > 10% threshold).
    expect(row?.coverageConfidence).toBe("medium");
    expect(row?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
    expect(row?.reason).toMatch(/14\.0%/u);
  });

  it("the shared cascade flips a 30% parse-error-rate row to 'low' (above the low threshold)", () => {
    // 15 broken / 50 eligible = 30% → low threshold. Aggregate flips
    // straight to "low" via the corpus axis even though the per-file
    // adjuster still has 35 clean files to fold from.
    const cleanFiles = Array.from({ length: 35 }, (_, i) =>
      syntheticHtml(`/clean${i}.html`, false),
    );
    const brokenFiles = Array.from({ length: 15 }, (_, i) =>
      syntheticHtml(`/broken${i}.html`, true),
    );
    const files = [...cleanFiles, ...brokenFiles];
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 50,
        filesEligible: 50,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const { adjustedPerRuleCoverage } = buildSharedPerRuleCoverageMeta({
      perRuleCoverage: rows,
      parsedFiles: files,
      activeRules: [htmlRule],
      violationFilePaths: new Set(),
      verboseMeta: true,
    });
    const [row] = adjustedPerRuleCoverage;
    expect(row?.coverageConfidence).toBe("low");
    expect(row?.coverageConfidenceReason).toBe("corpus-parse-error-rate-above-threshold");
    expect(row?.byFile?.length).toBe(15);
  });

  it("the shared cascade leaves a sub-threshold row at 'high' (per-file `byFile` carries the signal)", () => {
    // 4 broken / 50 eligible = 8% → below medium threshold. Aggregate
    // stays "high" (per-file adjuster's invariant); `byFile` lists the
    // 4 degraded files for the agent's triage.
    const cleanFiles = Array.from({ length: 46 }, (_, i) =>
      syntheticHtml(`/clean${i}.html`, false),
    );
    const brokenFiles = Array.from({ length: 4 }, (_, i) =>
      syntheticHtml(`/broken${i}.html`, true),
    );
    const files = [...cleanFiles, ...brokenFiles];
    const rows: readonly PerRuleCoverage[] = [
      {
        ruleId: "html/example",
        filesEvaluated: 50,
        filesEligible: 50,
        findingsEmitted: 0,
        fired: false,
        coverageConfidence: "high",
      },
    ];
    const { adjustedPerRuleCoverage } = buildSharedPerRuleCoverageMeta({
      perRuleCoverage: rows,
      parsedFiles: files,
      activeRules: [htmlRule],
      violationFilePaths: new Set(),
      verboseMeta: true,
    });
    const [row] = adjustedPerRuleCoverage;
    expect(row?.coverageConfidence).toBe("high");
    expect(row?.coverageConfidenceReason).toBeUndefined();
    expect(row?.byFile?.length).toBe(4);
  });
});
