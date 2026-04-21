/**
 * The `verdict_candidate` MCP tool. Asks the host's LLM — via MCP
 * `sampling/createMessage` — to verdict a single manual-review
 * candidate against its finder's `reviewPrompt`. The caller supplies
 * the candidate (location + reason + confidence) and optionally the
 * source snippet; the tool builds a grounded prompt, routes it to the
 * host, and returns a structured `{ status, reasoning, confidence,
 * citations?, _meta: { samplingModelHint } }` envelope.
 *
 * On hosts that did not declare the `sampling` capability — or if the
 * host's reply can't be parsed into the expected shape — the tool
 * degrades gracefully rather than throwing: it returns `status:
 * "cannot_verdict"` along with `verdictPromptForAgent`, the full
 * prompt the agent can run inline against its own model. Per the
 * AI-first consumer doctrine, never throw across the MCP boundary for
 * known failure modes.
 *
 * The `unclear` verdict is valid and honest: if the LLM reports
 * genuine uncertainty, we surface it rather than forcing a binary
 * pass/fail. See `docs/kb/architecture/ai-first-consumer.md` and
 * `docs/adr/0005-in-house-mcp-server.md` §Follow-up work.
 */

import { SamplingNotSupportedError, sample } from "./sampling.ts";
import type { McpSession } from "./session.ts";
import {
  errorResult,
  type McpTool,
  type McpToolResult,
  strParam,
  textResult,
} from "./tools-helpers.ts";

/** Structured verdict emitted when the host answered the sampling call. */
interface VerdictBody {
  readonly status: "pass" | "fail" | "unclear";
  readonly reasoning: string;
  readonly confidence: "high" | "medium" | "low";
  readonly citations?: readonly string[];
}

/**
 * Candidate input — a relaxed shape of `ReviewCandidate` that accepts
 * the same core fields but does not require every field the scanner
 * stamps (e.g. `confidence` is optional on the MCP call because the
 * agent may synthesize a candidate from an older scan). Schema-matched
 * against the tool's `inputSchema` in `tools.ts`.
 */
interface CandidateInput {
  readonly criterionId: string;
  readonly location: {
    readonly filePath: string;
    readonly line: number;
    readonly column?: number;
  };
  readonly reason: string;
  readonly snippet?: string;
  readonly confidence?: string;
}

const MAX_VERDICT_TOKENS = 512;

export const verdictCandidateTool: McpTool = {
  def: {
    name: "verdict_candidate",
    description:
      "Ask the host's LLM — via MCP sampling — to verdict a single manual-review candidate pass/fail (or honest `unclear`) with reasoning. Input: the candidate (`criterionId`, `location`, `reason`, optional `snippet`) plus the finder's `reviewPrompt` and optional inline `sourceContent`. Output: `{ status, reasoning, confidence, citations? }` plus `_meta.samplingModelHint` when the host exposes its model id.\n\nOn hosts without sampling capability, the response degrades to `status: \"cannot_verdict\"` + `verdictPromptForAgent` — the full prompt the agent can run inline against its own model. Point-query tool: no file walking, no scanning — caller provides the grounding. Pair with `review_candidates` to enumerate candidates first.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: {
          type: "object",
          description:
            "Review candidate to verdict. Shape matches `ReviewCandidate` from `review_candidates` — pass one row through verbatim.",
          properties: {
            criterionId: {
              type: "string",
              description: "Criterion this candidate maps to (e.g. wcag22:1.2.1).",
            },
            location: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                line: { type: "number" },
                column: { type: "number" },
              },
              required: ["filePath", "line"],
            },
            reason: {
              type: "string",
              description: "Finder's one-line framing of the question (the candidate's `reason`).",
            },
            snippet: {
              type: "string",
              description:
                "Optional candidate-supplied source snippet. When present, used verbatim as the grounding window.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
              description:
                "Finder's static-evidence confidence. Informational only — the sampled LLM assigns its own confidence in the reply.",
            },
          },
          required: ["criterionId", "location", "reason"],
        },
        reviewPrompt: {
          type: "string",
          description:
            "The pass/fail question the finder poses for this criterion. Pass through from `review_candidates`' `prompts[criterionId].text`.",
        },
        sourceContent: {
          type: "string",
          description:
            "Optional full source of `candidate.location.filePath`, passed inline so the tool doesn't re-read it. When omitted and `candidate.snippet` is present, the snippet is used as the only grounding. When both are absent, the prompt notes the missing grounding honestly.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Optional per-call timeout override for the sampling roundtrip. Defaults to the sampling helper's 60s.",
        },
      },
      required: ["candidate", "reviewPrompt"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  handler(params, session) {
    const candidateRaw = params["candidate"];
    const candidate = parseCandidate(candidateRaw);
    if (candidate === null) {
      return errorResult({
        code: "invalid-param",
        message:
          "candidate must be an object with `criterionId`, `location: { filePath, line }`, and `reason`.",
        details: { param: "candidate" },
      });
    }
    const reviewPrompt = strParam(params, "reviewPrompt");
    if (!reviewPrompt) {
      return errorResult({
        code: "missing-required-param",
        message: "reviewPrompt is required.",
        details: { param: "reviewPrompt" },
      });
    }
    const sourceContent = strParam(params, "sourceContent");
    const timeoutMsRaw = params["timeoutMs"];
    const timeoutMs = typeof timeoutMsRaw === "number" ? timeoutMsRaw : undefined;

    const promptText = buildVerdictPrompt(candidate, reviewPrompt, sourceContent);

    return runVerdict(session, promptText, candidate, timeoutMs);
  },
};

/**
 * Drives the sampling call and shapes the response. Kept separate so
 * the schema-validation half of the handler stays small and the
 * sampling-specific control flow (capability degrade, parse degrade)
 * lives in one place.
 */
async function runVerdict(
  session: McpSession,
  promptText: string,
  candidate: CandidateInput,
  timeoutMs: number | undefined,
): Promise<McpToolResult> {
  try {
    const result = await sample(
      session,
      {
        messages: [{ role: "user", content: { type: "text", text: promptText } }],
        maxTokens: MAX_VERDICT_TOKENS,
        systemPrompt: VERDICT_SYSTEM_PROMPT,
      },
      timeoutMs,
    );
    const parsed = parseVerdictReply(result.content.text);
    // `_meta` is MCP's reserved annotation namespace — underscore-
    // prefixed by spec, not a style choice. Bracket-assigned so the
    // naming-convention lint doesn't fire on what is a spec-defined
    // key (same approach as `src/mcp/server.ts`'s prompts-list path).
    const metaAnnotation: Record<string, unknown> = { samplingModelHint: result.model };
    if (parsed === null) {
      // Host answered but the shape couldn't be parsed into the
      // expected JSON envelope. Per CLAUDE.md §1 "Zero-output success
      // is ambiguous failure" and the structured-error doctrine, don't
      // fabricate a verdict — degrade to cannot_verdict with the raw
      // reply so the agent can inspect it and decide.
      const body: Record<string, unknown> = {
        criterionId: candidate.criterionId,
        status: "cannot_verdict",
        reason: "sampling_reply_unparseable",
        verdictPromptForAgent: promptText,
        rawReply: result.content.text,
      };
      body["_meta"] = metaAnnotation;
      return textResult(body);
    }
    const okBody: Record<string, unknown> = {
      criterionId: candidate.criterionId,
      status: parsed.status,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
      ...(parsed.citations && parsed.citations.length > 0 ? { citations: parsed.citations } : {}),
    };
    okBody["_meta"] = metaAnnotation;
    return textResult(okBody);
  } catch (err) {
    if (err instanceof SamplingNotSupportedError) {
      // Host declined sampling. Return the prompt so the agent runs
      // the model call itself — first-class degradation per ADR 0005.
      return textResult({
        criterionId: candidate.criterionId,
        status: "cannot_verdict",
        reason: "sampling_unsupported",
        verdictPromptForAgent: promptText,
      });
    }
    throw err;
  }
}

const VERDICT_SYSTEM_PROMPT =
  'You are an accessibility expert verdicting a single WCAG review candidate. Read the candidate\'s code context and answer the finder\'s pass/fail question. Respond ONLY with a single JSON object on one line matching this shape: {"status":"pass"|"fail"|"unclear","reasoning":"<1-3 sentences>","confidence":"high"|"medium"|"low","citations":["path:line",…]}. If you genuinely cannot decide, answer "unclear" — do NOT force a binary.';

/**
 * Builds the user-turn text that wraps the candidate's grounding +
 * the finder's `reviewPrompt`. Keeps the prompt string deterministic
 * so the agent can reproduce it verbatim when the host declines
 * sampling.
 */
function buildVerdictPrompt(
  candidate: CandidateInput,
  reviewPrompt: string,
  sourceContent: string | undefined,
): string {
  const loc = candidate.location;
  const groundingLabel = sourceContent
    ? `Full source of ${loc.filePath}:`
    : candidate.snippet
      ? `Snippet near ${loc.filePath}:${loc.line}:`
      : `No source grounding provided — answer "unclear" unless the reason alone is decisive for ${loc.filePath}:${loc.line}.`;
  const groundingBody = sourceContent ?? candidate.snippet ?? "";
  const parts = [
    `Criterion: ${candidate.criterionId}`,
    `Location: ${loc.filePath}:${loc.line}${loc.column ? `:${loc.column}` : ""}`,
    `Finder reason: ${candidate.reason}`,
    "",
    "Review question:",
    reviewPrompt,
    "",
    groundingLabel,
    groundingBody,
    "",
    "Return exactly one JSON object on one line — no preamble, no code fences.",
  ];
  return parts.filter((s) => s !== undefined).join("\n");
}

/**
 * Narrow `raw.location` into the shape the handler needs. Split out
 * of {@link parseCandidate} so each validator stays under the
 * cyclomatic-complexity cap.
 */
function parseLocation(
  raw: unknown,
): { readonly filePath: string; readonly line: number; readonly column?: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const loc = raw as Record<string, unknown>;
  const filePath = typeof loc["filePath"] === "string" ? loc["filePath"] : null;
  const line = typeof loc["line"] === "number" ? loc["line"] : null;
  if (filePath === null || line === null) return null;
  const column = typeof loc["column"] === "number" ? loc["column"] : undefined;
  return { filePath, line, ...(column === undefined ? {} : { column }) };
}

/**
 * Coerce `params.candidate` into `CandidateInput`. Returns null when
 * the required fields are absent or wrong type. Intentionally permissive
 * about extra fields — callers may pass the full `ReviewCandidate`
 * shape from `review_candidates` and we should not reject on surplus
 * keys.
 */
function parseCandidate(raw: unknown): CandidateInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const criterionId = typeof r["criterionId"] === "string" ? r["criterionId"] : null;
  const reason = typeof r["reason"] === "string" ? r["reason"] : null;
  const location = parseLocation(r["location"]);
  if (criterionId === null || reason === null || location === null) return null;
  const snippet = typeof r["snippet"] === "string" ? r["snippet"] : undefined;
  const confidence = typeof r["confidence"] === "string" ? r["confidence"] : undefined;
  return {
    criterionId,
    location,
    reason,
    ...(snippet === undefined ? {} : { snippet }),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

/**
 * Extract the JSON envelope the system prompt told the model to
 * produce. Tolerates hosts that wrap the object in a code fence or
 * leading prose; returns null when no parseable object with a valid
 * `status` can be recovered. Per the AI-first consumer doctrine, the
 * caller degrades to `cannot_verdict` rather than inventing a reply.
 */
function parseVerdictReply(text: string): VerdictBody | null {
  const candidate = extractJsonObject(text);
  if (candidate === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const status = p["status"];
  if (status !== "pass" && status !== "fail" && status !== "unclear") return null;
  const reasoning = typeof p["reasoning"] === "string" ? p["reasoning"] : "";
  if (reasoning.length === 0) return null;
  const confidenceRaw = p["confidence"];
  const confidence =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
      ? confidenceRaw
      : "medium";
  const citationsRaw = p["citations"];
  const citations = Array.isArray(citationsRaw)
    ? citationsRaw.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    status,
    reasoning,
    confidence,
    ...(citations && citations.length > 0 ? { citations } : {}),
  };
}

/**
 * Pull the first top-level JSON object out of `text`. Handles three
 * common host shapes: a bare object, a `json` fenced block, and prose
 * with an inline object. Returns the raw JSON substring for
 * `JSON.parse`; null when no `{...}` pair is found.
 */
function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const end = findMatchingBrace(trimmed, 0);
    return end > 0 ? trimmed.slice(0, end + 1) : null;
  }
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith("{")) {
      const end = findMatchingBrace(inner, 0);
      return end > 0 ? inner.slice(0, end + 1) : null;
    }
  }
  const openIdx = trimmed.indexOf("{");
  if (openIdx === -1) return null;
  const end = findMatchingBrace(trimmed, openIdx);
  return end > openIdx ? trimmed.slice(openIdx, end + 1) : null;
}

interface ScanState {
  depth: number;
  inString: boolean;
  escapeNext: boolean;
}

/**
 * Advance the scanner over one character. Keeps {@link findMatchingBrace}
 * under the cyclomatic-complexity cap by isolating the
 * string-literal / escape-sequence bookkeeping here.
 */
function stepBrace(state: ScanState, ch: string | undefined): void {
  if (state.escapeNext) {
    state.escapeNext = false;
    return;
  }
  if (ch === "\\") {
    state.escapeNext = true;
    return;
  }
  if (ch === '"') {
    state.inString = !state.inString;
    return;
  }
  if (state.inString) return;
  if (ch === "{") state.depth++;
  else if (ch === "}") state.depth--;
}

/**
 * Find the index of the `}` that closes the `{` at `start`. Naive —
 * honors string literals but not escaped braces outside strings,
 * which is sufficient for the single-object envelope the system
 * prompt demands.
 */
function findMatchingBrace(text: string, start: number): number {
  const state: ScanState = { depth: 0, inString: false, escapeNext: false };
  for (let i = start; i < text.length; i++) {
    const prev = state.depth;
    stepBrace(state, text[i]);
    if (prev === 1 && state.depth === 0) return i;
  }
  return -1;
}
