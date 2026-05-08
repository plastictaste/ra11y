/**
 * Unit-tests {@link applyPagingHintToNextStep} in isolation, without
 * spinning up the MCP subprocess. The helper is a pure overlay over
 * an already-assembled response, so we can drive it directly with
 * synthetic shapes — both the gate (when does the overlay fire?) and
 * the contract (what does the overlaid response look like?).
 *
 * The integration test in
 * `tests/integration/scan-project-truncated-paging-hint.test.ts`
 * pins the end-to-end wiring through scan_project; this file pins the
 * helper's individual decision points.
 */

import { describe, expect, it } from "bun:test";
import { applyPagingHintToNextStep } from "../../../src/mcp/scan-project-paging-hint.ts";

describe("applyPagingHintToNextStep", () => {
  it("returns input unchanged when truncated is not true", () => {
    const response = {
      truncated: false,
      nextOffset: 25,
      files: [{ path: "a.html" }],
      nextStep: "Call suggest_fix on a.html.",
      nextStepStructured: { tool: "suggest_fix", args: { file: "a.html" } },
      totalFilesWithFindings: 5,
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    // Identity-preserving on the gate-fail path.
    expect(out).toBe(response);
  });

  it("returns input unchanged when nextOffset is missing", () => {
    const response = {
      truncated: true,
      files: [{ path: "a.html" }],
      nextStep: "Call suggest_fix on a.html.",
      totalFilesWithFindings: 5,
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    expect(out).toBe(response);
  });

  it("returns input unchanged on the density-cap reroute path (pageClipReason: token_density)", () => {
    // When the density cap fires AND the per-rule narrowing reroute
    // engaged, the standard nextStep already points the agent at
    // `explain_rule` on the dominant rule — overriding with a paging
    // recommendation would re-recommend the degenerate ~N round-trip
    // loop the reroute exists to escape. Defer to the reroute.
    const response = {
      truncated: true,
      nextOffset: 1,
      files: [{ path: "a.html" }],
      nextStep:
        "150 files-with-findings; the token-density cap clipped this page to 1 file ... explain_rule on `img/alt` ...",
      nextStepStructured: { tool: "explain_rule", args: { ruleId: "img/alt" } },
      totalFilesWithFindings: 150,
      pageClipReason: "token_density",
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    expect(out).toBe(response);
  });

  it("returns input unchanged when files is empty (slim envelope)", () => {
    // Slim envelope shape: truncated:true + filesArrayDropped:true +
    // files:[] — has its own SLIM_NEXT_STEP_PROSE; the overlay must
    // not fire.
    const response = {
      truncated: true,
      filesArrayDropped: true,
      files: [],
      nextStep: "[slim prose]",
      totalFilesWithFindings: 4936,
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    expect(out).toBe(response);
  });

  it("prepends paging hint to nextStep prose with file counts and offset", () => {
    const response = {
      truncated: true,
      nextOffset: 25,
      files: Array.from({ length: 25 }, (_, i) => ({ path: `f-${i}.html` })),
      nextStep: "Call suggest_fix on f-0.html:1 (rule img/alt).",
      nextStepStructured: {
        tool: "suggest_fix",
        args: { file: "f-0.html", line: 1, ruleId: "img/alt" },
      },
      totalFilesWithFindings: 80,
    };
    const out = applyPagingHintToNextStep({ response, params: { cwd: "/tmp/scan" } });
    const prose = out["nextStep"] as string;
    expect(prose).toContain("Response truncated");
    expect(prose).toContain("80 files-with-findings");
    expect(prose).toContain("25 returned");
    expect(prose).toContain("offset: 25");
    // Original triage prose is preserved as the tail.
    expect(prose).toContain("Call suggest_fix on f-0.html:1");
    // Order: paging hint before triage tail.
    expect(prose.indexOf("Response truncated")).toBeLessThan(prose.indexOf("suggest_fix"));
  });

  it("replaces nextStepStructured with the paging shape (cwd + offset)", () => {
    const response = {
      truncated: true,
      nextOffset: 25,
      files: [{ path: "a.html" }],
      nextStep: "...",
      nextStepStructured: {
        tool: "suggest_fix",
        args: { file: "a.html", line: 1, ruleId: "img/alt" },
      },
      totalFilesWithFindings: 80,
    };
    const out = applyPagingHintToNextStep({ response, params: { cwd: "/tmp/scan" } });
    const structured = out["nextStepStructured"] as { tool: string; args: Record<string, unknown> };
    expect(structured.tool).toBe("scan_project");
    expect(structured.args["offset"]).toBe(25);
    expect(structured.args["cwd"]).toBe("/tmp/scan");
    // The paging shape is minimal — no echoed limit or other params
    // (the agent already passed those on the prior call).
    expect(Object.keys(structured.args)).toEqual(expect.arrayContaining(["offset", "cwd"]));
  });

  it("moves the prior structured call into nextStepStructuredAlternatives", () => {
    const priorStructured = {
      tool: "suggest_fix",
      args: { file: "a.html", line: 1, ruleId: "img/alt" },
    };
    const response = {
      truncated: true,
      nextOffset: 25,
      files: [{ path: "a.html" }],
      nextStep: "...",
      nextStepStructured: priorStructured,
      totalFilesWithFindings: 80,
    };
    const out = applyPagingHintToNextStep({ response, params: { cwd: "/tmp/scan" } });
    const alternatives = out["nextStepStructuredAlternatives"] as Array<{
      tool: string;
      args: Record<string, unknown>;
    }>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives.length).toBe(1);
    expect(alternatives[0].tool).toBe("suggest_fix");
    expect(alternatives[0].args["file"]).toBe("a.html");
    expect(alternatives[0].args["ruleId"]).toBe("img/alt");
  });

  it("omits alternatives when no prior structured call existed", () => {
    // Some scan_project branches degrade to prose-only (the fallback
    // branch with no concrete first finding to name). The paging
    // overlay must still fire on the prose, but the alternatives
    // field stays absent — present-when-meaningful per CLAUDE.md §1.
    const response = {
      truncated: true,
      nextOffset: 25,
      files: [{ path: "a.html" }],
      nextStep: "Use explain_rule, suggest_fix, and scan_file.",
      totalFilesWithFindings: 80,
    };
    const out = applyPagingHintToNextStep({ response, params: { cwd: "/tmp/scan" } });
    expect(out["nextStep"]).toContain("Response truncated");
    expect(out["nextStepStructuredAlternatives"]).toBeUndefined();
  });

  it("omits cwd from paging args when caller did not pass it", () => {
    // The caller's `params` never carried `cwd` — the structured
    // paging shape ships only `offset` rather than fabricating a
    // root the agent didn't pass. Mirrors the slim envelope's same
    // honesty rule for unknown cwd.
    const response = {
      truncated: true,
      nextOffset: 25,
      files: [{ path: "a.html" }],
      nextStep: "...",
      totalFilesWithFindings: 80,
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    const structured = out["nextStepStructured"] as { tool: string; args: Record<string, unknown> };
    expect(structured.tool).toBe("scan_project");
    expect(structured.args["offset"]).toBe(25);
    expect(structured.args).not.toHaveProperty("cwd");
  });

  it("computes 'remaining' as total - returned, with singular plural", () => {
    // When totalFilesWithFindings - filesReturned === 1, the prose
    // uses the singular form "1 remaining file".
    const response = {
      truncated: true,
      nextOffset: 4,
      files: Array.from({ length: 4 }, (_, i) => ({ path: `f-${i}.html` })),
      nextStep: "...",
      totalFilesWithFindings: 5,
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    expect(out["nextStep"]).toContain("1 remaining file");
  });

  it("uses plural form for multi-remaining inventory", () => {
    const response = {
      truncated: true,
      nextOffset: 25,
      files: Array.from({ length: 25 }, (_, i) => ({ path: `f-${i}.html` })),
      nextStep: "...",
      totalFilesWithFindings: 80,
    };
    const out = applyPagingHintToNextStep({ response, params: {} });
    expect(out["nextStep"]).toContain("55 remaining files");
  });
});
