/**
 * Unit tests for the `verdict_candidate` `candidateId` shortcut.
 *
 * The shortcut accepts a `findingId` from a prior `checklist` /
 * `review_candidates` / `scan_file` row, sparing the agent the cost of
 * re-stitching six fields per candidate (`criterionId`, `location`,
 * `reason`, `snippet`, `criteria`, `confidence`). At scale —
 * thousands of candidates — that re-stitch cost is what makes per-row
 * sampling impractical without the shortcut.
 *
 * Until the cross-tool persistence layer that resolves `findingId`
 * back to its candidate object lands, the shortcut returns a
 * structured `candidate-id-lookup-unavailable` error pointing at the
 * hand-built form. The shape is reserved now so callers can pin
 * against it before the lookup ships; once the index lands, only the
 * resolution path changes — every test below stays valid for the
 * shape contract (mutual-exclusion, missing-input, unknown-id error,
 * etc.).
 *
 * Doctrine: `docs/kb/architecture/ai-first-consumer.md` "Ambiguous
 * field shapes are dishonest" + the silent-drop closure pattern from
 * `src/mcp/param-validators.ts`.
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

interface StructuredErrorBody {
  readonly code: string;
  readonly message?: string;
  readonly details?: { readonly param?: string; readonly received?: unknown };
  readonly remediation?: string;
}

function structuredError(result: { structuredContent?: unknown }): StructuredErrorBody {
  return result.structuredContent as StructuredErrorBody;
}

describe("verdict_candidate: candidateId shortcut — mutual-exclusion shape", () => {
  it("rejects supplying both `candidate` and `candidateId` with a structured invalid-param", async () => {
    // The two input shapes are exactly-one-of by construction: one
    // says "verdict against this hand-built object," the other says
    // "verdict against the row I already pulled from prior tool
    // output." Letting both win silently would leave the agent
    // unable to tell which one fed the verdict — the silent-miss
    // pattern AI-first doctrine warns against.
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });
    const result = await verdictCandidateTool.handler(
      {
        candidate: validCandidate(),
        candidateId: "abc123",
        reviewPrompt: "prompt",
      },
      session,
    );
    expect(result.isError).toBe(true);
    const err = structuredError(result);
    expect(err.code).toBe("invalid-param");
    expect(err.details?.param).toBe("candidate|candidateId");
    expect(err.details?.received).toBe("both");
    expect(err.remediation).toContain("Remove one");
  });

  it("rejects supplying neither `candidate` nor `candidateId` with missing-required-param", async () => {
    // Symmetric to the both-supplied case — one of the two must be
    // present so the verdict surface knows what to ground against.
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });
    const result = await verdictCandidateTool.handler({ reviewPrompt: "prompt" }, session);
    expect(result.isError).toBe(true);
    const err = structuredError(result);
    expect(err.code).toBe("missing-required-param");
    expect(err.details?.param).toBe("candidate|candidateId");
    expect(err.details?.received).toBe("neither");
    expect(err.remediation).toContain("candidateId");
  });

  it("rejects a non-string `candidateId` with a structured invalid-param", async () => {
    // Same silent-drop closure as `param-validators.ts`'s strict
    // helpers — `candidateId: 123` would otherwise pass the truthy
    // check and fall into the lookup path with garbage input.
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });
    const result = await verdictCandidateTool.handler(
      { candidateId: 12345, reviewPrompt: "prompt" },
      session,
    );
    expect(result.isError).toBe(true);
    const err = structuredError(result);
    expect(err.code).toBe("invalid-param");
    expect(err.details?.param).toBe("candidateId");
  });

  it("rejects an empty-string `candidateId` with a structured invalid-param", async () => {
    // An empty string is the shape mistake the truthy-coerce branch
    // would otherwise let through. Treat as not-provided would be
    // dishonest — the agent passed the field, expecting it to take
    // effect; silently treating it as absent reads as the "supply
    // neither" case but the agent can't tell.
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });
    const result = await verdictCandidateTool.handler(
      { candidateId: "", reviewPrompt: "prompt" },
      session,
    );
    expect(result.isError).toBe(true);
    const err = structuredError(result);
    expect(err.code).toBe("invalid-param");
    expect(err.details?.param).toBe("candidateId");
  });
});

describe("verdict_candidate: candidateId shortcut — unavailable-lookup degrade path", () => {
  it("returns candidate-id-lookup-unavailable when the cross-tool persistence layer is not wired", async () => {
    // Until the server-side `findingId` → candidate lookup lands, the
    // shortcut path returns a structured error pointing at the
    // hand-built form. The shape is reserved now so callers can
    // pin against `verdict_candidate({candidateId, reviewPrompt})`
    // before the lookup ships — the wire format does not shift
    // when the lookup arrives, only the error path turns into a
    // real resolve.
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });
    const result = await verdictCandidateTool.handler(
      {
        candidateId: "f0e1d2c3b4a5",
        reviewPrompt: "Does this media element have captions available?",
      },
      session,
    );
    expect(result.isError).toBe(true);
    const err = structuredError(result);
    expect(err.code).toBe("candidate-id-lookup-unavailable");
    expect(err.details?.param).toBe("candidateId");
    expect(err.details?.received).toBe("f0e1d2c3b4a5");
    // Remediation points the caller at the alternative form (the
    // hand-built `candidate` shape) so the agent can keep moving
    // without waiting on the lookup index. The exact wording is
    // free-form; we pin only the load-bearing tokens.
    expect(err.remediation).toContain("candidate");
    expect(err.remediation).toContain("location");
  });

  it("does not consult the sampling host on the candidate-id-lookup-unavailable path", async () => {
    // The handler must short-circuit before sampling — if the
    // shortcut can't be resolved, there's no candidate to verdict
    // and no prompt to run. Calling the host anyway would burn a
    // sampling round-trip on a degenerate input.
    let sampleCalled = false;
    const session = new McpSession();
    session.setHostCapabilities({ sampling: {} });
    session.sendRequest = () => {
      sampleCalled = true;
      return Promise.resolve({
        role: "assistant",
        content: { type: "text", text: "{}" },
        model: "m",
      });
    };
    await verdictCandidateTool.handler({ candidateId: "abc", reviewPrompt: "prompt" }, session);
    expect(sampleCalled).toBe(false);
  });
});

describe("verdict_candidate: hand-built `candidate` form still works (additive shortcut, not replacement)", () => {
  it("verdict round-trip succeeds with the original hand-built candidate shape", async () => {
    // Backward-compat invariant: the `candidateId` shortcut is
    // additive — every call shape that worked before this commit
    // must continue to work. This test rehearses the canonical
    // happy-path with the full hand-built `candidate`.
    const session = samplingSession({
      role: "assistant",
      content: {
        type: "text",
        text: JSON.stringify({
          status: "fail",
          reasoning: "<video> has no <track>.",
          confidence: "high",
          citations: ["src/demo.tsx:42"],
        }),
      },
      model: "claude-opus-4-7",
    });
    const result = await verdictCandidateTool.handler(
      {
        candidate: validCandidate(),
        reviewPrompt: "Does this media element have captions available?",
      },
      session,
    );
    // `isError` is set to `true` only on failure paths; success leaves
    // the field undefined (per the `errorResult` / `textResult` shape
    // contract in `tools-helpers.ts`).
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0]?.text ?? "");
    expect(body["status"]).toBe("fail");
    expect(body["criterionId"]).toBe("wcag22:1.2.1");
    expect(body["citations"]).toEqual(["src/demo.tsx:42"]);
  });

  it("missing-required-param on `reviewPrompt` precedes the candidate/candidateId resolution", async () => {
    // Schema-validation order matters for error legibility: the
    // agent debugging a malformed call should see the most
    // specific diagnosis first. `reviewPrompt` is unconditionally
    // required; reporting that first (rather than the candidate
    // shape error) gives the agent the sharper signal.
    const session = samplingSession({
      role: "assistant",
      content: { type: "text", text: "{}" },
      model: "m",
    });
    const result = await verdictCandidateTool.handler(
      { candidateId: "abc" }, // both reviewPrompt missing AND candidateId path unwired
      session,
    );
    expect(result.isError).toBe(true);
    const err = structuredError(result);
    expect(err.code).toBe("missing-required-param");
    expect(err.details?.param).toBe("reviewPrompt");
  });
});
