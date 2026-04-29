/**
 * Unit tests for `src/mcp/next-step.ts`.
 *
 * The helper emits two views of the same recommendation:
 *   - `prose` — English summary; kept for humans and weaker LLMs.
 *   - `structured` — `{ tool, args }` machine hint; omitted when the
 *     prose degrades to generic multi-option advice (CLAUDE.md §1
 *     "Ambiguous field shapes are dishonest").
 *
 * These tests guard the alignment invariant: whichever tool the prose
 * names as the next call is the same tool the structured form names,
 * with args populated from the same first-finding tuple. If the prose
 * picks `suggest_fix` but the structured form reports `checklist`, the
 * whole point of shipping both forms collapses.
 */

import { describe, expect, it } from "bun:test";
import {
  buildNextStep,
  bulkVendorScopeDownNextStep,
  perRuleNarrowingNextStep,
  pickTopRuleByCount,
  shouldRerouteToBulkVendorScopeDown,
  shouldRerouteToPerRuleNarrowing,
} from "../../../src/mcp/next-step.ts";
import type { ScanFormatted } from "../../../src/mcp/tools-helpers.ts";

// These tests probe `buildNextStep`'s graceful handling of partial or
// malformed finding shapes — the function reads a few fields with
// optional chains and falls back cleanly when they're missing. Relax
// the helper's `files` parameter type so tests can exercise the real
// defensive code path without synthesizing full `AgentFinding`
// fixtures. Production call sites always pass `AgentFinding[]` through
// the strictly-typed `ScanFormatted`.
function formatted(overrides: {
  plan?: Record<string, unknown>;
  files?: readonly {
    readonly path: string;
    readonly findings: readonly Record<string, unknown>[];
  }[];
}): ScanFormatted {
  return {
    plan: overrides.plan ?? {},
    files: (overrides.files ?? []) as unknown as ScanFormatted["files"],
    meta: {},
  };
}

/**
 * Test fixture helper: produce a `plan.fixesByClass` block in the
 * per-scan-kind shape ({@link FixesByClassLane}) from flat per-lane
 * counts. Defaults every lane's `buildArtifact` half to zero — the
 * common `nextStep` test scope is "no vendor classification ran," so
 * every finding routes to the `source` half. Keeps the per-test fixture
 * literals readable while still emitting the shape the production
 * helper expects.
 */
function lanes(
  flat: Partial<{
    mechanical: number;
    guidance: number;
    runtimeOnly: number;
    verifyInSource: number;
  }>,
): Record<string, { source: number; buildArtifact: number }> {
  return {
    mechanical: { source: flat.mechanical ?? 0, buildArtifact: 0 },
    guidance: { source: flat.guidance ?? 0, buildArtifact: 0 },
    runtimeOnly: { source: flat.runtimeOnly ?? 0, buildArtifact: 0 },
    verifyInSource: { source: flat.verifyInSource ?? 0, buildArtifact: 0 },
  };
}

const sampleFinding = {
  ruleId: "aria/hidden-focus",
  line: 21,
  column: 4,
  message: "focusable descendant inside aria-hidden",
};

describe("buildNextStep", () => {
  it("returns suggest_fix with aligned prose + structured args when a fixable violation exists", () => {
    // The flat `plan.violations`
    // headline is gone; `buildNextStep` derives the count from
    // `plan.fixesByClass` so all next-step fixtures populate the
    // per-lane tally. One mechanical violation here.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ mechanical: 1 }),
        },
        files: [{ path: "DemoComposer.tsx", findings: [sampleFinding] }],
      }),
    );

    // Prose names the tool and the concrete file:line the agent should
    // open. Structured form names the same tool with canonical args
    // (`file`, not `filePath`,).
    expect(result.prose).toContain("suggest_fix");
    expect(result.prose).toContain("DemoComposer.tsx:21");
    expect(result.prose).toContain("aria/hidden-focus");
    expect(result.structured).toEqual({
      tool: "suggest_fix",
      args: { ruleId: "aria/hidden-focus", file: "DemoComposer.tsx", line: 21 },
    });
  });

  it("returns explain_rule when violations exist but no fix is available", () => {
    // Two violations in the runtime-only lane (which `buildNextStep`
    // counts toward `violations` but not `fixable`) — the branch
    // wants violations>0 but fixable===0.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ runtimeOnly: 2 }),
        },
        files: [{ path: "Header.tsx", findings: [sampleFinding] }],
      }),
    );

    expect(result.prose).toContain("explain_rule");
    expect(result.prose).toContain("aria/hidden-focus");
    expect(result.structured).toEqual({
      tool: "explain_rule",
      args: { ruleId: "aria/hidden-focus" },
    });
  });

  it("returns scan_file when the response carries only info-level notes", () => {
    // `notes` (severity-info) tracks a different axis than the
    // `fixesByClass` lanes — leaving `fixesByClass` empty signals
    // "no error/warning violations" and the branch falls into the
    // notes-only handling.
    const result = buildNextStep(
      formatted({
        plan: { notes: 3 },
        files: [{ path: "Sidebar.tsx", findings: [sampleFinding] }],
      }),
    );

    expect(result.prose).toContain("scan_file");
    expect(result.prose).toContain("Sidebar.tsx");
    expect(result.structured).toEqual({ tool: "scan_file", args: { path: "Sidebar.tsx" } });
  });

  it("returns checklist on a clean automated scan — both prose and structured point at the manual half", () => {
    const result = buildNextStep(formatted({ plan: { notes: 0, actionableManualItems: 0 } }));

    expect(result.prose).toContain("checklist");
    expect(result.structured).toEqual({ tool: "checklist", args: {} });
  });

  it("returns checklist when the actionable-manual count is non-zero", () => {
    const result = buildNextStep(formatted({ plan: { notes: 0, actionableManualItems: 4 } }));

    expect(result.prose).toContain("checklist");
    expect(result.prose).toContain("4 manual-review");
    expect(result.structured).toEqual({ tool: "checklist", args: {} });
  });

  it("omits the structured form when violations exist but no concrete (file, line, ruleId) can be named", () => {
    // Simulates the fallback branch: counts say something is wrong,
    // but `files` carries no extractable first finding. The prose
    // falls back to multi-option generic advice; the structured hint
    // is omitted (CLAUDE.md §1) rather than fabricated.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ runtimeOnly: 1 }),
        },
        files: [{ path: "Unknown.tsx", findings: [{ malformed: true }] }],
      }),
    );

    expect(result.prose).toMatch(/explain_rule/);
    expect(result.structured).toBeUndefined();
  });

  it("drops the suggest_fix nudge when every violation carries fixClass=mechanical", () => {
    // when every violation-severity finding already
    // carries an inline mechanical fix (primary + alternatives +
    // context), re-nudging the agent to call suggest_fix is a
    // redundant round-trip. Both prose and structured must be
    // trimmed consistently — a one-sided trim
    // would re-create the exact drift we ship both forms to prevent.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ mechanical: 2 }),
        },
        files: [
          {
            path: "App.tsx",
            findings: [
              { ...sampleFinding, severity: "error", fixClass: "mechanical" },
              {
                ruleId: "aria/valid-attr",
                line: 44,
                column: 2,
                severity: "warning",
                fixClass: "mechanical",
              },
            ],
          },
        ],
      }),
    );

    expect(result.prose).not.toContain("suggest_fix");
    expect(result.prose).toContain("apply `primary.edit` directly");
    expect(result.structured).toBeUndefined();
  });

  it("keeps the suggest_fix nudge when some violations are mechanical and others are guidance", () => {
    // Mixed-lane case: the guidance / verify-in-source / runtime-only
    // findings still need the round-trip, so the shared nudge stays.
    // This is the guardrail that prevents the dedupe from turning
    // into under-surfacing: when even one violation would benefit
    // from suggest_fix, we keep it for all of them.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ mechanical: 1, guidance: 1 }),
        },
        files: [
          {
            path: "App.tsx",
            findings: [
              { ...sampleFinding, severity: "error", fixClass: "mechanical" },
              {
                ruleId: "label/in-name",
                line: 88,
                column: 6,
                severity: "warning",
                fixClass: "guidance",
              },
            ],
          },
        ],
      }),
    );

    expect(result.prose).toContain("suggest_fix");
    expect(result.structured).toEqual({
      tool: "suggest_fix",
      args: { ruleId: "aria/hidden-focus", file: "App.tsx", line: 21 },
    });
  });

  it("keeps the suggest_fix nudge when every violation is guidance-class", () => {
    // All-guidance: no mechanical fixes exist, so the nudge is still
    // the canonical next step. Fail-closed predicate — we only drop
    // the nudge when 100% of violations are mechanical.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ guidance: 1 }),
        },
        files: [
          {
            path: "App.tsx",
            findings: [{ ...sampleFinding, severity: "error", fixClass: "guidance" }],
          },
        ],
      }),
    );

    expect(result.prose).toContain("suggest_fix");
    expect(result.structured).toEqual({
      tool: "suggest_fix",
      args: { ruleId: "aria/hidden-focus", file: "App.tsx", line: 21 },
    });
  });

  it("leaves the clean-scan nextStep unchanged when there are no violations", () => {
    // No-violations branch is outside the dedupe predicate's scope —
    // the flag is computed but irrelevant, and the clean-scan
    // recommendation (`checklist`) must not be affected.
    const result = buildNextStep(formatted({ plan: { notes: 0, actionableManualItems: 0 } }));

    expect(result.prose).toContain("checklist");
    expect(result.prose).not.toContain("suggest_fix");
    expect(result.structured).toEqual({ tool: "checklist", args: {} });
  });

  it("keeps the suggest_fix nudge when a violation is missing fixClass (fail-closed)", () => {
    // Synthetic / legacy shapes that don't stamp fixClass must NOT
    // slip past the predicate as "mechanical by default" — silent
    // drop of the nudge on an unknown lane is the exact under-
    // surfacing the AI-first doctrine rejects. The predicate
    // fail-closes: if a violation is missing fixClass, the suggest_fix
    // nudge stays.
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ mechanical: 1 }),
        },
        files: [
          {
            path: "App.tsx",
            // No fixClass on this finding.
            findings: [{ ...sampleFinding, severity: "error" }],
          },
        ],
      }),
    );

    expect(result.prose).toContain("suggest_fix");
    expect(result.structured).toEqual({
      tool: "suggest_fix",
      args: { ruleId: "aria/hidden-focus", file: "App.tsx", line: 21 },
    });
  });

  // ── Prompt-link assertions ──────────────────────────────
  // Each canonical workflow endpoint should surface the right prompt
  // template by name so agents discover them without extra round-trips
  // to `prompts/list`. The assertions are literal-string checks —
  // typos in the template name ("vpat" vs "ra11y/vpat-narrative") are
  // caught here before they ship.

  it("clean scan with manual candidates mentions ra11y/triage prompt", () => {
    const result = buildNextStep(formatted({ plan: { notes: 0, actionableManualItems: 3 } }));
    expect(result.prose).toContain("ra11y/triage");
    expect(result.prose).toContain("prompts/get");
    // Structured still points at the MCP tool (checklist); the prompt
    // name lives in the prose only per task instructions.
    expect(result.structured).toEqual({ tool: "checklist", args: {} });
  });

  it("clean scan with zero manual candidates mentions ra11y/audit prompt", () => {
    const result = buildNextStep(formatted({ plan: { notes: 0, actionableManualItems: 0 } }));
    expect(result.prose).toContain("ra11y/audit");
    expect(result.prose).toContain("prompts/get");
    // Structured still points at checklist — the canonical next MCP call.
    expect(result.structured).toEqual({ tool: "checklist", args: {} });
  });

  it("violation branch with fixable violations mentions ra11y/fix prompt", () => {
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ guidance: 2 }),
        },
        files: [
          {
            path: "App.tsx",
            findings: [
              { ...sampleFinding, severity: "error", fixClass: "guidance" },
              {
                ruleId: "label/empty",
                line: 10,
                column: 1,
                severity: "warning",
                fixClass: "guidance",
              },
            ],
          },
        ],
      }),
    );
    expect(result.prose).toContain("ra11y/fix");
    expect(result.prose).toContain("prompts/get");
    // Structured still points at suggest_fix (the MCP tool).
    expect(result.structured?.tool).toBe("suggest_fix");
  });

  it("all-mechanical violations branch mentions ra11y/fix prompt", () => {
    const result = buildNextStep(
      formatted({
        plan: {
          fixesByClass: lanes({ mechanical: 1 }),
        },
        files: [
          {
            path: "App.tsx",
            findings: [{ ...sampleFinding, severity: "error", fixClass: "mechanical" }],
          },
        ],
      }),
    );
    expect(result.prose).toContain("ra11y/fix");
    expect(result.prose).toContain("prompts/get");
    // All-mechanical branch omits structured (dedupe logic unchanged).
    expect(result.structured).toBeUndefined();
  });

  it("produces prose and structured forms that agree on the named tool across every branch", () => {
    // Invariant check: iterate the branches that emit structured
    // output and confirm the tool name in `structured.tool` appears
    // in the prose text. Drift between the two is exactly the bug
    // The paired-emission "both fields describe the same call" rule exists to
    // prevent.
    const cases: readonly ScanFormatted[] = [
      formatted({
        plan: {
          fixesByClass: lanes({ mechanical: 1 }),
        },
        files: [{ path: "A.tsx", findings: [sampleFinding] }],
      }),
      formatted({
        plan: {
          fixesByClass: lanes({ runtimeOnly: 2 }),
        },
        files: [{ path: "B.tsx", findings: [sampleFinding] }],
      }),
      formatted({
        plan: { notes: 1 },
        files: [{ path: "C.tsx", findings: [sampleFinding] }],
      }),
      formatted({ plan: { notes: 0, actionableManualItems: 2 } }),
    ];
    for (const f of cases) {
      const result = buildNextStep(f);
      expect(result.structured).toBeDefined();
      if (result.structured) {
        expect(result.prose).toContain(result.structured.tool);
      }
    }
  });

  // ── ─────────────────────────────────
  // When the top-ranked finding sits in vendor code (bootstrap.css,
  // font-awesome.css, compiled Tailwind) AND a same-`ruleId` finding
  // exists in authored code, the builder reroutes its structured
  // target to the authored file so the agent's first action lands
  // where it can edit. When no authored alternative exists, the
  // vendor target stays — behavior is unchanged.

  describe("vendorPaths reroute", () => {
    const contrastFinding = (line: number) => ({
      ruleId: "contrast/minimum",
      line,
      column: 1,
      severity: "error" as const,
      fixClass: "guidance" as const,
    });

    it("reroutes to an authored file when the first finding is vendor and a same-ruleId authored alternative exists", () => {
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 2 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [contrastFinding(365)] },
            { path: "authored/site.css", findings: [contrastFinding(42)] },
          ],
        }),
        { vendorPaths: new Set(["vendor/bootstrap.css"]) },
      );
      // Structured form now points at the authored file — that's the
      // whole point of the reroute.
      expect(result.structured).toEqual({
        tool: "suggest_fix",
        args: { ruleId: "contrast/minimum", file: "authored/site.css", line: 42 },
      });
      // Prose prepends a reason-note naming the vendor file the agent
      // is being steered away from.
      expect(result.prose).toContain("vendor/bootstrap.css");
      expect(result.prose).toContain("authored/site.css");
      expect(result.prose).toContain("same-family fix");
    });

    it("routes to scope-down when every callable finding sits in vendor code", () => {
      // Per the AI-first doctrine "NextStep prioritization on
      // truncated/bulk responses must avoid first-by-filename
      // routing": when every callable finding sits on a vendor path,
      // naming any specific finding wastes the suggest_fix
      // round-trip — the agent can't edit a vendor stylesheet. The
      // structured hint reroutes to `scan_project` itself with
      // `additionalPaths` / `cwd` narrowing as the recovery, mirroring
      // the slim-envelope nextStep shape.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 2 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [contrastFinding(365)] },
            { path: "vendor/font-awesome.css", findings: [contrastFinding(12)] },
          ],
        }),
        {
          vendorPaths: new Set(["vendor/bootstrap.css", "vendor/font-awesome.css"]),
        },
      );
      expect(result.structured).toEqual({
        tool: "scan_project",
        args: {},
      });
      expect(result.prose).toContain("vendor code");
      expect(result.prose).toContain("additionalPaths");
      // Naming the specific vendor path the picker would have surfaced
      // is load-bearing context — the agent reads it as evidence of
      // the corpus shape (compiled-CSS-only paged in this slice).
      expect(result.prose).toContain("vendor/bootstrap.css");
    });

    it("falls back to the highest-firing non-vendor rule when no same-ruleId non-vendor sibling exists", () => {
      // Per the AI-first doctrine, the dominant-rule fallback fires
      // when the same-ruleId reroute fails: rather than keeping the
      // vendor target (the prior behavior) or routing to scope-down
      // (the all-vendor branch), pick the highest-firing non-vendor
      // rule's first finding. The reroute crosses rule families, so
      // the prose names the rule-family change explicitly so the
      // agent doesn't assume a same-family substitution.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 2 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [contrastFinding(365)] },
            {
              path: "authored/site.css",
              findings: [{ ...contrastFinding(42), ruleId: "motion/pause-stop-hide" }],
            },
          ],
        }),
        { vendorPaths: new Set(["vendor/bootstrap.css"]) },
      );
      // Reroute lands on the authored file under the dominant
      // non-vendor rule — different ruleId from the vendor pick.
      expect(result.structured?.args).toEqual({
        ruleId: "motion/pause-stop-hide",
        file: "authored/site.css",
        line: 42,
      });
      // Prose names both the rerouted-from vendor path AND the
      // rule-family change; the "highest-firing non-vendor rule"
      // framing replaces the "same-family fix is applicable" framing
      // used by the same-ruleId reroute. The dominant-rule prefix
      // explicitly states "no same-family non-vendor alternative
      // exists" so the agent reads why the reroute crossed rule
      // families.
      expect(result.prose).toContain("vendor/bootstrap.css");
      expect(result.prose).toContain("authored/site.css");
      expect(result.prose).toContain("highest-firing non-vendor rule");
      expect(result.prose).toContain("no same-family non-vendor alternative");
      expect(result.prose).not.toContain("same-family fix is applicable");
    });

    it("is a no-op when vendorPaths is empty or omitted (behavior unchanged from pre-Q6)", () => {
      // Additive constraint: when the caller doesn't plumb
      // `scannedBuildArtifacts` through (scan, scan_file, tests), the
      // reroute code path short-circuits and the first-callable-
      // finding answer is exactly what would have shipped before.
      const withoutOption = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 1 }),
          },
          files: [{ path: "vendor/bootstrap.css", findings: [contrastFinding(365)] }],
        }),
      );
      const withEmptySet = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 1 }),
          },
          files: [{ path: "vendor/bootstrap.css", findings: [contrastFinding(365)] }],
        }),
        { vendorPaths: new Set() },
      );
      expect(withoutOption.structured?.args).toEqual({
        ruleId: "contrast/minimum",
        file: "vendor/bootstrap.css",
        line: 365,
      });
      expect(withEmptySet.structured?.args).toEqual({
        ruleId: "contrast/minimum",
        file: "vendor/bootstrap.css",
        line: 365,
      });
      expect(withoutOption.prose).not.toContain("same-family");
      expect(withEmptySet.prose).not.toContain("same-family");
    });

    it("does not reroute when the first finding is already in authored code", () => {
      // The classifier may flag `vendor/bootstrap.css` under the same
      // response that has an authored finding first. The reroute
      // predicate is "first finding is vendor" — if the first is
      // already authored, no rerouting is necessary and no
      // reason-note should appear.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 2 }),
          },
          files: [
            { path: "authored/site.css", findings: [contrastFinding(42)] },
            { path: "vendor/bootstrap.css", findings: [contrastFinding(365)] },
          ],
        }),
        { vendorPaths: new Set(["vendor/bootstrap.css"]) },
      );
      expect(result.structured?.args).toEqual({
        ruleId: "contrast/minimum",
        file: "authored/site.css",
        line: 42,
      });
      expect(result.prose).not.toContain("same-family");
    });

    it("reroutes inside the explain_rule branch when no fixes are available", () => {
      // Structural parity: the reason-note + rerouted target apply to
      // every violation branch that names a concrete finding, not just
      // the fixable sub-branch. The explain_rule branch is exercised
      // when `fixable === 0` — make sure the reroute lands there too.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ runtimeOnly: 2 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [contrastFinding(365)] },
            { path: "authored/site.css", findings: [contrastFinding(42)] },
          ],
        }),
        { vendorPaths: new Set(["vendor/bootstrap.css"]) },
      );
      expect(result.structured).toEqual({
        tool: "explain_rule",
        args: { ruleId: "contrast/minimum" },
      });
      expect(result.prose).toContain("vendor/bootstrap.css");
      expect(result.prose).toContain("authored/site.css");
      expect(result.prose).toContain("same-family");
    });

    it("dominant-rule fallback picks the non-vendor rule with the highest finding count", () => {
      // When the same-`ruleId` reroute fails, the picker tallies
      // findings per `ruleId` over non-vendor files only and picks the
      // top-firing rule. Two non-vendor rule families here; the
      // higher-count one (`forms/labels-required`, 3 occurrences) wins
      // over the lower-count one (`motion/pause-stop-hide`, 1
      // occurrence) regardless of file order on the page.
      const labelsFinding = (line: number) => ({
        ruleId: "forms/labels-required",
        line,
        column: 1,
        severity: "error" as const,
        fixClass: "guidance" as const,
      });
      const motionFinding = (line: number) => ({
        ruleId: "motion/pause-stop-hide",
        line,
        column: 1,
        severity: "error" as const,
        fixClass: "guidance" as const,
      });
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 4 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [contrastFinding(365)] },
            { path: "authored/animations.css", findings: [motionFinding(10)] },
            { path: "authored/forms-a.tsx", findings: [labelsFinding(20), labelsFinding(40)] },
            { path: "authored/forms-b.tsx", findings: [labelsFinding(15)] },
          ],
        }),
        { vendorPaths: new Set(["vendor/bootstrap.css"]) },
      );
      // Top non-vendor rule is `forms/labels-required` (3 hits across
      // two files); its first non-vendor finding sits at
      // `authored/forms-a.tsx:20`.
      expect(result.structured?.args).toEqual({
        ruleId: "forms/labels-required",
        file: "authored/forms-a.tsx",
        line: 20,
      });
      expect(result.prose).toContain("highest-firing non-vendor rule");
    });

    it("scope-down branch fires when every callable finding is vendor and there are no fixes", () => {
      // Structural parity: the all-vendor → scope-down branch fires
      // regardless of whether the violations carry fix suggestions.
      // Mixing a runtime-only lane (no `suggest_fix`-actionable fix)
      // with vendor-only paths must still route to scope-down rather
      // than into the explain_rule branch on a vendor target.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ runtimeOnly: 1 }),
          },
          files: [{ path: "vendor/bootstrap.css", findings: [contrastFinding(365)] }],
        }),
        { vendorPaths: new Set(["vendor/bootstrap.css"]) },
      );
      expect(result.structured).toEqual({
        tool: "scan_project",
        args: {},
      });
      expect(result.prose).toContain("vendor code");
      expect(result.prose).toContain("additionalPaths");
    });
  });

  // ── truncated-response reroute ──────────────────────────────
  // Per the AI-first doctrine "NextStep prioritization on truncated/
  // bulk responses must avoid first-by-filename routing": when the
  // response is paged (truncated: true), the alphabetical first pick
  // is a poor default — visual-regression fixtures, scaffold dirs
  // (`_template/index.html`), and underscore-prefixed templates
  // routinely sort earliest. The picker reroutes to the highest-
  // firing non-vendor rule's first finding so the agent's first
  // action lands on the rule with broadest authored impact.
  describe("truncated-response reroute", () => {
    const labelsFinding = (line: number) => ({
      ruleId: "forms/labels-required",
      line,
      column: 1,
      severity: "error" as const,
      fixClass: "guidance" as const,
    });
    const altFinding = (line: number) => ({
      ruleId: "alt-text/missing",
      line,
      column: 1,
      severity: "error" as const,
      fixClass: "guidance" as const,
    });

    it("reroutes alphabetical-first to the highest-firing rule's first finding when truncated", () => {
      // Alphabetical first sits at `__fixtures__/visual.tsx` under
      // `alt-text/missing` (one occurrence). The dominant non-vendor
      // rule is `forms/labels-required` (3 occurrences across two
      // authored files); reroute lands on its first finding at
      // `app/login.tsx:10`.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 4 }),
          },
          files: [
            { path: "__fixtures__/visual.tsx", findings: [altFinding(20)] },
            { path: "app/login.tsx", findings: [labelsFinding(10), labelsFinding(45)] },
            { path: "app/signup.tsx", findings: [labelsFinding(15)] },
          ],
        }),
        { truncated: true },
      );
      expect(result.structured?.args).toEqual({
        ruleId: "forms/labels-required",
        file: "app/login.tsx",
        line: 10,
      });
      // Prose names the rerouted-from path AND the paged-corpus
      // framing so the agent reads the correct cause for the
      // substitution. The vendor framing must not appear — the
      // rerouted-from path is authored, not vendor.
      expect(result.prose).toContain("__fixtures__/visual.tsx");
      expect(result.prose).toContain("app/login.tsx");
      expect(result.prose).toContain("response is truncated");
      expect(result.prose).toContain("highest-firing non-vendor rule");
      expect(result.prose).not.toContain("vendor code");
    });

    it("does not reroute when truncated:true but alphabetical first IS the highest-firing rule's first finding", () => {
      // Alphabetical first sits at `app/login.tsx:10` under
      // `forms/labels-required` — same rule, same file, same line as
      // the dominant pick. No reroute should fire; the prose stays
      // clean and reads like a non-truncated response.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 3 }),
          },
          files: [
            { path: "app/login.tsx", findings: [labelsFinding(10), labelsFinding(45)] },
            { path: "app/signup.tsx", findings: [labelsFinding(15)] },
          ],
        }),
        { truncated: true },
      );
      expect(result.structured?.args).toEqual({
        ruleId: "forms/labels-required",
        file: "app/login.tsx",
        line: 10,
      });
      expect(result.prose).not.toContain("response is truncated");
      expect(result.prose).not.toContain("highest-firing non-vendor rule");
    });

    it("does not reroute when truncated is false (behavior unchanged on small scans)", () => {
      // Same input as the first reroute test, but `truncated: false`.
      // The alphabetical first (`__fixtures__/visual.tsx`) wins
      // unchanged — small scans where the whole inventory ships
      // shouldn't pay the reroute's prose-noise cost.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 4 }),
          },
          files: [
            { path: "__fixtures__/visual.tsx", findings: [altFinding(20)] },
            { path: "app/login.tsx", findings: [labelsFinding(10), labelsFinding(45)] },
            { path: "app/signup.tsx", findings: [labelsFinding(15)] },
          ],
        }),
        { truncated: false },
      );
      expect(result.structured?.args).toEqual({
        ruleId: "alt-text/missing",
        file: "__fixtures__/visual.tsx",
        line: 20,
      });
      expect(result.prose).not.toContain("response is truncated");
    });

    it("does not reroute when truncated is omitted entirely (default behavior)", () => {
      // Same input, no `truncated` option. Behavior must be identical
      // to the pre-change shape so existing callers (scan, scan_file)
      // that don't plumb truncation through aren't impacted.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 4 }),
          },
          files: [
            { path: "__fixtures__/visual.tsx", findings: [altFinding(20)] },
            { path: "app/login.tsx", findings: [labelsFinding(10), labelsFinding(45)] },
            { path: "app/signup.tsx", findings: [labelsFinding(15)] },
          ],
        }),
      );
      expect(result.structured?.args).toEqual({
        ruleId: "alt-text/missing",
        file: "__fixtures__/visual.tsx",
        line: 20,
      });
      expect(result.prose).not.toContain("response is truncated");
    });

    it("does not reroute to a finding whose path is in scannedBuildArtifacts (vendor lane wins)", () => {
      // Mixed signal: alphabetical first is a vendor file AND
      // truncated: true. The vendor-aware reroute lane fires first
      // (it has a same-`ruleId` non-vendor sibling), so the prose
      // uses the vendor framing — the truncation lane only kicks in
      // when the alphabetical first is non-vendor. Per the backlog
      // test: when scannedBuildArtifacts contains the candidate,
      // nextStep does NOT route to it.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 3 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [labelsFinding(365)] },
            { path: "app/login.tsx", findings: [labelsFinding(10), labelsFinding(45)] },
          ],
        }),
        {
          vendorPaths: new Set(["vendor/bootstrap.css"]),
          truncated: true,
        },
      );
      // Reroute target is the authored file under same-`ruleId` lane.
      expect(result.structured?.args).toEqual({
        ruleId: "forms/labels-required",
        file: "app/login.tsx",
        line: 10,
      });
      // Vendor-lane prose; truncation framing must NOT appear when
      // the vendor lane diagnosed the reroute first.
      expect(result.prose).toContain("vendor code");
      expect(result.prose).toContain("same-family fix");
      expect(result.prose).not.toContain("response is truncated");
    });

    it("routes to scope-down when only vendor paths exist on a truncated response", () => {
      // Per backlog test (c): when only vendor + scaffold paths are
      // available, nextStep routes to "scope down via additionalPaths"
      // structured suggestion. The all-vendor lane fires regardless of
      // the truncation flag — every callable finding sits in
      // scannedBuildArtifacts, so naming any specific finding wastes
      // the suggest_fix round-trip.
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ guidance: 2 }),
          },
          files: [
            { path: "vendor/bootstrap.css", findings: [labelsFinding(365)] },
            { path: "vendor/font-awesome.css", findings: [labelsFinding(12)] },
          ],
        }),
        {
          vendorPaths: new Set(["vendor/bootstrap.css", "vendor/font-awesome.css"]),
          truncated: true,
        },
      );
      expect(result.structured).toEqual({
        tool: "scan_project",
        args: {},
      });
      expect(result.prose).toContain("vendor code");
      expect(result.prose).toContain("additionalPaths");
    });

    it("routes to scope-down on truncated:true when no non-vendor finding exists at all", () => {
      // Edge case: the truncation lane diagnoses the all-vendor shape
      // even when the alphabetical first happened to BE non-vendor in
      // a partial-vendor classification — but here we test the lane
      // exit when EVERY finding is vendor (vendorPaths covers every
      // file), to confirm the all-vendor signal flows through both
      // entry lanes (vendor-first and truncation-first).
      const result = buildNextStep(
        formatted({
          plan: {
            fixesByClass: lanes({ runtimeOnly: 2 }),
          },
          files: [
            { path: "_a/vendor.css", findings: [labelsFinding(1)] },
            { path: "_b/vendor.css", findings: [labelsFinding(2)] },
          ],
        }),
        {
          vendorPaths: new Set(["_a/vendor.css", "_b/vendor.css"]),
          truncated: true,
        },
      );
      expect(result.structured).toEqual({
        tool: "scan_project",
        args: {},
      });
      expect(result.prose).toContain("vendor code");
      expect(result.prose).toContain("additionalPaths");
    });
  });
});

describe("per-rule narrowing reroute", () => {
  describe("pickTopRuleByCount", () => {
    it("returns the rule ID with the highest finding count across the page", () => {
      const files = [
        {
          findings: [
            { ruleId: "contrast/minimum" },
            { ruleId: "contrast/minimum" },
            { ruleId: "alt-text/missing" },
          ],
        },
        { findings: [{ ruleId: "contrast/minimum" }] },
      ];
      expect(pickTopRuleByCount(files)).toBe("contrast/minimum");
    });

    it("returns undefined on empty input", () => {
      expect(pickTopRuleByCount([])).toBeUndefined();
      expect(pickTopRuleByCount([{ findings: [] }])).toBeUndefined();
    });

    it("returns undefined when the top two rules tie at the highest count", () => {
      // Honest "we couldn't pick" — naming an alphabetically-stable
      // winner would route the agent to a rule that doesn't dominate.
      const files = [
        {
          findings: [
            { ruleId: "contrast/minimum" },
            { ruleId: "contrast/minimum" },
            { ruleId: "alt-text/missing" },
            { ruleId: "alt-text/missing" },
          ],
        },
      ];
      expect(pickTopRuleByCount(files)).toBeUndefined();
    });

    it("ignores findings missing a string ruleId", () => {
      const files = [
        {
          findings: [
            { ruleId: "contrast/minimum" },
            { ruleId: 42 }, // wrong type
            null,
            "not-an-object",
            { noRuleId: true },
          ],
        },
      ];
      expect(pickTopRuleByCount(files)).toBe("contrast/minimum");
    });
  });

  describe("shouldRerouteToPerRuleNarrowing", () => {
    it("fires when effectiveLimit ≤ 2 and totalFilesWithFindings > 100", () => {
      expect(
        shouldRerouteToPerRuleNarrowing({ effectiveLimit: 1, totalFilesWithFindings: 1793 }),
      ).toBe(true);
      expect(
        shouldRerouteToPerRuleNarrowing({ effectiveLimit: 2, totalFilesWithFindings: 101 }),
      ).toBe(true);
    });

    it("does not fire when effectiveLimit exceeds the page-files threshold", () => {
      // 3 files in the page is no longer the degenerate one-or-two regime.
      expect(
        shouldRerouteToPerRuleNarrowing({ effectiveLimit: 3, totalFilesWithFindings: 1793 }),
      ).toBe(false);
    });

    it("does not fire on a strict-equality 100-file inventory boundary", () => {
      // Strict `>`, not `>=` — at 100 files the standard pagination is
      // still finite. The reroute targets the bulk-template pathology
      // (well above this floor); 100 stays out by design.
      expect(
        shouldRerouteToPerRuleNarrowing({ effectiveLimit: 1, totalFilesWithFindings: 100 }),
      ).toBe(false);
    });

    it("does not fire on small-inventory scans even with a one-file page", () => {
      expect(
        shouldRerouteToPerRuleNarrowing({ effectiveLimit: 1, totalFilesWithFindings: 12 }),
      ).toBe(false);
    });
  });

  describe("perRuleNarrowingNextStep", () => {
    it("routes the structured hint to explain_rule with the dominant ruleId", () => {
      const result = perRuleNarrowingNextStep({
        topRuleId: "contrast/minimum",
        totalFilesWithFindings: 1793,
        effectiveLimit: 1,
      });
      expect(result.structured).toEqual({
        tool: "explain_rule",
        args: { ruleId: "contrast/minimum" },
      });
    });

    it("names the dominant rule and the inventory size in the prose", () => {
      const result = perRuleNarrowingNextStep({
        topRuleId: "contrast/minimum",
        totalFilesWithFindings: 1793,
        effectiveLimit: 1,
      });
      expect(result.prose).toContain("contrast/minimum");
      expect(result.prose).toContain("1793");
      expect(result.prose).toContain("explain_rule");
      // Prose names the per-rule narrowing pattern explicitly so the
      // agent reads the escape from the per-file pagination loop.
      expect(result.prose).toContain("file-by-file");
    });
  });
});

describe("bulk-vendor scope-down reroute", () => {
  describe("shouldRerouteToBulkVendorScopeDown", () => {
    it("fires when groupedCount ≥ 10 and totalFilesWithFindings > 50", () => {
      expect(
        shouldRerouteToBulkVendorScopeDown({ groupedCount: 10, totalFilesWithFindings: 51 }),
      ).toBe(true);
      expect(
        shouldRerouteToBulkVendorScopeDown({ groupedCount: 25, totalFilesWithFindings: 1793 }),
      ).toBe(true);
    });

    it("does not fire below the basename-group floor", () => {
      // Nine vendor groups means a thin vendor footprint — the agent
      // can dismiss inline; the standard `suggest_fix` first call is
      // the right routing.
      expect(
        shouldRerouteToBulkVendorScopeDown({ groupedCount: 9, totalFilesWithFindings: 1793 }),
      ).toBe(false);
    });

    it("does not fire on a strict-equality 50-file inventory boundary", () => {
      // Strict `>`, not `>=` — at 50 files the standard routing is
      // fine even with vendor noise; the bulk-vendor pathology starts
      // above this floor.
      expect(
        shouldRerouteToBulkVendorScopeDown({ groupedCount: 25, totalFilesWithFindings: 50 }),
      ).toBe(false);
    });

    it("does not fire when both thresholds individually clear but the conjunction fails", () => {
      // groupedCount above the floor BUT inventory below — small
      // authored repo that happens to vendor a lot of basenames. The
      // structural reroute would be noise; standard routing wins.
      expect(
        shouldRerouteToBulkVendorScopeDown({ groupedCount: 12, totalFilesWithFindings: 30 }),
      ).toBe(false);
    });

    it("does not fire on a clean scan with no vendor groups", () => {
      expect(
        shouldRerouteToBulkVendorScopeDown({ groupedCount: 0, totalFilesWithFindings: 200 }),
      ).toBe(false);
    });
  });

  describe("bulkVendorScopeDownNextStep", () => {
    it("routes the structured hint to propose_config with empty args", () => {
      const result = bulkVendorScopeDownNextStep({
        topGroupHints: [
          { basename: "bootstrap.css", count: 45, suggestedGlob: "**/bootstrap.css" },
        ],
        groupedTotal: 12,
        totalFilesWithFindings: 800,
      });
      expect(result.structured).toEqual({ tool: "propose_config", args: {} });
    });

    it("names the suggestedGlob entries inline so the agent has paste-ready exclude paths", () => {
      const result = bulkVendorScopeDownNextStep({
        topGroupHints: [
          { basename: "bootstrap.css", count: 45, suggestedGlob: "**/bootstrap.css" },
          { basename: "fontawesome.css", count: 30, suggestedGlob: "**/fontawesome.css" },
        ],
        groupedTotal: 2,
        totalFilesWithFindings: 800,
      });
      expect(result.prose).toContain("**/bootstrap.css");
      expect(result.prose).toContain("**/fontawesome.css");
      expect(result.prose).toContain("bootstrap.css");
      expect(result.prose).toContain("45");
      expect(result.prose).toContain("ra11y.config.ts");
      expect(result.prose).toContain("exclude");
    });

    it("offers additionalPaths narrowing as the alternative scope-down path", () => {
      const result = bulkVendorScopeDownNextStep({
        topGroupHints: [
          { basename: "bootstrap.css", count: 45, suggestedGlob: "**/bootstrap.css" },
        ],
        groupedTotal: 10,
        totalFilesWithFindings: 800,
      });
      expect(result.prose).toContain("additionalPaths");
    });

    it("caps inline glob hints and reports overflow groups via meta pointer", () => {
      // Twelve groups, cap is five — prose should name the top five
      // verbatim and point the agent at meta for the rest so the
      // overflow stays visible without prose bloat.
      const groups = Array.from({ length: 12 }, (_, i) => ({
        basename: `vendor-${i}.css`,
        count: 50 - i,
        suggestedGlob: `**/vendor-${i}.css`,
      }));
      const result = bulkVendorScopeDownNextStep({
        topGroupHints: groups,
        groupedTotal: 12,
        totalFilesWithFindings: 800,
      });
      // Top five named.
      expect(result.prose).toContain("**/vendor-0.css");
      expect(result.prose).toContain("**/vendor-4.css");
      // Sixth onwards omitted from prose.
      expect(result.prose).not.toContain("**/vendor-5.css");
      // Pointer to grouped meta for the residue.
      expect(result.prose).toContain("scannedBuildArtifacts.grouped");
      expect(result.prose).toContain("7 more");
    });

    it("names the inventory + group-count totals so the agent sees the corpus shape", () => {
      const result = bulkVendorScopeDownNextStep({
        topGroupHints: [
          { basename: "bootstrap.css", count: 45, suggestedGlob: "**/bootstrap.css" },
        ],
        groupedTotal: 18,
        totalFilesWithFindings: 1793,
      });
      expect(result.prose).toContain("1793");
      expect(result.prose).toContain("18");
    });
  });
});
