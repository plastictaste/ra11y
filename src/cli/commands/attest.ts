/**
 * `ra11y attest <criterionId>` — single-shot CLI wrapper around the
 * durable attestation store primitive. Appends one validated record to
 * `<cwd>/.ra11y/attestations.jsonl` so subsequent scans pick it up as
 * an `attested` evidence source.
 *
 * Mirrors the `attest` MCP tool's safety posture: `reason` is required
 * and non-empty, the criterion must resolve to a loaded standard,
 * `ruleIds` — if provided — must actually satisfy the target criterion,
 * and `scope: "file" | "line"` requires a parseable `--location`.
 *
 * Exit codes (CLAUDE.md §12):
 *   - `OK` — record appended.
 *   - `USER_ERROR` — missing reason / unknown criterion / unknown rule
 *     IDs / malformed location / scope↔location mismatch / file-write
 *     failure.
 *
 * Commit hash is derived at scan time via `headSha()`. Outside a git
 * repo the commit-hash side-effect is simply omitted — attestations
 * carry no commit field, but the conformance-statement signing path
 * surfaces `non_git_repo_signature_omitted` separately when asked.
 */

import { appendAttestation } from "../../config/attestation-store.ts";
import { createBuiltinRegistry, type Registry } from "../../engine/registry/registry.ts";
import { ATTESTATION_EVIDENCE_SOURCES, type AttestationRecord } from "../../types/evidence.ts";
import { headSha } from "../../utils/git.ts";
import { isIsoTimestamp } from "../../utils/iso-timestamp.ts";
import type { CliOptions } from "../args.ts";
import { ExitCode } from "../exit-codes.ts";
import type { ScanExit } from "./scan.ts";

const DEFAULT_BY = "agent";

/** Entry point registered by `src/cli/run.ts`. */
export async function runAttestCommand(
  options: CliOptions,
  registry: Registry = createBuiltinRegistry(),
): Promise<ScanExit> {
  const cwd = process.cwd();
  const pre = preflight(options, registry);
  if ("error" in pre) return pre.error;
  const { record } = pre;

  try {
    await appendAttestation(cwd, record);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `ra11y: failed to append attestation: ${message}\n`,
      exitCode: ExitCode.USER_ERROR,
    };
  }

  return {
    stdout: renderReport(record, cwd),
    stderr: maybeNonGitRepoWarning(cwd),
    exitCode: ExitCode.OK,
  };
}

interface PreflightOk {
  readonly record: AttestationRecord;
}

type PreflightResult = PreflightOk | { readonly error: ScanExit };

function preflight(options: CliOptions, registry: Registry): PreflightResult {
  const required = requireMinimumFlags(options, registry);
  if ("error" in required) return required;
  const { criterionId, rawReason, evidenceSource } = required;

  const scope = options.attestScope;
  const ruleIds = validateRuleIds(options.attestRuleIds, criterionId, registry);
  if ("error" in ruleIds) return ruleIds;
  const location = parseLocation(options.attestLocation, scope);
  if ("error" in location) return location;
  const observedAt = validateOptionalIso(options.attestObservedAt, "observed-at");
  if ("error" in observedAt) return observedAt;

  const by = options.attestBy ?? DEFAULT_BY;
  const record: AttestationRecord = {
    criterionId,
    by: by.length === 0 ? DEFAULT_BY : by,
    reason: rawReason.trim(),
    attestedAt: new Date().toISOString(),
    evidenceSource,
    ...(options.attestToolName !== undefined && { toolName: options.attestToolName }),
    ...(options.attestRunUrl !== undefined && { runUrl: options.attestRunUrl }),
    ...(observedAt.value !== undefined && { observedAt: observedAt.value }),
    ...(ruleIds.value !== undefined && { ruleIds: ruleIds.value }),
    ...(scope !== undefined && { scope }),
    ...(location.value !== undefined && { location: location.value }),
    ...(options.attestVerdict !== undefined && { verdict: options.attestVerdict }),
  };
  return { record };
}

/**
 * Validates the required flags (criterion ID, reason, evidence source)
 * and returns them typed. Extracted from {@link preflight} so the outer
 * function's cognitive complexity stays under the lint budget — three
 * required-flag failure paths compounded with the optional-flag
 * validation would push the single-function score over.
 */
function requireMinimumFlags(
  options: CliOptions,
  registry: Registry,
):
  | {
      readonly criterionId: string;
      readonly rawReason: string;
      readonly evidenceSource: NonNullable<CliOptions["attestEvidenceSource"]>;
    }
  | { readonly error: ScanExit } {
  const criterionId = options.positionals[0];
  if (criterionId === undefined || criterionId.length === 0) {
    return usage(
      "ra11y attest: missing <criterionId>. Usage: `ra11y attest <criterionId> --reason <text> --evidence-source <runtime_tool|manual_review|human_study|declaration> [--verdict pass|fail|na|pending] [--rule-ids <id>,…] [--scope project|file|line] [--location <file>:<line>[:<col>]] [--by <who>] [--tool-name <name>] [--run-url <url>] [--observed-at <iso>]`.",
    );
  }
  if (registry.findCriterion(criterionId) === undefined) {
    return usage(
      `ra11y attest: unknown criterion '${criterionId}'. Must resolve to a loaded standard (e.g. 'wcag22:2.4.7').`,
    );
  }
  const rawReason = options.attestReason;
  if (rawReason === undefined || rawReason.trim().length === 0) {
    return usage(
      "ra11y attest: --reason is required and must be non-empty. An un-justified attestation is the same failure mode a bare `ra11y-disable` represents — the whole point is provenance.",
    );
  }
  const evidenceSource = options.attestEvidenceSource;
  if (evidenceSource === undefined) {
    return usage(
      `ra11y attest: --evidence-source is required (one of ${ATTESTATION_EVIDENCE_SOURCES.join(", ")}). A VPAT / conformance reader distinguishes a runtime-harness pass from an unverified declaration by this field.`,
    );
  }
  return { criterionId, rawReason, evidenceSource };
}

/**
 * Validates an optional ISO-8601 CLI flag value. Returns
 * `{ value: undefined }` when the flag was absent; `{ value: <raw> }`
 * when present and well-formed; `{ error }` when present but malformed.
 */
function validateOptionalIso(
  raw: string | undefined,
  flagName: string,
): { readonly value: string | undefined } | { readonly error: ScanExit } {
  if (raw === undefined) return { value: undefined };
  if (!isIsoTimestamp(raw)) {
    return usage(
      `ra11y attest: --${flagName} must be an ISO-8601 timestamp (e.g. "2026-04-18T00:00:00Z"). Got: '${raw}'.`,
    );
  }
  return { value: raw };
}

function validateRuleIds(
  raw: readonly string[],
  criterionId: string,
  registry: Registry,
): { readonly value: readonly string[] | undefined } | { readonly error: ScanExit } {
  if (raw.length === 0) return { value: undefined };
  const satisfyingSet = new Set(registry.rulesForCriterion(criterionId).map((r) => r.id));
  const unknown = raw.filter((id) => !satisfyingSet.has(id));
  if (unknown.length > 0) {
    return usage(
      `ra11y attest: the following rule IDs do not satisfy '${criterionId}': ${unknown.join(", ")}. Drop them or pick a different criterion.`,
    );
  }
  const deduped = [...new Set(raw)].sort();
  return { value: deduped };
}

/**
 * Parses `<file>:<line>[:<col>]`. Returns `{ value: undefined }` when
 * no flag was passed and scope allows it; `{ error }` when the flag is
 * malformed or when scope demands a location that's absent.
 */
function parseLocation(
  raw: string | undefined,
  scope: CliOptions["attestScope"],
): { readonly value: AttestationRecord["location"] | undefined } | { readonly error: ScanExit } {
  if (raw === undefined) {
    if (scope === "file" || scope === "line") {
      return usage(
        `ra11y attest: --location <file>:<line>[:<col>] is required when scope="${scope}".`,
      );
    }
    return { value: undefined };
  }
  const split = splitLocation(raw);
  if ("error" in split) return split;
  const { filePath, lineRaw, columnRaw } = split.value;
  const line = parsePositiveInt(lineRaw, "line");
  if ("error" in line) return line;
  const column = columnRaw === undefined ? { value: 1 } : parsePositiveInt(columnRaw, "column");
  if ("error" in column) return column;
  return { value: { filePath, line: line.value, column: column.value } };
}

/**
 * Splits `<file>:<line>[:<col>]` into its three raw parts. Paths
 * containing colons are unlikely on POSIX but defensive handling is
 * cheap — we parse from the right and join the remainder back.
 */
function splitLocation(raw: string):
  | {
      readonly value: {
        readonly filePath: string;
        readonly lineRaw: string;
        readonly columnRaw: string | undefined;
      };
    }
  | { readonly error: ScanExit } {
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return usage(
      `ra11y attest: --location must be '<file>:<line>' or '<file>:<line>:<col>'. Got: '${raw}'.`,
    );
  }
  const columnRaw = parts.length === 3 ? parts[2] : undefined;
  const tailWidth = columnRaw === undefined ? 1 : 2;
  const lineRaw = parts[parts.length - tailWidth] ?? "";
  const filePath = parts.slice(0, parts.length - tailWidth).join(":");
  if (filePath.length === 0) {
    return usage(`ra11y attest: --location file path is empty in '${raw}'.`);
  }
  return { value: { filePath, lineRaw, columnRaw } };
}

function parsePositiveInt(
  raw: string,
  field: "line" | "column",
): { readonly value: number } | { readonly error: ScanExit } {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    return usage(`ra11y attest: --location ${field} must be a positive integer (got '${raw}').`);
  }
  return { value };
}

function renderReport(record: AttestationRecord, cwd: string): string {
  const commit = headSha(cwd);
  const lines = [
    `ra11y attest: appended attestation for ${record.criterionId} (verdict=${record.verdict ?? "pass"}) to .ra11y/attestations.jsonl`,
    `  reason: ${record.reason}`,
    `  evidenceSource: ${record.evidenceSource}`,
    `  by: ${record.by}`,
    `  attestedAt: ${record.attestedAt}`,
  ];
  if (record.toolName !== undefined) lines.push(`  toolName: ${record.toolName}`);
  if (record.runUrl !== undefined) lines.push(`  runUrl: ${record.runUrl}`);
  if (record.observedAt !== undefined) lines.push(`  observedAt: ${record.observedAt}`);
  if (record.ruleIds !== undefined) lines.push(`  ruleIds: ${record.ruleIds.join(", ")}`);
  if (record.scope !== undefined) lines.push(`  scope: ${record.scope}`);
  if (record.location !== undefined) {
    lines.push(
      `  location: ${record.location.filePath}:${record.location.line}:${record.location.column}`,
    );
  }
  if (commit !== null) lines.push(`  commit: ${commit}`);
  lines.push(
    "Next: re-run `ra11y conformance` (or `--coverage`) to see the attested source on the ledger. Commit .ra11y/attestations.jsonl so the trail persists.",
  );
  return `${lines.join("\n")}\n`;
}

function maybeNonGitRepoWarning(cwd: string): string {
  if (headSha(cwd) !== null) return "";
  return "ra11y attest: warnings=non_git_repo_commit_omitted (attestation recorded without a commit anchor — conformance signing will skip the signature block)\n";
}

function usage(message: string): { readonly error: ScanExit } {
  return {
    error: {
      stdout: "",
      stderr: `${message}\n`,
      exitCode: ExitCode.USER_ERROR,
    },
  };
}
