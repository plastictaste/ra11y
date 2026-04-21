/**
 * The suggest_fix MCP tool. Lives in its own file so src/mcp/tools.ts
 * stays under the 500-line file budget after the P0-D unique-anchor
 * wiring landed.
 */

import { runScan } from "../engine/scanner.ts";
import { buildSuggestFixPayload } from "./tool-suggest-fix-internals.ts";
import {
  applyRuleSettings,
  buildSourceContext,
  errorResult,
  findRule,
  type McpTool,
  numParam,
  resolveStandards,
  strParam,
  textResult,
} from "./tools-helpers.ts";
import { warningsField } from "./warnings.ts";

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

    // Parse the file to find the specific violation and its suggestion.
    const parsed = await session.parseFile(filePath, strParam(params, "cwd"));
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
    const payload = buildSuggestFixPayload({
      ruleId,
      line,
      match,
      sourceContext,
      source: parsed.source,
      filePath,
      ...(scanWarnings.length > 0 ? { warnings: scanWarnings } : {}),
    });
    return textResult(payload as Record<string, unknown>);
  },
};
