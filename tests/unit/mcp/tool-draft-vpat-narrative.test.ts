/**
 * Unit tests for the `draft_vpat_narrative` MCP tool.
 *
 * Covers the invariants the doctrine demands, symmetrically with
 * `tool-verdict-candidate.test.ts`:
 *   - Happy path: a host that answers with a well-formed prose draft
 *     yields `{ narrative, tokenCount, _meta: { samplingModelHint } }`.
 *   - Host without sampling capability → `SamplingNotSupportedError`
 *     caught and degraded to `{ narrative: "", reason:
 *     "sampling_unsupported", promptForAgent }`. Never throws across
 *     the MCP boundary.
 *   - Empty / too-short host reply → degrades to `{ narrative: "",
 *     reason: "sampling_reply_empty_or_too_short", rawReply }` so the
 *     agent can inspect what the model actually returned.
 *   - Schema validation: missing `criterionId`, missing `scanSummary`,
 *     malformed `scanSummary` (missing numerics) all yield structured
 *     errors.
 *   - Grounding guardrail: the built prompt explicitly instructs the
 *     model to cite only findings present in the summary — verified by
 *     inspecting the prompt text forwarded to the sampling helper.
 */

import { describe, expect, it } from "bun:test";
import { McpSession } from "../../../src/mcp/session.ts";
import { draftVpatNarrativeTool } from "../../../src/mcp/tool-draft-vpat-narrative.ts";

function samplingSession(reply: unknown): McpSession {
  const session = new McpSession();
  session.setHostCapabilities({ sampling: {} });
  session.sendRequest = () => Promise.resolve(reply);
  return session;
}

function validSummary(): Record<string, unknown> {
  return {
    totalFindings: 3,
    violations: 2,
    notes: 1,
    actionableManual: 4,
    untargetedCriteria: 0,
    keyViolationExamples: [
      {
        ruleId: "contrast/minimum",
        criterionId: "wcag22:1.4.3",
        filePath: "src/theme/button.css",
        line: 12,
        message: "foreground #aaa on #fff fails 4.5:1 ratio",
      },
    ],
  };
}

async function call(
  session: McpSession,
  params: Record<string, unknown>,
): Promise<{ readonly isError: boolean; readonly body: Record<string, unknown> }> {
  const result = await draftVpatNarrativeTool.handler(params, session);
  const body = JSON.parse(result.content[0]?.text ?? "");
  return { isError: result.isError === true, body };
}

const NARRATIVE_TEXT =
  "Partially Supports. The scan identified two contrast violations in src/theme/button.css at line 12, where the foreground colour does not meet the 4.5:1 ratio required for normal body text. No additional manual-review items were grounded in the current pass, and no findings were raised at the info-level. Remediation is straightforward: adjust the affected tokens to pass the minimum ratio and rerun the scan to confirm.";

describe("draft_vpat_narrative: happy path", () => {
  it("returns a narrative draft when the host answers with prose", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: NARRATIVE_TEXT },
      model: "claude-opus-4-7",
    });

    const { isError, body } = await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });

    expect(isError).toBe(false);
    expect(body["criterionId"]).toBe("wcag22:1.4.3");
    expect(typeof body["narrative"]).toBe("string");
    expect((body["narrative"] as string).length).toBeGreaterThanOrEqual(40);
    // tokenCount is a char-length approximation — match the narrative length.
    expect(body["tokenCount"]).toBe((body["narrative"] as string).length);
    expect((body["_meta"] as { samplingModelHint: string }).samplingModelHint).toBe(
      "claude-opus-4-7",
    );
    // Empty-reply sentinel fields must be absent on the happy path
    // (present-when-meaningful — per CLAUDE.md §1).
    expect(body["reason"]).toBeUndefined();
    expect(body["rawReply"]).toBeUndefined();
    expect(body["promptForAgent"]).toBeUndefined();
  });

  it("trims surrounding whitespace from the host's reply", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: `   \n${NARRATIVE_TEXT}\n   ` },
      model: "m",
    });

    const { body } = await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });
    const narrative = body["narrative"] as string;
    expect(narrative.startsWith(" ")).toBe(false);
    expect(narrative.endsWith(" ")).toBe(false);
    expect(narrative.startsWith("Partially Supports")).toBe(true);
  });

  it("builds a prompt that explicitly forbids hallucinated findings", async () => {
    const session = new McpSession();
    session.setHostCapabilities({ sampling: {} });
    let capturedText = "";
    let capturedSystem = "";
    session.sendRequest = (_method, params) => {
      const p = params as {
        messages: readonly { content: { text: string } }[];
        systemPrompt?: string;
      };
      capturedText = p.messages[0]?.content.text ?? "";
      capturedSystem = p.systemPrompt ?? "";
      return Promise.resolve({
        role: "assistant",
        content: { type: "text", text: NARRATIVE_TEXT },
        model: "m",
      });
    };

    await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });
    // Grounding guardrail — prompt must tell the model not to invent.
    expect(capturedText).toContain("Criterion: wcag22:1.4.3");
    expect(capturedText).toContain("Do NOT fabricate");
    expect(capturedText).toContain("Total findings: 3");
    expect(capturedText).toContain("Violations (error/warning): 2");
    expect(capturedText).toContain("Actionable manual-review items");
    // Example row is formatted into the prompt verbatim.
    expect(capturedText).toContain("rule=contrast/minimum");
    expect(capturedText).toContain("at src/theme/button.css:12");
    // System prompt carries the grounding constraint too.
    expect(capturedSystem).toMatch(/only cite findings present/i);
    expect(capturedSystem).toMatch(/do NOT claim compliance-related information not in scope/i);
  });

  it("omits the key-examples section cleanly when the caller supplies none", async () => {
    const session = new McpSession();
    session.setHostCapabilities({ sampling: {} });
    let capturedText = "";
    session.sendRequest = (_method, params) => {
      const p = params as { messages: readonly { content: { text: string } }[] };
      capturedText = p.messages[0]?.content.text ?? "";
      return Promise.resolve({
        role: "assistant",
        content: { type: "text", text: NARRATIVE_TEXT },
        model: "m",
      });
    };

    const summary = validSummary();
    delete (summary as Record<string, unknown>)["keyViolationExamples"];
    await call(session, { criterionId: "wcag22:1.4.3", scanSummary: summary });
    expect(capturedText).toContain("No representative findings were supplied.");
    expect(capturedText).not.toContain("Key violation examples:");
  });

  it("forwards the caller's `timeoutMs` to the sampling helper", async () => {
    const session = new McpSession();
    session.setHostCapabilities({ sampling: {} });
    let observedTimeout = 0;
    session.sendRequest = (_method, _params, timeoutMs) => {
      observedTimeout = timeoutMs;
      return Promise.resolve({
        role: "assistant",
        content: { type: "text", text: NARRATIVE_TEXT },
        model: "m",
      });
    };

    await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
      timeoutMs: 9_000,
    });
    expect(observedTimeout).toBe(9_000);
  });
});

describe("draft_vpat_narrative: graceful degradation", () => {
  it("returns sampling_unsupported + promptForAgent when the host declined sampling", async () => {
    const session = new McpSession();
    // No host capability declared → sample() throws SamplingNotSupportedError.

    const { isError, body } = await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });

    expect(isError).toBe(false); // doctrine: never throw across MCP boundary
    expect(body["narrative"]).toBe("");
    expect(body["reason"]).toBe("sampling_unsupported");
    expect(typeof body["promptForAgent"]).toBe("string");
    const prompt = body["promptForAgent"] as string;
    expect(prompt).toContain("wcag22:1.4.3");
    expect(prompt).toContain("Do NOT fabricate");
    // _meta is omitted on this path — no model consulted.
    expect(body["_meta"]).toBeUndefined();
    expect(body["tokenCount"]).toBeUndefined();
  });

  it("degrades to sampling_reply_empty_or_too_short when the host returns nothing", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "" },
      model: "test-model",
    });

    const { isError, body } = await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });

    expect(isError).toBe(false);
    expect(body["narrative"]).toBe("");
    expect(body["reason"]).toBe("sampling_reply_empty_or_too_short");
    expect(body["rawReply"]).toBe("");
    expect(typeof body["promptForAgent"]).toBe("string");
    // samplingModelHint preserved so the agent knows which model answered.
    expect((body["_meta"] as { samplingModelHint: string }).samplingModelHint).toBe("test-model");
  });

  it("degrades when the host returns a too-short reply (below MIN_NARRATIVE_CHARS)", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "Supports." },
      model: "test-model",
    });

    const { body } = await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });
    expect(body["narrative"]).toBe("");
    expect(body["reason"]).toBe("sampling_reply_empty_or_too_short");
    expect(body["rawReply"]).toBe("Supports.");
  });

  it("degrades when the host returns whitespace-only prose", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "   \n\t\n   " },
      model: "test-model",
    });

    const { body } = await call(session, {
      criterionId: "wcag22:1.4.3",
      scanSummary: validSummary(),
    });
    expect(body["narrative"]).toBe("");
    expect(body["reason"]).toBe("sampling_reply_empty_or_too_short");
  });
});

describe("draft_vpat_narrative: schema validation", () => {
  it("returns missing-required-param when criterionId is absent", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: NARRATIVE_TEXT },
      model: "m",
    });

    const result = await draftVpatNarrativeTool.handler({ scanSummary: validSummary() }, session);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("missing-required-param");
  });

  it("returns invalid-param when scanSummary is missing", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: NARRATIVE_TEXT },
      model: "m",
    });

    const result = await draftVpatNarrativeTool.handler({ criterionId: "wcag22:1.4.3" }, session);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("invalid-param");
  });

  it("returns invalid-param when scanSummary lacks a required numeric", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: NARRATIVE_TEXT },
      model: "m",
    });

    const summary = validSummary();
    delete (summary as Record<string, unknown>)["totalFindings"];
    const result = await draftVpatNarrativeTool.handler(
      { criterionId: "wcag22:1.4.3", scanSummary: summary },
      session,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("invalid-param");
  });

  it("returns invalid-param when scanSummary is not an object", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: NARRATIVE_TEXT },
      model: "m",
    });

    const result = await draftVpatNarrativeTool.handler(
      { criterionId: "wcag22:1.4.3", scanSummary: "not-an-object" },
      session,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("invalid-param");
  });
});
