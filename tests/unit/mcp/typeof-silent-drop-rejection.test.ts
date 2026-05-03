/**
 * Audit-driven coverage for the silent-drop closure on MCP tool inputs.
 *
 * The `V1-SESSION-CONFIGURE-ALLOWWRITE-SILENT-DROP` fix established a
 * pattern: a `typeof x === "boolean"` (or "number" / "string-array")
 * guard that quietly skips type-mismatched inputs is dishonest per the
 * AI-first consumer doctrine — the agent thinks it configured a setting
 * that never took effect. This test asserts the same closure on the
 * remaining MCP tool boundaries: each handler that previously dropped
 * non-boolean / non-array / non-number inputs now returns a structured
 * `invalid-param` envelope naming the offending field.
 *
 * Spec: docs/kb/architecture/ai-first-consumer.md "Ambiguous field
 * shapes are dishonest" + "Zero-output success is ambiguous failure."
 */

import { describe, expect, it } from "bun:test";
import { McpSession } from "../../../src/mcp/session.ts";
import { MCP_TOOLS } from "../../../src/mcp/tools.ts";

function findTool(name: string) {
  const tool = MCP_TOOLS.find((t) => t.def.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

interface InvalidParamEnvelope {
  readonly code: string;
  readonly details?: { readonly param?: string };
}

async function expectInvalidParam(
  toolName: string,
  paramKey: string,
  badValue: unknown,
  baseParams: Record<string, unknown> = {},
): Promise<void> {
  const tool = findTool(toolName);
  const session = new McpSession();
  const params = { ...baseParams, [paramKey]: badValue };
  const result = await tool.handler(params, session);
  expect(result.isError).toBe(true);
  const structured = result.structuredContent as unknown as InvalidParamEnvelope;
  expect(structured.code).toBe("invalid-param");
  expect(structured.details?.param).toBe(paramKey);
}

describe("MCP typeof-guard silent-drop closure: boolean fields", () => {
  it("scan_project rejects non-boolean autoDetectWrappers", async () => {
    await expectInvalidParam("scan_project", "autoDetectWrappers", "true");
  });

  it("scan_project rejects non-boolean verboseMeta", async () => {
    await expectInvalidParam("scan_project", "verboseMeta", 1);
  });

  it("scan_project rejects non-boolean collapseByGroupKey", async () => {
    await expectInvalidParam("scan_project", "collapseByGroupKey", "yes");
  });

  it("scan_project rejects non-boolean changedOnly", async () => {
    await expectInvalidParam("scan_project", "changedOnly", 1);
  });

  it("scan rejects non-boolean verboseMeta", async () => {
    await expectInvalidParam("scan", "verboseMeta", "true", { paths: ["."] });
  });

  it("scan_file rejects non-boolean verboseMeta", async () => {
    await expectInvalidParam("scan_file", "verboseMeta", 1, { path: "/dev/null" });
  });

  it("scan_diff rejects non-boolean hunksOnly", async () => {
    await expectInvalidParam("scan_diff", "hunksOnly", "true");
  });

  it("scan_diff rejects non-boolean verboseMeta", async () => {
    await expectInvalidParam("scan_diff", "verboseMeta", 1);
  });

  it("coverage rejects non-boolean showUntargeted", async () => {
    await expectInvalidParam("coverage", "showUntargeted", "true");
  });

  it("coverage rejects non-boolean verboseMeta", async () => {
    await expectInvalidParam("coverage", "verboseMeta", 1);
  });

  it("checklist rejects non-boolean showUntargeted", async () => {
    await expectInvalidParam("checklist", "showUntargeted", "true");
  });

  it("conformance_statement rejects non-boolean verboseMeta", async () => {
    await expectInvalidParam("conformance_statement", "verboseMeta", 1);
  });

  it("bootstrap rejects non-boolean writeBaseline", async () => {
    await expectInvalidParam("bootstrap", "writeBaseline", "true");
  });

  it("apply_fix rejects non-boolean dryRun (after allowWrite is set)", async () => {
    const tool = findTool("apply_fix");
    const session = new McpSession();
    session.configure({ allowWrite: true });
    const result = await tool.handler({ dryRun: "false", file: "x", edit: {} }, session);
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as unknown as InvalidParamEnvelope;
    expect(structured.code).toBe("invalid-param");
    expect(structured.details?.param).toBe("dryRun");
  });

  it("suppress rejects non-boolean dryRun (after allowWrite is set)", async () => {
    const tool = findTool("suppress");
    const session = new McpSession();
    session.configure({ allowWrite: true });
    const result = await tool.handler(
      { dryRun: "false", file: "x", ruleId: "r/x", reason: "test", line: 1 },
      session,
    );
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as unknown as InvalidParamEnvelope;
    expect(structured.code).toBe("invalid-param");
    expect(structured.details?.param).toBe("dryRun");
  });
});

describe("MCP typeof-guard silent-drop closure: string-array fields", () => {
  it("scan_project rejects non-array additionalPaths", async () => {
    await expectInvalidParam("scan_project", "additionalPaths", "src");
  });

  it("scan_project rejects non-array restrictToPaths", async () => {
    await expectInvalidParam("scan_project", "restrictToPaths", "src");
  });

  it("scan_project rejects non-array skipCriterion", async () => {
    await expectInvalidParam("scan_project", "skipCriterion", "wcag22:1.4.3");
  });

  it("scan_project rejects mixed-type array entries in additionalPaths", async () => {
    await expectInvalidParam("scan_project", "additionalPaths", ["valid", 42]);
  });

  it("scan_diff rejects non-array additionalPaths", async () => {
    await expectInvalidParam("scan_diff", "additionalPaths", "src");
  });

  it("checklist rejects non-array paths", async () => {
    await expectInvalidParam("checklist", "paths", "src");
  });

  it("checklist rejects non-array skipCriterion", async () => {
    await expectInvalidParam("checklist", "skipCriterion", "wcag22:1.4.3");
  });

  it("coverage rejects non-array paths", async () => {
    await expectInvalidParam("coverage", "paths", "src");
  });

  it("conformance_statement rejects non-array paths", async () => {
    await expectInvalidParam("conformance_statement", "paths", "src");
  });

  it("bootstrap rejects non-array additionalPaths", async () => {
    await expectInvalidParam("bootstrap", "additionalPaths", "dist");
  });

  it("list_suppressions rejects non-array additionalPaths", async () => {
    await expectInvalidParam("list_suppressions", "additionalPaths", "dist");
  });

  it("review_candidates rejects non-array paths", async () => {
    await expectInvalidParam("review_candidates", "paths", "src");
  });

  it("propose_baseline rejects non-array legacyRoutes", async () => {
    await expectInvalidParam("propose_baseline", "legacyRoutes", "packages/legacy/**");
  });
});

describe("MCP typeof-guard silent-drop closure: number fields", () => {
  it("checklist rejects non-numeric limit", async () => {
    await expectInvalidParam("checklist", "limit", "100");
  });

  it("checklist rejects non-numeric maxCandidatesPerCriterion", async () => {
    await expectInvalidParam("checklist", "maxCandidatesPerCriterion", "10");
  });

  it("checklist rejects non-numeric offset", async () => {
    await expectInvalidParam("checklist", "offset", "0");
  });

  it("conformance_statement rejects non-numeric scopeFilesCap", async () => {
    await expectInvalidParam("conformance_statement", "scopeFilesCap", "50");
  });

  it("checklist rejects NaN limit (Number.isFinite gate)", async () => {
    await expectInvalidParam("checklist", "limit", Number.NaN);
  });
});

describe("MCP typeof-guard silent-drop closure: omitting the field is honest", () => {
  it("scan_project: omitting autoDetectWrappers leaves the default in place", async () => {
    const tool = findTool("scan_project");
    const session = new McpSession();
    // No bad-typed param: handler should not error on this axis
    // (it may emit other warnings unrelated to type validation).
    const result = await tool.handler({ cwd: process.cwd() }, session);
    if (result.isError) {
      const structured = result.structuredContent as unknown as InvalidParamEnvelope;
      // Whatever error path triggers, it must NOT be a typeof-driven
      // invalid-param on autoDetectWrappers — that would mean the
      // helper is over-rejecting absent fields.
      if (structured.code === "invalid-param") {
        expect(structured.details?.param).not.toBe("autoDetectWrappers");
      }
    }
  });

  it("checklist: omitting limit leaves the default in place", async () => {
    const tool = findTool("checklist");
    const session = new McpSession();
    const result = await tool.handler({ cwd: process.cwd() }, session);
    if (result.isError) {
      const structured = result.structuredContent as unknown as InvalidParamEnvelope;
      if (structured.code === "invalid-param") {
        expect(structured.details?.param).not.toBe("limit");
      }
    }
  });
});
