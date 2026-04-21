/**
 * Unit tests for the `verdict_candidate` MCP tool.
 *
 * Covers the invariants the doctrine demands:
 *   - Happy path: a host that answers with a well-formed JSON envelope
 *     yields a `{ status, reasoning, confidence, citations?, _meta:{samplingModelHint} }` body.
 *   - Host declines sampling → `SamplingNotSupportedError` is caught and
 *     the tool degrades to `cannot_verdict` + `verdictPromptForAgent`
 *     (never throws across the MCP boundary).
 *   - Malformed sampling reply → degrades to `cannot_verdict` with
 *     `sampling_reply_unparseable` and the raw text preserved so the
 *     agent can inspect it.
 *   - Schema-validation: missing `reviewPrompt` / malformed `candidate`
 *     return structured errors.
 *   - `unclear` is a valid status (AI-first consumer: honest
 *     uncertainty, never forced binary).
 *   - Fenced-JSON replies parse correctly (common host behavior).
 */

import { describe, expect, it } from "bun:test";
import { McpSession } from "../../../src/mcp/session.ts";
import { verdictCandidateTool } from "../../../src/mcp/tool-verdict-candidate.ts";

function samplingSession(reply: unknown): McpSession {
  const session = new McpSession();
  session.setHostCapabilities({ sampling: {} });
  session.sendRequest = () => Promise.resolve(reply);
  return session;
}

function validCandidate(): Record<string, unknown> {
  return {
    criterionId: "wcag22:1.2.1",
    location: { filePath: "src/demo.tsx", line: 42, column: 3 },
    reason: "<video> element present — check for captions",
    confidence: "medium",
  };
}

async function call(
  session: McpSession,
  params: Record<string, unknown>,
): Promise<{ readonly isError: boolean; readonly body: Record<string, unknown> }> {
  const result = await verdictCandidateTool.handler(params, session);
  const body = JSON.parse(result.content[0]?.text ?? "");
  return { isError: result.isError === true, body };
}

describe("verdict_candidate: happy path", () => {
  it("returns a structured verdict when the host answers with a JSON envelope", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: JSON.stringify({
          status: "fail",
          reasoning: "The <video> has no <track> element and no captions reference.",
          confidence: "high",
          citations: ["src/demo.tsx:42"],
        }),
      },
      model: "claude-opus-4-7",
    });

    const { isError, body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "Does this media element have captions available?",
    });

    expect(isError).toBe(false);
    expect(body["status"]).toBe("fail");
    expect(body["confidence"]).toBe("high");
    expect(body["reasoning"]).toContain("captions");
    expect(body["citations"]).toEqual(["src/demo.tsx:42"]);
    expect(body["criterionId"]).toBe("wcag22:1.2.1");
    expect((body["_meta"] as { samplingModelHint: string }).samplingModelHint).toBe(
      "claude-opus-4-7",
    );
  });

  it("accepts `unclear` as an honest-uncertainty verdict", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: JSON.stringify({
          status: "unclear",
          reasoning: "Snippet does not show whether captions are loaded at runtime.",
          confidence: "low",
        }),
      },
      model: "test-model",
    });

    const { isError, body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "Does this media element have captions available?",
    });

    expect(isError).toBe(false);
    expect(body["status"]).toBe("unclear");
    expect(body["confidence"]).toBe("low");
    expect(body["citations"]).toBeUndefined(); // conditional spread — omitted when empty
  });

  it("extracts a JSON envelope wrapped in a ```json fence", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text:
          "Here is my verdict:\n" +
          "```json\n" +
          JSON.stringify({
            status: "pass",
            reasoning: "Captions <track> present inline.",
            confidence: "high",
          }) +
          "\n```",
      },
      model: "test-model",
    });

    const { body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "Does this media element have captions available?",
    });

    expect(body["status"]).toBe("pass");
    expect(body["confidence"]).toBe("high");
  });

  it("forwards the caller's `timeoutMs` to the sampling helper", async () => {
    const session = new McpSession();
    session.setHostCapabilities({ sampling: {} });
    let observedTimeout = 0;
    session.sendRequest = (_method, _params, timeoutMs) => {
      observedTimeout = timeoutMs;
      return Promise.resolve({
        role: "assistant",
        content: {
          type: "text",
          text: JSON.stringify({
            status: "pass",
            reasoning: "x",
            confidence: "high",
          }),
        },
        model: "m",
      });
    };

    await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "prompt",
      timeoutMs: 7_500,
    });
    expect(observedTimeout).toBe(7_500);
  });

  it("includes the caller-supplied `sourceContent` in the sampling prompt", async () => {
    const session = new McpSession();
    session.setHostCapabilities({ sampling: {} });
    let capturedText = "";
    session.sendRequest = (_method, params) => {
      const p = params as {
        messages: readonly { content: { text: string } }[];
      };
      capturedText = p.messages[0]?.content.text ?? "";
      return Promise.resolve({
        role: "assistant",
        content: {
          type: "text",
          text: JSON.stringify({
            status: "pass",
            reasoning: "ok",
            confidence: "high",
          }),
        },
        model: "m",
      });
    };

    await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "Does this media element have captions available?",
      sourceContent: "<video><track kind='captions' src='c.vtt'/></video>",
    });
    expect(capturedText).toContain("Full source of src/demo.tsx");
    expect(capturedText).toContain("<track kind='captions'");
    // Finder's reviewPrompt is always embedded.
    expect(capturedText).toContain("Does this media element have captions available?");
  });
});

describe("verdict_candidate: graceful degradation", () => {
  it("returns cannot_verdict + verdictPromptForAgent when the host declined sampling", async () => {
    const session = new McpSession();
    // No host capability declared — sample() will throw SamplingNotSupportedError.

    const { isError, body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "Does this media element have captions available?",
    });

    expect(isError).toBe(false); // doctrine: never throw across MCP boundary for this known case
    expect(body["status"]).toBe("cannot_verdict");
    expect(body["reason"]).toBe("sampling_unsupported");
    expect(typeof body["verdictPromptForAgent"]).toBe("string");
    const prompt = body["verdictPromptForAgent"] as string;
    expect(prompt).toContain("wcag22:1.2.1");
    expect(prompt).toContain("Does this media element have captions available?");
    // _meta is omitted on the unsupported path — no model was consulted.
    expect(body["_meta"]).toBeUndefined();
  });

  it("degrades to cannot_verdict + sampling_reply_unparseable when the host returns non-JSON", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: "This is just prose, not JSON at all.",
      },
      model: "test-model",
    });

    const { isError, body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "Does this media element have captions available?",
    });

    expect(isError).toBe(false);
    expect(body["status"]).toBe("cannot_verdict");
    expect(body["reason"]).toBe("sampling_reply_unparseable");
    expect(typeof body["verdictPromptForAgent"]).toBe("string");
    expect(body["rawReply"]).toBe("This is just prose, not JSON at all.");
    // samplingModelHint is preserved so the agent knows what answered.
    expect((body["_meta"] as { samplingModelHint: string }).samplingModelHint).toBe("test-model");
  });

  it("degrades when the JSON envelope lacks a valid `status`", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: JSON.stringify({
          status: "maybe", // not in pass/fail/unclear
          reasoning: "x",
          confidence: "high",
        }),
      },
      model: "test-model",
    });

    const { body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "prompt",
    });
    expect(body["status"]).toBe("cannot_verdict");
    expect(body["reason"]).toBe("sampling_reply_unparseable");
  });

  it("degrades when the JSON envelope lacks `reasoning`", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: JSON.stringify({ status: "pass", confidence: "high" }),
      },
      model: "test-model",
    });

    const { body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "prompt",
    });
    expect(body["status"]).toBe("cannot_verdict");
  });

  it("defaults missing `confidence` to medium when status + reasoning are valid", async () => {
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: JSON.stringify({ status: "fail", reasoning: "x" }),
      },
      model: "test-model",
    });

    const { body } = await call(session, {
      candidate: validCandidate(),
      reviewPrompt: "prompt",
    });
    expect(body["status"]).toBe("fail");
    expect(body["confidence"]).toBe("medium");
  });
});

describe("verdict_candidate: schema validation", () => {
  it("returns missing-required-param when reviewPrompt is absent", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });

    const result = await verdictCandidateTool.handler({ candidate: validCandidate() }, session);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("missing-required-param");
  });

  it("returns invalid-param when candidate is missing `location`", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });

    const result = await verdictCandidateTool.handler(
      {
        candidate: { criterionId: "wcag22:1.2.1", reason: "r" },
        reviewPrompt: "prompt",
      },
      session,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("invalid-param");
  });

  it("returns invalid-param when candidate is not an object", async () => {
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });

    const result = await verdictCandidateTool.handler(
      { candidate: "not-an-object", reviewPrompt: "prompt" },
      session,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["code"]).toBe("invalid-param");
  });
});
