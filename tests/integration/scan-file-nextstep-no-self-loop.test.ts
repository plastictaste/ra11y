/**
 * Pins the AI-first doctrine bullet
 * "NextStep handoffs must terminate at a narrowing tool, never form a
 * cycle between transport-failing siblings"
 * (`docs/kb/architecture/ai-first-consumer.md`) at the per-tool
 * self-loop axis on `scan_file`.
 *
 * Pre-fix regression: `scan_file` on a response with zero error/warning
 * findings but one or more info-severity notes routed
 * `nextStepStructured` to `{ tool: "scan_file", args: { path: <same
 * path> } }` — echoing the caller's exact arguments. The agent
 * following the structured hint re-ran `scan_file` on the same path,
 * producing the same info-only response and the same self-loop. No
 * progression toward `suggest_fix`, `checklist`, or scope narrowing.
 *
 * Distinct from the cross-tool cycle case the
 * `nextstep-cycle-avoidance.test.ts` pins (project-rooted siblings
 * routing at each other): here the cycle is one tool routing at
 * itself with identical args.
 *
 * Closure: on `scan_file` with no error/warning-severity findings,
 *   - if review-candidates exist (actionable manual-review items),
 *     route structured to `checklist`;
 *   - otherwise route structured to `suggest_fix` on the highest-
 *     priority (first-callable) info-level finding.
 *
 * Pinned at the `buildNextStep` helper level — the `tool-scan-file.ts`
 * call site wires this helper into the response under
 * `nextStepStructured`, and the wiring is exercised by the existing
 * `scan-file-*` integration tests. Pinning at the helper avoids the
 * MCP subprocess startup cost while keeping the invariant on the same
 * code path the wire-level test would exercise.
 */

import { describe, expect, it } from "bun:test";
import { buildNextStep } from "../../src/mcp/next-step.ts";
import type { ScanFormatted } from "../../src/mcp/tools-helpers.ts";

function infoOnlyScanFormatted(
  args: {
    readonly path: string;
    readonly ruleId: string;
    readonly line: number;
    readonly actionableManualSource?: number;
  },
): ScanFormatted {
  return {
    plan: {
      infoSeverityFindings: 1,
      ...(args.actionableManualSource === undefined
        ? {}
        : {
            actionableManualItemsBySource: {
              source: args.actionableManualSource,
              buildArtifact: 0,
            },
          }),
    },
    files: [
      {
        path: args.path,
        findings: [
          {
            ruleId: args.ruleId,
            line: args.line,
            column: 1,
            severity: "info",
          },
        ],
      },
    ] as unknown as ScanFormatted["files"],
    meta: {},
  };
}

describe("scan_file nextStepStructured never echoes the caller's own args (no self-loop)", () => {
  it("routes to suggest_fix on the first info-level finding when no review-candidates exist", () => {
    const path = "src/Sidebar.tsx";
    const result = buildNextStep(
      infoOnlyScanFormatted({ path, ruleId: "aria/hidden-focus", line: 21 }),
      { singleFilePath: path },
    );

    // Self-loop guard: structured MUST NOT echo the caller's
    // `scan_file({ path })` arguments.
    expect(result.structured).not.toEqual({ tool: "scan_file", args: { path } });

    // The honest route on the no-review-candidates arm: suggest_fix
    // on the first info-level finding so the agent inspects per-
    // finding evidence directly.
    expect(result.structured).toEqual({
      tool: "suggest_fix",
      args: { ruleId: "aria/hidden-focus", file: path, line: 21 },
    });

    // Prose / structured channel agreement: the prose names the
    // same tool the structured hint encodes (AI-first doctrine
    // "NextStep prose and structured channels must agree").
    expect(result.prose).toContain("suggest_fix");
  });

  it("routes to checklist when review-candidates exist on the file", () => {
    const path = "src/Page.tsx";
    const result = buildNextStep(
      infoOnlyScanFormatted({
        path,
        ruleId: "aria/hidden-focus",
        line: 5,
        actionableManualSource: 3,
      }),
      { singleFilePath: path },
    );

    expect(result.structured).not.toEqual({ tool: "scan_file", args: { path } });
    expect(result.structured).toEqual({ tool: "checklist", args: {} });
    expect(result.prose).toContain("checklist");
  });

  it("never echoes caller args even when first finding shares the caller's path (general invariant)", () => {
    // Walk a few representative shapes to make the invariant robust
    // against future branch changes inside the notes-only handling.
    const path = "components/widget.tsx";
    const shapes: readonly { readonly actionableManualSource?: number }[] = [
      {},
      { actionableManualSource: 0 },
      { actionableManualSource: 1 },
      { actionableManualSource: 7 },
    ];
    for (const shape of shapes) {
      const result = buildNextStep(
        infoOnlyScanFormatted({
          path,
          ruleId: "review/focus-order",
          line: 9,
          ...shape,
        }),
        { singleFilePath: path },
      );
      expect(result.structured).not.toEqual({
        tool: "scan_file",
        args: { path },
      });
    }
  });
});
