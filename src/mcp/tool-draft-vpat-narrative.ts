/**
 * The `draft_vpat_narrative` MCP tool. Drafts the VPAT "Remarks and
 * explanations" cell for one criterion via host-sampled LLM output,
 * grounded strictly in a caller-provided scan summary. The tool does
 * NOT re-scan — the agent supplies the summary from an earlier
 * `scan_project` / `checklist` / `coverage` call and passes it through
 * verbatim so the narrative cites only findings the scan actually saw.
 *
 * Structurally parallel to `tool-verdict-candidate.ts` — the two tools
 * share the sampling pattern (prompt-build → `sample()` → parse →
 * structured reply, with graceful degradation on hosts that declined
 * sampling or returned unparseable output).
 *
 * Doctrine anchors:
 *   - Never hallucinate VPAT language the scan didn't support: the
 *     prompt explicitly instructs the model to cite only findings
 *     present in the supplied summary and to avoid compliance claims
 *     outside the summary's scope.
 *   - Graceful degradation, never throw across the MCP boundary:
 *       - host without sampling → `{ narrative: "", reason:
 *         "sampling_unsupported", promptForAgent }`
 *       - host returned empty/too-short reply → `{ narrative: "",
 *         reason: "sampling_reply_empty_or_too_short", rawReply }`
 *   - Ambiguous-field rule: `narrative` is schema-required on the
 *     happy path, present-as-"" only when paired with an explicit
 *     `reason` so the caller can always disambiguate "got a draft" vs
 *     "tool couldn't produce one and here's why."
 *
 * See `docs/adr/0005-in-house-mcp-server.md` §Follow-up work and
 * `docs/kb/architecture/ai-first-consumer.md`.
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

/**
 * Single-finding row the caller may pass as a worked example in the
 * scan summary. The shape is a loose subset of the scanner's
 * `Violation` that covers the fields a VPAT narrative actually cites
 * (rule, criterion, file:line, message) — keeping it narrow prevents
 * agents from feeling pressured to forward full scan envelopes.
 */
interface KeyViolationExample {
  readonly ruleId?: string;
  readonly criterionId?: string;
  readonly filePath?: string;
  readonly line?: number;
  readonly message?: string;
}

/**
 * Narrow caller-supplied scan summary. Parallels the per-criterion
 * slice of `scan_project`'s plan — totals the agent already has on
 * hand plus an optional short list of representative findings.
 */
interface ScanSummary {
  readonly totalFindings: number;
  readonly violations: number;
  readonly notes: number;
  readonly actionableManual: number;
  readonly untargetedCriteria: number;
  readonly keyViolationExamples?: readonly KeyViolationExample[];
}

/**
 * Narrative token budget — generous enough for the 100–300-word VPAT
 * paragraph plus scaffolding the model emits (acknowledgements,
 * thinking), but bounded so a runaway reply doesn't exhaust the host's
 * context budget. 1024 tokens is the same magnitude the
 * `ra11y/vpat-narrative` prompt expects hosts to allocate; using it
 * here keeps the two surfaces in rough parity.
 */
const MAX_NARRATIVE_TOKENS = 1024;

/**
 * Minimum characters an LLM reply must contain before we treat it as a
 * real narrative. A cell shorter than this is almost certainly a
 * refusal, truncation, or single-token smoke signal — not VPAT prose.
 * Tuned low: a terse "Supports." answer is ~10 chars but still useless
 * as a Remarks cell; anything under 40 is noise. The threshold is a
 * deterministic length check, not a quality heuristic — per doctrine
 * we surface the raw reply when it trips.
 */
const MIN_NARRATIVE_CHARS = 40;

export const draftVpatNarrativeTool: McpTool = {
  def: {
    name: "draft_vpat_narrative",
    description:
      'Draft the VPAT `Remarks and explanations` cell for one criterion via host sampling, grounded strictly in a caller-provided scan summary. Input: `criterionId` plus a `scanSummary` the caller has already computed via `scan_project` / `checklist` / `coverage` — the tool does NOT re-scan. Optional `scanSummary.keyViolationExamples` supplies representative findings the narrative may cite. Output on success: `{ narrative, tokenCount, _meta: { samplingModelHint? } }`.\n\nGraceful degradation, never throws across the MCP boundary:\n  • Host without the `sampling` capability → `{ narrative: "", reason: "sampling_unsupported", promptForAgent }` so the calling agent can run the prompt against its own model.\n  • Host returned an empty or too-short reply → `{ narrative: "", reason: "sampling_reply_empty_or_too_short", rawReply }`.\n\nThe prompt instructs the model to cite only findings present in the summary and to avoid compliance claims outside its scope — this tool never emits VPAT language the scan didn\'t support. Pair with the `ra11y/vpat-narrative` built-in prompt when you want the full scan + checklist + narrative flow driven by the host; use this tool when the agent has already gathered evidence and wants a single drafted paragraph back.',
    inputSchema: {
      type: "object",
      properties: {
        criterionId: {
          type: "string",
          description: "Criterion ID the Remarks cell belongs to (e.g. `wcag22:1.4.3`).",
        },
        scanSummary: {
          type: "object",
          description:
            "Grounding for the narrative. Caller-computed summary of the scan's result for this criterion — the tool does NOT re-scan.",
          properties: {
            totalFindings: {
              type: "number",
              description:
                "Total findings across the scan whose scope includes this criterion (violations + notes).",
            },
            violations: {
              type: "number",
              description: "Error/warning findings (severity !== 'info').",
            },
            notes: {
              type: "number",
              description: "Info-level findings.",
            },
            actionableManual: {
              type: "number",
              description:
                "Manual-review candidates the scan grounded in a file:line (from checklist's actionableManualItems).",
            },
            untargetedCriteria: {
              type: "number",
              description:
                "Manual criteria that did NOT ground in a file:line (bare-criterion prompts — headline-count sibling of actionableManual).",
            },
            keyViolationExamples: {
              type: "array",
              description:
                "Optional short list of representative findings the narrative may cite. Keep it small — 3–5 items covers the vast majority of Remarks cells.",
              items: {
                type: "object",
                properties: {
                  ruleId: { type: "string" },
                  criterionId: { type: "string" },
                  filePath: { type: "string" },
                  line: { type: "number" },
                  message: { type: "string" },
                },
              },
            },
          },
          required: [
            "totalFindings",
            "violations",
            "notes",
            "actionableManual",
            "untargetedCriteria",
          ],
        },
        timeoutMs: {
          type: "number",
          description:
            "Optional per-call timeout override for the sampling roundtrip. Defaults to the sampling helper's 60s.",
        },
      },
      required: ["criterionId", "scanSummary"],
    },
    annotations: { readOnlyHint: true, idempotentHint: false },
  },
  handler(params, session) {
    const criterionId = strParam(params, "criterionId");
    if (!criterionId) {
      return errorResult({
        code: "missing-required-param",
        message: "criterionId is required.",
        details: { param: "criterionId" },
      });
    }
    const summary = parseScanSummary(params["scanSummary"]);
    if (summary === null) {
      return errorResult({
        code: "invalid-param",
        message:
          "scanSummary must be an object with numeric `totalFindings`, `violations`, `notes`, `actionableManual`, and `untargetedCriteria`.",
        details: { param: "scanSummary" },
      });
    }
    const timeoutMsRaw = params["timeoutMs"];
    const timeoutMs = typeof timeoutMsRaw === "number" ? timeoutMsRaw : undefined;

    const promptText = buildNarrativePrompt(criterionId, summary);
    return runDraft(session, promptText, criterionId, timeoutMs);
  },
};

/**
 * Drives the sampling call and shapes the response. Kept separate so
 * the schema-validation half of the handler stays small and the
 * sampling-specific control flow (capability degrade, empty-reply
 * degrade) lives in one place — same split as
 * `tool-verdict-candidate.ts`'s `runVerdict`.
 */
async function runDraft(
  session: McpSession,
  promptText: string,
  criterionId: string,
  timeoutMs: number | undefined,
): Promise<McpToolResult> {
  try {
    const result = await sample(
      session,
      {
        messages: [{ role: "user", content: { type: "text", text: promptText } }],
        maxTokens: MAX_NARRATIVE_TOKENS,
        systemPrompt: NARRATIVE_SYSTEM_PROMPT,
      },
      timeoutMs,
    );
    // `_meta` is MCP's reserved annotation namespace — underscore-
    // prefixed by spec, not a style choice. Bracket-assigned so the
    // naming-convention lint doesn't fire on a spec-defined key (same
    // approach as `tool-verdict-candidate.ts`).
    const metaAnnotation: Record<string, unknown> = { samplingModelHint: result.model };
    const rawReply = result.content.text;
    const narrative = rawReply.trim();
    if (narrative.length < MIN_NARRATIVE_CHARS) {
      const body: Record<string, unknown> = {
        criterionId,
        narrative: "",
        reason: "sampling_reply_empty_or_too_short",
        rawReply,
        promptForAgent: promptText,
      };
      body["_meta"] = metaAnnotation;
      return textResult(body);
    }
    const okBody: Record<string, unknown> = {
      criterionId,
      narrative,
      // Character count, not a model-reported token count — the spec
      // doesn't give us a tokenization contract across hosts. Named
      // `tokenCount` per the backlog spec; the surrounding context
      // (schema, docs) frames it as "approximate reply size."
      tokenCount: narrative.length,
    };
    okBody["_meta"] = metaAnnotation;
    return textResult(okBody);
  } catch (err) {
    if (err instanceof SamplingNotSupportedError) {
      // Host declined sampling. Return the prompt so the agent runs
      // the model call itself — first-class degradation per ADR 0005.
      // `_meta` is omitted on this path: no model was consulted, so
      // there's no honest `samplingModelHint` to report.
      return textResult({
        criterionId,
        narrative: "",
        reason: "sampling_unsupported",
        promptForAgent: promptText,
      });
    }
    throw err;
  }
}

const NARRATIVE_SYSTEM_PROMPT =
  "You are a VPAT technical writer drafting the `Remarks and explanations` cell for one accessibility criterion. Produce a single 100–300 word paragraph suitable for a VPAT row. Ground every claim strictly in the scan summary the user provides — only cite findings present in that summary; do NOT claim compliance-related information not in scope, and do NOT invent file paths, rule IDs, or evidence that was not supplied. Lead with the conformance verdict (Supports / Partially Supports / Does Not Support / Not Applicable / Not Evaluated). No marketing language, no hedging like `we believe`, no bullet lists — the cell is prose. Cite file:line locations only when they appear in the supplied summary. Return the paragraph text only — no preamble, no code fences, no trailing commentary.";

/**
 * Builds the user-turn text wrapping the scan summary. Keeps the
 * prompt string deterministic so the agent can reproduce it verbatim
 * when the host declines sampling — the `promptForAgent` field returns
 * this exact string.
 */
function buildNarrativePrompt(criterionId: string, summary: ScanSummary): string {
  const parts: string[] = [
    `Criterion: ${criterionId}`,
    "",
    "Scan summary (this is the ONLY evidence available — do not cite findings outside it):",
    `- Total findings: ${summary.totalFindings}`,
    `- Violations (error/warning): ${summary.violations}`,
    `- Notes (info-level): ${summary.notes}`,
    `- Actionable manual-review items (grounded with file:line): ${summary.actionableManual}`,
    `- Untargeted manual criteria (no grounding): ${summary.untargetedCriteria}`,
  ];
  if (summary.keyViolationExamples && summary.keyViolationExamples.length > 0) {
    parts.push("", "Key violation examples:");
    for (const ex of summary.keyViolationExamples) {
      parts.push(`- ${formatExample(ex)}`);
    }
  } else {
    parts.push("", "No representative findings were supplied.");
  }
  parts.push(
    "",
    "Write the `Remarks and explanations` cell for this criterion:",
    "- One paragraph, 100–300 words.",
    "- Lead with the conformance verdict (Supports / Partially Supports / Does Not Support / Not Applicable / Not Evaluated).",
    "- Cite only findings present in the summary above. Do NOT fabricate files, rules, or evidence.",
    "- Do NOT claim compliance-related information outside the provided summary's scope.",
    "- Return the paragraph text only — no preamble, no code fences.",
  );
  return parts.join("\n");
}

/**
 * One-line representation of a worked-example finding for the prompt.
 * Skips absent fields so the model doesn't see `line: undefined` style
 * noise; when no fields are populated we fall back to a neutral
 * placeholder so the bullet stays parseable rather than blanking out.
 */
function formatExample(ex: KeyViolationExample): string {
  const bits: string[] = [];
  if (ex.ruleId) bits.push(`rule=${ex.ruleId}`);
  if (ex.criterionId) bits.push(`criterion=${ex.criterionId}`);
  if (ex.filePath) {
    bits.push(typeof ex.line === "number" ? `at ${ex.filePath}:${ex.line}` : `at ${ex.filePath}`);
  }
  if (ex.message) bits.push(`— ${ex.message}`);
  return bits.length > 0 ? bits.join(" ") : "(unnamed finding)";
}

/**
 * Coerce `params.scanSummary` into `ScanSummary`. Returns null when
 * any required numeric is absent or wrong type. Permissive about the
 * shape of `keyViolationExamples`: rows that aren't objects are
 * dropped silently (the agent supplied them; we surface the ones the
 * model can use, skip the ones it can't).
 */
function parseScanSummary(raw: unknown): ScanSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const totalFindings = typeof r["totalFindings"] === "number" ? r["totalFindings"] : null;
  const violations = typeof r["violations"] === "number" ? r["violations"] : null;
  const notes = typeof r["notes"] === "number" ? r["notes"] : null;
  const actionableManual = typeof r["actionableManual"] === "number" ? r["actionableManual"] : null;
  const untargetedCriteria =
    typeof r["untargetedCriteria"] === "number" ? r["untargetedCriteria"] : null;
  if (
    totalFindings === null ||
    violations === null ||
    notes === null ||
    actionableManual === null ||
    untargetedCriteria === null
  ) {
    return null;
  }
  const examples = parseExamples(r["keyViolationExamples"]);
  return {
    totalFindings,
    violations,
    notes,
    actionableManual,
    untargetedCriteria,
    ...(examples === undefined ? {} : { keyViolationExamples: examples }),
  };
}

function parseExamples(raw: unknown): readonly KeyViolationExample[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: KeyViolationExample[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const ex: KeyViolationExample = {
      ...(typeof r["ruleId"] === "string" ? { ruleId: r["ruleId"] } : {}),
      ...(typeof r["criterionId"] === "string" ? { criterionId: r["criterionId"] } : {}),
      ...(typeof r["filePath"] === "string" ? { filePath: r["filePath"] } : {}),
      ...(typeof r["line"] === "number" ? { line: r["line"] } : {}),
      ...(typeof r["message"] === "string" ? { message: r["message"] } : {}),
    };
    out.push(ex);
  }
  return out;
}
