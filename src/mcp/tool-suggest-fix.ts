/**
 * The suggest_fix MCP tool. Lives in its own file so src/mcp/tools.ts
 * stays under the 500-line file budget after the P0-D unique-anchor
 * wiring landed.
 */

import { runScan } from "../engine/scanner.ts";
import { hasTailwindSignal } from "./analysis-coverage-hints.ts";
import { resolveInsideCwd } from "./resolve-inside-cwd.ts";
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
 * V1-SCAN-FILE-CWD-CONTAINMENT preflight. Returns an error envelope
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

export const suggestFixTool: McpTool = {
  def: {
    name: "suggest_fix",
    description:
      "Get resolution paths for a violation. Returns either `kind: 'edit'` with a direct oldText/newText pair that Edit can apply, or `kind: 'guidance'` with a ranked `primary` fix and `alternatives` — each a short labeled path you can act on. Prefer the primary; fall through alternatives when context rules it out. The `sourceContext` and `snippet` are included so you can compose the edit yourself when no mechanical fix is available.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "Rule ID of the violation." },
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
    const ruleId = strParam(params, "ruleId");
    const filePath = strParam(params, "file");
    const line = numParam(params, "line");

    if (!(ruleId && filePath) || line === undefined) {
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

    if (!findRule(ruleId, session)) {
      return errorResult({
        code: "rule-not-found",
        message: `Rule '${ruleId}' not found.`,
        details: { requested: ruleId },
        remediation: "Call `list_rules` to discover valid rule IDs.",
      });
    }

    // V1-SCAN-FILE-CWD-CONTAINMENT: reject paths that escape the
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
    // V1-SUGGEST-FIX-TAILWIND-HINT-SCOPED: probe the parsed-file set
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
    const payload = buildSuggestFixPayload({
      ruleId,
      line,
      match,
      sourceContext,
      source: parsed.source,
      filePath,
      tailwindDetected,
      // Q7-SUGGEST-FIX-NONE-NEAREST-FINDING: forward every per-file
      // finding so the builder can attach `nearestFinding` /
      // `didYouMean` breadcrumbs on the `kind: "none"` branch. The
      // suggest_fix scan is single-file, so `result.violations` IS the
      // per-file set — no further filtering needed here.
      sameFileFindings: result.violations,
      ...(scanWarnings.length > 0 ? { warnings: scanWarnings } : {}),
    });
    return textResult(payload as Record<string, unknown>);
  },
};
