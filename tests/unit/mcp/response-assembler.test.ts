/**
 * Unit tests for the scan-family response assembler — the single seam
 * consumed (eventually) by every scan-family tool handler.
 *
 * Invariants guarded here (from docs/kb/architecture/ai-first-consumer.md):
 *
 *   - Clean scans carry no sentinel zeros — `mechanicalEditsAvailable`
 *     and `fixesByClass` are absent, not zero.
 *   - `warnings` is entirely absent on a healthy scan, never `[]`.
 *   - Zero parsed files fires `scanned_zero_files`.
 *   - `configSource: null` fires `no_config_found`; a populated path
 *     does not.
 *   - `rootSource: "git"` / `"spawn-cwd"` fires `root_source_defaulted`;
 *     `"explicit"` does not.
 *   - Violations group per-file and sort deterministically by path.
 *   - `hoistReferenceGuide: false` omits the guide even with findings.
 *   - `tokenBudget: 0` disables truncation.
 *   - Review candidates only appear when `includeReviewCandidates: true`
 *     is passed, and only when the deduped list is non-empty.
 */

import { describe, expect, it } from "bun:test";
import type { ParsedFile } from "../../../src/engine/scanner.ts";
import {
  assembleScanFamilyResponse,
  buildDerivativeScanWarnings,
  type ScanFamilyResponseInput,
} from "../../../src/mcp/response-assembler.ts";
import type { Violation } from "../../../src/types/violation.ts";

function parsedFile(path: string): ParsedFile {
  return {
    filePath: path,
    source: "",
    ast: {
      language: "tsx",
      root: {
        kind: "TsxModule",
        range: { start: 0, end: 0 },
        loc: {
          start: { line: 1, column: 1, offset: 0 },
          end: { line: 1, column: 1, offset: 0 },
        },
        jsxElements: [],
      },
      errors: [],
    },
  };
}

function violation(path: string, line: number, ruleId = "alt-text/missing"): Violation {
  return {
    ruleId,
    fixClass: "mechanical",
    criteria: ["wcag22:1.1.1"],
    severity: "error",
    location: { filePath: path, line, column: 1 },
    message: `<img> at ${path}:${line}`,
    findingId: `${path}:${line}:${ruleId}`,
    groupKey: `${ruleId}:group`,
  } as unknown as Violation;
}

function baseInput(overrides: Partial<ScanFamilyResponseInput> = {}): ScanFamilyResponseInput {
  return {
    violations: [],
    parsedFiles: [parsedFile("/src/a.tsx")],
    activeRules: [],
    durationMs: 4,
    enabledStandards: ["wcag22"],
    perRuleCoverage: [],
    reviewCandidates: [],
    wrappers: {
      wrappers: [],
      sessionOnly: [],
      bySource: {
        fromConfig: [],
        fromSession: [],
        fromAutoDetect: { confirmed: [], assumed: [] },
      },
      elements: {},
    },
    unusedWrappers: [],
    suppressions: [],
    verboseMeta: false,
    preset: undefined,
    actionableManual: 0,
    untargetedCriteria: 0,
    configSource: "/proj/ra11y.config.ts",
    rootSource: "explicit",
    ...overrides,
  };
}

describe("assembleScanFamilyResponse", () => {
  it("emits an honest clean-scan shape — zero counters omitted, no warnings, no referenceGuide", () => {
    const r = assembleScanFamilyResponse(baseInput());
    expect(r.plan["totalFindings"]).toBe(0);
    expect(r.plan["violations"]).toBe(0);
    expect(r.plan["notes"]).toBe(0);
    // Conditional-spread zero-counts are absent, not zero.
    expect(r.plan["mechanicalEditsAvailable"]).toBeUndefined();
    expect(r.plan["fixesByClass"]).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    expect(r.referenceGuide).toBeUndefined();
    expect(r.reviewCandidates).toBeUndefined();
    expect(r.files.length).toBe(0);
  });

  it("fires `scanned_zero_files` when no parseable files reached the scanner", () => {
    const r = assembleScanFamilyResponse(baseInput({ parsedFiles: [] }));
    expect(r.warnings).toContain("scanned_zero_files");
  });

  it("fires `no_config_found` when configSource is null", () => {
    const r = assembleScanFamilyResponse(baseInput({ configSource: null }));
    expect(r.warnings).toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` when configSource is populated", () => {
    const r = assembleScanFamilyResponse(baseInput({ configSource: "/proj/ra11y.config.ts" }));
    expect(r.warnings ?? []).not.toContain("no_config_found");
  });

  it("fires `root_source_defaulted` for `git` and `spawn-cwd` fallbacks", () => {
    const git = assembleScanFamilyResponse(baseInput({ rootSource: "git" }));
    const spawn = assembleScanFamilyResponse(baseInput({ rootSource: "spawn-cwd" }));
    expect(git.warnings).toContain("root_source_defaulted");
    expect(spawn.warnings).toContain("root_source_defaulted");
  });

  it("does NOT fire `root_source_defaulted` when rootSource is explicit", () => {
    const r = assembleScanFamilyResponse(baseInput({ rootSource: "explicit" }));
    expect(r.warnings ?? []).not.toContain("root_source_defaulted");
  });

  it("groups violations by filePath and sorts the file list deterministically", () => {
    const violations = [
      violation("/src/z.tsx", 1),
      violation("/src/a.tsx", 3),
      violation("/src/m.tsx", 2),
      violation("/src/a.tsx", 1),
    ];
    const r = assembleScanFamilyResponse(
      baseInput({
        violations,
        parsedFiles: [parsedFile("/src/a.tsx"), parsedFile("/src/m.tsx"), parsedFile("/src/z.tsx")],
      }),
    );
    expect(r.files.map((f) => f.path)).toEqual(["/src/a.tsx", "/src/m.tsx", "/src/z.tsx"]);
    const a = r.files.find((f) => f.path === "/src/a.tsx");
    expect(a?.findings.length).toBe(2);
  });

  it("omits referenceGuide entirely when hoistReferenceGuide is false, even with findings", () => {
    const r = assembleScanFamilyResponse(baseInput({ violations: [violation("/src/a.tsx", 1)] }), {
      hoistReferenceGuide: false,
    });
    expect(r.referenceGuide).toBeUndefined();
    // Findings still present — the opt-out only silences the hoist.
    expect(r.files.length).toBe(1);
  });

  it("surfaces referenceGuide.suppressPlacement when findings exist and hoist is default-on", () => {
    const r = assembleScanFamilyResponse(baseInput({ violations: [violation("/src/a.tsx", 1)] }));
    expect(r.referenceGuide).toBeDefined();
    expect(r.referenceGuide?.suppressPlacement).toBeDefined();
  });

  it("tokenBudget: 0 disables truncation so `truncated` / `nextOffset` never ride along", () => {
    // Stuff enough violations to push a non-trivial serialized size.
    const violations = Array.from({ length: 20 }, (_, i) =>
      violation(`/src/file-${String(i).padStart(2, "0")}.tsx`, i + 1),
    );
    const parsedFiles = violations.map((v) => parsedFile(v.location.filePath));
    const r = assembleScanFamilyResponse(baseInput({ violations, parsedFiles }), {
      tokenBudget: 0,
    });
    expect(r.truncated).toBeUndefined();
    expect(r.nextOffset).toBeUndefined();
  });

  it("emits plan counters for mechanical edits when violations carry fix paths", () => {
    const v: Violation = {
      ...violation("/src/a.tsx", 1),
      fixPaths: {
        primary: {
          label: "add alt",
          edit: { oldText: "<img>", newText: '<img alt="">' },
        },
        alternatives: [],
      },
    } as unknown as Violation;
    const r = assembleScanFamilyResponse(baseInput({ violations: [v] }));
    expect(r.plan["mechanicalEditsAvailable"]).toBe(1);
    expect(r.plan["fixesByClass"]).toBeDefined();
  });

  it("splits notes from non-note violations in plan counters", () => {
    const note: Violation = {
      ...violation("/src/a.tsx", 1),
      severity: "info",
    } as unknown as Violation;
    const err = violation("/src/a.tsx", 2);
    const r = assembleScanFamilyResponse(baseInput({ violations: [note, err] }));
    expect(r.plan["violations"]).toBe(1);
    expect(r.plan["notes"]).toBe(1);
    expect(r.plan["totalFindings"]).toBe(2);
  });

  it("omits reviewCandidates when includeReviewCandidates is not set", () => {
    const r = assembleScanFamilyResponse(
      baseInput({
        reviewCandidates: [
          {
            criterionId: "wcag22:1.2.1",
            location: { filePath: "/src/a.tsx", line: 1, column: 1 },
            reason: "video element present",
            confidence: "medium",
          },
        ],
      }),
    );
    expect(r.reviewCandidates).toBeUndefined();
  });

  it("dedupes review candidates when includeReviewCandidates is true", () => {
    const sharedLoc = { filePath: "/src/a.tsx", line: 1, column: 1 } as const;
    const r = assembleScanFamilyResponse(
      baseInput({
        reviewCandidates: [
          {
            criterionId: "wcag22:1.4.5",
            location: sharedLoc,
            reason: "images-of-text",
            confidence: "medium",
          },
          {
            criterionId: "section508:1194.22.a",
            location: sharedLoc,
            reason: "images-of-text",
            confidence: "medium",
          },
        ],
      }),
      { includeReviewCandidates: true },
    );
    expect(r.reviewCandidates?.length).toBe(1);
    expect(r.reviewCandidates?.[0]?.criteria).toEqual(["section508:1194.22.a", "wcag22:1.4.5"]);
  });

  it("passes `scannedBuildArtifactsPresent` through to the warnings channel", () => {
    const r = assembleScanFamilyResponse(baseInput({ scannedBuildArtifactsPresent: true }));
    expect(r.warnings).toContain("scanned_build_artifacts_present");
  });

  it("passes `storybookPresetActive` through to the warnings channel", () => {
    const r = assembleScanFamilyResponse(baseInput({ storybookPresetActive: true }));
    expect(r.warnings).toContain("storybook_preset_active");
  });

  it("passes `sessionWrappersMismatchCwd` through to the warnings channel", () => {
    const r = assembleScanFamilyResponse(baseInput({ sessionWrappersMismatchCwd: true }));
    expect(r.warnings).toContain("session_wrappers_configured_for_different_cwd");
  });
});

describe("buildDerivativeScanWarnings (ADR 0024 stage 4 — derivative-tool seam)", () => {
  // The derivative-tool helper is a thin wrapper over `warningsField`;
  // these cases confirm it routes to the same authority the primary
  // scan tools use so `checklist` / `coverage` / `conformance_statement`
  // cannot drift away from the `scan` / `scan_project` warnings
  // predicate.
  it("emits `scanned_zero_files` when filesScanned is zero", () => {
    const out = buildDerivativeScanWarnings({
      filesScanned: 0,
      rootSource: null,
      configSource: undefined,
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(out.warnings).toContain("scanned_zero_files");
  });

  it("emits `no_config_found` when configSource is null", () => {
    const out = buildDerivativeScanWarnings({
      filesScanned: 1,
      rootSource: null,
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(out.warnings).toContain("no_config_found");
  });

  it("omits the fields entirely on a healthy input (never `warnings: []`)", () => {
    const out = buildDerivativeScanWarnings({
      filesScanned: 1,
      rootSource: null,
      // `undefined` means "tool did not attempt config resolution" —
      // not the same as "resolution failed to find one" (`null`).
      // Derivative tools that do not load project config pass
      // `undefined` here; primary scan tools that do load config pass
      // the resolved `sourcePath` or `null`.
      configSource: undefined,
      analysisCoverage: undefined,
      filesByExtension: undefined,
    });
    expect(out.warnings).toBeUndefined();
    expect(out.warningsDetails).toBeUndefined();
  });

  it("includes warningsDetails payload for codes that carry one", () => {
    const out = buildDerivativeScanWarnings({
      filesScanned: 1,
      rootSource: null,
      configSource: undefined,
      analysisCoverage: { skippedByExtension: { ".scss": 5, ".vue": 2 } },
      filesByExtension: undefined,
    });
    expect(out.warnings).toContain("extensions_skipped_no_parser");
    expect(out.warningsDetails?.extensions_skipped_no_parser).toBeDefined();
    expect(out.warningsDetails?.extensions_skipped_no_parser?.topExtension).toBe(".scss");
    expect(out.warningsDetails?.extensions_skipped_no_parser?.totalSkipped).toBe(7);
  });
});
