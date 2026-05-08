/**
 * The `audit_rule_coverage` MCP tool — answers "did rule X fire on file Y,
 * and if not, was the file even eligible?" in one call.
 *
 * Before this tool, the only way for an agent to discover a suspected
 * false-negative — a rule that should have fired on a given file but
 * didn't — was to walk `scan_file({ path })`'s `meta.perRuleCoverage[]`
 * and reason about whether the absent emission was "rule never ran"
 * (extension gate didn't match) or "rule ran but found nothing" (the
 * suspected FN). Per the AI-first doctrine "One tool call should answer
 * 'what next?'", an agent investigating a missing emission shouldn't
 * have to cross-walk per-rule rows manually; this tool collapses the
 * inspection into one call returning the deterministic two-axis answer:
 *
 *   - `eligibleByExtension` — did this rule's `appliesTo.fileExtensions`
 *     accept the file's extension? Project-scoped rules with no
 *     extension gate are treated as eligible for any file.
 *   - `fired` — did the rule emit any non-info findings on this file?
 *
 * The composed `predicateMissed` (eligible-but-quiet) is the signal an
 * agent reading the result branches on: when true, the rule could have
 * fired but didn't, and the next step is for the agent to read the
 * cited file and decide. The tool does NOT try to re-encode the rule's
 * emission predicate or guess why the rule was quiet — per the AI-first
 * doctrine "Don't duplicate capability the agent already has," the
 * tool's job is to POINT (here is a rule + file pair worth investigating);
 * the agent's job is to investigate.
 *
 * Optional `hint` carries the rule's `coverageConfidenceReason` /
 * `reason` from per-rule-coverage when available (e.g. `"partial-parse"`,
 * `"file-parse-error"`, `"fragment-input-no-document-envelope"`) plus
 * any `knownLimitations` declared on the rule's docs — additive context,
 * not a verdict. When neither is available, the field is omitted
 * (present-when-meaningful per `.claude/rules/mcp-response-shapes.md`).
 *
 * Per the AI-first doctrine "Zero-output success is ambiguous failure,"
 * a deterministic structured error envelope distinguishes the four
 * input-failure modes (rule-not-found, file-not-found, file-unsupported,
 * cwd-not-found) — never a silent zero-result envelope.
 *
 * Helpers (input validation, error envelopes, eligibility / emission
 * predicates, hint synthesis, response assembly) live in
 * `./tool-audit-rule-coverage-internals.ts` so this file stays under
 * the per-MCP-tool effective-line budget (`scripts/check-limits.ts`).
 */

import { extension as fileExtension } from "../utils/path.ts";
import { pathExists } from "./path-exists.ts";
import { runScanAndCollect } from "./scan-collect.ts";
import {
  buildHint,
  fileNotFoundResult,
  fileReadFailedResult,
  parseTargetFile,
  ruleEligibleForExtension,
  ruleFiredOnFile,
  ruleNotFoundError,
  unsupportedExtensionResult,
  validateInput,
} from "./tool-audit-rule-coverage-internals.ts";
import { buildResult } from "./tool-audit-rule-coverage-result.ts";
import { findRuleWithAlias, type McpTool, resolveStandards } from "./tools-helpers.ts";
import { buildWrapperSourcesFromConfig } from "./wrappers-meta.ts";

const AUDIT_RULE_COVERAGE_DESCRIPTION =
  'Answer "did rule X fire on file Y, and was the file even eligible?" in one call. Use to investigate a suspected false-negative — a rule whose absent emission on a specific file you want to verify. Returns `{ fired, eligibleByExtension, predicateMissed, hint? }`: `eligibleByExtension` checks the rule\'s `appliesTo.fileExtensions` against the file\'s extension (project-scoped rules with no extension gate are eligible for any file); `fired` is whether the rule emitted any non-info findings on this file; `predicateMissed === eligibleByExtension && !fired` is the actionable case (rule could have fired but didn\'t — read the file to investigate). The optional `hint` surfaces the rule\'s `coverageConfidenceReason` / `reason` from per-rule coverage (e.g. `"partial-parse"`, `"fragment-input-no-document-envelope"`) and any declared `knownLimitations` — additive context, not a verdict. The tool deliberately does NOT re-encode the rule\'s emission predicate; it points at the rule + file pair so the agent reads the source to decide.';

const AUDIT_RULE_COVERAGE_RULE_ID_DESCRIPTION =
  "The rule ID to audit — e.g. `media/alt-text-missing`, `keyboard/handler-missing`. Resolves through `src/engine/rule-aliases.ts` so deprecated old IDs are accepted. Call `list_rules` to discover valid IDs.";

const AUDIT_RULE_COVERAGE_FILE_DESCRIPTION =
  "Path to the file the rule should have inspected. Relative paths resolve against `cwd` (defaults to the MCP server's spawn directory). The file must exist on disk and have a parseable extension.";

const AUDIT_RULE_COVERAGE_CWD_DESCRIPTION =
  "Base directory for resolving the relative `file` and for loading any `ra11y.config.ts`. Defaults to the MCP server's spawn directory.";

export const auditRuleCoverageTool: McpTool = {
  def: {
    name: "audit_rule_coverage",
    description: AUDIT_RULE_COVERAGE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: AUDIT_RULE_COVERAGE_RULE_ID_DESCRIPTION },
        file: { type: "string", description: AUDIT_RULE_COVERAGE_FILE_DESCRIPTION },
        cwd: { type: "string", description: AUDIT_RULE_COVERAGE_CWD_DESCRIPTION },
      },
      required: ["ruleId", "file"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const validated = validateInput(params);
    if ("error" in validated) return validated.error;
    const { ruleId: inputRuleId, file: filePath, cwd } = validated;

    const aliasResolution = findRuleWithAlias(inputRuleId, session);
    const rule = aliasResolution.rule;
    if (rule === undefined) return ruleNotFoundError(inputRuleId);

    if (!(await pathExists(filePath, cwd))) return fileNotFoundResult(filePath);

    const ext = fileExtension(filePath);
    const eligibleByExtension = ruleEligibleForExtension(rule, ext);

    const parsed = await parseTargetFile(filePath, cwd, session);
    if (parsed === "unsupported") return unsupportedExtensionResult(filePath);
    if (parsed === "read-failed") return fileReadFailedResult(filePath);

    const projectConfig = await session.loadProjectConfig(cwd ?? process.cwd());
    const collected = await runScanAndCollect({
      files: [parsed],
      session,
      enabled: resolveStandards(undefined, session),
      minSeverity: undefined,
      ruleSettings: session.effectiveRules(projectConfig),
      wrapperSources: buildWrapperSourcesFromConfig(projectConfig, session),
      ...(cwd === undefined ? {} : { cwd }),
    });
    const fired = ruleFiredOnFile(collected.violations, rule.id, parsed.filePath);
    const predicateMissed = eligibleByExtension && !fired;
    const hint = buildHint(rule, collected.perRuleCoverage);

    return buildResult({
      ruleId: rule.id,
      filePath,
      fired,
      eligibleByExtension,
      predicateMissed,
      hint,
      deprecated: aliasResolution.deprecated,
    });
  },
};
