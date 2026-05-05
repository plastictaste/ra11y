/**
 * The suggest_fix MCP tool. Lives in its own file so src/mcp/tools.ts
 * stays under the 500-line file budget after the unique-anchor
 * wiring landed.
 */

import { runScan } from "../engine/scanner.ts";
import { indexFindersByCriterion } from "./review-candidate-prompts.ts";
import { resolveInsideCwd } from "./resolve-inside-cwd.ts";
import { findCandidateMatch } from "./suggest-fix-candidate-match.ts";
import { collectSuggestFixContext } from "./suggest-fix-context.ts";
import { applyCriterionBridge, optionalSuggestFixFields } from "./suggest-fix-criterion-bridge.ts";
import { buildSuggestFixPayload } from "./tool-suggest-fix-internals.ts";
import {
  applyRuleSettings,
  errorResult,
  findRule,
  type McpTool,
  type McpToolResult,
  numParam,
  resolveStandards,
  strParam,
  textResult,
} from "./tools-helpers.ts";

/**
 * preflight. Returns an error envelope
 * when the (explicit) cwd and file escape each other, or null when
 * the call is safe to proceed. Extracted to its own helper so the
 * main handler stays under the cognitive-complexity cap.
 */
async function checkCwdContainment(
  filePath: string,
  suggestFixCwd: string | undefined,
): Promise<McpToolResult | null> {
  if (suggestFixCwd === undefined) return null;
  if ((await resolveInsideCwd(filePath, suggestFixCwd)) !== null) return null;
  return errorResult({
    code: "path-escapes-cwd",
    message: `file '${filePath}' escapes cwd '${suggestFixCwd}'. Every suggested-fix target must resolve inside the declared cwd.`,
    details: { file: filePath, cwd: suggestFixCwd },
  });
}

/**
 * Param-validation preflight. Returns the canonical
 * `missing-required-param` envelope when any of the three required
 * params is absent, or null when all three are present. Extracted to
 * its own helper so the main handler stays under the cognitive-
 * complexity cap (pushed the inline form
 * past the 15-point Biome budget).
 */
function checkRequiredParams(
  ruleId: string | undefined,
  filePath: string | undefined,
  line: number | undefined,
): McpToolResult | null {
  if (ruleId && filePath && line !== undefined) return null;
  return errorResult({
    code: "missing-required-param",
    message: "ruleId, file, and line are required.",
    details: {
      missing: [
        ...(ruleId ? [] : ["ruleId"]),
        ...(filePath ? [] : ["file"]),
        ...(line === undefined ? ["line"] : []),
      ],
    },
  });
}

export const suggestFixTool: McpTool = {
  def: {
    name: "suggest_fix",
    description:
      "Get resolution paths for a violation. Returns one of four kinds: `kind: 'edit'` with a direct oldText/newText pair that Edit can apply; `kind: 'guidance'` with a ranked `primary` fix and `alternatives` — each a short labeled path you can act on; `kind: 'suppress-recommended'` when the rule's evidence model has conceded the criterion may not apply on this substrate and the deterministic dismissal path is the source-level disable pragma (carries `pragma` + `criterionId` siblings ready to paste, NO edit); or `kind: 'none'` when no violation matched the requested line. Prefer the primary; fall through alternatives when context rules it out. The `sourceContext` and `snippet` are included so you can compose the edit yourself when no mechanical fix is available.\n\nThe `ruleId` parameter accepts EITHER a rule ID (e.g. `keyboard/handler-missing`) OR a criterion ID (e.g. `wcag22:2.4.5`, `section508:1194.22.c`, `en301549:9.2.4.5`) — pass through whatever the manual-review candidate carries. When a criterion ID is passed and multiple rules satisfy it, the handler resolves to the most-specific rule (smallest `satisfies` list, alphabetic tiebreak) and attaches a `disambiguationNote` naming the chosen rule and the others; singleton resolution leaves the note absent.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: {
          type: "string",
          description:
            "Rule ID of the violation, OR a criterion ID (`wcag22:2.4.5`, `section508:…`, `en301549:…`) — the latter resolves to the most-specific satisfying rule.",
        },
        file: { type: "string", description: "File path containing the violation." },
        line: { type: "number", description: "Line number of the violation." },
        sourceContext: {
          type: "string",
          description: "Source code around the violation (±3 lines). If omitted, read from file.",
        },
        cwd: {
          type: "string",
          description: "Base directory for resolving the file path if relative.",
        },
      },
      required: ["ruleId", "file", "line"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const inputRuleId = strParam(params, "ruleId");
    const filePath = strParam(params, "file");
    const line = numParam(params, "line");

    if (!(inputRuleId && filePath) || line === undefined) {
      return checkRequiredParams(inputRuleId, filePath, line) as McpToolResult;
    }

    // Criterion-id bridge: when the caller passes a criterion ID
    // (`wcag22:N.N.N`, `section508:…`, `en301549:…`) instead of a rule
    // ID, resolve it to the most-specific rule that satisfies it.
    // Manual-review candidates carry criterion IDs; without this bridge
    // the handoff `review_candidates → suggest_fix` hard-errors with
    // `Rule not found. Call list_rules.` See
    // `docs/kb/architecture/ai-first-consumer.md`: "One tool call
    // should answer 'what next?'" + "Surface, don't suppress."
    const bridge = applyCriterionBridge(inputRuleId, session);
    if ("error" in bridge) return bridge.error;
    const { ruleId, disambiguationNote } = bridge;

    if (!findRule(ruleId, session)) {
      return errorResult({
        code: "rule-not-found",
        message: `Rule '${ruleId}' not found.`,
        details: { requested: ruleId },
        remediation: "Call `list_rules` to discover valid rule IDs.",
      });
    }

    // reject paths that escape the
    // declared `cwd` sandbox before any parse or fs access. See the
    // matching comment in tool-scan-file.ts for the read-only vs
    // write-tool enforcement difference.
    const suggestFixCwd = strParam(params, "cwd");
    const escapeError = await checkCwdContainment(filePath, suggestFixCwd);
    if (escapeError !== null) return escapeError;

    // Parse the file to find the specific violation and its suggestion.
    const parsed = await session.parseFile(filePath, suggestFixCwd);
    if (!parsed) {
      return errorResult({
        code: "file-unsupported",
        message: `Unsupported or unreadable file: ${filePath}`,
        details: { file: filePath },
        remediation: "Pass a .tsx/.jsx/.ts/.js, .html/.htm, or .css file that exists on disk.",
      });
    }

    const standards = resolveStandards(undefined, session);
    const { result, report } = runScan({
      standards: session.registry.standards,
      rules: applyRuleSettings(session.registry.rules, session.config.rules),
      enabled: standards,
      files: [parsed],
      level: session.config.level,
    });

    const match = result.violations.find((v) => v.ruleId === ruleId && v.location.line === line);
    // Review-candidate match resolver — closes the
    // checklist→suggest_fix lane parity gap. When the rule did not
    // fire at the queried line BUT a manual-review candidate at the
    // same coordinate carries a criterion the rule satisfies, the
    // payload builder routes to `kind: "guidance"` derived from the
    // candidate's prose instead of dead-ending at `kind: "none"`. The
    // resolver runs only when the rule lookup missed (mutually
    // exclusive with `match`) and only consults `report.candidates`,
    // which the suggest_fix single-file scan already produced.
    // See `src/mcp/suggest-fix-candidate-match.ts` for the doctrine
    // rationale.
    const rule = findRule(ruleId, session);
    const candidateMatch =
      match !== undefined || rule === undefined
        ? null
        : findCandidateMatch({
            rule,
            filePath,
            line,
            candidates: report.candidates ?? [],
            findersByCriterion: indexFindersByCriterion(session.registry.finders),
          });
    const ctx = await collectSuggestFixContext({
      session,
      parsed,
      result,
      line,
      sourceContextOverride: strParam(params, "sourceContext"),
      cwd: suggestFixCwd,
      filePath,
      matchUndefined: match === undefined,
      ruleId,
    });
    const payload = buildSuggestFixPayload({
      ruleId,
      line,
      match,
      sourceContext: ctx.sourceContext,
      source: parsed.source,
      filePath,
      tailwindDetected: ctx.tailwindDetected,
      // forward every per-file
      // finding so the builder can attach `nearestFinding` /
      // `didYouMean` breadcrumbs on the `kind: "none"` branch. The
      // suggest_fix scan is single-file, so `result.violations` IS the
      // per-file set — no further filtering needed here.
      sameFileFindings: result.violations,
      ...(candidateMatch === null ? {} : { candidateMatch }),
      ...(ctx.inheritedFromWrapper === null
        ? {}
        : { inheritedFromWrapper: ctx.inheritedFromWrapper }),
      ...(ctx.templateDirectiveContext === null
        ? {}
        : { templateDirectiveContext: ctx.templateDirectiveContext }),
      ...(ctx.markdownHeadingCollision === null
        ? {}
        : { markdownHeadingCollision: ctx.markdownHeadingCollision }),
      ...optionalSuggestFixFields(ctx.scanWarnings, ctx.vendorContext, disambiguationNote),
    });
    return textResult(payload as Record<string, unknown>);
  },
};
