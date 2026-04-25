/**
 * `ra11y --explain <rule-id>` — prints detailed metadata for a rule:
 * normative quote, rationale, good/bad examples, references.
 */

import { createBuiltinRegistry, type Registry } from "../../engine/registry/registry.ts";
import { formatDeprecatedRuleIdWarning, resolveRuleId } from "../../engine/rule-aliases.ts";
import { ExitCode } from "../exit-codes.ts";
import type { ScanExit } from "./scan.ts";

export function runExplain(ruleId: string, registry: Registry = createBuiltinRegistry()): ScanExit {
  // V1-INFRA-RULE-ID-ALIAS-TABLE: accept the old ID of a renamed rule
  // and look up the canonical form in the registry. The `deprecated`
  // record stays visible in stderr so humans reading the CLI output
  // see the same `deprecated_rule_id:<old>:<new>` signal MCP agents
  // get on the `warnings[]` channel — no quiet aliasing.
  const resolution = resolveRuleId(ruleId);
  const rule = registry.findRule(resolution.resolved);
  if (!rule) {
    return {
      stdout: "",
      stderr: `ra11y: rule '${ruleId}' not found. Use --list-rules to see loaded rules.\n`,
      exitCode: ExitCode.USER_ERROR,
    };
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${rule.id}  [${rule.severity}]`);
  lines.push("");
  const stderr =
    resolution.deprecated === undefined
      ? ""
      : `ra11y: ${formatDeprecatedRuleIdWarning(resolution.deprecated)} (deprecated since ${resolution.deprecated.deprecatedSince}, removed in ${resolution.deprecated.removeIn})\n`;
  lines.push(`  Satisfies: ${rule.satisfies.join(", ")}`);
  lines.push("");
  lines.push(`  Description`);
  lines.push(`    ${rule.docs.description}`);
  lines.push("");
  if (rule.docs.rationale) {
    lines.push(`  Rationale`);
    lines.push(`    ${rule.docs.rationale}`);
    lines.push("");
  }
  if (rule.docs.normativeQuote) {
    lines.push(`  Normative text (WCAG)`);
    lines.push(`    "${rule.docs.normativeQuote}"`);
    lines.push("");
  }
  if (rule.docs.goodExample) {
    lines.push(`  Good example`);
    lines.push(indent(rule.docs.goodExample, 4));
    lines.push("");
  }
  if (rule.docs.badExample) {
    lines.push(`  Bad example`);
    lines.push(indent(rule.docs.badExample, 4));
    lines.push("");
  }
  if (rule.docs.references.length > 0) {
    lines.push(`  References`);
    for (const ref of rule.docs.references) lines.push(`    - ${ref}`);
    lines.push("");
  }

  return { stdout: lines.join("\n"), stderr, exitCode: ExitCode.OK };
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}
