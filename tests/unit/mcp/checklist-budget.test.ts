/**
 * Unit tests for `applyChecklistBudget` — the oversize-envelope slim
 * fallback for the `checklist` tool. Closes
 * Q14-CHECKLIST-COVERAGE-LACK-MINIMUM-HONEST-ENVELOPE on the
 * checklist surface.
 *
 * Symmetric to `tests/unit/mcp/scan-project-budget-oversize.test.ts`
 * and `tests/unit/mcp/scan-file-budget.test.ts` — exercises:
 *
 *   - Pass-through when the response fits under the host ceiling — wire
 *     shape stays byte-identical to the input.
 *   - The slim fallback when the post-build envelope overflows —
 *     `itemsTruncated: []` (renamed from `items` so the field name
 *     signals truncation), `truncationReason`, warnings + payload.
 *   - The slim envelope's structured `nextStep` routes to a different
 *     surface (`coverage`) than the failing tool, per the
 *     "NextStep prioritization on truncated/bulk responses must avoid
 *     re-routing to the failed tool" extension of the doctrine bullet.
 *   - Cross-surface invariant: warning code + payload shape match
 *     scan_project / scan_file slim paths exactly.
 */

import { describe, expect, it } from "bun:test";
import { applyChecklistBudget } from "../../../src/mcp/checklist-budget.ts";

function buildSyntheticChecklistResponse(
  itemCount: number,
  options: { itemBloatChars?: number; metaBloat?: boolean; cwd?: string } = {},
): Record<string, unknown> {
  const bloat = "x".repeat(options.itemBloatChars ?? 0);
  const items = Array.from({ length: itemCount }, (_, i) => ({
    criterionId: `wcag22:1.${i + 1}.1`,
    title: `Item ${i + 1}`,
    candidates: [
      {
        path: `src/component-${i}.tsx`,
        line: i + 1,
        column: 1,
        reason: bloat.length > 0 ? `${bloat} reason ${i}` : `reason ${i}`,
      },
    ],
  }));
  return {
    summary: {
      actionable: {
        criteria: itemCount,
        candidatesUncapped: itemCount,
        candidatesReturned: itemCount,
      },
      untargetedCriteria: 0,
    },
    items,
    totalCandidates: itemCount,
    untargetedCriteriaList: [],
    likelyIrrelevant: [],
    nextStep: "Iterate items[].",
    nextStepStructured: { tool: "scan_project", args: { cwd: options.cwd ?? "/tmp/test" } },
    meta: {
      tool: "checklist",
      version: "0.1.0",
      standards: ["wcag22"],
      level: "AA",
      filesScanned: itemCount,
      durationMs: 5,
      configSource: null,
      cwd: options.cwd ?? "/tmp/test",
      scanned: { kind: "project", root: options.cwd ?? "/tmp/test" },
      ...(options.metaBloat ? { bloatedField: "y".repeat(200_000) } : {}),
    },
  };
}

describe("applyChecklistBudget — pass-through under ceiling", () => {
  it("returns the response unchanged when envelope fits under host ceiling", () => {
    const response = buildSyntheticChecklistResponse(5);
    const result = applyChecklistBudget({ response });
    // Pass-through preserves the input reference (no clone) when the
    // slim guard didn't fire.
    expect(result.response).toBe(response);
    expect(result.truncated).toBe(false);
  });
});

describe("applyChecklistBudget — slim fallback fires on oversize envelope", () => {
  it("degrades to minimum-honest envelope when items+meta exceed host ceiling", () => {
    // Force the over-ceiling regime by stuffing meta with a synthetic
    // bloat field. The slim path drops items[] entirely and ships the
    // warning code + payload.
    const response = buildSyntheticChecklistResponse(3, {
      metaBloat: true,
      cwd: "/tmp/example-project",
    });
    const result = applyChecklistBudget({ response });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    // The slim shape keeps `summary` + slimmed `meta` + `nextStep` +
    // the warnings channel. The verbose `items[]` array is RENAMED to
    // `itemsTruncated` (per the doctrine bullet "Truncated containers
    // must rename or sentinel, not retain") — an agent reading just
    // `response.items` now gets `undefined` rather than the misleading
    // `[]` that used to ship under the original field name. The
    // recovery path is to re-call with narrower scope.
    expect(slim.items).toBeUndefined();
    expect(slim.itemsTruncated).toEqual([]);
    expect(slim.truncationReason).toBe("response_dropped_files_oversize");
    // The legacy boolean flag was dropped — the field-rename signals
    // the same fact at the field level, so a sibling boolean would be
    // redundant (per "Sibling fields naming the same concept must use
    // one shape").
    expect(slim.itemsArrayDropped).toBeUndefined();
    expect(slim.truncated).toBe(true);
    expect(slim.totalCandidates).toBe(3);
    // `summary` is load-bearing — the agent budgets against it for the
    // actionable count even when items[] dropped.
    expect(slim.summary).toBeDefined();
    // Warnings channel carries the structured code + payload.
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
    const details = slim.warningsDetails as Record<string, unknown>;
    const dropPayload = details["response_dropped_files_oversize"] as {
      preDropBytes: number;
      hardCeilingBytes: number;
      droppedFileCountFromRequestedLimit: number;
      totalFilesWithFindings: number;
      metaFieldsDropped?: readonly string[];
    };
    expect(dropPayload).toBeDefined();
    expect(dropPayload.preDropBytes).toBeGreaterThan(dropPayload.hardCeilingBytes);
    expect(dropPayload.hardCeilingBytes).toBeGreaterThan(0);
    // `metaFieldsDropped` names the bloat field the slim builder
    // discarded so the agent can distinguish "no scan-confidence
    // concerns" from "block was clipped to fit." Per the
    // "Truncated containers must rename or sentinel, not retain"
    // doctrine bullet.
    expect(dropPayload.metaFieldsDropped).toBeDefined();
    expect(dropPayload.metaFieldsDropped).toContain("bloatedField");
    // The slim meta dropped the bloat field; only known scan-confidence
    // keys survive.
    const meta = slim.meta as Record<string, unknown>;
    expect(meta).not.toHaveProperty("bloatedField");
    expect(meta.tool).toBe("checklist");
    expect(meta.version).toBe("0.1.0");
    expect(meta.filesScanned).toBe(3);
    expect(meta.cwd).toBe("/tmp/example-project");
  });

  it("routes nextStep to propose_config (scope-narrowing tool) when the slim guard fires", () => {
    // Cycle-break invariant per
    // `docs/kb/architecture/ai-first-consumer.md` "NextStep handoffs
    // must terminate at a narrowing tool, never form a cycle between
    // transport-failing siblings": pointing at the sibling
    // project-rooted `coverage` tool (the previous routing) on a
    // bulk-vendor / oversize corpus would echo the same scope-
    // classifier and re-trigger `coverage`'s own slim guard — the
    // canonical circular handoff with no narrowing path. The slim
    // envelope's structured next-call routes to `propose_config`
    // (deterministic exclude-block emission from the build-artifact
    // classifier), so the next `scan_project` call after the agent
    // applies the proposed excludes traverses a narrower file set by
    // construction.
    const response = buildSyntheticChecklistResponse(3, {
      metaBloat: true,
      cwd: "/tmp/example-project",
    });
    const result = applyChecklistBudget({ response });
    const slim = result.response as Record<string, unknown>;
    expect(typeof slim.nextStep).toBe("string");
    expect((slim.nextStep as string).length).toBeGreaterThan(0);
    const structured = slim.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured).toBeDefined();
    expect(structured.tool).toBe("propose_config");
    // `propose_config` resolves its own scan root, and fabricating a
    // `cwd` here would lock the agent into the same too-large scope
    // that just produced the oversize envelope. Empty args is the
    // honest shape — per the doctrine bullet, the structured target
    // must "never echo the parameters that just produced the
    // truncation."
    expect(structured.args).toEqual({});
    // Cycle-break: must NOT route to either project-rooted sibling
    // that ships from the same scope-classifier.
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });

  it("ships empty args even when meta carries cwd (cycle-break invariant)", () => {
    // The cycle-break routing is unconditional — `propose_config`
    // resolves its own scan root regardless of whether the caller's
    // cwd is recoverable, and including the cwd would echo the same
    // scope the slim envelope just truncated.
    const response = buildSyntheticChecklistResponse(3, { metaBloat: true });
    (response.meta as Record<string, unknown>).cwd = undefined;
    const result = applyChecklistBudget({ response });
    const slim = result.response as Record<string, unknown>;
    const structured = slim.nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("propose_config");
    expect(structured.args).toEqual({});
  });
});

describe("applyChecklistBudget — custom hardCeilingChars (test ergonomics)", () => {
  it("triggers slim path under a small synthetic ceiling", () => {
    // Smaller ceiling lets us trigger the slim path on a tractable
    // fixture without the 200-KB synthetic bloat. Pinned via the
    // exported `hardCeilingChars` knob the helper accepts for tests.
    const response = buildSyntheticChecklistResponse(20, {
      itemBloatChars: 100,
      cwd: "/tmp/example-project",
    });
    const result = applyChecklistBudget({ response, hardCeilingChars: 1000 });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    expect(slim.items).toBeUndefined();
    expect(slim.itemsTruncated).toEqual([]);
    expect(slim.truncationReason).toBe("response_dropped_files_oversize");
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
  });
});
