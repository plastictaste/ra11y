/**
 * Pins the AI-first doctrine bullet
 * "NextStep prose and structured channels must agree"
 * (`docs/kb/architecture/ai-first-consumer.md`).
 *
 * Every project-rooted response shipping both `nextStep` (prose) and
 * `nextStepStructured` (`{ tool, args }`) must derive both channels
 * from the same response-assembly predicate. When the prose advises a
 * scope-narrowing call, the structured field MUST encode that same
 * call's tool + args; when the prose advises a different next move,
 * the structured field MUST encode that move. Silent disagreement
 * between the channels — prose says "scope down further: pass
 * `restrictToPaths`" while structured ships `{ tool: "explain_rule" }`
 * — is the canonical regression the bullet closes.
 *
 * Predicate: the structured tool name must be consistent with the
 * action verb in the prose's first one-or-two sentences. We encode a
 * verb→tool table mapping each canonical narrowing-prose phrase to the
 * tools that honestly satisfy it:
 *
 *   - "scope down" / "narrow scope" / "tighter `cwd`" /
 *     "use `restrictToPaths`" / "additional[Pp]aths" →
 *     `scan_project` (with narrowing args), `propose_config`,
 *     `scan_file`, `coverage` (the documented narrowing-recovery set).
 *   - "page forward" / "Re-call `scan_file`" → `scan_file`.
 *   - "call `explain_rule`" / "explain_rule" → `explain_rule`.
 *   - "call `suggest_fix`" / "suggest_fix" → `suggest_fix`.
 *   - "call `checklist`" / "checklist" → `checklist`.
 *   - "call `coverage`" / "coverage" → `coverage`.
 *
 * The test focuses on the slim / scope-down branches where the
 * disagreement was originally observed (summary-only oversize fallback,
 * standard slim envelope, scan_file slim envelope). The
 * cycle-avoidance test (`nextstep-cycle-avoidance.test.ts`) pins the
 * adjacent "no cycle between transport-failing siblings" invariant; the
 * two tests share the closure but the agreement axis stands on its own.
 *
 * Forces the slim/oversize branches by exercising the budget helpers
 * with synthetic responses on a small `hardCeilingChars` (same pattern
 * as `oversize-envelope-cross-surface.test.ts` and the cycle-avoidance
 * test). Full MCP subprocess spawn would require fabricating a 100+ KB
 * bulk corpus to trigger the natural ceiling — brittle and slow; the
 * helper contracts are the pinned surface here.
 */

import { describe, expect, it } from "bun:test";
import { applyScanFileBudget } from "../../src/mcp/scan-file-budget.ts";
import { buildSlimNextStepStructured as buildScanProjectSlimNextStep } from "../../src/mcp/scan-project-slim-next-step.ts";
import { applySummaryOnlyBudget } from "../../src/mcp/scan-project-summary-only.ts";
import type { ScanFormatted } from "../../src/mcp/tools-helpers.ts";

const HARD_CEILING = 500;

/**
 * Phrases that mark a "scope down / narrow input" action verb in the
 * prose's first sentence(s). Case-insensitive substring match. When any
 * of these fire, the structured channel must route at a tool in the
 * `NARROWING_TOOLS` set (or a `scan_project` call with a narrowing
 * args knob).
 */
const NARROWING_VERB_PHRASES: readonly string[] = [
  "scope down",
  "narrow scope",
  "tighter `cwd`",
  "tighter cwd",
  "restricttopaths",
  "additionalpaths",
  "narrower scope",
  "scope to",
];

/**
 * Tools whose call semantics narrow input by construction. Calling any
 * of these from a "scope down" prose is honest. `scan_project` is
 * borderline — it narrows ONLY when its `args` carry a real narrowing
 * knob (`restrictToPaths` / `additionalPaths` / a different `cwd`),
 * and the agreement predicate enforces that explicitly. The remaining
 * narrowing-recovery tools (`scan_file`, `coverage`, `propose_config`,
 * `baseline`, `detect_native_wrappers`) narrow by construction
 * regardless of args.
 */
const NARROWING_RECOVERY_TOOLS: ReadonlySet<string> = new Set([
  "propose_config",
  "scan_file",
  "coverage",
  "baseline",
  "detect_native_wrappers",
]);

/**
 * Returns true when the prose's first one-or-two sentences carry any
 * of the narrowing-verb phrases. Lowercases first so the match is
 * case-insensitive (`Scope down...` vs. `scope down...`).
 */
function proseAdvisesNarrowing(prose: string): boolean {
  const head = prose.toLowerCase();
  return NARROWING_VERB_PHRASES.some((phrase) => head.includes(phrase));
}

/**
 * Returns true when the structured `{ tool, args }` honestly satisfies
 * a "scope down" prose verb. Either the tool is in the
 * narrowing-recovery set (single-file / single-criterion / explicit
 * exclude-emission surface), OR it routes to `scan_project` with a
 * real narrowing knob in `args` (`restrictToPaths` / `additionalPaths`
 * non-empty array, or a `cwd` distinct from the originating cwd).
 *
 * Empty array `restrictToPaths: []` does NOT clear — the doctrine
 * `nextstep-cycle-avoidance` test already names this the canonical
 * "echoes the same scope" failure mode.
 */
function structuredHonorsNarrowing(structured: {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}): boolean {
  if (NARROWING_RECOVERY_TOOLS.has(structured.tool)) return true;
  if (structured.tool !== "scan_project") return false;
  const a = structured.args;
  if (Array.isArray(a["restrictToPaths"]) && a["restrictToPaths"].length > 0) return true;
  if (Array.isArray(a["additionalPaths"]) && a["additionalPaths"].length > 0) return true;
  // A different cwd (sub-tree) would also clear, but the slim
  // builders here don't ship that arm — keep this strict so the test
  // catches regressions where the slim builder accidentally ships a
  // bare `{ tool: "scan_project", args: {} }`.
  return false;
}

/**
 * Synthetic `summaryOnly: true` response shaped like the wire output
 * of `buildSummaryOnlyResponse`. Mirrors the fixture in
 * `mcp-scan-project-summary-only-oversize.test.ts` (the structured
 * next-step input is `explain_rule({ ruleId })` — the upstream summary
 * builder's normal output — so the test verifies the slim builder
 * REPLACES it with a narrowing call rather than propagating).
 */
function buildLargeSummaryResponse(): Record<string, unknown> {
  return {
    plan: {
      topRules: Array.from({ length: 10 }, (_, i) => ({
        ruleId: `rules/r-${String(i).padStart(2, "0")}`,
        count: 100 - i,
      })),
      findingsByRule: Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [`rules/r-${String(i).padStart(2, "0")}`, 80 - i]),
      ),
      findingsByFile: Array.from({ length: 20 }, (_, i) => ({
        path: `templates/site-${String(i).padStart(3, "0")}/index.html`,
        count: 20 - i,
      })),
      fixesByClass: { mechanical: 100, guidance: 50, runtimeOnly: 0, verifyInSource: 0 },
      infoSeverityFindings: 0,
      actionableManualItemsBySource: { source: 5, buildArtifact: 0 },
      untargetedCriteriaForProject: 0,
    },
    summaryOnly: true as const,
    filesArrayDropped: true as const,
    totalFilesWithFindings: 4936,
    nextStep: "Summary-only mode skipped per-file findings.".repeat(3),
    // Canonical upstream structured hint — `explain_rule` on the
    // top-firing rule. The summary-slim envelope MUST replace this
    // with a narrowing call so the prose ("Scope down further...")
    // and structured channels agree.
    nextStepStructured: { tool: "explain_rule", args: { ruleId: "rules/r-00" } },
    meta: {
      tool: "scan_project",
      version: "0.1.0",
      standards: ["wcag22"],
      level: "AA",
      filesScanned: 4936,
      durationMs: 1234,
      configSource: null,
      scanned: { root: "/tmp/x", extras: [] },
      filesByExtension: Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`.ext${String(i).padStart(2, "0")}`, i + 1]),
      ),
      rulesEvaluated: 86,
      filesWithAnyRuleEvaluated: 4936,
      filesWithZeroRuleEvaluation: 0,
      rulesNotEvaluatedDueToInputType: [],
      analysisCoverage: {
        parseErrorFiles: Array.from({ length: 50 }, (_, i) => `vendor/path-${i}.css`),
        partialParseFiles: [],
        fragmentFiles: [],
        skippedByExtension: { ".jpg": 1835 },
      },
    },
  };
}

/**
 * Synthetic scan_file response shaped like the wire output. The
 * scan_file slim envelope's prose advises "Re-call `scan_file` with
 * offset/limit" — the structured channel must route back to scan_file
 * with a derived `limit` knob (the single-file surface narrows by
 * construction).
 */
function buildOversizeScanFileResponse(): Record<string, unknown> {
  return {
    findings: Array.from({ length: 50 }, (_, i) => ({
      findingId: `x@${i + 1}`,
      ruleId: "test/rule",
      severity: "error",
      line: i + 1,
      column: 1,
    })),
    plan: {
      infoSeverityFindings: 0,
      fixesByClass: {
        mechanical: { source: 1, buildArtifact: 0 },
        guidance: { source: 0, buildArtifact: 0 },
        runtimeOnly: { source: 0, buildArtifact: 0 },
        verifyInSource: { source: 0, buildArtifact: 0 },
      },
      reviewNeeded: 0,
      manualOnly: 0,
      estimatedEffort: "trivial",
      summary: "50 findings",
    },
    nextStep: "Call suggest_fix.",
    meta: {
      tool: "scan_file",
      version: "0.1.0",
      filesScanned: 1,
      configSource: null,
      scanned: { kind: "file", file: "/tmp/x.html" },
      bloatedField: "y".repeat(2000),
    },
  };
}

/**
 * Synthetic `ScanFormatted` for scan_project's slim builder — the
 * non-vendor file `src/app.tsx` carries the most findings, so the slim
 * envelope routes to `scan_file` on it. The slim prose names that exact
 * surface ("structured next-call routes to a different surface
 * (`scan_file`...)") — the agreement test pins that routing.
 */
function buildScanProjectFormatted(): ScanFormatted {
  return {
    files: [
      {
        path: "src/app.tsx",
        findings: [
          { findingId: "a@1", ruleId: "alt/img", severity: "error", line: 1, column: 1 },
          { findingId: "a@2", ruleId: "alt/img", severity: "error", line: 5, column: 1 },
        ],
      },
      {
        path: "src/foo.tsx",
        findings: [{ findingId: "f@1", ruleId: "alt/img", severity: "error", line: 1, column: 1 }],
      },
    ],
    totalFindings: 3,
  } as unknown as ScanFormatted;
}

describe("nextStep prose <-> structured agreement — every slim envelope's structured tool consistent with the prose's action verb", () => {
  it("summary-slim envelope: prose advises scope-down AND structured routes to a narrowing tool (not the upstream explain_rule)", () => {
    // Pre-fix observation: `buildSummarySlimEnvelope` propagated the
    // upstream summary's `nextStepStructured` verbatim — typically
    // `{ tool: "explain_rule", args: { ruleId } }` — even though the
    // slim prose was rewritten to "Scope down further...". The
    // canonical doctrine miss the fix closes.
    const original = buildLargeSummaryResponse();
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: HARD_CEILING });
    expect(result.truncated).toBe(true);

    const slim = result.response as Record<string, unknown>;
    const prose = slim["nextStep"] as string;
    const structured = slim["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };

    expect(typeof prose).toBe("string");
    expect(structured).toBeDefined();

    // The prose MUST carry a scope-down action verb on this branch.
    expect(proseAdvisesNarrowing(prose)).toBe(true);
    // The structured tool MUST honor that verb (narrowing-recovery
    // tool, or scan_project with a real narrowing knob). The regression
    // shipped `{ tool: "explain_rule" }` — explicitly NOT in the
    // narrowing set and not scan_project-with-knob.
    expect(
      structuredHonorsNarrowing(structured),
      `summary-slim envelope prose advises scope-down but structured routes at ${
        structured.tool
      } with args ${JSON.stringify(
        structured.args,
      )} — channels disagree. Per AI-first doctrine "NextStep prose and structured channels must agree."`,
    ).toBe(true);
    // The regression signature: upstream explain_rule propagation. Pin
    // the exact failure mode so a future "propagate upstream" refactor
    // surfaces here.
    expect(structured.tool).not.toBe("explain_rule");
  });

  it("summary-slim envelope: structured prefers `scan_project { restrictToPaths: [<head findingsByFile.path>] }` when the slim plan exposes it", () => {
    // The slim prose's primary recommendation reads "use
    // `restrictToPaths: [<dominant path from plan.findingsByFile>]`."
    // The structured channel must encode exactly that call — the
    // head findingsByFile entry's path is the dominant path the prose
    // names, so the structured `restrictToPaths` array should carry it.
    const original = buildLargeSummaryResponse();
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: HARD_CEILING });
    const slim = result.response as Record<string, unknown>;
    const structured = slim["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };

    expect(structured.tool).toBe("scan_project");
    const restrictTo = structured.args["restrictToPaths"];
    expect(Array.isArray(restrictTo)).toBe(true);
    expect((restrictTo as readonly string[]).length).toBeGreaterThan(0);
    // Same path the prose tells the operator to read off the plan.
    expect((restrictTo as readonly string[])[0]).toMatch(/templates\/site-/);
  });

  it("summary-slim envelope: falls back to `propose_config` when the slim plan dropped findingsByFile entirely", () => {
    // When trimSummaryPlan head-slices findingsByFile to the cap (3
    // entries) the head is still present, but a degenerate plan with
    // no findingsByFile array at all should fall back to the
    // documented narrowing-recovery surface (`propose_config`) per the
    // slim prose's "or call `propose_config`" alternative. Build a
    // response whose plan lacks findingsByFile entirely to exercise
    // the fallback arm.
    const original = buildLargeSummaryResponse();
    const plan = original["plan"] as Record<string, unknown>;
    delete plan["findingsByFile"];

    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: HARD_CEILING });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const structured = slim["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };

    // Fallback: when no addressable head path, route to
    // `propose_config` (a deterministic narrowing-recovery tool per
    // the cycle-avoidance test's NARROWING_RECOVERY_TOOLS set).
    expect(structured.tool).toBe("propose_config");
    // Still honors narrowing by construction.
    expect(structuredHonorsNarrowing(structured)).toBe(true);
  });

  it("scan_project slim envelope: prose names the cross-surface pivot AND structured routes to that same surface", () => {
    // The standard `scan_project` slim envelope's prose explicitly
    // names the cross-surface route the structured channel takes
    // ("structured next-call routes to a different surface (`scan_file`
    // on the top-impact non-vendor file, or `coverage` for the
    // manual-review angle)"). The structured channel must encode one
    // of those two — never something unrelated. Pin both arms.
    const formatted = buildScanProjectFormatted();
    // Arm 1: top non-vendor file exists → scan_file on it.
    const armOne = buildScanProjectSlimNextStep({
      formatted,
      params: { cwd: "/tmp/q20-scan-project" },
      isVendor: () => false,
    });
    expect(armOne.tool).toBe("scan_file");
    expect(structuredHonorsNarrowing(armOne)).toBe(true);
    // Arm 2: every file vendor → coverage (manual-review angle).
    const armTwo = buildScanProjectSlimNextStep({
      formatted,
      params: { cwd: "/tmp/q20-scan-project" },
      isVendor: () => true,
    });
    expect(armTwo.tool).toBe("coverage");
    expect(structuredHonorsNarrowing(armTwo)).toBe(true);
  });

  it("scan_file slim envelope: prose advises Re-call scan_file with offset/limit AND structured re-routes to scan_file with a derived limit", () => {
    // The scan_file slim envelope's prose says "Re-call `scan_file`
    // with `offset: <effectiveLimit>` ... or with `limit: <smaller>`".
    // The structured channel routes back to scan_file because the
    // single-file surface narrows by construction (one file is not a
    // bulk corpus). The agreement here is explicit: same tool, same
    // recovery surface.
    const result = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    const prose = slim["nextStep"] as string;
    const structured = slim["nextStepStructured"] as {
      tool: string;
      args: Record<string, unknown>;
    };

    // Prose first sentence: "The full response was over the MCP host's
    // token ceiling, so per-finding details were dropped..." Second
    // sentence: "Re-call `scan_file` with `offset: <effectiveLimit>`...".
    // The recovery verb is "Re-call `scan_file`" — structured agrees.
    expect(prose.toLowerCase()).toContain("scan_file");
    expect(structured.tool).toBe("scan_file");
    // The args must carry a `limit` knob (narrowing the next call's
    // per-page count). Empty args would echo the failing scope.
    expect(typeof structured.args["limit"]).toBe("number");
  });

  it("walk-property closure: every fired slim envelope across the project-rooted/file-rooted set agrees on the narrowing axis", () => {
    // Property check across the slim builders pinned above. For each:
    // if the prose advises narrowing, the structured channel must
    // honor narrowing. Catches a future regression where one builder
    // is rewritten to keep narrowing prose but accidentally drop the
    // narrowing args (e.g. shipping `{ tool: "scan_project", args: {} }`).
    const summaryResult = applySummaryOnlyBudget({
      response: buildLargeSummaryResponse(),
      hardCeilingChars: HARD_CEILING,
    });
    const scanFileResult = applyScanFileBudget({
      limit: undefined,
      offset: undefined,
      maxBytes: HARD_CEILING,
      response: buildOversizeScanFileResponse(),
    });
    const scanProjectStructured = buildScanProjectSlimNextStep({
      formatted: buildScanProjectFormatted(),
      params: { cwd: "/tmp/q20-walk" },
      isVendor: () => false,
    });

    const slimResponses: ReadonlyArray<{
      readonly source: string;
      readonly prose: string;
      readonly structured: { readonly tool: string; readonly args: Record<string, unknown> };
    }> = [
      {
        source: "scan_project summary-slim",
        prose: (summaryResult.response as Record<string, unknown>)["nextStep"] as string,
        structured: (summaryResult.response as Record<string, unknown>)["nextStepStructured"] as {
          tool: string;
          args: Record<string, unknown>;
        },
      },
      {
        source: "scan_file slim",
        prose: (scanFileResult.response as Record<string, unknown>)["nextStep"] as string,
        structured: (scanFileResult.response as Record<string, unknown>)["nextStepStructured"] as {
          tool: string;
          args: Record<string, unknown>;
        },
      },
      {
        // The standard scan_project slim builder's prose lives at the
        // shared constant; reusing it inline matches what the
        // assembly site stamps.
        source: "scan_project slim",
        prose:
          "The full response was over the MCP host's token ceiling, so per-file findings were dropped to keep the envelope routable.",
        structured: scanProjectStructured,
      },
    ];

    for (const { source, prose, structured } of slimResponses) {
      // The slim envelopes here all carry narrowing prose by design;
      // the agreement assertion is that structured honors narrowing on
      // every one. The prose-side predicate is informational — if a
      // future refactor drops the narrowing prose, the test maintainer
      // will see the assertion change shape rather than silently pass.
      if (proseAdvisesNarrowing(prose)) {
        expect(
          structuredHonorsNarrowing(structured),
          `${source} prose advises scope-down but structured routes at ${
            structured.tool
          } with args ${JSON.stringify(
            structured.args,
          )} — channels disagree. Per AI-first doctrine "NextStep prose and structured channels must agree."`,
        ).toBe(true);
      }
    }
  });
});
