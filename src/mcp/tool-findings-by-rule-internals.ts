/**
 * Internal helpers for the `findings_by_rule` MCP tool. Lives in its
 * own module so `tool-findings-by-rule.ts` stays under the per-MCP-tool
 * effective-line budget (`scripts/check-limits.ts`); same pattern as
 * `tool-get-finding-internals.ts` / `tool-suggest-fix-internals.ts`.
 *
 * The handler in `tool-findings-by-rule.ts` keeps the wire shape
 * (param-validation flow, scan dispatch, response assembly call); this
 * module owns the support concerns: input validation, scan-root
 * resolution, alias-warning construction, the per-finding collection
 * walk, and the final response assembly + nextStep selection.
 */

import { existsSync } from "node:fs";
import type { RuleAlias } from "../engine/rule-aliases.ts";
import type { AgentFinding } from "../output/agent-response/types.ts";
import { gitRoot } from "../utils/git.ts";
import { scannedProject } from "./scanned-envelope.ts";
import type { McpSession } from "./session.ts";
import { errorResult, type McpToolResult, strParam, textResult } from "./tools-helpers.ts";

export interface ValidatedInput {
  readonly inputRuleId: string;
  readonly explicitCwd: string | undefined;
}

/**
 * Up-front input validation — required-param + cwd-existence checks
 * surface as structured errors rather than silently falling through to
 * defaults. Same closure pattern `tool-coverage.ts` /
 * `tool-get-finding.ts` use.
 */
export function validateInput(
  params: Record<string, unknown>,
): ValidatedInput | { readonly error: McpToolResult } {
  const inputRuleId = strParam(params, "ruleId");
  if (inputRuleId === undefined || inputRuleId.length === 0) {
    return {
      error: errorResult({
        code: "missing-required-param",
        message: "ruleId is required.",
        details: { missing: ["ruleId"] },
      }),
    };
  }
  const explicitCwd = strParam(params, "cwd");
  if (explicitCwd !== undefined && !existsSync(explicitCwd)) {
    return {
      error: errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${explicitCwd}`,
        details: { cwd: explicitCwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      }),
    };
  }
  return { inputRuleId, explicitCwd };
}

export function ruleNotFoundError(inputRuleId: string): McpToolResult {
  return errorResult({
    code: "rule-not-found",
    message: `Rule '${inputRuleId}' not found.`,
    details: { requested: inputRuleId },
    remediation: "Call `list_rules` to discover valid rule IDs.",
  });
}

/**
 * Resolves the scan root using the same precedence as `scan_project`:
 * explicit caller `cwd` → host-declared MCP root → spawn-cwd's git root
 * → `process.cwd()`. Threaded through one helper so the precedence
 * stays in lockstep with the sibling tools.
 */
export function resolveScanRoot(explicitCwd: string | undefined, session: McpSession): string {
  const spawnCwd = process.cwd();
  const hostRoot = explicitCwd === undefined ? session.firstRootPath() : null;
  return explicitCwd ?? hostRoot ?? gitRoot(spawnCwd) ?? spawnCwd;
}

export interface AliasWarnings {
  readonly warnings: string[];
  readonly warningsDetails: Record<string, unknown>;
}

/**
 * Builds the alias-driven `warnings[]` / `warningsDetails` pair. When
 * the caller supplied an old ID rewritten via `RULE_ALIASES`, emits the
 * structured `deprecated_rule_id:<from>:<to>` code. Per
 * `docs/kb/architecture/ai-first-consumer.md` "Empty
 * `warningsDetails.<code>: {}` is dishonest" the corresponding details
 * payload carries `from` / `to` / `deprecatedSince` / `removeIn` so the
 * agent has actionable rewrite metadata. The returned arrays are
 * mutable so the handler can append the `scanned_zero_files` code on
 * the empty-corpus branch.
 */
export function buildAliasWarnings(deprecated: RuleAlias | undefined): AliasWarnings {
  const warnings: string[] = [];
  const warningsDetails: Record<string, unknown> = {};
  if (deprecated !== undefined) {
    const code = `deprecated_rule_id:${deprecated.from}:${deprecated.to}`;
    warnings.push(code);
    warningsDetails[code] = {
      from: deprecated.from,
      to: deprecated.to,
      deprecatedSince: deprecated.deprecatedSince,
      removeIn: deprecated.removeIn,
    };
  }
  return { warnings, warningsDetails };
}

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
export function collectFindingsForRule(
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

export interface BuildResultArgs {
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
 *     (never `[]` / `{}` sentinels).
 *   - `nextStep` / `nextStepStructured`: ship as a unit; on a populated
 *     findings list route to `suggest_fix` on the first finding (the
 *     agent's natural next action); on an empty list route to
 *     `scan_project` so the agent can verify the corpus was parsed.
 */
export function buildResult(args: BuildResultArgs): McpToolResult {
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

interface NextStepFields {
  readonly nextStep: string;
  readonly nextStepStructured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
}

function buildEmptyNextStep(args: {
  readonly ruleId: string;
  readonly root: string;
}): NextStepFields {
  return {
    nextStep: `No findings for \`${args.ruleId}\` in this scope. If the empty count is unexpected, call \`scan_project({ cwd })\` to confirm the corpus was parsed — \`meta.filesByExtension\` and \`meta.perRuleCoverage\` show whether the rule had eligible input.`,
    nextStepStructured: { tool: "scan_project", args: { cwd: args.root } },
  };
}

function buildPopulatedNextStep(args: {
  readonly ruleId: string;
  readonly findings: readonly (AgentFinding & { readonly file: string })[];
  readonly root: string;
}): NextStepFields {
  // Caller routes through `buildResult`, which only invokes this
  // helper on a non-empty findings list. The explicit guard satisfies
  // the no-non-null-assertion lint rule.
  const first = args.findings[0];
  if (first === undefined) {
    return buildEmptyNextStep({ ruleId: args.ruleId, root: args.root });
  }
  return {
    nextStep: `Found ${args.findings.length} finding${args.findings.length === 1 ? "" : "s"} for \`${args.ruleId}\`. Call \`suggest_fix({ ruleId, file, line })\` on each finding to get a primary/alternative fix path, or \`apply_fix({ findingId })\` for findings whose \`fixClass: "mechanical"\` lane carries a materialized edit.`,
    nextStepStructured: {
      tool: "suggest_fix",
      args: { ruleId: args.ruleId, file: first.file, line: first.line, cwd: args.root },
    },
  };
}
