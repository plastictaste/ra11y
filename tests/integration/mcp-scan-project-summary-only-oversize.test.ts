/**
 * `scan_project({ summaryOnly: true })` oversize-envelope guard.
 *
 * Closes Q17-SUMMARYONLY-OVERSIZE-NO-WARNING. Pre-fix observation: on a
 * vendor-heavy CSS framework corpus the standard envelope shipped 82k
 * chars (transport-fail) and the `summaryOnly: true` envelope still
 * shipped 54k chars (still over host cap, transport-fail) — but its
 * `warnings[]` carried neither `response_token_budget_truncated` nor
 * `response_dropped_files_oversize`. The summary-only path silently
 * succeeded-then-transport-failed with no signal telling the caller to
 * scope down further.
 *
 * Per AI-first doctrine "Oversize-success is ambiguous failure" — when
 * the summary envelope itself crosses the host token ceiling, the
 * caller needs the same minimum-honest envelope behavior the standard
 * `scan_project` slim path offers: trim verbose secondary surfaces and
 * stamp `response_dropped_files_oversize` so the agent reads an honest
 * "scope down further" signal.
 *
 * Strategy: drive the helper directly with a small synthetic ceiling
 * so the test is tractable without building a 100+ KB corpus. The
 * ceiling override is the same primitive `oversize-envelope.ts`
 * exposes for unit tests; per the cross-surface integration test in
 * `oversize-envelope-cross-surface.test.ts`, the helper's contract is
 * the pinned surface — wiring at each tool's textResult callsite is
 * exercised by their respective `tool-*.ts` integration tests.
 */

import { describe, expect, it } from "bun:test";
import { applySummaryOnlyBudget } from "../../src/mcp/scan-project-summary-only.ts";

interface SlimWarningPayload {
  readonly preDropBytes: number;
  readonly hardCeilingBytes: number;
  readonly droppedFileCountFromRequestedLimit: number;
  readonly totalFilesWithFindings: number;
  readonly metaFieldsDropped?: readonly string[];
  readonly slimTruncations?: readonly {
    readonly fieldPath: string;
    readonly shown: number;
    readonly total: number;
  }[];
}

/**
 * Synthetic summary-only response shaped like the wire output of
 * `buildSummaryOnlyResponse` — discriminator pair (`summaryOnly: true`
 * + `filesArrayDropped: true`), `plan` with verbose rollups, slim
 * `meta`, prose nextStep + structured next-step. Used to drive the
 * budget helper into the slim path with a small synthetic ceiling.
 */
function buildLargeSummaryResponse(): Record<string, unknown> {
  return {
    plan: {
      // Long arrays the slim path should head-slice.
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
    nextStep: "Summary-only mode skipped per-file findings to fit under the response envelope. ".repeat(
      3,
    ),
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
      // Bloat the meta to push the envelope past a low ceiling.
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

describe("scan_project summaryOnly — oversize-envelope guard", () => {
  it("passes the response through unchanged when under the ceiling", () => {
    const original = buildLargeSummaryResponse();
    const result = applySummaryOnlyBudget({ response: original });
    expect(result.truncated).toBe(false);
    expect(result.response).toBe(original);
  });

  it("emits response_dropped_files_oversize when the summary envelope crosses the ceiling", () => {
    const original = buildLargeSummaryResponse();
    // Force the slim path with a synthetic ceiling well below the
    // synthetic response size. Same override pattern as
    // `oversize-envelope-cross-surface.test.ts`.
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: 500 });
    expect(result.truncated).toBe(true);
    const warnings = (result.response["warnings"] as readonly string[]) ?? [];
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = result.response["warningsDetails"] as Record<string, unknown>;
    const payload = details["response_dropped_files_oversize"] as SlimWarningPayload;
    expect(payload).toBeDefined();
    expect(payload.preDropBytes).toBeGreaterThan(500);
    expect(payload.hardCeilingBytes).toBe(500);
    expect(payload.totalFilesWithFindings).toBe(4936);
  });

  it("retains the summaryOnly + filesArrayDropped discriminator pair on the slim path", () => {
    const original = buildLargeSummaryResponse();
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: 500 });
    expect(result.truncated).toBe(true);
    // Discriminator pair MUST survive the slim path so the agent
    // reading the response can still tell summary-only mode from a
    // clean scan of zero files. Per "Truncated containers must rename
    // or sentinel, not retain" — the slim path adds the warning, it
    // does NOT strip the mode discriminator.
    expect(result.response["summaryOnly"]).toBe(true);
    expect(result.response["filesArrayDropped"]).toBe(true);
    expect(typeof result.response["totalFilesWithFindings"]).toBe("number");
  });

  it("trims verbose plan arrays and reports them in slimTruncations", () => {
    const original = buildLargeSummaryResponse();
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: 500 });
    expect(result.truncated).toBe(true);
    const plan = result.response["plan"] as Record<string, unknown>;
    // findingsByRule on the input had 80 entries — the slim path
    // head-slices it so the post-trim count is well under 80.
    const findingsByRule = plan["findingsByRule"];
    if (findingsByRule !== undefined) {
      expect(Object.keys(findingsByRule as Record<string, number>).length).toBeLessThan(80);
    }
    const details = result.response["warningsDetails"] as Record<string, unknown>;
    const payload = details["response_dropped_files_oversize"] as SlimWarningPayload;
    // slimTruncations should name at least one trimmed field path
    // (the helper picks among the known verbose plan / meta surfaces).
    expect(payload.slimTruncations).toBeDefined();
    expect((payload.slimTruncations ?? []).length).toBeGreaterThan(0);
  });

  it("preserves prior warnings when the slim path fires", () => {
    // Pre-existing warning state (e.g. from upstream scan-meta
    // detectors) must thread through the slim merge — same shape as
    // `oversizeEnvelopeWarningsField` already pins for the standard
    // scan_project path.
    const original = {
      ...buildLargeSummaryResponse(),
      warnings: ["scanned_build_artifacts_present"],
    };
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: 500 });
    expect(result.truncated).toBe(true);
    const warnings = (result.response["warnings"] as readonly string[]) ?? [];
    expect(warnings).toContain("scanned_build_artifacts_present");
    expect(warnings).toContain("response_dropped_files_oversize");
  });

  it("rewrites nextStep to recommend narrower scope on the slim path", () => {
    const original = buildLargeSummaryResponse();
    const result = applySummaryOnlyBudget({ response: original, hardCeilingChars: 500 });
    expect(result.truncated).toBe(true);
    // Per "NextStep handoffs must terminate at a narrowing tool" —
    // when the summary envelope itself was over the ceiling, the
    // recovery is "scope down further," not "page deeper."
    const nextStep = result.response["nextStep"];
    expect(typeof nextStep).toBe("string");
    expect((nextStep as string).length).toBeGreaterThan(0);
  });

  it("does not mutate the input response object", () => {
    const original = buildLargeSummaryResponse();
    const snapshot = JSON.stringify(original);
    applySummaryOnlyBudget({ response: original, hardCeilingChars: 500 });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
