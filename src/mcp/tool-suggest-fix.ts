/**
 * The suggest_fix MCP tool. Lives in its own file so src/mcp/tools.ts
 * stays under the 500-line file budget after the P0-D unique-anchor
 * wiring landed.
 */

import { runScan } from "../engine/scanner.ts";
import { hasTailwindSignal } from "./analysis-coverage-hints.ts";
import { resolveInsideCwd } from "./resolve-inside-cwd.ts";
import { applyCriterionBridge, optionalSuggestFixFields } from "./suggest-fix-criterion-bridge.ts";
import { detectVendorContext } from "./suggest-fix-vendor-context.ts";
import { buildSuggestFixPayload } from "./tool-suggest-fix-internals.ts";
import {
  applyRuleSettings,
  buildSourceContext,
  errorResult,
  findRule,
  type McpTool,
  type McpToolResult,
  numParam,
  resolveStandards,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { warningsField } from "./warnings.ts";

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
      "Get resolution paths for a violation. Returns either `kind: 'edit'` with a direct oldText/newText pair that Edit can apply, or `kind: 'guidance'` with a ranked `primary` fix and `alternatives` — each a short labeled path you can act on. Prefer the primary; fall through alternatives when context rules it out. The `sourceContext` and `snippet` are included so you can compose the edit yourself when no mechanical fix is available.\n\nThe `ruleId` parameter accepts EITHER a rule ID (e.g. `keyboard/handler-missing`) OR a criterion ID (e.g. `wcag22:2.4.5`, `section508:1194.22.c`, `en301549:9.2.4.5`) — pass through whatever the manual-review candidate carries. When a criterion ID is passed and multiple rules satisfy it, the handler resolves to the most-specific rule (smallest `satisfies` list, alphabetic tiebreak) and attaches a `disambiguationNote` naming the chosen rule and the others; singleton resolution leaves the note absent.",
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
    const { result } = runScan({
      standards: session.registry.standards,
      rules: applyRuleSettings(session.registry.rules, session.config.rules),
      enabled: standards,
      files: [parsed],
      level: session.config.level,
    });

    const match = result.violations.find((v) => v.ruleId === ruleId && v.location.line === line);
    const sourceContext =
      strParam(params, "sourceContext") ?? buildSourceContext(parsed.source, line);
    const scanWarnings =
      warningsField({
        filesScanned: result.filesScanned,
        rootSource: null,
        configSource: undefined,
        analysisCoverage: undefined,
        filesByExtension: undefined,
      }).warnings ?? [];
    // probe the parsed-file set
    // for Tailwind utility usage. Reuses the same `hasTailwindSignal`
    // detector that the `tailwind_detected_css_undercounted` warning
    // dispatches on, so suggest_fix's "is this a Tailwind project?"
    // judgment matches scan_project's. With only the violation file
    // in scope (the suggest_fix scan is single-file), a CSS target
    // resolves to `false` — the parsed-file set carries no JSX
    // evidence — and the prose builder strips the rule's Tailwind
    // escape-hatch sentence so vanilla CSS repos don't read
    // context-blind advice.
    const tailwindDetected = hasTailwindSignal([parsed]);
    // detect whether the target file is
    // a build artifact (matches the same predicates that power
    // `meta.scannedBuildArtifacts`) or a vendor-library bundle (matches
    // the curated banner table powering
    // `meta.scannedBuildArtifacts.vendorLibraries`). Both signals are
    // deterministic from the file's (path, source) inputs alone — no
    // heuristic guessing — so the vendor-context payload reads as
    // honest evidence the agent can re-derive. When detected, the
    // payload builder restructures the response so the primary fix
    // lane recommends overriding the failing selector in the
    // consumer's own stylesheet, with the rule's original edit/guidance
    // demoted to an alternative. Pairs with-
    // CSS (closed): Q6 reroutes the `nextStep` target away from
    // vendor; this reroutes the `suggest_fix` primary lane away from
    // vendor edits.
    const vendorContext = detectVendorContext(parsed.filePath, parsed.source);
    const payload = buildSuggestFixPayload({
      ruleId,
      line,
      match,
      sourceContext,
      source: parsed.source,
      filePath,
      tailwindDetected,
      // forward every per-file
      // finding so the builder can attach `nearestFinding` /
      // `didYouMean` breadcrumbs on the `kind: "none"` branch. The
      // suggest_fix scan is single-file, so `result.violations` IS the
      // per-file set — no further filtering needed here.
      sameFileFindings: result.violations,
      ...optionalSuggestFixFields(scanWarnings, vendorContext, disambiguationNote),
    });
    return textResult(payload as Record<string, unknown>);
  },
};
