/**
 * Internal helpers for the `audit_rule_coverage` MCP tool — input
 * validation, error envelopes, and the per-file scan probes the handler
 * needs. Lives in its own module so `tool-audit-rule-coverage.ts` stays
 * under the per-MCP-tool effective-line budget (`scripts/check-limits.ts`);
 * same pattern as `tool-findings-by-rule-internals.ts`.
 *
 * Response assembly (the `buildResult` shape with `nextStep` /
 * `nextStepStructured` / warnings) lives in
 * `./tool-audit-rule-coverage-result.ts` so neither file overruns.
 */

import { existsSync } from "node:fs";
import type { ParsedFile } from "../engine/scanner.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage, Violation } from "../types/violation.ts";
import { extensionMatches } from "../utils/path.ts";
import type { McpSession } from "./session.ts";
import { errorResult, type McpToolResult, strParam } from "./tools-helpers.ts";

export interface ValidatedInput {
  readonly ruleId: string;
  readonly file: string;
  readonly cwd: string | undefined;
}

/**
 * Up-front input validation — required-param + cwd-existence checks
 * surface as structured errors rather than silently falling through to
 * defaults. Same closure pattern `tool-findings-by-rule-internals.ts` /
 * `tool-coverage.ts` use.
 */
export function validateInput(
  params: Record<string, unknown>,
): ValidatedInput | { readonly error: McpToolResult } {
  const ruleId = strParam(params, "ruleId");
  if (ruleId === undefined || ruleId.length === 0) {
    return {
      error: errorResult({
        code: "missing-required-param",
        message: "ruleId is required.",
        details: { missing: ["ruleId"] },
      }),
    };
  }
  const file = strParam(params, "file");
  if (file === undefined || file.length === 0) {
    return {
      error: errorResult({
        code: "missing-required-param",
        message: "file is required.",
        details: { missing: ["file"] },
      }),
    };
  }
  const cwd = strParam(params, "cwd");
  if (cwd !== undefined && !existsSync(cwd)) {
    return {
      error: errorResult({
        code: "cwd-not-found",
        message: `Requested cwd does not exist on disk: ${cwd}`,
        details: { cwd },
        remediation:
          "Pass `cwd` as a path to an existing directory. Relative paths resolve against the MCP server's spawn directory.",
      }),
    };
  }
  return { ruleId, file, cwd };
}

export function ruleNotFoundError(ruleId: string): McpToolResult {
  return errorResult({
    code: "rule-not-found",
    message: `Rule '${ruleId}' not found.`,
    details: { requested: ruleId },
    remediation: "Call `list_rules` to discover valid rule IDs.",
  });
}

export function fileNotFoundResult(filePath: string): McpToolResult {
  return errorResult({
    code: "file-not-found",
    message: `File not found: ${filePath}`,
    details: { filePath },
    remediation:
      "Verify the path exists on disk. Relative paths resolve against `cwd` (defaults to the MCP server's spawn directory).",
  });
}

export function unsupportedExtensionResult(filePath: string): McpToolResult {
  return errorResult({
    code: "file-unsupported",
    message: `Unsupported file extension: ${filePath}`,
    details: { filePath },
    remediation: "Pass a file with a parseable extension (e.g. .tsx, .jsx, .ts, .js, .html, .css).",
  });
}

export function fileReadFailedResult(filePath: string): McpToolResult {
  return errorResult({
    code: "file-read-failed",
    message: `Failed to read ${filePath}.`,
    details: { filePath },
    remediation:
      "The file exists and has a supported extension, but the scanner could not read or parse it. Check permissions or encoding, then retry.",
  });
}

/**
 * Determines whether a rule's static `appliesTo.fileExtensions` would
 * accept the given file extension. Project-scoped rules and rules
 * without an extension gate are eligible for any file. Routes through
 * `extensionMatches` so the alias table (`.scss → .css`, `.md → .html`,
 * `.jsx → .js`, etc.) is honored — the same predicate the engine uses
 * at run-time, so an agent reading `eligibleByExtension: true` here
 * matches what `scan_file` would have run.
 */
export function ruleEligibleForExtension(rule: Rule, ext: string): boolean {
  const extensions = rule.appliesTo?.fileExtensions;
  if (extensions === undefined || extensions.length === 0) return true;
  return extensionMatches(ext, extensions);
}

/**
 * Walks the post-filter violations stream looking for any non-info
 * emission whose `ruleId` matches AND whose `filePath` matches the
 * scanned file's parsed-path key. Info-severity findings are excluded
 * for parity with `findings_by_rule` / `scan_project.plan.findingsByRule`,
 * so the cross-surface answer "did rule X fire?" agrees across tools.
 */
export function ruleFiredOnFile(
  violations: readonly Violation[],
  ruleId: string,
  parsedFilePath: string,
): boolean {
  for (const v of violations) {
    if (v.ruleId !== ruleId || v.severity === "info") continue;
    if (v.location.filePath === parsedFilePath) return true;
  }
  return false;
}

export async function parseTargetFile(
  filePath: string,
  cwd: string | undefined,
  session: McpSession,
): Promise<ParsedFile | "unsupported" | "read-failed"> {
  let parsed: ParsedFile | null;
  try {
    parsed = await session.parseFile(filePath, cwd);
  } catch {
    return "read-failed";
  }
  return parsed ?? "unsupported";
}

/**
 * Builds the optional `hint` text from the rule's `knownLimitations`
 * docs and any per-rule `coverageConfidenceReason` / `reason` the scan
 * stamped on this file's coverage row. Both are additive context — the
 * tool does NOT claim either signals "the rule should have fired"; the
 * agent reads the file and decides. Returns `undefined` when no hint
 * material is available so the response field omits cleanly per
 * present-when-meaningful discipline.
 */
export function buildHint(
  rule: Rule,
  perRuleCoverage: readonly PerRuleCoverage[],
): string | undefined {
  const parts: string[] = [];
  const row = perRuleCoverage.find((r) => r.ruleId === rule.id);
  const coverageReason = row?.coverageConfidenceReason ?? row?.reason;
  if (coverageReason !== undefined && coverageReason.length > 0) {
    parts.push(`coverage reason: ${coverageReason}`);
  }
  const limits = rule.docs.knownLimitations;
  if (limits !== undefined && limits.length > 0) {
    parts.push(`known limitations: ${limits.join("; ")}`);
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}
