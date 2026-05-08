/**
 * Unit tests for the scan-family response assembler — the single seam
 * consumed (eventually) by every scan-family tool handler.
 *
 * Invariants guarded here (from docs/kb/architecture/ai-first-consumer.md):
 *
 *   - Clean scans carry no sentinel zeros — `fixesByClass` is absent,
 *     not zero. The former `safeEditsAvailable` sibling was dropped
 *     (Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT); agents sum the
 *     editable `fixesByClass` lanes instead of reading a composite.
 *   - `warnings` is entirely absent on a healthy scan, never `[]`.
 *   - Zero parsed files fires `scanned_zero_files`.
 *   - `configSource: null` + filesScanned ≥ 10 + walk saw a project
 *     marker fires `no_config_found`; a populated path / tiny repo /
 *     missing marker does not (Q-SHARED-NO-CONFIG-WARNING-TINY-REPO).
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
    // `totalFindings` was removed per "Composite headline counts are
    // dishonest." `plan.violations` was removed for the same reason
    // per. The honest plan shape carries
    // `infoSeverityFindings` (severity-info, single kind) plus `fixesByClass` (per-
    // lane structured tally, present-when-meaningful).
    expect(r.plan["totalFindings"]).toBeUndefined();
    expect(r.plan["violations"]).toBeUndefined();
    expect(r.plan["infoSeverityFindings"]).toBe(0);
    // Conditional-spread zero-counts are absent, not zero.
    // `safeEditsAvailable` was dropped entirely
    // (Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT); it must never
    // appear on the plan, populated or otherwise.
    expect(r.plan["safeEditsAvailable"]).toBeUndefined();
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

  it("fires `no_config_found` when configSource is null, filesScanned ≥ 10, and the walk saw a project marker", () => {
    // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: the warning now requires
    // (a) the loader returned null, (b) the scan saw at least ten
    // files (not a demo-size scratch run), and (c) the probe found a
    // package.json / ra11y.config.* along the walk — evidence that
    // the walk reached a real Node project root. `baseInput` defaults
    // to one parsed file, so we widen the parsedFiles list here.
    const manyFiles = Array.from({ length: 12 }, (_, i) => parsedFile(`/src/f${i}.tsx`));
    const r = assembleScanFamilyResponse(
      baseInput({
        configSource: null,
        parsedFiles: manyFiles,
        configSearchSawProjectMarker: true,
      }),
    );
    expect(r.warnings).toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` when configSource is populated", () => {
    const r = assembleScanFamilyResponse(baseInput({ configSource: "/proj/ra11y.config.ts" }));
    expect(r.warnings ?? []).not.toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` on a tiny-repo scan (filesScanned < 10) even with configSource null and the marker present", () => {
    // Canonical repro: 50projects50days standalone dirs, sub-tree
    // demos. `meta.configSource: null` still tells the agent the
    // loader found nothing; the top-level warning is duplicative
    // noise on demo-size scans.
    const r = assembleScanFamilyResponse(
      baseInput({
        configSource: null,
        parsedFiles: [parsedFile("/demo/a.tsx"), parsedFile("/demo/b.tsx")],
        configSearchSawProjectMarker: true,
      }),
    );
    expect(r.warnings ?? []).not.toContain("no_config_found");
  });

  it("does NOT fire `no_config_found` when the walk saw no project marker (scratch dir, not a Node project)", () => {
    const manyFiles = Array.from({ length: 12 }, (_, i) => parsedFile(`/scratch/f${i}.tsx`));
    const r = assembleScanFamilyResponse(
      baseInput({
        configSource: null,
        parsedFiles: manyFiles,
        configSearchSawProjectMarker: false,
      }),
    );
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

  it("emits the per-lane fixesByClass tally when violations carry fix paths (no safeEditsAvailable composite)", () => {
    // Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT: the former
    // `plan.safeEditsAvailable` counter was dropped because it
    // disagreed with `fixesByClass.mechanical` on the same response.
    // The honest shape surfaces only the per-lane tally; callers that
    // want the apply-now subset sum
    // `fixesByClass.mechanical + fixesByClass.verifyInSource`.
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
    expect(r.plan["safeEditsAvailable"]).toBeUndefined();
    expect(r.plan["fixesByClass"]).toBeDefined();
    type Lane = { source: number; buildArtifact: number };
    const lanes = r.plan["fixesByClass"] as {
      mechanical: Lane;
      guidance: Lane;
      runtimeOnly: Lane;
      verifyInSource: Lane;
    };
    const laneSum = (l: Lane): number => l.source + l.buildArtifact;
    // The test `violation` helper stamps fixClass: "mechanical"; the
    // editable-lane sum is a straightforward caller-side derivation.
    expect(laneSum(lanes.mechanical)).toBe(1);
    expect(laneSum(lanes.mechanical) + laneSum(lanes.verifyInSource)).toBe(1);
  });

  it("splits notes from non-note violations via plan.infoSeverityFindings + plan.fixesByClass (no composite headline)", () => {
    const note: Violation = {
      ...violation("/src/a.tsx", 1),
      severity: "info",
    } as unknown as Violation;
    const err = violation("/src/a.tsx", 2);
    const r = assembleScanFamilyResponse(baseInput({ violations: [note, err] }));
    // `plan.violations` and `plan.totalFindings` were both removed
    // per the "Composite headline counts are dishonest" doctrine
    // (/ ADR 0024). The honest shape
    // carries `plan.infoSeverityFindings` (severity-info, single kind)
    // and `plan.fixesByClass` (per-lane structured tally) — consumers
    // that want the flat error+warning total sum the four lanes.
    expect(r.plan["violations"]).toBeUndefined();
    expect(r.plan["totalFindings"]).toBeUndefined();
    expect(r.plan["infoSeverityFindings"]).toBe(1);
    type Lane = { source: number; buildArtifact: number };
    const lanes = r.plan["fixesByClass"] as Record<string, Lane>;
    const laneSum = (l: Lane | undefined): number => (l?.source ?? 0) + (l?.buildArtifact ?? 0);
    const errorWarningTotal =
      laneSum(lanes["mechanical"]) +
      laneSum(lanes["guidance"]) +
      laneSum(lanes["runtimeOnly"]) +
      laneSum(lanes["verifyInSource"]);
    expect(errorWarningTotal).toBe(1);
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

  it("Q14: elides review candidate whose (file, line, criterion) is already covered by a rule finding in the same response", () => {
    // Canonical Q14 case: the rule emission satisfies wcag22:4.1.2 at
    // line 12; a parallel review candidate at the same line under the
    // same criterion is purely redundant — the agent already has the
    // actionable signal on the rule finding with WCAG attribution
    // intact. Per AI-first doctrine the inverse of "Surface, don't
    // suppress": signal redundancy without dedup is its own dishonesty.
    const r = assembleScanFamilyResponse(
      baseInput({
        violations: [violation("/src/a.tsx", 12, "aria/expanded-on-disclosure")],
        reviewCandidates: [
          {
            criterionId: "wcag22:1.1.1",
            location: { filePath: "/src/a.tsx", line: 12, column: 4 },
            reason: "covered by rule finding (same criterion)",
            confidence: "medium",
          },
          {
            criterionId: "wcag22:3.3.8",
            location: { filePath: "/src/a.tsx", line: 12, column: 4 },
            reason: "different criterion at same line — survives",
            confidence: "medium",
          },
          {
            criterionId: "wcag22:1.1.1",
            location: { filePath: "/src/a.tsx", line: 25, column: 4 },
            reason: "different line — survives",
            confidence: "medium",
          },
        ],
      }),
      { includeReviewCandidates: true },
    );
    // The fixture violation() helper stamps `criteria: ["wcag22:1.1.1"]`
    // on every finding regardless of ruleId — this lets the test
    // assert the dedup predicate without coupling to any specific
    // rule's `satisfies` set. The wcag22:1.1.1 candidate at line 12
    // is dropped; the other two survive.
    expect(r.reviewCandidates?.length).toBe(2);
    const surviving = (r.reviewCandidates ?? [])
      .map((c) => `${c.line}:${c.criteria.join(",")}`)
      .sort();
    expect(surviving).toEqual(["12:wcag22:3.3.8", "25:wcag22:1.1.1"]);
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

  // The former `meta.countsBySurface` cross-surface tripwire — a 4-way
  // internal spread of disagreeing finding totals — was dropped per
  // `docs/kb/architecture/ai-first-consumer.md` "Composite headline
  // counts are dishonest." A field whose name implied cross-surface
  // reconciliation but whose contents were three competing summaries
  // of the same response read like an additional contested headline
  // rather than the disagreement tripwire it claimed to be. Consumers
  // that want to reconcile read the structured siblings directly.
  describe("meta.countsBySurface — dropped composite, doctrine pin", () => {
    it("cross-surface invariant — sum(files[*].findings) equals sum(plan.fixesByClass) + plan.infoSeverityFindings on a non-truncated scan", () => {
      const note: Violation = {
        ...violation("/src/a.tsx", 1),
        severity: "info",
      } as unknown as Violation;
      const errA = violation("/src/a.tsx", 2);
      const errB = violation("/src/b.tsx", 3);
      const r = assembleScanFamilyResponse(
        baseInput({
          violations: [note, errA, errB],
          parsedFiles: [parsedFile("/src/a.tsx"), parsedFile("/src/b.tsx")],
        }),
      );
      expect(r.truncated).toBeUndefined();
      let filesSurface = 0;
      for (const f of r.files) filesSurface += f.findings.length;
      type Lane = { source: number; buildArtifact: number };
      const lanes = r.plan["fixesByClass"] as Record<string, Lane> | undefined;
      const laneSum = (l: Lane | undefined): number => (l?.source ?? 0) + (l?.buildArtifact ?? 0);
      const errorWarning =
        laneSum(lanes?.["mechanical"]) +
        laneSum(lanes?.["guidance"]) +
        laneSum(lanes?.["runtimeOnly"]) +
        laneSum(lanes?.["verifyInSource"]);
      const planTotal = errorWarning + (r.plan["infoSeverityFindings"] as number);
      expect(filesSurface).toBe(planTotal);
    });

    it("never emits meta.countsBySurface — even when perRuleCoverage disagrees with plan, the dropped composite stays absent", () => {
      const v = violation("/src/a.tsx", 1);
      const r = assembleScanFamilyResponse(
        baseInput({
          violations: [v],
          // perRuleCoverage simulates the scanner-raw stream tallying
          // more findings than the filtered plan view — the historical
          // worst-case for cross-surface drift. The field is no longer
          // emitted regardless.
          perRuleCoverage: [
            {
              ruleId: "alt-text/missing",
              filesEvaluated: 1,
              filesEligible: 1,
              findingsEmitted: 5,
              fired: true,
              coverageConfidence: "high",
            },
          ],
        }),
      );
      expect(r.meta["countsBySurface"]).toBeUndefined();
    });
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

  it("emits `no_config_found` when configSource is null, filesScanned ≥ 10, and the walk saw a project marker", () => {
    // Q-SHARED-NO-CONFIG-WARNING-TINY-REPO: same gate as the primary
    // scan tools. Derivative tools currently pass
    // `configSource: undefined` at their call sites (config isn't
    // part of their handler contract), so the code rarely fires here
    // in production — but the predicate stays uniform across surfaces
    // so future derivative-tool integrations that DO thread
    // configSource through get the same gating behavior.
    const out = buildDerivativeScanWarnings({
      filesScanned: 12,
      rootSource: null,
      configSource: null,
      analysisCoverage: undefined,
      filesByExtension: undefined,
      configSearchSawProjectMarker: true,
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
    expect(out.warnings).toContain("text_source_skipped");
    expect(out.warningsDetails?.text_source_skipped).toBeDefined();
    expect(out.warningsDetails?.text_source_skipped?.topExtension).toBe(".scss");
    expect(out.warningsDetails?.text_source_skipped?.totalSkipped).toBe(7);
  });
});
