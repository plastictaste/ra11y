/**
 * File-backed store for durable attestations — `.ra11y/attestations.jsonl`
 * at the project root.
 *
 * One {@link AttestationRecord} per line, JSON-encoded. Append-only:
 * writers never rewrite history, so the store is a git-friendly
 * audit trail. Readers skip malformed lines rather than crashing —
 * an external tool that appends a bad entry shouldn't stop an agent
 * from seeing the valid entries around it.
 *
 * Shape conventions — any line not matching the {@link AttestationRecord}
 * contract is ignored:
 *   - Missing `criterionId`, `by`, `reason`, or `attestedAt` → skip.
 *   - Non-string required fields → skip.
 *   - Unknown top-level fields are preserved in the parsed object but
 *     not consumed by the ledger builder (forward-compatible for
 *     future metadata additions).
 *
 * Validation is deliberately lenient at read time — the `attest` MCP
 * tool enforces strict shape at *write* time so malformed entries
 * can't enter the store through the sanctioned path.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AttestationRecord } from "../types/evidence.ts";

/** Relative path from project root to the attestation store. */
export const ATTESTATION_STORE_RELATIVE_PATH = ".ra11y/attestations.jsonl";

/**
 * Resolves the attestation store path under a project root. The store
 * may not exist yet; callers that need to distinguish "no store" from
 * "empty store" can use {@link readAttestations} which returns `[]`
 * for both cases.
 */
export function resolveAttestationStorePath(projectRoot: string): string {
  return join(projectRoot, ATTESTATION_STORE_RELATIVE_PATH);
}

/**
 * Reads every valid attestation record from the store at
 * `<projectRoot>/.ra11y/attestations.jsonl`. Returns `[]` when the
 * file is absent or empty. Malformed lines are silently skipped.
 */
export async function readAttestations(projectRoot: string): Promise<AttestationRecord[]> {
  const path = resolveAttestationStorePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return parseAttestationJsonl(raw);
}

/**
 * Parses JSONL content into validated attestation records. Exported
 * for testability; production callers use {@link readAttestations}.
 */
export function parseAttestationJsonl(raw: string): AttestationRecord[] {
  const out: AttestationRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = coerceAttestationRecord(parsed);
    if (record !== null) out.push(record);
  }
  return out;
}

/**
 * Appends one validated record to the store. Creates `.ra11y/` and
 * the empty file if neither exists. Strict: the input must match the
 * {@link AttestationRecord} shape exactly — any malformed field
 * throws rather than silently dropping. The strict gate lives here
 * (the sanctioned write path) so the store is guaranteed well-formed
 * when read elsewhere.
 */
export async function appendAttestation(
  projectRoot: string,
  record: AttestationRecord,
): Promise<void> {
  const validated = requireValidRecord(record);
  const path = resolveAttestationStorePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const existing = await readRaw(path);
  const suffix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${existing}${suffix}${JSON.stringify(validated)}\n`, "utf8");
}

async function readRaw(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return "";
    throw err;
  }
}

/**
 * Rewrites the attestation store with the given records, replacing
 * any existing content. Creates `.ra11y/` and the file if neither
 * exists. Each record is validated through the same strict gate as
 * {@link appendAttestation} so the store remains well-formed.
 *
 * This is the sibling of {@link appendAttestation} used by prune-like
 * operations that legitimately need to rewrite history (dropping
 * entries whose files have been deleted). Unlike `appendAttestation`,
 * this intentionally replaces the file — callers must already own the
 * full desired ledger state.
 */
export async function rewriteAttestations(
  projectRoot: string,
  records: readonly AttestationRecord[],
): Promise<void> {
  const validated = records.map((r) => requireValidRecord(r));
  const path = resolveAttestationStorePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const body = validated.map((r) => JSON.stringify(r)).join("\n");
  const contents = body.length > 0 ? `${body}\n` : "";
  await writeFile(path, contents, "utf8");
}

/**
 * Result of a prune pass over the attestation store. `kept` is every
 * record that survives; `dropped` is every record removed because a
 * file it pins to no longer exists. Structural so callers (CLI,
 * future MCP tool) can report what changed.
 */
export interface AttestationPruneResult {
  readonly kept: AttestationRecord[];
  readonly dropped: AttestationRecord[];
}

/**
 * Drops attestation records whose pinned file locations no longer
 * exist on disk. A record is a prune candidate only when it carries a
 * {@link AttestationRecord.location} (scope `"file"` or `"line"`) —
 * project-scope records (no location) are file-agnostic and always
 * kept, even when authored alongside deleted files.
 *
 * The predicate is injectable so tests don't need a real filesystem.
 * Production callers pass `fs.existsSync`. The function is pure —
 * same input, same output, no I/O of its own.
 *
 * @param records - The loaded attestation ledger.
 * @param fileExists - Predicate called with the absolute or
 *   record-supplied `location.filePath`. Defaults to `fs.existsSync`.
 * @returns `{ kept, dropped }` — both arrays preserve input order.
 *
 * @example
 * ```ts
 * const records = await readAttestations(root);
 * const { kept, dropped } = pruneAttestations(records, existsSync);
 * if (dropped.length > 0) await rewriteAttestations(root, kept);
 * ```
 */
export function pruneAttestations(
  records: readonly AttestationRecord[],
  fileExists: (path: string) => boolean = existsSync,
): AttestationPruneResult {
  const kept: AttestationRecord[] = [];
  const dropped: AttestationRecord[] = [];
  for (const record of records) {
    const pinnedPath = record.location?.filePath;
    if (pinnedPath !== undefined && !fileExists(pinnedPath)) dropped.push(record);
    else kept.push(record);
  }
  return { kept, dropped };
}

/**
 * One finding produced by {@link verifyAttestationIntegrity}. Each
 * finding describes a single ledger line that violates an integrity
 * invariant defined in ADR 0020. `kind` discriminates the variant so
 * consumers can route by failure mode; `line` is the 1-based line
 * number in whichever file the finding is anchored to (working tree
 * for `backdated-attestation` / `future-attestation-before-commit` /
 * `uncommitted`; HEAD revision for `removed-since-head`).
 */
export type AttestationIntegrityFinding =
  | {
      readonly kind: "removed-since-head";
      readonly line: number;
      readonly record: AttestationRecord;
    }
  | {
      readonly kind: "backdated-attestation";
      readonly line: number;
      readonly record: AttestationRecord;
      readonly attestedAt: string;
      readonly commitDate: string;
    }
  | {
      readonly kind: "future-attestation-before-commit";
      readonly line: number;
      readonly record: AttestationRecord;
      readonly attestedAt: string;
      readonly commitDate: string;
    }
  | {
      readonly kind: "uncommitted";
      readonly line: number;
      readonly record: AttestationRecord;
    };

/**
 * Result of a verify pass over the attestation ledger. `findings` is
 * every flagged entry — both hard failures (`removed-since-head`,
 * `backdated-attestation`, `future-attestation-before-commit`) and
 * informational ones (`uncommitted`, which is expected when a caller
 * has just run `attest` and hasn't committed the ledger yet).
 *
 * The CLI wrapper treats the three hard-failure kinds as exit-2 signals
 * and `uncommitted` as informational; the split lives on the finding's
 * `kind` so the caller owns the policy.
 */
export interface AttestationVerifyResult {
  readonly findings: readonly AttestationIntegrityFinding[];
}

/**
 * Pure core of `ra11y attestations verify` (ADR 0020). Compares the
 * working-tree ledger body against the HEAD revision body and flags
 * integrity violations against git as the trust root.
 *
 * The function is deliberately pure — it takes both JSONL bodies and a
 * per-line commit-date map as arguments, emits no I/O of its own, and
 * exposes no git-shape dependency beyond the `ISO date string` typing
 * on the blame map. The CLI wrapper materializes these inputs via
 * `git show HEAD:<path>` + `git blame --line-porcelain`; tests
 * construct them directly without a real git repo.
 *
 * Invariants enforced:
 *
 * 1. **Removed since HEAD.** Every line committed on HEAD that does not
 *    appear (by exact JSON-line equality) in the working-tree body is
 *    flagged as `removed-since-head`. Catches the `vim :g/<rec>/d`
 *    attack — once an attestation has been committed, deleting it in
 *    the working tree is surfaced.
 * 2. **Backdated attestation.** A working-tree line's `attestedAt` is
 *    compared against the author-date of the commit that first added
 *    that line (keyed on the line's stable content hash via the
 *    `workingTreeLineCommitDates` map). `attestedAt > commitDate` →
 *    `backdated-attestation`. Catches "I wrote this in July but dated
 *    it January before the known regression landed."
 * 3. **Future attestation before commit.** `attestedAt < commitDate` →
 *    `future-attestation-before-commit`. Rarer; plausible when the
 *    authoring clock was wrong, still worth surfacing.
 * 4. **Uncommitted.** A working-tree line that carries no entry in the
 *    commit-date map (not yet committed to git) is flagged as
 *    `uncommitted` — informational, not a failure. Expected right after
 *    `ra11y attest` before `git commit`.
 *
 * @param workingTreeBody - Contents of `.ra11y/attestations.jsonl` in
 *   the working tree.
 * @param headBody - Contents of `.ra11y/attestations.jsonl` at
 *   `HEAD` (from `git show HEAD:<path>`). Empty string when the path
 *   is absent at HEAD — callers handle the precondition separately;
 *   this helper treats it as "no committed ledger yet," so every
 *   working-tree line reports as `uncommitted`.
 * @param workingTreeLineCommitDates - Map keyed by working-tree line
 *   number (1-based) to the author-date of the commit that added that
 *   line (ISO 8601 string). Absent entries → line is uncommitted.
 */
export function verifyAttestationIntegrity(
  workingTreeBody: string,
  headBody: string,
  workingTreeLineCommitDates: ReadonlyMap<number, string>,
): AttestationVerifyResult {
  const findings: AttestationIntegrityFinding[] = [];
  const workingLines = splitLedgerLines(workingTreeBody);
  const headLines = splitLedgerLines(headBody);

  const workingSet = new Set<string>();
  for (const { content } of workingLines) workingSet.add(content);
  collectRemovedSinceHead(headLines, workingSet, findings);
  classifyWorkingLines(workingLines, workingTreeLineCommitDates, findings);

  return { findings };
}

/**
 * Walks HEAD lines, emitting `removed-since-head` findings for every
 * line whose exact-JSON content is missing from the working-tree
 * body. We compare on raw JSON string rather than parsed objects so
 * adversarial key reorderings inside one record can't mask a
 * deletion — any edit beyond whitespace trimming flips equality,
 * which is the honest signal.
 */
function collectRemovedSinceHead(
  headLines: readonly LedgerLine[],
  workingSet: ReadonlySet<string>,
  out: AttestationIntegrityFinding[],
): void {
  for (const { content, lineNumber } of headLines) {
    if (workingSet.has(content)) continue;
    const record = parseLedgerLine(content);
    if (record !== null) {
      out.push({ kind: "removed-since-head", line: lineNumber, record });
    }
  }
}

/**
 * Classifies every working-tree line against its adding-commit date,
 * emitting `uncommitted` / `backdated-attestation` /
 * `future-attestation-before-commit` per {@link classifyWorkingLine}.
 */
function classifyWorkingLines(
  workingLines: readonly LedgerLine[],
  commitDates: ReadonlyMap<number, string>,
  out: AttestationIntegrityFinding[],
): void {
  for (const { content, lineNumber } of workingLines) {
    const record = parseLedgerLine(content);
    if (record === null) continue;
    const finding = classifyWorkingLine(record, lineNumber, commitDates.get(lineNumber));
    if (finding !== null) out.push(finding);
  }
}

/**
 * Classifies one working-tree ledger line against its adding-commit
 * date. Pure: returns a finding or null.
 */
function classifyWorkingLine(
  record: AttestationRecord,
  lineNumber: number,
  commitDate: string | undefined,
): AttestationIntegrityFinding | null {
  if (commitDate === undefined) {
    return { kind: "uncommitted", line: lineNumber, record };
  }
  const attestedAt = record.attestedAt;
  const attestedMs = Date.parse(attestedAt);
  const commitMs = Date.parse(commitDate);
  if (!(Number.isFinite(attestedMs) && Number.isFinite(commitMs))) {
    // Unparseable date on either side — skip rather than fabricate a
    // verdict. The adding-commit date is a git invariant (always
    // ISO); an unparseable `attestedAt` indicates a malformed record
    // the lenient reader would already skip, so there is nothing
    // useful to flag here.
    return null;
  }
  if (attestedMs > commitMs) {
    return { kind: "backdated-attestation", line: lineNumber, record, attestedAt, commitDate };
  }
  if (attestedMs < commitMs) {
    return {
      kind: "future-attestation-before-commit",
      line: lineNumber,
      record,
      attestedAt,
      commitDate,
    };
  }
  return null;
}

interface LedgerLine {
  readonly lineNumber: number;
  readonly content: string;
}

function splitLedgerLines(body: string): LedgerLine[] {
  if (body.length === 0) return [];
  const out: LedgerLine[] = [];
  let lineNumber = 0;
  for (const raw of body.split("\n")) {
    lineNumber += 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    out.push({ lineNumber, content: trimmed });
  }
  return out;
}

function parseLedgerLine(content: string): AttestationRecord | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return coerceAttestationRecord(parsed);
  } catch {
    return null;
  }
}

/**
 * Validates the parsed JSON value against the {@link AttestationRecord}
 * contract and returns a normalized record, or `null` if the value is
 * not a valid record. Used by the lenient read path.
 */
function coerceAttestationRecord(value: unknown): AttestationRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["criterionId"] !== "string" || v["criterionId"].length === 0) return null;
  if (typeof v["by"] !== "string" || v["by"].length === 0) return null;
  if (typeof v["reason"] !== "string" || v["reason"].length === 0) return null;
  if (typeof v["attestedAt"] !== "string" || v["attestedAt"].length === 0) return null;
  const record: AttestationRecord = {
    criterionId: v["criterionId"],
    by: v["by"],
    reason: v["reason"],
    attestedAt: v["attestedAt"],
    ...(isRuleIds(v["ruleIds"]) ? { ruleIds: v["ruleIds"] } : {}),
    ...(isScope(v["scope"]) ? { scope: v["scope"] } : {}),
    ...(isLocation(v["location"]) ? { location: v["location"] } : {}),
    ...(isVerdict(v["verdict"]) ? { verdict: v["verdict"] } : {}),
  };
  return record;
}

function isRuleIds(v: unknown): v is readonly string[] {
  if (!Array.isArray(v)) return false;
  if (v.length === 0) return false;
  return v.every((x) => typeof x === "string" && x.length > 0);
}

/**
 * Strict form of {@link coerceAttestationRecord} — throws instead of
 * returning null. Used by the write path so malformed data can't
 * enter the store through the sanctioned tool.
 */
function requireValidRecord(record: AttestationRecord): AttestationRecord {
  const coerced = coerceAttestationRecord(record);
  if (coerced === null) {
    const missing = describeMissingFields(record);
    throw new Error(
      `ra11y: invalid attestation record — ${missing}. Required non-empty strings: criterionId, by, reason, attestedAt. Example: { criterionId: "wcag22:1.1.1", by: "agent", reason: "reviewed", attestedAt: "2026-04-19T00:00:00Z", verdict: "pass", scope: "project" }.`,
    );
  }
  return coerced;
}

function describeMissingFields(record: AttestationRecord): string {
  const problems: string[] = [];
  const v = record as unknown as Record<string, unknown>;
  for (const field of ["criterionId", "by", "reason", "attestedAt"] as const) {
    const value = v[field];
    if (typeof value !== "string") problems.push(`${field} is ${typeof value}`);
    else if (value.length === 0) problems.push(`${field} is empty`);
  }
  return problems.length > 0 ? problems.join(", ") : "fields failed deeper validation";
}

function isScope(v: unknown): v is "project" | "file" | "line" {
  return v === "project" || v === "file" || v === "line";
}

function isVerdict(v: unknown): v is "pass" | "fail" | "n/a" | "pending" {
  return v === "pass" || v === "fail" || v === "n/a" || v === "pending";
}

function isLocation(v: unknown): v is { filePath: string; line: number; column: number } {
  if (typeof v !== "object" || v === null) return false;
  const loc = v as Record<string, unknown>;
  return (
    typeof loc["filePath"] === "string" &&
    typeof loc["line"] === "number" &&
    typeof loc["column"] === "number"
  );
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
