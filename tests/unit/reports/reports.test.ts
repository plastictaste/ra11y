import { describe, expect, it } from "bun:test";
import {
  buildCertificationScorecard,
  buildChecklist,
  buildCoverageReport,
  buildVpatReport,
  renderCertificationMarkdown,
  renderChecklistMarkdown,
  renderVpatMarkdown,
} from "../../../src/reports/index.ts";
import { BUILTIN_STANDARDS } from "../../../src/standards/index.ts";
import type { ScanResult } from "../../../src/types/violation.ts";
import { withFindingIds } from "../../helpers/make-violation.ts";

// Fixed synthetic ScanResult so the reports layer can be tested without
// parsing real files. Two violations targeting wcag22:1.1.1 (from a
// single rule declaration the alt-text-missing rule could produce).
const RESULT: ScanResult = {
  violations: withFindingIds([
    {
      ruleId: "media/alt-text-missing",
      fixClass: "mechanical",
      criteria: ["wcag22:1.1.1", "wcag21:1.1.1", "section508:1.1.1", "en301549:9.1.1.1"],
      severity: "error",
      location: { filePath: "src/ui/Card.tsx", line: 12, column: 5 },
      message: "<img> missing alt.",
      suggestion: "Add alt text.",
    },
    {
      ruleId: "media/alt-text-missing",
      fixClass: "mechanical",
      criteria: ["wcag22:1.1.1", "wcag21:1.1.1", "section508:1.1.1", "en301549:9.1.1.1"],
      severity: "error",
      location: { filePath: "src/ui/Header.tsx", line: 4, column: 3 },
      message: "<img> missing alt.",
      suggestion: "Add alt text.",
    },
  ]),
  filesScanned: 2,
  durationMs: 5,
  enabledStandards: ["wcag22", "wcag21", "section508", "en301549"],
  isTTY: false,
};

describe("buildCoverageReport", () => {
  it("returns one entry per enabled standard", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const ids = coverage.map((c) => c.standardId).sort();
    expect(ids).toEqual(["en301549", "section508", "wcag21", "wcag22"]);
  });

  it("marks wcag22:1.1.1 as failing", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const wcag22 = coverage.find((c) => c.standardId === "wcag22");
    expect(wcag22?.failingCriteria).toContain("wcag22:1.1.1");
    expect(wcag22?.failing).toBeGreaterThan(0);
  });

  it("computes automatedPassRate as 0-100", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    for (const c of coverage) {
      expect(c.automatedPassRate).toBeGreaterThanOrEqual(0);
      expect(c.automatedPassRate).toBeLessThanOrEqual(100);
    }
  });

  it("lists manual-only criteria per standard", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const wcag22 = coverage.find((c) => c.standardId === "wcag22");
    // 1.2.1 Audio-only/Video-only is a known manual criterion.
    expect(wcag22?.manualCriteria).toContain("wcag22:1.2.1");
  });
});

describe("buildChecklist + renderChecklistMarkdown", () => {
  it("produces sections for each standard with manual criteria", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const checklist = buildChecklist(coverage, BUILTIN_STANDARDS);
    expect(checklist.sections.length).toBeGreaterThan(0);
    expect(checklist.totalItems).toBeGreaterThan(0);
  });

  it("renders Markdown with checkboxes and spec URLs", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const checklist = buildChecklist(coverage, BUILTIN_STANDARDS);
    const md = renderChecklistMarkdown(checklist);
    expect(md).toContain("# Manual review checklist");
    expect(md).toContain("- [ ]");
    expect(md).toContain("https://www.w3.org/TR/");
  });

  it("includes custom guidance for known SCs like 1.2.1", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const checklist = buildChecklist(coverage, BUILTIN_STANDARDS);
    const md = renderChecklistMarkdown(checklist);
    expect(md).toContain("transcript"); // from the 1.2.1 guidance prompt
  });
});

describe("buildVpatReport + renderVpatMarkdown", () => {
  it("builds a section per enabled standard with correct summary counts", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    expect(report.standards).toHaveLength(4);
    for (const section of report.standards) {
      const sum =
        section.summary.supports +
        section.summary.partiallySupports +
        section.summary.doesNotSupport +
        section.summary.notApplicable +
        section.summary.notEvaluated;
      expect(sum).toBe(section.entries.length);
    }
  });

  it("marks wcag22:1.1.1 as 'Does Not Support'", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.1.1");
    expect(entry?.conformance).toBe("Does Not Support");
    expect(entry?.violationCount).toBe(2);
  });

  it("marks manual-only criteria as 'Not Evaluated'", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(entry?.conformance).toBe("Not Evaluated");
  });

  it("marks clean automatable criteria as 'Supports' or 'Partially Supports'", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    // 2.4.2 Page Titled — clean in our synthetic result, automatable: "full"
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.4.2");
    expect(entry?.conformance).toBe("Supports");
  });

  it("renders Markdown with conformance table", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const md = renderVpatMarkdown(report);
    expect(md).toContain("# VPAT 2.5 Rev INT Conformance Report");
    expect(md).toContain("| Criterion | Level | Conformance | Remarks |");
    expect(md).toContain("Does Not Support");
    expect(md).toContain("Chapter 5: Software");
  });

  it("falls back to generic manual-review remark when no candidates supplied", () => {
    // No applicability passed — 1.2.1 stays "Not Evaluated" (N/A detection
    // only fires when detectApplicability data is wired through).
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(entry?.conformance).toBe("Not Evaluated");
    expect(entry?.remarks).toContain("requires manual review");
    expect(entry?.remarks).not.toContain("candidate location(s)");
  });

  it("injects candidate locations into the manual-review remark", () => {
    const candidates = [
      {
        criterionId: "wcag22:1.2.1",
        location: { filePath: "src/ui/Player.tsx", line: 42, column: 3 },
        reason: "video without transcript link",
        confidence: "medium" as const,
      },
      {
        criterionId: "wcag22:1.2.1",
        location: { filePath: "src/ui/Intro.tsx", line: 7, column: 1 },
        reason: "audio element detected",
        confidence: "medium" as const,
      },
    ];
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z", candidates);
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(entry?.remarks).toContain("2 candidate location(s)");
    expect(entry?.remarks).toContain("src/ui/Player.tsx:42");
    expect(entry?.remarks).toContain("src/ui/Intro.tsx:7");
  });

  it("caps remark preview and summarizes overflow", () => {
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      criterionId: "wcag22:1.2.1",
      location: { filePath: `src/f${i}.tsx`, line: i + 1, column: 1 },
      reason: "x",
      confidence: "medium" as const,
    }));
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z", candidates);
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(entry?.remarks).toContain("8 candidate location(s)");
    expect(entry?.remarks).toContain("+5 more");
  });

  it("surfaces violations on a manual-classified criterion as 'Does Not Support'", () => {
    // Regression guard: document/meta-refresh is a real rule that can
    // fire on wcag22:2.2.1, classified "manual" in metadata. The VPAT
    // must not silently downgrade that to "Not Evaluated" just because
    // the criterion is tagged manual.
    const ruleHit: ScanResult = {
      ...RESULT,
      violations: withFindingIds([
        {
          ruleId: "document/meta-refresh",
          fixClass: "mechanical",
          criteria: ["wcag22:2.2.1"],
          severity: "error",
          location: { filePath: "src/page.html", line: 1, column: 1 },
          message: '<meta http-equiv="refresh">',
          suggestion: "Remove.",
        },
      ]),
    };
    const report = buildVpatReport(ruleHit, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.2.1");
    expect(entry?.conformance).toBe("Does Not Support");
    expect(entry?.violationCount).toBe(1);
    expect(entry?.remarks).toContain("document/meta-refresh");
  });

  it("leaves automated criteria remarks untouched when candidates attach", () => {
    // Candidates targeting the same criterion that already has violations
    // should not overwrite the violation-based remark, because the
    // criterion is "Does Not Support," not "Not Evaluated."
    const candidates = [
      {
        criterionId: "wcag22:1.1.1",
        location: { filePath: "src/weird.tsx", line: 1, column: 1 },
        reason: "should not appear",
        confidence: "medium" as const,
      },
    ];
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z", candidates);
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.1.1");
    expect(entry?.remarks).not.toContain("candidate location(s)");
    expect(entry?.remarks).toContain("findings from rule");
  });

  it("emits header 'VPAT 2.5 Rev' when EN 301 549 is not enabled", () => {
    const wcagOnly: ScanResult = {
      ...RESULT,
      enabledStandards: ["wcag22"],
    };
    const report = buildVpatReport(wcagOnly, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
    });
    expect(report.templateVersion).toBe("VPAT 2.5 Rev");
    expect(renderVpatMarkdown(report)).toContain("# VPAT 2.5 Rev Conformance Report");
  });

  it("emits header 'VPAT 2.5 Rev INT' when EN 301 549 is enabled", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
    });
    expect(report.templateVersion).toBe("VPAT 2.5 Rev INT");
    expect(renderVpatMarkdown(report)).toContain("# VPAT 2.5 Rev INT Conformance Report");
  });

  it("accepts product metadata and round-trips it into the report + markdown", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      product: {
        productName: "ra11y",
        productVersion: "1.0.0",
        contactEmail: "accessibility@example.com",
        contactOrganization: "Example Inc.",
        evaluationMethods: "Static source code analysis via ra11y + manual review",
        notesOnEvaluation: "Snapshot scan of main branch.",
      },
    });
    expect(report.product.productName).toBe("ra11y");
    expect(report.product.productVersion).toBe("1.0.0");
    expect(report.product.contactEmail).toBe("accessibility@example.com");

    const md = renderVpatMarkdown(report);
    expect(md).toContain("- **Name**: ra11y");
    expect(md).toContain("- **Version**: 1.0.0");
    expect(md).toContain("- **Organization**: Example Inc.");
    expect(md).toContain("- **Contact**: accessibility@example.com");
    expect(md).toContain("Static source code analysis via ra11y");
    expect(md).toContain("Snapshot scan of main branch.");
  });

  it("falls back to template placeholders when required metadata is missing", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
    });
    // Placeholder is visible — the VPAT reader sees the gap instead of a
    // silent empty string.
    expect(report.product.productName).toBe("<Product Name>");
    expect(report.product.productVersion).toBe("<Product Version>");
    expect(report.product.contactEmail).toBeUndefined();
    expect(report.product.contactOrganization).toBeUndefined();
  });

  it("marks media SCs as 'Not Applicable' when applicability.hasMedia is false", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      applicability: { hasMedia: false },
    });
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    // 1.2.1 Audio-only and Video-only (Prerecorded) — manual, media-dependent
    const c121 = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(c121?.conformance).toBe("Not Applicable");
    expect(c121?.remarks).toContain("No <video> or <audio> elements");
    // 1.4.2 Audio Control — also media-dependent
    const c142 = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.4.2");
    expect(c142?.conformance).toBe("Not Applicable");
  });

  it("leaves non-media manual SCs as 'Not Evaluated' even when applicability.hasMedia is false", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      applicability: { hasMedia: false },
    });
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    // 2.1.4 Character Key Shortcuts — automatable partial, not media-dependent.
    // Confirms N/A detection doesn't over-fire.
    const c214 = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.1.4");
    expect(c214?.conformance).not.toBe("Not Applicable");
    // 1.4.1 Use of Color — manual, not media-dependent
    const c141 = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.4.1");
    expect(c141?.conformance).toBe("Not Evaluated");
  });

  it("keeps media SCs at 'Not Evaluated' when applicability.hasMedia is true", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      applicability: { hasMedia: true },
    });
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const c121 = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.2.1");
    expect(c121?.conformance).toBe("Not Evaluated");
  });

  it("remarks are auditor-friendly and never mention internal tooling", () => {
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      applicability: { hasMedia: false },
    });
    for (const section of report.standards) {
      for (const entry of section.entries) {
        expect(entry.remarks).not.toMatch(/terminal|JSON report|--checklist/i);
      }
    }
  });

  it("routes runtime-evidence-required SCs to 'Not Evaluated' on clean scan with no attestations", () => {
    // Absence of a static finding on 2.1.1 Keyboard is not evidence of
    // conformance; the honest verdict is "Not Evaluated" rather than
    // "Partially Supports" (which the old automatable="partial" default
    // emitted).
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    for (const sc of ["wcag22:2.1.1", "wcag22:2.4.3", "wcag22:2.4.7", "wcag22:1.4.3"]) {
      const entry = wcag22?.entries.find((e) => e.criterionId === sc);
      expect(entry?.conformance).toBe("Not Evaluated");
      expect(entry?.remarks).toContain("runtime-dependent criterion");
      expect(entry?.remarks).toContain("attest");
    }
  });

  it("routes runtime-evidence SC with fresh pass attestation back to 'Supports'/'Partially Supports'", () => {
    // A runtime harness (or manual review) has attested via
    // `attest({ criterionId: "wcag22:2.1.1", verdict: "pass" })`. The
    // builder must honour that evidence rather than blanket-routing to
    // "Not Evaluated."
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      attestations: [
        {
          criterionId: "wcag22:2.1.1",
          by: "manual-review",
          reason: "Keyboard traversal verified via NVDA + keyboard-only walkthrough.",
          attestedAt: "2026-04-11T00:00:00Z",
          verdict: "pass",
        },
      ],
    });
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.1.1");
    expect(entry).toBeDefined();
    if (!entry) return;
    // 2.1.1 is automatable="partial" in wcag-shared metadata; with the
    // attestation in hand the runtime-evidence override steps aside and
    // the normal partial-automation verdict applies.
    expect(["Supports", "Partially Supports"]).toContain(entry.conformance);
    // Verify a non-attested runtime-only SC in the same scan still
    // routes to Not Evaluated — the attestation's scope is per-criterion.
    const otherEntry = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.4.7");
    expect(otherEntry?.conformance).toBe("Not Evaluated");
  });

  it("preserves 'Does Not Support' on a runtime-only SC that has a proven static failure", () => {
    // Conservative default: a proven static failure is honest negative
    // evidence even when the criterion is runtime-dependent. Hiding a
    // demonstrated failure behind "Not Evaluated" would be worse than
    // the previous silent-miss.
    // Synthesize a scan result with a contrast/minimum finding on
    // wcag22:1.4.3 so the runtime-only override must *not* fire.
    const contrastHit: ScanResult = {
      ...RESULT,
      violations: withFindingIds([
        {
          ruleId: "contrast/minimum",
          fixClass: "mechanical",
          criteria: ["wcag22:1.4.3"],
          severity: "error",
          location: { filePath: "src/styles.css", line: 3, column: 1 },
          message: "Contrast 3:1 against white.",
          suggestion: "Darken foreground.",
        },
      ]),
    };
    const report = buildVpatReport(contrastHit, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:1.4.3");
    expect(entry?.conformance).toBe("Does Not Support");
    expect(entry?.violationCount).toBe(1);
    expect(entry?.remarks).toContain("contrast/minimum");
  });

  it("ignores 'pending' attestations on runtime-only SCs (unasserted claim is not evidence)", () => {
    // Bare pragmas produce `verdict: "pending"` attestations — the
    // ledger surfaces them via list_attestations so agents see the
    // unasserted claim, but they contribute no pass/fail evidence. The
    // VPAT builder must treat them the same way; a pending attestation
    // does NOT lift a runtime-only SC out of "Not Evaluated."
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, {
      generatedAt: "2026-04-11T00:00:00Z",
      attestations: [
        {
          criterionId: "wcag22:2.1.1",
          by: "pragma",
          reason: "ra11y:suppression-no-reason",
          attestedAt: "2026-04-11T00:00:00Z",
          verdict: "pending",
        },
      ],
    });
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.1.1");
    expect(entry?.conformance).toBe("Not Evaluated");
  });

  it("leaves non-runtime-only SCs on their automatable default when clean", () => {
    // 2.4.2 Page Titled is automatable="full" in wcag-shared metadata
    // and is NOT in RUNTIME_EVIDENCE_REQUIRED_CRITERIA. A clean scan
    // must still route it to "Supports" — the runtime-only carve-out
    // should not over-fire onto ordinary static-evaluable criteria.
    const report = buildVpatReport(RESULT, BUILTIN_STANDARDS, "2026-04-11T00:00:00Z");
    const wcag22 = report.standards.find((s) => s.standardId === "wcag22");
    const entry = wcag22?.entries.find((e) => e.criterionId === "wcag22:2.4.2");
    expect(entry?.conformance).toBe("Supports");
  });
});

describe("buildCertificationScorecard + renderCertificationMarkdown", () => {
  it("produces a score per enabled standard", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const scores = buildCertificationScorecard(coverage, BUILTIN_STANDARDS, {}, "AA");
    expect(scores).toHaveLength(4);
  });

  it("readiness is 0-100", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const scores = buildCertificationScorecard(coverage, BUILTIN_STANDARDS, {}, "AA");
    for (const s of scores) {
      expect(s.readiness).toBeGreaterThanOrEqual(0);
      expect(s.readiness).toBeLessThanOrEqual(100);
    }
  });

  it("manual completion increases readiness", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const noManual = buildCertificationScorecard(coverage, BUILTIN_STANDARDS, {}, "AA");
    const withManual = buildCertificationScorecard(
      coverage,
      BUILTIN_STANDARDS,
      {
        "wcag22:1.2.1": { reviewed: true, status: "supports" },
        "wcag22:1.4.1": { reviewed: true, status: "supports" },
      },
      "AA",
    );
    const noWcag22 = noManual.find((s) => s.standardId === "wcag22");
    const withWcag22 = withManual.find((s) => s.standardId === "wcag22");
    expect(withWcag22?.manual.reviewed).toBeGreaterThan(noWcag22?.manual.reviewed ?? 0);
  });

  it("lists blocking issues capped at 10", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const scores = buildCertificationScorecard(coverage, BUILTIN_STANDARDS, {}, "AA");
    for (const s of scores) {
      expect(s.blockingIssues.length).toBeLessThanOrEqual(10);
    }
  });

  it("renders Markdown with readiness number and next steps", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const scores = buildCertificationScorecard(coverage, BUILTIN_STANDARDS, {}, "AA");
    const md = renderCertificationMarkdown(scores);
    expect(md).toContain("# Certification Readiness Scorecard");
    expect(md).toContain("Readiness:");
    expect(md).toContain("Next steps");
  });
});

describe("buildCoverageReport level filtering", () => {
  it("--level AA excludes AAA criteria from manual review", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS, "AA");
    const wcag22 = coverage.find((c) => c.standardId === "wcag22");
    expect(wcag22).toBeDefined();
    for (const criterionId of wcag22?.manualCriteria ?? []) {
      // Look up the criterion in the standard to check its level
      const std = BUILTIN_STANDARDS.find((s) => s.id === "wcag22");
      const criterion = std?.criteria.find((c) => c.id === criterionId);
      expect(criterion?.level).not.toBe("AAA");
    }
  });

  it("--level AA produces fewer manual criteria than --level AAA", () => {
    const aa = buildCoverageReport(RESULT, BUILTIN_STANDARDS, "AA");
    const aaa = buildCoverageReport(RESULT, BUILTIN_STANDARDS, "AAA");
    const aaManual = aa.find((c) => c.standardId === "wcag22")?.manualCriteria.length ?? 0;
    const aaaManual = aaa.find((c) => c.standardId === "wcag22")?.manualCriteria.length ?? 0;
    expect(aaManual).toBeLessThan(aaaManual);
  });

  it("--level A excludes both AA and AAA criteria", () => {
    const coverage = buildCoverageReport(RESULT, BUILTIN_STANDARDS, "A");
    const wcag22 = coverage.find((c) => c.standardId === "wcag22");
    for (const criterionId of wcag22?.manualCriteria ?? []) {
      const std = BUILTIN_STANDARDS.find((s) => s.id === "wcag22");
      const criterion = std?.criteria.find((c) => c.id === criterionId);
      expect(criterion?.level).toBe("A");
    }
  });

  it("omitting level defaults to including all levels", () => {
    const all = buildCoverageReport(RESULT, BUILTIN_STANDARDS);
    const aaa = buildCoverageReport(RESULT, BUILTIN_STANDARDS, "AAA");
    const allManual = all.find((c) => c.standardId === "wcag22")?.manualCriteria.length ?? 0;
    const aaaManual = aaa.find((c) => c.standardId === "wcag22")?.manualCriteria.length ?? 0;
    expect(allManual).toBe(aaaManual);
  });
});
