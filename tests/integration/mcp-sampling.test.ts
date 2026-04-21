/**
 * Integration test: MCP sampling end-to-end for `verdict_candidate`.
 *
 * The `verdict_candidate` tool is the first sampling-backed surface
 * ra11y ships: when the host declares the `sampling` capability, the
 * tool issues a server → host `sampling/createMessage` request and
 * shapes the reply into a structured verdict envelope. Per ADR 0005
 * and the AI-first consumer doctrine, the tool must degrade
 * gracefully across three named failure modes — host lacks sampling,
 * sampling reply is unparseable, and sampling roundtrip times out —
 * rather than throwing across the MCP boundary.
 *
 * This test drives the real server in-process through
 * `startMcpHarness` so the bidirectional stdio path (including
 * `createOutbound`'s pending-id table) is exercised end-to-end with
 * coverage credit. The harness lets us intercept the outbound
 * `sampling/createMessage` request and hand-feed the host's reply,
 * which a close-and-read subprocess approach cannot do.
 *
 * Kept as a docs artifact for future sampling-backed tool authors:
 * the `interceptSampling` + `sendSamplingResult` helpers show the
 * minimal shape of a mock host that participates in an LLM turn.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type JsonRpcLike, type McpHarness, startMcpHarness } from "../helpers/mcp-harness.ts";

// JSON-RPC internal error code (mirrors src/mcp/server.ts).
const INTERNAL_ERROR = -32603;

interface ToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

interface VerdictBody {
  readonly criterionId: string;
  readonly status: string;
  readonly reasoning?: string;
  readonly confidence?: string;
  readonly citations?: readonly string[];
  readonly reason?: string;
  readonly verdictPromptForAgent?: string;
  readonly rawReply?: string;
  readonly _meta?: { readonly samplingModelHint?: string };
}

/** Initialize message — caller chooses whether to advertise sampling. */
function initMsg(id: number, withSampling: boolean): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: withSampling ? { sampling: {} } : {},
      clientInfo: { name: "test-host", version: "1.0" },
    },
  };
}

/** Default candidate payload — shared across happy-path + degrade cases. */
function verdictCandidateCall(
  id: number,
  extraArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "verdict_candidate",
      arguments: {
        candidate: {
          criterionId: "wcag22:1.2.1",
          location: { filePath: "src/demo.tsx", line: 42 },
          reason: "<video> element present — verify captions",
          confidence: "medium",
        },
        reviewPrompt: "Does this media element have captions available?",
        ...extraArgs,
      },
    },
  };
}

/**
 * Wait for the server's outbound `sampling/createMessage` request.
 * Returns the full JSON-RPC envelope so the caller can correlate by id.
 */
function interceptSampling(harness: McpHarness): Promise<JsonRpcLike> {
  return harness.waitForPredicate(
    (m) =>
      typeof m.method === "string" &&
      m.method === "sampling/createMessage" &&
      typeof m.id === "number",
  );
}

/** Reply to an intercepted sampling request with an assistant-role result. */
function sendSamplingResult(
  harness: McpHarness,
  id: number | string | null | undefined,
  text: string,
  model = "test-model-1",
): void {
  harness.send({
    jsonrpc: "2.0",
    id: id as number,
    result: {
      role: "assistant",
      content: { type: "text", text },
      model,
      stopReason: "endTurn",
    },
  });
}

function parseToolBody(reply: JsonRpcLike): VerdictBody {
  const result = reply.result as ToolResult;
  const text = result.content[0]?.text ?? "";
  return JSON.parse(text) as VerdictBody;
}

describe("MCP sampling: verdict_candidate happy path", () => {
  let harness: McpHarness;
  beforeEach(() => {
    harness = startMcpHarness();
  });
  afterEach(async () => {
    await harness.end();
  });

  it("returns a parsed verdict when the host answers with a JSON envelope", async () => {
    harness.send(initMsg(1, true));
    harness.send(verdictCandidateCall(2));

    const sampling = await interceptSampling(harness);
    sendSamplingResult(
      harness,
      sampling.id,
      JSON.stringify({
        status: "fail",
        reasoning: "The <video> has no <track> element and no caption reference.",
        confidence: "high",
        citations: ["src/demo.tsx:42"],
      }),
      "claude-opus-4-7",
    );

    const reply = await harness.waitForReply(2);
    const body = parseToolBody(reply);

    expect(body.status).toBe("fail");
    expect(body.confidence).toBe("high");
    expect(body.citations).toEqual(["src/demo.tsx:42"]);
    expect(body._meta?.samplingModelHint).toBe("claude-opus-4-7");
  });

  it("forwards criterionId, reviewPrompt, and candidate context into the sampling prompt", async () => {
    harness.send(initMsg(1, true));
    harness.send(verdictCandidateCall(2));

    const sampling = await interceptSampling(harness);
    const params = sampling.params as {
      messages: Array<{ content: { text: string } }>;
      systemPrompt?: string;
    };
    const userText = params.messages[0]?.content.text ?? "";

    expect(userText).toContain("wcag22:1.2.1");
    expect(userText).toContain("src/demo.tsx:42");
    expect(userText).toContain("Does this media element have captions");
    expect(typeof params.systemPrompt).toBe("string");

    // Resolve the pending sampling turn so the harness shuts down cleanly.
    sendSamplingResult(
      harness,
      sampling.id,
      JSON.stringify({ status: "unclear", reasoning: "noop", confidence: "low" }),
    );
    await harness.waitForReply(2);
  });
});

describe("MCP sampling: verdict_candidate graceful degradation", () => {
  let harness: McpHarness;
  beforeEach(() => {
    harness = startMcpHarness();
  });
  afterEach(async () => {
    await harness.end();
  });

  it("degrades to cannot_verdict + sampling_unsupported when the host omits sampling capability", async () => {
    harness.send(initMsg(1, false));
    harness.send(verdictCandidateCall(2));

    const reply = await harness.waitForReply(2);
    const body = parseToolBody(reply);

    expect(reply.error).toBeUndefined();
    expect(body.status).toBe("cannot_verdict");
    expect(body.reason).toBe("sampling_unsupported");
    expect(typeof body.verdictPromptForAgent).toBe("string");
    expect((body.verdictPromptForAgent ?? "").length).toBeGreaterThan(0);
  });

  it("degrades to cannot_verdict + sampling_reply_unparseable when the host returns non-JSON text", async () => {
    harness.send(initMsg(1, true));
    harness.send(verdictCandidateCall(2));

    const sampling = await interceptSampling(harness);
    sendSamplingResult(
      harness,
      sampling.id,
      "Sorry, I cannot answer this — the snippet is ambiguous.",
    );

    const reply = await harness.waitForReply(2);
    const body = parseToolBody(reply);

    expect(reply.error).toBeUndefined();
    expect(body.status).toBe("cannot_verdict");
    expect(body.reason).toBe("sampling_reply_unparseable");
    expect(body.rawReply).toContain("Sorry");
    expect(typeof body.verdictPromptForAgent).toBe("string");
  });

  it("surfaces a timeout error without hanging when the host never answers the sampling call", async () => {
    harness.send(initMsg(1, true));
    // Small per-call timeout — we never answer the outbound sampling
    // request, so the server's outbound pending-id table must fire the
    // timer and reject, which dispatch turns into a JSON-RPC error.
    harness.send(verdictCandidateCall(2, { timeoutMs: 50 }));

    await interceptSampling(harness);

    const reply = await harness.waitForReply(2);
    const err = reply.error as { readonly code: number; readonly message: string } | undefined;

    expect(err).toBeDefined();
    expect(err?.code).toBe(INTERNAL_ERROR);
    expect(err?.message).toContain("timed out");
  });
});
