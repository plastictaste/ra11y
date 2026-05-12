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
        emissionsTotal: itemCount,
        emissionsAfterCollapse: itemCount,
        emissionsReturnedAfterClip: itemCount,
      },
      untargetedCriteriaForProject: 0,
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

  it("falls back to propose_config({}) when neither narrowingDir nor cwd is supplied", () => {
    // Last-resort fallback per Q16-PROPOSE-CONFIG-NEXTSTEP-DOES-NOT-NARROW:
    // when no scope evidence flowed through to the helper, the slim
    // envelope routes at `propose_config` with empty args — propose_config
    // resolves its own scan root from the spawn directory. Still cycle-
    // safe (NOT routed at the sibling `checklist`/`coverage` that would
    // re-trigger the slim guard) but acknowledged as the worst routing
    // decision available. The call site is expected to supply `cwd`
    // (and ideally a `narrowingDir`) so this branch fires only on
    // helper-direct invocations without context.
    const response = buildSyntheticChecklistResponse(3, {
      metaBloat: true,
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
    expect(structured.args).toEqual({});
    // Cycle-break: must NOT route to either project-rooted sibling
    // that ships from the same scope-classifier.
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });

  it("routes to propose_config({cwd}) when only cwd is supplied (no narrowing dir)", () => {
    // Q16 closure step 2: when the caller's `cwd` is known but no
    // dominant non-vendor top-level directory was honestly derivable
    // (every top dir vendor-classified, files all sit at root, top-
    // dir tally ties), the slim envelope routes to `propose_config`
    // WITH cwd. `propose_config` only accepts `cwd`, so passing it
    // explicitly avoids the implicit-default ambiguity where the
    // tool would resolve to the MCP server's spawn directory rather
    // than the scope the agent just queried. Strictly narrower than
    // `propose_config({})` — the agent gets a deterministic re-scan
    // target without re-deriving cwd.
    const response = buildSyntheticChecklistResponse(3, {
      metaBloat: true,
    });
    const result = applyChecklistBudget({
      response,
      cwd: "/tmp/example-project",
    });
    const structured = (result.response as Record<string, unknown>).nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("propose_config");
    expect(structured.args).toEqual({ cwd: "/tmp/example-project" });
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
  });

  it("routes to scan_project({restrictToPaths,cwd}) when narrowingDir + cwd are supplied", () => {
    // Q16 closure step 1: when the call site identified a dominant
    // non-vendor top-level directory in the corpus, the slim envelope
    // routes the agent at `scan_project({restrictToPaths:
    // [narrowingDir], cwd})` directly — the most direct scope-
    // narrowing call available. Skips the `propose_config` round-
    // trip entirely. Mirrors `scan_project`'s bulk-vendor scope-down
    // override so the slim envelope's recovery path stays identical
    // across project-rooted tools per "Per-tool lane and warning-set
    // classification must agree."
    const response = buildSyntheticChecklistResponse(3, {
      metaBloat: true,
    });
    const result = applyChecklistBudget({
      response,
      narrowingDir: "src",
      cwd: "/tmp/example-project",
    });
    const structured = (result.response as Record<string, unknown>).nextStepStructured as {
      tool: string;
      args: Record<string, unknown>;
    };
    expect(structured.tool).toBe("scan_project");
    expect(structured.args).toEqual({
      restrictToPaths: ["src"],
      cwd: "/tmp/example-project",
    });
    // Cycle-break invariant still holds — must NOT route to either
    // project-rooted sibling that ships from the same scope-classifier
    // and re-trigger the slim guard on the same corpus. `scan_project`
    // with a narrower `restrictToPaths` IS a scope-narrowing call
    // (different parameters, different file set on the next traversal).
    expect(structured.tool).not.toBe("coverage");
    expect(structured.tool).not.toBe("checklist");
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

describe("applyChecklistBudget — engages on empirically-rejected envelope sizes", () => {
  it("slims when the natural envelope crosses the empirical host wall (~86260 chars)", () => {
    // Regression for Q20-CHECKLIST-NO-MIN-ENVELOPE-FALLBACK: field
    // observation reported that a checklist response measuring 86260
    // serialized chars was transport-rejected by the MCP host on a
    // 50-sibling vanilla-demo corpus, while `coverage` on identical
    // cwd correctly slimmed. The host rejection sat BELOW the prior
    // 96000-char in-tree ceiling because the BPE tokenizer on dense
    // JSON identifiers runs closer to ~3.4 chars/token (86260 / 3.4
    // ≈ 25371 tokens, over the ~25k host wall) than the 4
    // chars/token proxy our gate assumed.
    //
    // Per the AI-first doctrine "Per-tool lane and warning-set
    // classification must agree": with the ceiling lowered to 80000
    // chars, an 86260-char natural envelope MUST engage the slim
    // guard — not slip through and transport-fail. The test exercises
    // the helper at the DEFAULT ceiling (no `hardCeilingChars`
    // override) so it pins production behavior on the field-report
    // size, not a synthetic test-only knob.
    const itemCount = 18;
    // ~4800 chars per item gets us to ~86260 chars overall (matched
    // empirically against the synthetic builder's wrapper bytes).
    const response = buildSyntheticChecklistResponse(itemCount, {
      itemBloatChars: 4800,
      cwd: "/tmp/example-project",
    });
    // Anchor on the empirical floor: the synthetic envelope must be
    // at least as large as the field-observed rejected size so the
    // regression check is honest. If the synthetic builder ever
    // changes shape and falls below 86260, the assertion below would
    // start passing even with a too-generous ceiling — that's the
    // exact silent-miss this floor catches.
    expect(JSON.stringify(response).length).toBeGreaterThanOrEqual(86_260);
    const result = applyChecklistBudget({ response });
    expect(result.truncated).toBe(true);
    const slim = result.response as Record<string, unknown>;
    expect(slim.items).toBeUndefined();
    expect(slim.itemsTruncated).toEqual([]);
    expect(slim.truncationReason).toBe("response_dropped_files_oversize");
    const warnings = slim.warnings as readonly string[];
    expect(warnings).toContain("response_dropped_files_oversize");
  });
});
