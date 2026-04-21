import { describe, expect, it } from "bun:test";
import { agentFormatter } from "../../src/output/formatters/agent.ts";
import type { ReportData, ScanResult } from "../../src/types/violation.ts";
import { withFindingIds } from "../helpers/make-violation.ts";

// Fixed synthetic ScanResult — deterministic across runs. Duration is zeroed.
const RESULT: ScanResult = {
  violations: withFindingIds([
    {
      ruleId: "keyboard/handler-missing",
      fixClass: "verify-in-source",
      criteria: ["wcag22:2.1.1", "wcag21:2.1.1"],
      severity: "error",
      location: { filePath: "src/ui/Button.tsx", line: 8, column: 3 },
      message: "Interactive element has no keyboard handler.",
      suggestion: "Add onKeyDown or onKeyUp alongside onClick.",
    },
    {
      ruleId: "semantics/button-name",
      fixClass: "verify-in-source",
      criteria: ["wcag22:4.1.2"],
      severity: "error",
      location: { filePath: "src/ui/Button.tsx", line: 22, column: 5, endLine: 22, endColumn: 30 },
      message: "<button> has no accessible name.",
      suggestion: "Add aria-label, aria-labelledby, or visible text content.",
    },
    {
      ruleId: "keyboard/handler-missing",
      fixClass: "verify-in-source",
      criteria: ["wcag22:2.1.1"],
      severity: "error",
      location: { filePath: "src/ui/Card.tsx", line: 14, column: 7 },
      message: "Interactive element has no keyboard handler.",
      suggestion: "Add onKeyDown or onKeyUp alongside onClick.",
      snippet: "<div onClick={handleClick}>",
    },
    {
      ruleId: "media/alt-text-missing",
      fixClass: "mechanical",
      criteria: ["wcag22:1.1.1", "wcag21:1.1.1"],
      severity: "warning",
      location: { filePath: "src/ui/Card.tsx", line: 31, column: 9 },
      message: "<img> 'hero.png' is missing a text alternative.",
      suggestion: "Add alt describing the image content.",
    },
  ]),
  filesScanned: 15,
  durationMs: 0,
  enabledStandards: ["wcag22", "wcag21"],
  isTTY: false,
};

const REPORT: ReportData = {
  coverage: [{ standardId: "wcag22", automated: 22, total: 87, passing: 20, failing: 4 }],
  manualReviewNeeded: ["wcag22:1.2.1"],
  candidates: [
    {
      criterionId: "wcag22:1.2.1",
      location: { filePath: "src/ui/Card.tsx", line: 5, column: 1 },
      reason: "Video element may need a text alternative.",
      confidence: "medium",
      snippet: "<video src='intro.mp4'>",
    },
    {
      criterionId: "wcag22:1.4.1",
      location: { filePath: "src/ui/Button.tsx", line: 10, column: 1 },
      reason: "Color may be the only visual means of conveying information.",
      confidence: "medium",
    },
  ],
};

const EMPTY_RESULT: ScanResult = {
  violations: [],
  filesScanned: 5,
  durationMs: 0,
  enabledStandards: ["wcag22"],
  isTTY: false,
};

const EMPTY_REPORT: ReportData = {
  coverage: [],
  manualReviewNeeded: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parse(result: ScanResult = RESULT, report: ReportData = REPORT) {
  const raw = agentFormatter.format(result, report);
  return JSON.parse(raw) as {
    plan: {
      totalFindings: number;
      mechanicalEditsAvailable: number;
      fixesByClass: {
        mechanical: number;
        guidance: number;
        runtimeOnly: number;
        verifyInSource: number;
      };
      reviewNeeded: number;
      manualOnly: number;
      estimatedEffort: string;
      summary: string;
    };
    files: Array<{
      path: string;
      findings: Array<{
        findingId: string;
        groupKey: string;
        ruleId: string;
        fixClass: string;
        criteria: string[];
        severity: string;
        confidence: string;
        line: number;
        column: number;
        endLine?: number;
        endColumn?: number;
        message: string;
        snippet?: string;
        fix?: {
          oldText?: string;
          newText?: string;
          safety: string;
          description: string;
        };
        effort: string;
        category: string;
        suppressWith: string;
        suppressPlacement: string;
      }>;
    }>;
    reviewCandidates: Array<{
      criterionId: string;
      path: string;
      line: number;
      reason: string;
      snippet?: string;
    }>;
    meta: {
      tool: string;
      version: string;
      standards: string[];
      level: string;
      filesScanned: number;
      durationMs: number;
    };
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("formatter: agent — output shape", () => {
  it("emits compact JSON with the four top-level keys", () => {
    const raw = agentFormatter.format(RESULT, REPORT);
    // Compact: no leading whitespace
    expect(raw.startsWith("{")).toBe(true);
    // No indentation newlines
    expect(raw).not.toContain("\n");

    const parsed = parse();
    expect(parsed).toHaveProperty("plan");
    expect(parsed).toHaveProperty("files");
    expect(parsed).toHaveProperty("reviewCandidates");
    expect(parsed).toHaveProperty("meta");
  });

  it("is deterministic across repeated calls", () => {
    const a = agentFormatter.format(RESULT, REPORT);
    const b = agentFormatter.format(RESULT, REPORT);
    expect(a).toBe(b);
  });
});

describe("formatter: agent — plan", () => {
  it("plan.totalFindings matches violation count", () => {
    const { plan } = parse();
    expect(plan.totalFindings).toBe(4);
  });

  it("plan.summary includes the violation count", () => {
    const { plan } = parse();
    expect(plan.summary).toContain("4");
  });

  it("plan.summary names the most common rules", () => {
    const { plan } = parse();
    // keyboard/handler-missing fires twice — should appear first
    expect(plan.summary).toContain("keyboard/handler-missing");
  });

  it("plan exposes mechanicalEditsAvailable and a per-fixClass fixesByClass tally", () => {
    const { plan } = parse();
    // None of the 4 violations ship an inline `fixPaths.primary.edit`,
    // so `mechanicalEditsAvailable` is 0 — that counter only sees
    // batch-applyable edits, not prose suggestions.
    expect(plan.mechanicalEditsAvailable).toBe(0);
    // `fixesByClass` is the honest per-lane tally — RESULT has 1
    // mechanical (media/alt-text-missing) and 3 verify-in-source
    // (keyboard/handler-missing x2, semantics/button-name) violations.
    expect(plan.fixesByClass.mechanical).toBe(1);
    expect(plan.fixesByClass.guidance).toBe(0);
    expect(plan.fixesByClass.runtimeOnly).toBe(0);
    expect(plan.fixesByClass.verifyInSource).toBe(3);
    expect(plan.reviewNeeded).toBe(0);
  });

  // V1-SHAPE-CLI-AGENT-HEADLINE: plan.summary parenthetical breaks down by fixClass lane.
  it("plan.summary parenthetical breaks down by fixClass lane, not by suggestion presence", () => {
    const { plan } = parse();
    // RESULT has 1 mechanical + 3 verify-in-source violations.
    // The old format was "(4 guidance fixes)" — wrong because:
    //   (a) none of these are fixClass:"guidance", and
    //   (b) it conflated verify-in-source with guidance.
    // New format: "(1 mechanical, 3 verify-in-source)".
    expect(plan.summary).toContain("1 mechanical");
    expect(plan.summary).toContain("3 verify-in-source");
    // guidance and runtime-only lanes are zero — omitted.
    expect(plan.summary).not.toContain("guidance");
    expect(plan.summary).not.toContain("runtime-only");
  });

  it("plan.summary omits zero-count fixClass lanes", () => {
    // Only non-zero lanes appear in the parenthetical.
    // RESULT: 1 mechanical + 3 verify-in-source → guidance and runtime-only absent.
    const { plan } = parse();
    expect(plan.summary).not.toMatch(/0 (mechanical|guidance|runtime-only|verify-in-source)/);
  });

  it("plan.summary with all four fixClass lanes populated shows each lane", () => {
    const mixedResult: ScanResult = {
      ...RESULT,
      violations: withFindingIds([
        {
          ruleId: "media/alt-text-missing",
          fixClass: "mechanical",
          criteria: ["wcag22:1.1.1"],
          severity: "error",
          location: { filePath: "src/a.tsx", line: 1, column: 1 },
          message: "msg",
          suggestion: "fix",
        },
        {
          ruleId: "contrast/minimum",
          fixClass: "guidance",
          criteria: ["wcag22:1.4.3"],
          severity: "warning",
          location: { filePath: "src/a.tsx", line: 2, column: 1 },
          message: "msg",
          suggestion: "fix",
        },
        {
          ruleId: "focus/visible",
          fixClass: "runtime-only",
          criteria: ["wcag22:2.4.7"],
          severity: "warning",
          location: { filePath: "src/a.tsx", line: 3, column: 1 },
          message: "msg",
          suggestion: "fix",
        },
        {
          ruleId: "keyboard/handler-missing",
          fixClass: "verify-in-source",
          criteria: ["wcag22:2.1.1"],
          severity: "error",
          location: { filePath: "src/a.tsx", line: 4, column: 1 },
          message: "msg",
          suggestion: "fix",
        },
      ]),
    };
    const parsed = JSON.parse(agentFormatter.format(mixedResult, EMPTY_REPORT)) as {
      plan: { summary: string };
    };
    // All four lanes are non-zero; all four must appear in the parenthetical.
    expect(parsed.plan.summary).toContain("1 mechanical");
    expect(parsed.plan.summary).toContain("1 guidance");
    expect(parsed.plan.summary).toContain("1 runtime-only");
    expect(parsed.plan.summary).toContain("1 verify-in-source");
    // Lane order: mechanical → guidance → runtime-only → verify-in-source.
    const mechanicalIdx = parsed.plan.summary.indexOf("1 mechanical");
    const guidanceIdx = parsed.plan.summary.indexOf("1 guidance");
    const runtimeIdx = parsed.plan.summary.indexOf("1 runtime-only");
    const verifyIdx = parsed.plan.summary.indexOf("1 verify-in-source");
    expect(mechanicalIdx).toBeLessThan(guidanceIdx);
    expect(guidanceIdx).toBeLessThan(runtimeIdx);
    expect(runtimeIdx).toBeLessThan(verifyIdx);
  });

  it("zero violations produces plan.totalFindings: 0 and trivial effort", () => {
    const { plan } = parse(EMPTY_RESULT, EMPTY_REPORT);
    expect(plan.totalFindings).toBe(0);
    expect(plan.estimatedEffort).toBe("trivial");
    expect(plan.summary).toBe("No accessibility violations found.");
  });
});

describe("formatter: agent — files", () => {
  it("groups findings by file path", () => {
    const { files } = parse();
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src/ui/Button.tsx");
    expect(paths).toContain("src/ui/Card.tsx");
  });

  it("files are sorted alphabetically by path", () => {
    const { files } = parse();
    const paths = files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
  });

  it("findings within a file are sorted by line then column then ruleId", () => {
    const { files } = parse();
    const card = files.find((f) => f.path === "src/ui/Card.tsx");
    expect(card).toBeDefined();
    const lines = card!.findings.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });

  it("finding.findingId is the stable findingId hash (survives line-number drift)", () => {
    const { files } = parse();
    const finding = files[0]?.findings[0];
    expect(finding).toBeDefined();
    // 12 hex chars, matches the Violation.findingId recipe.
    expect(finding!.findingId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("suppressWith uses JSX block comment syntax for .tsx files", () => {
    const { files } = parse();
    for (const file of files) {
      for (const finding of file.findings) {
        expect(finding.suppressWith).toBe(`{/* ra11y-disable-next-line ${finding.ruleId} */}`);
      }
    }
  });

  it("suppressPlacement warns about JSX attribute placement for .tsx/.jsx files", () => {
    // The #1 wasted edit: pasting `{/* ra11y-disable-next-line ... */}`
    // as an attribute value. Placement text makes the first edit land.
    const { files } = parse();
    for (const file of files) {
      for (const finding of file.findings) {
        expect(finding.suppressPlacement).toContain("opening JSX tag");
        expect(finding.suppressPlacement).toContain("not inside attributes");
      }
    }
  });

  it("suppressWith uses // syntax for plain .ts files", () => {
    const tsResult: ScanResult = {
      ...RESULT,
      violations: withFindingIds([
        {
          ruleId: "parsing/duplicate-id",
          fixClass: "mechanical",
          criteria: ["wcag22:4.1.2"],
          severity: "error",
          location: { filePath: "src/util.ts", line: 3, column: 1 },
          message: "msg",
          suggestion: "fix",
        },
      ]),
    };
    const parsed = JSON.parse(agentFormatter.format(tsResult, REPORT)) as {
      files: Array<{ findings: Array<{ suppressWith: string }> }>;
    };
    expect(parsed.files[0]?.findings[0]?.suppressWith).toBe(
      "// ra11y-disable-next-line parsing/duplicate-id",
    );
  });

  it("suppressWith uses CSS comment syntax for .css files", () => {
    const cssResult: ScanResult = {
      ...RESULT,
      violations: withFindingIds([
        {
          ruleId: "focus/outline-visible",
          fixClass: "verify-in-source",
          criteria: ["wcag22:2.4.7"],
          severity: "warning",
          location: { filePath: "src/app.css", line: 12, column: 3 },
          message: "outline: none removes focus indicator",
          suggestion: "Provide a replacement focus indicator.",
        },
      ]),
    };
    const parsed = JSON.parse(agentFormatter.format(cssResult, REPORT)) as {
      files: Array<{ findings: Array<{ suppressWith: string }> }>;
    };
    expect(parsed.files[0]?.findings[0]?.suppressWith).toBe(
      "/* ra11y-disable-next-line focus/outline-visible */",
    );
  });

  it("suppressWith uses HTML comment syntax for .html files", () => {
    const htmlResult: ScanResult = {
      ...RESULT,
      violations: withFindingIds([
        {
          ruleId: "media/alt-text-missing",
          fixClass: "mechanical",
          criteria: ["wcag22:1.1.1"],
          severity: "error",
          location: { filePath: "index.html", line: 5, column: 3 },
          message: "<img> missing alt",
          suggestion: "Add alt attribute.",
        },
      ]),
    };
    const parsed = JSON.parse(agentFormatter.format(htmlResult, REPORT)) as {
      files: Array<{ findings: Array<{ suppressWith: string }> }>;
    };
    expect(parsed.files[0]?.findings[0]?.suppressWith).toBe(
      "<!-- ra11y-disable-next-line media/alt-text-missing -->",
    );
  });

  it("finding.fix is populated when suggestion exists", () => {
    const { files } = parse();
    const buttonFile = files.find((f) => f.path === "src/ui/Button.tsx");
    const firstFinding = buttonFile?.findings[0];
    expect(firstFinding?.fix).toBeDefined();
    expect(firstFinding?.fix?.description).toBe("Add onKeyDown or onKeyUp alongside onClick.");
    expect(firstFinding?.confidence).toBe("high");
    expect(firstFinding?.fix?.safety).toBe("safe");
  });

  it("finding.confidence is medium for warning severity", () => {
    const { files } = parse();
    const card = files.find((f) => f.path === "src/ui/Card.tsx");
    const warning = card?.findings.find((f) => f.severity === "warning");
    expect(warning?.confidence).toBe("medium");
  });

  it("finding exposes top-level fixClass from the rule's metadata", () => {
    const { files } = parse();
    const card = files.find((f) => f.path === "src/ui/Card.tsx");
    const altImg = card?.findings.find((f) => f.ruleId === "media/alt-text-missing");
    // The fixture declares `fixClass: "mechanical"` on the alt-text violation.
    expect(altImg?.fixClass).toBe("mechanical");
    // verify-in-source is the other fixClass in the sample fixtures.
    const kbd = card?.findings.find((f) => f.ruleId === "keyboard/handler-missing");
    expect(kbd?.fixClass).toBe("verify-in-source");
  });

  it("finding.snippet is the raw snippet string when the violation carries one", () => {
    const { files } = parse();
    const card = files.find((f) => f.path === "src/ui/Card.tsx");
    // The third violation in RESULT (Card.tsx:14) has a snippet
    const withSnippet = card?.findings.find((f) => f.line === 14);
    expect(withSnippet?.snippet).toBe("<div onClick={handleClick}>");
  });

  it("finding.snippet is absent when the violation carries no snippet", () => {
    const { files } = parse();
    const btn = files.find((f) => f.path === "src/ui/Button.tsx");
    const first = btn?.findings[0];
    // V1-SHAPE-SNIPPET-EMPTY: present-when-meaningful — omitted when
    // the violation had no snippet, not emitted as an empty sentinel.
    expect(first).toBeDefined();
    expect(Object.hasOwn(first as object, "snippet")).toBe(false);
  });

  it("endLine and endColumn are forwarded when present", () => {
    const { files } = parse();
    const btn = files.find((f) => f.path === "src/ui/Button.tsx");
    const withEnd = btn?.findings.find((f) => f.line === 22);
    expect(withEnd?.endLine).toBe(22);
    expect(withEnd?.endColumn).toBe(30);
  });

  it("zero violations produces empty files array", () => {
    const { files } = parse(EMPTY_RESULT, EMPTY_REPORT);
    expect(files).toHaveLength(0);
  });
});

describe("formatter: agent — reviewCandidates", () => {
  it("reviewCandidates are populated from report.candidates", () => {
    const { reviewCandidates } = parse();
    expect(reviewCandidates).toHaveLength(2);
  });

  it("reviewCandidates carry criterionId, path, line, reason", () => {
    const { reviewCandidates } = parse();
    const first = reviewCandidates.find((c) => c.criterionId === "wcag22:1.2.1");
    expect(first).toBeDefined();
    expect(first?.path).toBe("src/ui/Card.tsx");
    expect(first?.line).toBe(5);
    expect(first?.reason).toBe("Video element may need a text alternative.");
  });

  it("reviewCandidates.snippet is forwarded when present", () => {
    const { reviewCandidates } = parse();
    const withSnippet = reviewCandidates.find((c) => c.criterionId === "wcag22:1.2.1");
    expect(withSnippet?.snippet).toBe("<video src='intro.mp4'>");
  });

  it("reviewCandidates.snippet is absent when not provided", () => {
    const { reviewCandidates } = parse();
    const withoutSnippet = reviewCandidates.find((c) => c.criterionId === "wcag22:1.4.1");
    expect(withoutSnippet).toBeDefined();
    expect(Object.hasOwn(withoutSnippet as object, "snippet")).toBe(false);
  });

  it("reviewCandidates are empty when report.candidates is undefined", () => {
    const reportNoCandidates: ReportData = { coverage: [], manualReviewNeeded: [] };
    const { reviewCandidates } = parse(RESULT, reportNoCandidates);
    expect(reviewCandidates).toHaveLength(0);
  });

  it("reviewCandidates are sorted by file path then line", () => {
    const { reviewCandidates } = parse();
    // Button.tsx line 10 comes after Card.tsx line 5 alphabetically: B < C — wait no, B < C
    // Button.tsx < Card.tsx alphabetically, so Button first
    expect(reviewCandidates[0]?.path).toBe("src/ui/Button.tsx");
    expect(reviewCandidates[1]?.path).toBe("src/ui/Card.tsx");
  });
});

describe("formatter: agent — meta", () => {
  it("meta.tool is ra11y", () => {
    const { meta } = parse();
    expect(meta.tool).toBe("ra11y");
  });

  it("meta.filesScanned matches result.filesScanned", () => {
    const { meta } = parse();
    expect(meta.filesScanned).toBe(15);
  });

  it("meta.standards are sorted", () => {
    const { meta } = parse();
    expect(meta.standards).toEqual([...meta.standards].sort());
  });

  it("meta.durationMs is rounded", () => {
    const fractional: ScanResult = { ...RESULT, durationMs: 123.7 };
    const { meta } = parse(fractional, REPORT);
    expect(meta.durationMs).toBe(124);
  });
});
