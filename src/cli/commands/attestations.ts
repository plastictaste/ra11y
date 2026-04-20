/**
 * `ra11y attestations <action>` — subcommand namespace for managing
 * the on-disk attestation ledger at `.ra11y/attestations.jsonl`.
 *
 * Today this exposes `prune` (drops records pinned to files that no
 * longer exist) and `verify` (checks the ledger for tampering against
 * git as the trust root — see ADR 0020). Both wrap pure helpers in
 * `src/config/attestation-store.ts` with CLI-level I/O here.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  ATTESTATION_STORE_RELATIVE_PATH,
  type AttestationIntegrityFinding,
  pruneAttestations,
  readAttestations,
  resolveAttestationStorePath,
  rewriteAttestations,
  verifyAttestationIntegrity,
} from "../../config/attestation-store.ts";
import type { AttestationRecord } from "../../types/evidence.ts";
import { gitRoot, isGitRepo } from "../../utils/git.ts";
import type { CliOptions } from "../args.ts";
import { ExitCode } from "../exit-codes.ts";
import type { ScanExit } from "./scan.ts";

/** Routes `ra11y attestations <action>` to the matching handler. */
export function runAttestationsCommand(options: CliOptions): Promise<ScanExit> {
  if (options.attestationsAction === "prune") return runAttestationsPrune(options);
  if (options.attestationsAction === "verify") return runAttestationsVerify();
  return Promise.resolve({
    stdout: "",
    stderr: `ra11y: unknown attestations action '${options.attestationsAction ?? ""}'. Supported: prune, verify.\n`,
    exitCode: ExitCode.USER_ERROR,
  });
}

/**
 * `ra11y attestations prune` — drops records pinned to deleted files
 * and rewrites `.ra11y/attestations.jsonl`. With `--dry-run`, reports
 * without mutating. Exit 0 on success (including zero-stale); exit 2
 * when the store is missing or any line is malformed beyond the
 * lenient read path's tolerance.
 */
async function runAttestationsPrune(options: CliOptions): Promise<ScanExit> {
  const cwd = process.cwd();
  const path = resolveAttestationStorePath(cwd);
  const displayPath = relative(cwd, path) || path;

  if (!existsSync(path)) {
    return {
      stdout: "",
      stderr: `ra11y: attestation store not found at ${displayPath}. Run \`ra11y attest\` (or the \`attest\` MCP tool) to create entries first.\n`,
      exitCode: ExitCode.USER_ERROR,
    };
  }

  let records: readonly AttestationRecord[];
  try {
    records = await readAttestations(cwd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `ra11y: failed to read attestation store at ${displayPath}: ${message}\n`,
      exitCode: ExitCode.USER_ERROR,
    };
  }

  const { kept, dropped } = pruneAttestations(records, existsSync);
  if (!options.attestationsDryRun && dropped.length > 0) {
    await rewriteAttestations(cwd, kept);
  }

  return {
    stdout: renderPruneReport(kept, dropped, displayPath, options.attestationsDryRun),
    stderr: "",
    exitCode: ExitCode.OK,
  };
}

/**
 * `ra11y attestations verify` — validates the attestation ledger
 * against git as the trust root per ADR 0020. Flags:
 *
 *   - lines removed since HEAD (committed entries absent from the
 *     working tree) — exit 2;
 *   - backdated entries (`attestedAt` after the adding commit's
 *     author-date) — exit 2;
 *   - future-before-commit entries (`attestedAt` before the adding
 *     commit's author-date; rare but surfaced) — exit 2;
 *   - uncommitted entries (working-tree lines not yet in git) —
 *     informational; exit 0 when that is the only variant.
 *
 * Preconditions: the current directory must be inside a git repo and
 * the ledger must exist in the working tree. Outside those bounds
 * the command emits a clear error rather than faking success —
 * silent "clean ledger" when git never actually ran is exactly the
 * zero-output-success failure mode the AI-first consumer rules call
 * out.
 */
function runAttestationsVerify(): Promise<ScanExit> {
  const cwd = process.cwd();
  const path = resolveAttestationStorePath(cwd);
  const displayPath = relative(cwd, path) || path;

  if (!isGitRepo(cwd)) {
    return Promise.resolve({
      stdout: "",
      stderr:
        "ra11y: attestations verify requires a git repository (git is the trust root per ADR 0020).\n",
      exitCode: ExitCode.USER_ERROR,
    });
  }
  if (!existsSync(path)) {
    return Promise.resolve({
      stdout: "",
      stderr: `ra11y: attestation store not found at ${displayPath}. Run \`ra11y attest\` (or the \`attest\` MCP tool) to create entries first.\n`,
      exitCode: ExitCode.USER_ERROR,
    });
  }

  let workingTreeBody: string;
  try {
    workingTreeBody = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Promise.resolve({
      stdout: "",
      stderr: `ra11y: failed to read attestation store at ${displayPath}: ${message}\n`,
      exitCode: ExitCode.USER_ERROR,
    });
  }

  const root = gitRoot(cwd) ?? cwd;
  const headBody = readHeadLedger(root);
  const commitDates = blameWorkingTreeLedger(root, path);
  const { findings } = verifyAttestationIntegrity(workingTreeBody, headBody, commitDates);

  const hardFailures = findings.filter((f) => f.kind !== "uncommitted");
  const exitCode = hardFailures.length > 0 ? ExitCode.USER_ERROR : ExitCode.OK;
  return Promise.resolve({
    stdout: renderVerifyReport(findings, displayPath, hardFailures.length === 0),
    stderr: "",
    exitCode,
  });
}

/**
 * Reads `git show HEAD:<relative-ledger-path>` from the repo root.
 * Returns `""` when HEAD doesn't have the ledger yet (first commit
 * hasn't touched it) — the verifier treats that as "no committed
 * ledger," which makes every working-tree entry `uncommitted`.
 */
function readHeadLedger(repoRoot: string): string {
  const result = spawnSync("git", ["show", `HEAD:${ATTESTATION_STORE_RELATIVE_PATH}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return "";
  return result.stdout ?? "";
}

/**
 * Walks `git blame --line-porcelain <ledger>` from the repo root and
 * returns a per-line author-date map. Lines that blame reports as not
 * yet committed (the all-zero SHA sentinel) are omitted — the verifier
 * treats their absence as the `uncommitted` signal.
 */
function blameWorkingTreeLedger(repoRoot: string, absoluteLedgerPath: string): Map<number, string> {
  const ledgerRel = relative(repoRoot, absoluteLedgerPath);
  const result = spawnSync("git", ["blame", "--line-porcelain", "--", ledgerRel], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return new Map();
  return parseBlameLineDates(result.stdout ?? "");
}

/**
 * Parses `git blame --line-porcelain` output into a map of working-tree
 * line-number → ISO author-date.
 *
 * The porcelain format emits a header line `<sha> <orig> <final> [n]`
 * followed by key/value lines (`author`, `author-time`, `author-tz`,
 * …) and ends each hunk with the source line prefixed by a tab. We
 * track (final-line-number, author-time) per hunk and emit one map
 * entry per source line.
 *
 * Lines whose header SHA is the all-zero sentinel (blame's marker for
 * staged-but-not-committed or working-tree-modified lines) are
 * intentionally omitted — the verifier treats missing map entries as
 * `uncommitted`.
 *
 * Exported for testability so unit tests can exercise the parser on
 * hand-crafted blame output without needing a real git repo.
 */
export function parseBlameLineDates(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  const state: BlameHunkState = {
    currentSha: null,
    currentFinalLine: null,
    currentAuthorTime: null,
  };
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    applyBlameLine(line, state, out);
  }
  return out;
}

interface BlameHunkState {
  currentSha: string | null;
  currentFinalLine: number | null;
  currentAuthorTime: number | null;
}

const BLAME_ALL_ZEROES = "0000000000000000000000000000000000000000";
const BLAME_HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

function applyBlameLine(line: string, state: BlameHunkState, out: Map<number, string>): void {
  if (line.startsWith("\t")) {
    emitBlameHunk(state, out);
    state.currentFinalLine = null;
    state.currentAuthorTime = null;
    return;
  }
  const headerMatch = BLAME_HEADER_RE.exec(line);
  if (headerMatch !== null) {
    state.currentSha = headerMatch[1] ?? null;
    const finalStr = headerMatch[2];
    state.currentFinalLine = finalStr === undefined ? null : Number.parseInt(finalStr, 10);
    return;
  }
  if (line.startsWith("author-time ")) {
    const rest = line.slice("author-time ".length).trim();
    const n = Number.parseInt(rest, 10);
    state.currentAuthorTime = Number.isFinite(n) ? n : null;
  }
}

function emitBlameHunk(state: BlameHunkState, out: Map<number, string>): void {
  const { currentSha, currentFinalLine, currentAuthorTime } = state;
  if (currentSha === null || currentSha === BLAME_ALL_ZEROES) return;
  if (currentFinalLine === null || currentAuthorTime === null) return;
  out.set(currentFinalLine, new Date(currentAuthorTime * 1000).toISOString());
}

function renderVerifyReport(
  findings: readonly AttestationIntegrityFinding[],
  displayPath: string,
  clean: boolean,
): string {
  const byKind = {
    removed: findings.filter((f) => f.kind === "removed-since-head"),
    backdated: findings.filter((f) => f.kind === "backdated-attestation"),
    future: findings.filter((f) => f.kind === "future-attestation-before-commit"),
    uncommitted: findings.filter((f) => f.kind === "uncommitted"),
  };
  const lines: string[] = [];
  if (clean && findings.length === 0) {
    lines.push(`ra11y attestations verify: ${displayPath} is clean against HEAD`);
    return `${lines.join("\n")}\n`;
  }
  if (clean) {
    lines.push(
      `ra11y attestations verify: ${displayPath} matches HEAD (${byKind.uncommitted.length} uncommitted)`,
    );
  } else {
    const total = byKind.removed.length + byKind.backdated.length + byKind.future.length;
    lines.push(
      `ra11y attestations verify: ${displayPath} has ${total} integrity findings against HEAD`,
    );
  }
  for (const f of byKind.removed) {
    lines.push(`  removed-since-head  HEAD line ${f.line}  ${f.record.criterionId}`);
  }
  for (const f of byKind.backdated) {
    if (f.kind !== "backdated-attestation") continue;
    lines.push(
      `  backdated-attestation  line ${f.line}  ${f.record.criterionId}  attestedAt=${f.attestedAt} after commit=${f.commitDate}`,
    );
  }
  for (const f of byKind.future) {
    if (f.kind !== "future-attestation-before-commit") continue;
    lines.push(
      `  future-attestation-before-commit  line ${f.line}  ${f.record.criterionId}  attestedAt=${f.attestedAt} before commit=${f.commitDate}`,
    );
  }
  for (const f of byKind.uncommitted) {
    lines.push(`  uncommitted  line ${f.line}  ${f.record.criterionId} (not yet committed)`);
  }
  return `${lines.join("\n")}\n`;
}

function renderPruneReport(
  kept: readonly AttestationRecord[],
  dropped: readonly AttestationRecord[],
  displayPath: string,
  dryRun: boolean,
): string {
  const prefix = dryRun ? "ra11y attestations prune (dry-run):" : "ra11y attestations prune:";
  const verb = dropped.length === 0 ? "dropped" : dryRun ? "would drop" : "dropped";
  const lines = [
    `${prefix} ${verb} ${dropped.length} dead records (${kept.length} still live) in ${displayPath}`,
  ];
  for (const record of dropped) {
    const pinned = record.location?.filePath ?? "<no location>";
    lines.push(`  - ${pinned}  ${record.criterionId}`);
  }
  return `${lines.join("\n")}\n`;
}

// Re-export the constant so future callers that import the CLI
// module keep a single source of truth for the path layout.
export { ATTESTATION_STORE_RELATIVE_PATH };
