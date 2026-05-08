/**
 * Response-assembly helpers for the `audit_rule_coverage` MCP tool.
 * Lives in its own module so neither this file nor the input-validation
 * helpers in `./tool-audit-rule-coverage-internals.ts` overrun the
 * per-MCP-tool effective-line budget (`scripts/check-limits.ts`).
 *
 * Owns the wire shape (the `{ fired, eligibleByExtension, predicateMissed,
 * hint?, nextStep, nextStepStructured, warnings? }` literal) plus the
 * branch-by-state `nextStep` text — agents reading the response always
 * see a routing recommendation that matches the predicate state, per
 * the AI-first doctrine "One tool call should answer 'what next?'".
 */

import { isAbsolute } from "node:path";
import type { RuleAlias } from "../engine/rule-aliases.ts";
import { posixResolve } from "../utils/path.ts";
import { type McpToolResult, textResult } from "./tools-helpers.ts";

export interface BuildResultArgs {
  readonly ruleId: string;
  readonly filePath: string;
  readonly fired: boolean;
  readonly eligibleByExtension: boolean;
  readonly predicateMissed: boolean;
  readonly hint: string | undefined;
  readonly deprecated: RuleAlias | undefined;
}

/**
 * Assembles the response shape. `nextStep` / `nextStepStructured` ride
 * together per the conditional-spread doctrine: when `predicateMissed`,
 * the agent's natural next action is to read the cited file and verify
 * (the tool's job is to point — the agent's is to investigate); when
 * `fired`, the agent calls `findings_by_rule` to retrieve the emissions
 * the rule produced; otherwise the rule was extension-mismatched on
 * this file and the agent should pick a different file.
 */
export function buildResult(args: BuildResultArgs): McpToolResult {
  const { ruleId, filePath, fired, eligibleByExtension, predicateMissed, hint, deprecated } = args;
  const absFile = isAbsolute(filePath) ? filePath : posixResolve(process.cwd(), filePath);
  const nextStep = buildNextStep({ ruleId, filePath: absFile, fired, predicateMissed });
  const warnings: string[] = [];
  const warningsDetails: Record<string, unknown> = {};
  if (deprecated !== undefined) {
    const code = `deprecated_rule_id:${deprecated.from}:${deprecated.to}`;
    warnings.push(code);
    warningsDetails[code] = { ...deprecated };
  }
  return textResult({
    ruleId,
    file: filePath,
    fired,
    eligibleByExtension,
    predicateMissed,
    ...(hint === undefined ? {} : { hint }),
    ...nextStep,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(Object.keys(warningsDetails).length > 0 ? { warningsDetails } : {}),
  });
}

interface NextStepFields {
  readonly nextStep: string;
  readonly nextStepStructured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
}

function buildNextStep(args: {
  readonly ruleId: string;
  readonly filePath: string;
  readonly fired: boolean;
  readonly predicateMissed: boolean;
}): NextStepFields {
  const { ruleId, filePath, fired, predicateMissed } = args;
  if (predicateMissed) {
    return {
      nextStep: `Rule \`${ruleId}\` was eligible to run on this file but emitted no findings. Read \`${filePath}\` and decide whether the rule should have fired. If the file legitimately has no issue the rule targets, this is a true negative; otherwise the rule's predicate is missing this case and the next step is to capture the source as a real-world fixture under \`tests/fixtures/real-world/\`.`,
      nextStepStructured: { tool: "scan_file", args: { path: filePath, verboseMeta: true } },
    };
  }
  if (fired) {
    return {
      nextStep: `Rule \`${ruleId}\` fired on this file. Call \`findings_by_rule({ ruleId })\` to retrieve every emission, or \`scan_file({ path, verboseMeta: true })\` to see the per-finding detail with the rule's coverage row.`,
      nextStepStructured: { tool: "findings_by_rule", args: { ruleId } },
    };
  }
  return {
    nextStep: `Rule \`${ruleId}\` is not eligible for this file's extension — its \`appliesTo.fileExtensions\` gate excluded the file before any evaluation. Pick a file whose extension matches the rule's gate (call \`explain_rule({ ruleId })\` to see the rule's documented scope), or audit a different rule on this file.`,
    nextStepStructured: { tool: "explain_rule", args: { ruleId } },
  };
}
