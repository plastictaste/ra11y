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
 */

import { existsSync } from "node:fs";
import type { AgentFinding } from "../output/agent-response/types.ts";
import { gitRoot } from "../utils/git.ts";
import { scannedProject } from "./scanned-envelope.ts";
import {
  errorResult,
  findRuleWithAlias,
  type McpTool,
  type McpToolResult,
  parseFilesWithDiagnostics,
  resolveStandards,
  runScanAndFormat,
  strParam,
  textResult,
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
    const inputRuleId = strParam(params, "ruleId");
    if (inputRuleId === undefined || inputRuleId.length === 0) {
      return errorResult({
        code: "missing-required-param",
        message: "ruleId is required.",
        details: { missing: ["ruleId"] },
      });
    }
    const explicitCwd = strParam(params, "cwd");
    if (explicitCwd !== undefined && !existsSync(explicitCwd)) {
      return errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${explicitCwd}`,
        details: { cwd: explicitCwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      });
    }

    // Alias-aware rule lookup — old IDs from `src/engine/rule-aliases.ts`
    // resolve to canonical and surface a `deprecated_rule_id:<from>:<to>`
    // warning so the agent can offer to rewrite. Same pattern
    // `suggest_fix` / `suppress` / `explain_rule` use; a non-resolving
    // ID returns a structured `rule-not-found` so the agent gets an
    // actionable error rather than a silent zero-results envelope.
    const aliasResolution = findRuleWithAlias(inputRuleId, session);
    const rule = aliasResolution.rule;
    if (rule === undefined) {
      return errorResult({
        code: "rule-not-found",
        message: `Rule '${inputRuleId}' not found.`,
        details: { requested: inputRuleId },
        remediation: "Call `list_rules` to discover valid rule IDs.",
      });
    }
    const ruleId = rule.id;

    const spawnCwd = process.cwd();
    const hostRoot = explicitCwd === undefined ? session.firstRootPath() : null;
    const root = explicitCwd ?? hostRoot ?? gitRoot(spawnCwd) ?? spawnCwd;
    const projectConfig = await session.loadProjectConfig(root);
    const { files } = await parseFilesWithDiagnostics(
      [root],
      session,
      root,
      projectConfig.preset === "storybook" ? { includeStoryFiles: true } : {},
    );
    // Per the AI-first doctrine "Zero-output success is ambiguous
    // failure" — when no parseable files reach the scanner, an empty
    // `findings: []` reads identically to "rule has zero findings on
    // a real corpus." Surface a structured warning so the caller can
    // distinguish "scan ran on nothing" from "rule is clean."
    const warnings: string[] = [];
    const warningsDetails: Record<string, unknown> = {};
    if (aliasResolution.deprecated !== undefined) {
      const alias = aliasResolution.deprecated;
      const code = `deprecated_rule_id:${alias.from}:${alias.to}`;
      warnings.push(code);
      warningsDetails[code] = {
        from: alias.from,
        to: alias.to,
        deprecatedSince: alias.deprecatedSince,
        removeIn: alias.removeIn,
      };
    }
    if (files.length === 0) {
      warnings.push("scanned_zero_files");
      return buildResult({
        ruleId,
        findings: [],
        filesScanned: 0,
        root,
        warnings,
        warningsDetails,
      });
    }
    const standards = resolveStandards(undefined, session);
    const scanRunResult = await runScanAndFormat(
      files,
      session,
      standards,
      undefined, // no minSeverity filter — let the per-finding severity check downstream handle the info-exclude
      session.effectiveRules(projectConfig),
      undefined,
      root,
    );
    // Walk the FULL `formatted.files` list (not a paginated subset) so
    // the response is the entire per-rule distribution in one round
    // trip — that's the round-trip-cost reduction the tool exists for.
    // Severity filter mirrors `computeFindingsByRule` exactly:
    // info-severity findings are excluded so the totalFindings scalar
    // here agrees with `plan.findingsByRule[ruleId]` on the same cwd
    // (cross-surface count invariant per
    // `docs/kb/architecture/ai-first-consumer.md`).
    const findings: ReadonlyArray<AgentFinding & { readonly file: string }> =
      collectFindingsForRule(scanRunResult.formatted.files, ruleId);

    return buildResult({
      ruleId,
      findings,
      filesScanned: files.length,
      root,
      warnings,
      warningsDetails,
    });
  },
};

/**
 * Walks the scan-formatted per-file findings list and emits a flat
 * sequence of `(file, ...finding)` entries for the requested ruleId.
 * Info-severity findings are excluded — same predicate
 * `computeFindingsByRule` and `computeTopRules` apply, so the
 * cross-surface count invariant pinned by
 * `tests/integration/findings-by-rule-cross-surface.test.ts` holds.
 *
 * The flat shape is what differentiates this tool from `scan_project`:
 * agents triaging a single rule don't need the per-file bucket
 * structure (`{ path, findings: [...] }`); they need an addressable
 * list keyed by `(file, line, column)` so each entry round-trips into
 * `suggest_fix` directly.
 */
function collectFindingsForRule(
  files: readonly { readonly path: string; readonly findings: readonly AgentFinding[] }[],
  ruleId: string,
): readonly (AgentFinding & { readonly file: string })[] {
  const out: (AgentFinding & { readonly file: string })[] = [];
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.ruleId !== ruleId) continue;
      if (finding.severity === "info") continue;
      out.push({ ...finding, file: file.path });
    }
  }
  return out;
}

interface BuildResultArgs {
  readonly ruleId: string;
  readonly findings: readonly (AgentFinding & { readonly file: string })[];
  readonly filesScanned: number;
  readonly root: string;
  readonly warnings: readonly string[];
  readonly warningsDetails: Readonly<Record<string, unknown>>;
}

/**
 * Assembles the wire shape for `findings_by_rule`. Conditional-spread
 * discipline for present-when-meaningful fields per
 * `.claude/rules/mcp-response-shapes.md`:
 *   - `warnings` / `warningsDetails`: omitted when no warning fired
 *     (never `[]` / `{}` sentinels — those would read as "the channel
 *     fired empty," ambiguous against "no signal to ship").
 *   - `nextStep` / `nextStepStructured`: ship as a unit; on a
 *     non-empty findings list route to `suggest_fix` for the first
 *     finding (the agent's natural first action); on an empty list
 *     route to `list_rules` so the agent can verify the rule is
 *     loaded if the empty count surprises them.
 */
function buildResult(args: BuildResultArgs): McpToolResult {
  const { ruleId, findings, filesScanned, root, warnings, warningsDetails } = args;
  const nextStep =
    findings.length === 0
      ? buildEmptyNextStep({ ruleId, root })
      : buildPopulatedNextStep({ ruleId, findings, root });
  const response: Record<string, unknown> = {
    ruleId,
    totalFindings: findings.length,
    findings,
    filesScanned,
    scanned: scannedProject(root),
    ...nextStep,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(Object.keys(warningsDetails).length > 0 ? { warningsDetails } : {}),
  };
  return textResult(response);
}

function buildEmptyNextStep(args: { readonly ruleId: string; readonly root: string }): {
  readonly nextStep: string;
  readonly nextStepStructured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
} {
  return {
    nextStep: `No findings for \`${args.ruleId}\` in this scope. If the empty count is unexpected, call \`list_rules\` to verify the rule is loaded, or \`scan_project({ cwd })\` to confirm the corpus is being parsed (e.g. \`meta.filesByExtension\` shows the relevant file types).`,
    nextStepStructured: { tool: "list_rules", args: { ruleId: args.ruleId } },
  };
}

function buildPopulatedNextStep(args: {
  readonly ruleId: string;
  readonly findings: readonly (AgentFinding & { readonly file: string })[];
  readonly root: string;
}): {
  readonly nextStep: string;
  readonly nextStepStructured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
} {
  // Caller routes through `buildResult`, which only invokes this
  // helper on a non-empty findings list. The explicit guard satisfies
  // the no-non-null-assertion lint rule without changing semantics.
  const first = args.findings[0];
  if (first === undefined) {
    return {
      nextStep: `Found ${args.findings.length} findings for \`${args.ruleId}\`.`,
      nextStepStructured: { tool: "list_rules", args: { ruleId: args.ruleId } },
    };
  }
  return {
    nextStep: `Found ${args.findings.length} finding${args.findings.length === 1 ? "" : "s"} for \`${args.ruleId}\`. Call \`suggest_fix({ ruleId, file, line })\` on each finding to get a primary/alternative fix path, or \`apply_fix({ findingId })\` for findings whose \`fixClass: "mechanical"\` lane carries a materialized edit.`,
    nextStepStructured: {
      tool: "suggest_fix",
      args: { ruleId: args.ruleId, file: first.file, line: first.line, cwd: args.root },
    },
  };
}
