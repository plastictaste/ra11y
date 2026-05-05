/**
 * The `findings_by_rule` MCP tool — returns every error/warning finding
 * for a single rule across the project in one call. Replaces the
 * paginated-by-file traversal an agent would otherwise need on
 * `scan_project` to collect "all 169 `aria/expanded-on-disclosure`
 * findings" (≈22 round trips on a 110-finding-bearing-files corpus
 * before this tool existed).
 *
 * Pairs with `scan_project.plan.findingsByRule` (the count map) and
 * `scan_project.plan.topRules` (the rank-ordered top-N head): the
 * planner reads those two fields to pick which rules to drill into,
 * then calls `findings_by_rule({ ruleId, cwd })` per dominant rule.
 *
 * Per-finding shape mirrors `scan_project.files[].findings[]` exactly —
 * same `findingId` hash recipe, same `criteria` / `severity` / `fix` /
 * `evidence` projection — so an agent already familiar with the scan-
 * family per-finding shape doesn't have to re-learn anything. The
 * difference is the response envelope: a single flat `findings[]` keyed
 * by `(file, line)` rather than the per-file bucket structure
 * `scan_project` emits. Each finding carries a top-level `file` field
 * (the relative path) so the agent can route from finding → suggest_fix
 * / read without walking back through a parent.
 *
 * Cross-surface count invariant per
 * `docs/kb/architecture/ai-first-consumer.md`: the `totalFindings`
 * scalar this tool returns equals
 * `scan_project({ cwd }).plan.findingsByRule[ruleId]` for the same
 * (ruleId, cwd). Both surfaces filter info-severity findings the same
 * way (excluded — same predicate as `computeFindingsByRule`); both
 * collect from the FULL scan output (not the paginated `files[]`
 * subset). Pinned by an integration test.
 *
 * Helpers (input validation, scan-root resolution, alias warnings,
 * per-finding collection, response assembly) live in
 * `./tool-findings-by-rule-internals.ts` so this file stays under the
 * per-MCP-tool effective-line budget (`scripts/check-limits.ts`); same
 * split rationale as `tool-get-finding-internals.ts`.
 */

import {
  buildAliasWarnings,
  buildResult,
  collectFindingsForRule,
  resolveScanRoot,
  ruleNotFoundError,
  validateInput,
} from "./tool-findings-by-rule-internals.ts";
import {
  findRuleWithAlias,
  type McpTool,
  parseFilesWithDiagnostics,
  resolveStandards,
  runScanAndFormat,
} from "./tools-helpers.ts";

const FINDINGS_BY_RULE_DESCRIPTION =
  'Return every error/warning finding for a single rule across the project in one call. Use after `scan_project` reveals a high-firing rule (`plan.topRules` / `plan.findingsByRule`) so an agent triaging "all N findings of rule X" reads the full list in one round trip instead of paging through `scan_project.files[]` per rule. Per-finding shape mirrors `scan_project.files[].findings[]` exactly (same `findingId`, `criteria`, `severity`, `fix`, `evidence`); the envelope flattens to a single `findings[]` array keyed by `(file, line)` rather than per-file buckets, with each finding carrying a top-level `file` field. Info-severity findings are excluded — same severity filter as `plan.findingsByRule` so the cross-surface count invariant `totalFindings === scan_project(cwd).plan.findingsByRule[ruleId]` holds.';

const FINDINGS_BY_RULE_RULE_ID_DESCRIPTION =
  "The rule ID to filter findings by — e.g. `aria/expanded-on-disclosure`, `forms/labels-required`. Resolves through `src/engine/rule-aliases.ts` so deprecated old IDs are accepted (a `deprecated_rule_id:<from>:<to>` warning fires when an alias rewrites). Call `list_rules` to discover valid IDs.";

const FINDINGS_BY_RULE_CWD_DESCRIPTION =
  "Project root to scan. Defaults to the host-declared MCP root, then the spawn directory's git root, then `process.cwd()` — same precedence as `scan_project`.";

export const findingsByRuleTool: McpTool = {
  def: {
    name: "findings_by_rule",
    description: FINDINGS_BY_RULE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: FINDINGS_BY_RULE_RULE_ID_DESCRIPTION },
        cwd: { type: "string", description: FINDINGS_BY_RULE_CWD_DESCRIPTION },
      },
      required: ["ruleId"],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler(params, session) {
    const validated = validateInput(params);
    if ("error" in validated) return validated.error;
    const { inputRuleId, explicitCwd } = validated;

    const aliasResolution = findRuleWithAlias(inputRuleId, session);
    const rule = aliasResolution.rule;
    if (rule === undefined) return ruleNotFoundError(inputRuleId);
    const ruleId = rule.id;

    const root = resolveScanRoot(explicitCwd, session);
    const projectConfig = await session.loadProjectConfig(root);
    const { files } = await parseFilesWithDiagnostics(
      [root],
      session,
      root,
      projectConfig.preset === "storybook" ? { includeStoryFiles: true } : {},
    );
    const warnings = buildAliasWarnings(aliasResolution.deprecated);

    if (files.length === 0) {
      // Per the AI-first doctrine "Zero-output success is ambiguous
      // failure" — when no parseable files reach the scanner, an empty
      // `findings: []` reads identically to "rule has zero findings on
      // a real corpus." Surface a structured warning so the caller can
      // distinguish "scan ran on nothing" from "rule is clean."
      warnings.warnings.push("scanned_zero_files");
      return buildResult({
        ruleId,
        findings: [],
        filesScanned: 0,
        root,
        warnings: warnings.warnings,
        warningsDetails: warnings.warningsDetails,
      });
    }

    const standards = resolveStandards(undefined, session);
    const scanRunResult = await runScanAndFormat(
      files,
      session,
      standards,
      undefined, // info-exclude happens per-finding in `collectFindingsForRule`
      session.effectiveRules(projectConfig),
      undefined,
      root,
    );
    // Walk the FULL `formatted.files` list (not a paginated subset) so
    // the response is the entire per-rule distribution in one round
    // trip — that's the round-trip-cost reduction the tool exists for.
    const findings = collectFindingsForRule(scanRunResult.formatted.files, ruleId);
    return buildResult({
      ruleId,
      findings,
      filesScanned: files.length,
      root,
      warnings: warnings.warnings,
      warningsDetails: warnings.warningsDetails,
    });
  },
};
