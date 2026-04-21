/**
 * MCP tool definitions — name, description, inputSchema, handler.
 *
 * `MCP_TOOLS` (exported below) is the canonical inventory consumed by
 * `tools/list`. Tools whose handlers fit in one file live here; larger
 * tools live in their own `tool-*.ts` module and are imported into the
 * `MCP_TOOLS` array.
 *
 * Every handler is a pure function over the scanner's output + session
 * state. No MCP-specific logic leaks into `src/engine/`.
 */

import { buildListRulesNextStep } from "./list-rules-next-step.ts";
import { applyFixTool } from "./tool-apply-fix.ts";
import { attestTool } from "./tool-attest.ts";
import { auditTool } from "./tool-audit.ts";
import { baselineTool } from "./tool-baseline.ts";
import { bootstrapTool } from "./tool-bootstrap.ts";
import { checklistTool } from "./tool-checklist.ts";
import { conformanceStatementTool } from "./tool-conformance-statement.ts";
import { coverageTool } from "./tool-coverage.ts";
import { detectNativeWrappersTool } from "./tool-detect-wrappers.ts";
import { draftVpatNarrativeTool } from "./tool-draft-vpat-narrative.ts";
import { explainStandardTool } from "./tool-explain-standard.ts";
import { listAttestationsTool } from "./tool-list-attestations.ts";
import { listSuppressionsTool } from "./tool-list-suppressions.ts";
import { proposeBaselineTool } from "./tool-propose-baseline.ts";
import { proposeConfigTool } from "./tool-propose-config.ts";
import { reviewCandidatesTool } from "./tool-review-candidates.ts";
import { scanTool } from "./tool-scan.ts";
import { scanDiffTool } from "./tool-scan-diff.ts";
import { scanFileTool } from "./tool-scan-file.ts";
import { scanProcessTool } from "./tool-scan-process.ts";
import { scanProjectTool } from "./tool-scan-project.ts";
import { suggestFixTool } from "./tool-suggest-fix.ts";
import { suppressTool } from "./tool-suppress.ts";
import { verdictCandidateTool } from "./tool-verdict-candidate.ts";
import { vpatTool } from "./tool-vpat.ts";
import { wrapperIntrospectTool } from "./tool-wrapper-introspect.ts";
import {
  buildConfigureOpts,
  errorResult,
  findRule,
  type McpTool,
  strParam,
  textResult,
} from "./tools-helpers.ts";

export type { McpTool, McpToolDef, McpToolResult } from "./tools-helpers.ts";

// ─── Tool: explain_rule ─────────────────────────────────────────────────────

const explainRuleTool: McpTool = {
  def: {
    name: "explain_rule",
    description:
      "Get full details for a rule — description, rationale, normative WCAG quote, good/bad examples, and spec references. Use when a finding needs context.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "Rule ID (e.g. contrast/minimum)." },
      },
      required: ["ruleId"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(params, session) {
    const ruleId = strParam(params, "ruleId");
    if (!ruleId) {
      return errorResult({
        code: "missing-required-param",
        message: "ruleId is required.",
        details: { param: "ruleId" },
      });
    }
    const rule = findRule(ruleId, session);
    if (!rule) {
      return errorResult({
        code: "rule-not-found",
        message: `Rule '${ruleId}' not found. Use list_rules to see available rules.`,
        details: { requested: ruleId },
        remediation: "Call `list_rules` to discover valid rule IDs.",
      });
    }

    return textResult({
      id: rule.id,
      severity: rule.severity,
      satisfies: [...rule.satisfies],
      description: rule.docs.description,
      rationale: rule.docs.rationale,
      ...(rule.docs.normativeQuote ? { normativeQuote: rule.docs.normativeQuote } : {}),
      goodExample: rule.docs.goodExample,
      badExample: rule.docs.badExample,
      references: [...rule.docs.references],
    });
  },
};

// ─── Tool: list_rules ───────────────────────────────────────────────────────

const listRulesTool: McpTool = {
  def: {
    name: "list_rules",
    description:
      "List all available accessibility rules with their ID, severity, and what criteria they satisfy. Call once to understand what ra11y checks.",
    inputSchema: {
      type: "object",
      properties: {
        standard: {
          type: "string",
          description: "Filter to rules that satisfy criteria in this standard.",
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  handler(params, session) {
    const total = session.registry.rules.length;
    let rules = session.registry.rules;

    const standardFilter = strParam(params, "standard");
    if (standardFilter) {
      if (!session.registry.standards.some((s) => s.id === standardFilter)) {
        const known = session.registry.standards.map((s) => s.id).join(", ");
        return errorResult({
          code: "standard-not-found",
          message: `Unknown standard '${standardFilter}'. Loaded: ${known}.`,
          details: {
            requested: standardFilter,
            loaded: session.registry.standards.map((s) => s.id),
          },
          remediation:
            "Pass `standard` with one of the loaded IDs, or omit to list rules from every loaded standard.",
        });
      }
      const prefix = `${standardFilter}:`;
      rules = rules.filter((r) => r.satisfies.some((s) => s.startsWith(prefix)));
    }

    // Envelope parity with the other onboarding tools (propose_config,
    // propose_baseline, list_suppressions, detect_native_wrappers):
    // `meta` carries deterministic scan-confidence telemetry, `nextStep`
    // prose + `nextStepStructured` route the agent to the canonical
    // follow-up call. No metaMode / meta-cache here: list_rules is a
    // pure enumeration of the built-in registry — no scan, no cwd, no
    // config load — so there's no delta to collapse across repeat
    // calls. The counts + standards list are the honest signal the
    // agent uses to cross-check that the filter resolved as expected
    // (CLAUDE.md §1 "Verbose meta is signal, not clutter").
    const meta: Record<string, unknown> = {
      rulesTotal: total,
      rulesMatched: rules.length,
      standardsLoaded: session.registry.standards.length,
      standards: session.registry.standards.map((s) => s.id),
    };
    const nextStep = buildListRulesNextStep(standardFilter, rules.length);
    return textResult({
      // Echo the applied filter only when non-empty (present-when-meaningful);
      // always emit matchedOf so callers can tell a no-op filter (matched === total)
      // apart from a filter that actually narrowed the list.
      ...(standardFilter ? { filter: { standard: standardFilter } } : {}),
      matchedOf: { total, matched: rules.length },
      rules: rules.map((r) => ({
        id: r.id,
        description: r.docs.description,
        severity: r.severity,
        satisfies: [...r.satisfies],
      })),
      meta,
      nextStep: nextStep.prose,
      nextStepStructured: nextStep.structured,
    });
  },
};

// ─── Tool: sessionConfigure ─────────────────────────────────────────────────

const sessionConfigureTool: McpTool = {
  def: {
    name: "sessionConfigure",
    description:
      'Set EPHEMERAL session-scoped defaults — standard, level, excludes, per-rule severity, native-wrapper components — so subsequent tool calls on this MCP connection don\'t repeat these parameters. State lives in the session only; nothing is written to disk, and a fresh connection starts clean.\n\nFor durable, committed configuration, drop a `ra11y.config.ts` at the project root:\n\n  export default {\n    nativeWrappers: ["Button", "ActionButton"],\n    rules: { "media/alt-text-missing": "warning" },\n    exclude: ["packages/legacy/**"],\n  };\n\nThe scan response surfaces `meta.configSource` (path of the loaded file, or null) and `meta.configSearchedFrom` (directory the loader walked up from). If `configSource` is null, make sure you pass `cwd` so the loader walks up from your project root, not the MCP server\'s spawn directory.\n\nPass `cwd` alongside `nativeWrappers` to anchor the wrappers to a specific project root. Session state is connection-wide, so a later `scan_project` / `list_suppressions` call against a different `cwd` will still see the wrappers — but the response will carry a `session_wrappers_configured_for_different_cwd` warning so an agent that switches targets knows the configured wrappers may not match the new codebase.',
    inputSchema: {
      type: "object",
      properties: {
        standard: { type: "string", description: "Default standard ID (e.g. wcag22)." },
        level: { type: "string", enum: ["A", "AA", "AAA"], description: "Default level." },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "Glob patterns to exclude from scanning.",
        },
        rules: {
          type: "object",
          description:
            "Per-rule severity overrides. Values: 'error', 'warning', 'info', or 'off'. Example: {\"keyboard/handler-missing\": \"off\"}.",
          additionalProperties: { type: "string", enum: ["error", "warning", "info", "off"] },
        },
        nativeWrappers: {
          oneOf: [
            {
              type: "array",
              items: { type: "string" },
            },
            {
              type: "object",
              additionalProperties: { type: "string" },
            },
          ],
          description:
            'PascalCase components you\'ve verified wrap a native interactive element (<button>, <a>, etc.). Two accepted shapes:\n\n  • Flat names array — `["Button", "ActionButton", "IconButton"]`. Info-level keyboard/handler-missing notes on these components are suppressed; wrapper-opt-in rules (`media/alt-text-missing`, `navigation/link-descriptive-text`, `forms/labels-required`) do NOT pick them up because the native element target is unknown.\n  • Object map — `{ Button: "button", ActionButton: "button", RouterLink: "a", Avatar: "img" }`. In addition to suppression, wrapper-opt-in rules treat these components as the mapped native element and fire/pass accordingly. Surfaces on the response as `activeNativeWrapperElements`.\n\nAdditive across calls: per-key merge on the object form (later entries refine prior ones for the same wrapper); union on the array form.',
        },
        cwd: {
          type: "string",
          description:
            "Absolute path of the project the wrappers apply to. Recorded as the session's wrapper anchor on the first call that registers wrappers. Later scans against a different resolved root emit `session_wrappers_configured_for_different_cwd` in `warnings` so cross-cwd state is visible to the agent. Defaults to the MCP server's spawn directory when omitted — pass this explicitly alongside `nativeWrappers` to scope honestly.",
        },
        allowWrite: {
          type: "boolean",
          description:
            "Opt-in gate for tools that mutate user source (`apply_fix`). Defaults to false: no ra11y MCP tool will write to disk until the host flips this to true. Flip it back to false to re-gate after a batch of fixes. Read-only tools ignore this flag.",
        },
      },
    },
    annotations: { idempotentHint: true },
  },
  handler(params, session) {
    const config = session.configure(buildConfigureOpts(params));
    const ruleCount = session.registry.rules.filter((r) =>
      r.satisfies.some((s) => s.startsWith(`${config.standard}:`)),
    ).length;
    return textResult({
      active: {
        standard: config.standard,
        level: config.level,
        ruleCount,
        allowWrite: config.allowWrite,
      },
    });
  },
};

// ─── Export ─────────────────────────────────────────────────────────────────

export const MCP_TOOLS: readonly McpTool[] = [
  scanTool,
  scanProjectTool,
  scanFileTool,
  scanDiffTool,
  scanProcessTool,
  detectNativeWrappersTool,
  wrapperIntrospectTool,
  explainRuleTool,
  explainStandardTool,
  suggestFixTool,
  applyFixTool,
  coverageTool,
  checklistTool,
  conformanceStatementTool,
  reviewCandidatesTool,
  verdictCandidateTool,
  draftVpatNarrativeTool,
  auditTool,
  baselineTool,
  bootstrapTool,
  listRulesTool,
  listSuppressionsTool,
  suppressTool,
  attestTool,
  listAttestationsTool,
  vpatTool,
  proposeConfigTool,
  proposeBaselineTool,
  sessionConfigureTool,
];
