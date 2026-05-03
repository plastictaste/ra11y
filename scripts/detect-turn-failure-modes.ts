#!/usr/bin/env bun
/**
 * Deterministic failure-mode detector for /continue turn artifacts.
 *
 * Extracts the cheap-deterministic class of signal that
 * `.claude/agents/meta-reviewer.md` §1 describes — the cases where
 * the artifact alone (plus a small git-state delta) tells you what
 * went wrong, without LLM judgment. The meta-reviewer agent still
 * owns routing decisions, ledger maintenance, and the harness-patch
 * gates; this script only lights up the signals so a future
 * meta-reviewer prompt regression can't silently stop catching them.
 *
 * Reads JSON from stdin or `--file <path>`. Exits 0 on parse success;
 * emits a JSON `{ signals: [...] }` block on stdout regardless of how
 * many signals fired (zero signals = clean turn).
 *
 * Wiring: the meta-reviewer invokes the script, then merges its
 * deterministic signals with its own NLP-flavored detection (e.g.
 * `integrator_note_freeform` classification). The two halves don't
 * overlap.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SpecialistReturn {
  readonly branch_assigned?: string;
  readonly branch_returned?: string | null;
  readonly wall_time_seconds?: number;
  readonly total_tokens?: number;
  readonly return?: {
    readonly blocked?: string;
    readonly sha?: string | null;
    readonly commits?: readonly string[];
    readonly changed?: boolean;
    readonly verifyPrecommit?: string;
    readonly signals?: readonly { readonly code: string; readonly evidence: string }[];
  };
}

export interface IntegratorReturn {
  readonly integrated?: readonly { readonly item: string; readonly sha?: string }[];
  readonly errors?: readonly string[];
  readonly note?: string | null;
  readonly signals?: readonly { readonly code: string; readonly evidence: string }[];
}

export interface PlannerPick {
  readonly item: string;
  readonly inferredFiles?: readonly string[];
}

export interface TurnCost {
  readonly total_tokens?: number;
  readonly wall_seconds?: number;
}

export interface TurnArtifact {
  readonly turn_n?: number;
  readonly main_sha_before?: string;
  readonly main_sha_after?: string;
  readonly planner_picks?: readonly PlannerPick[];
  readonly specialist_returns?: readonly SpecialistReturn[];
  readonly integrator_return?: IntegratorReturn;
  readonly turn_cost?: TurnCost;
}

export interface GitDelta {
  /** SHAs landed on main between main_sha_before and main_sha_after. */
  readonly commitShasInRange: ReadonlySet<string>;
  /** Files changed across that range (relative paths, e.g. `src/rules/foo.ts`). */
  readonly filesChangedInRange: readonly string[];
  /**
   * `true` when the caller actually computed the delta against git
   * (even if the result is an empty set — meaning zero commits
   * landed). `false` or absent when the caller has no information,
   * in which case detectors that compare specialist-reported SHAs
   * against the delta skip rather than false-positive.
   */
  readonly commitRangeKnown?: boolean;
}

export interface Signal {
  readonly code: string;
  readonly evidence: string;
}

const STALL_WALL_TIME_SECONDS = 5 * 60;
const SLOW_SPECIALIST_WALL_SECONDS = 10 * 60;
const SLOW_SPECIALIST_TOKEN_THRESHOLD = 200_000;
const HIGH_COST_TURN_TOKEN_THRESHOLD = 500_000;

function detectBlockedSignal(specialist: SpecialistReturn): Signal | null {
  const blocked = specialist.return?.blocked;
  if (typeof blocked !== "string" || blocked.length === 0) return null;
  const colonIdx = blocked.indexOf(":");
  if (colonIdx === -1) return { code: blocked.trim(), evidence: "" };
  return {
    code: blocked.slice(0, colonIdx).trim(),
    evidence: blocked.slice(colonIdx + 1).trim(),
  };
}

function detectBranchDrift(specialist: SpecialistReturn): Signal | null {
  const assigned = specialist.branch_assigned;
  const returned = specialist.branch_returned;
  if (typeof assigned !== "string" || typeof returned !== "string") return null;
  if (assigned === returned) return null;
  return {
    code: "branch_naming_drift",
    evidence: `${assigned} → ${returned}`,
  };
}

function detectCherryPickDrop(specialist: SpecialistReturn, delta: GitDelta): Signal[] {
  // Without a computed range, we have no ground truth — skip rather than false-positive.
  if (delta.commitRangeKnown !== true) return [];
  const ret = specialist.return;
  if (!ret) return [];
  const reported: string[] = [];
  if (typeof ret.sha === "string" && ret.sha.length > 0) reported.push(ret.sha);
  for (const sha of ret.commits ?? []) {
    if (typeof sha === "string" && sha.length > 0) reported.push(sha);
  }
  const dropped = reported.filter((sha) => !delta.commitShasInRange.has(sha));
  if (dropped.length === 0) return [];
  const branch = specialist.branch_assigned ?? specialist.branch_returned ?? "<unknown>";
  return dropped.map((sha) => ({
    code: "cherry_pick_dropped_commits",
    evidence: `${branch}: specialist sha ${sha} not in main..HEAD`,
  }));
}

function detectStall(specialist: SpecialistReturn): Signal | null {
  const wall = specialist.wall_time_seconds ?? 0;
  const ret = specialist.return;
  const branch = specialist.branch_assigned ?? "<unknown>";
  // No structured return at all.
  if (ret === undefined || ret === null) {
    return {
      code: "specialist_stall",
      evidence: `${branch}: no structured JSON return`,
    };
  }
  // Claimed `changed: true` but no sha.
  if (ret.changed === true && (typeof ret.sha !== "string" || ret.sha.length === 0)) {
    return {
      code: "specialist_stall",
      evidence: `${branch}: changed=true but no sha`,
    };
  }
  // Long wall time without commits or blocked.
  const hasCommits =
    (ret.commits?.length ?? 0) > 0 || (typeof ret.sha === "string" && ret.sha.length > 0);
  const hasBlocked = typeof ret.blocked === "string" && ret.blocked.length > 0;
  if (wall > STALL_WALL_TIME_SECONDS && !hasCommits && !hasBlocked) {
    return {
      code: "specialist_stall",
      evidence: `${branch}: ${wall}s wall, no commits, no blocked`,
    };
  }
  return null;
}

function detectSlowSpecialist(specialist: SpecialistReturn): Signal | null {
  const wall = specialist.wall_time_seconds;
  const tokens = specialist.total_tokens;
  if (typeof wall !== "number" || typeof tokens !== "number") return null;
  if (wall <= SLOW_SPECIALIST_WALL_SECONDS) return null;
  if (tokens <= SLOW_SPECIALIST_TOKEN_THRESHOLD) return null;
  const ret = specialist.return;
  if (!ret) return null;
  const blocked = typeof ret.blocked === "string" && ret.blocked.length > 0;
  if (blocked) return null;
  if (ret.verifyPrecommit !== "ok") return null;
  const branch = specialist.branch_assigned ?? "<unknown>";
  return {
    code: "slow_specialist",
    evidence: `${branch}: ${wall}s / ${tokens} tokens for clean return`,
  };
}

function detectIntegratorErrors(integrator: IntegratorReturn | undefined): Signal[] {
  if (!integrator?.errors) return [];
  const out: Signal[] = [];
  for (const entry of integrator.errors) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const colonIdx = entry.indexOf(":");
    if (colonIdx === -1) {
      out.push({ code: entry.trim(), evidence: "" });
    } else {
      out.push({
        code: entry.slice(0, colonIdx).trim(),
        evidence: entry.slice(colonIdx + 1).trim(),
      });
    }
  }
  return out;
}

function detectCoverageRegenMiss(artifact: TurnArtifact, delta: GitDelta): Signal | null {
  const addedRuleOrFinder = delta.filesChangedInRange.some(
    (f) => f.startsWith("src/rules/") || f.startsWith("src/review/finders/"),
  );
  if (!addedRuleOrFinder) return null;
  const coverageTouched = delta.filesChangedInRange.some(
    (f) => f === "docs/kb/standards/coverage.md",
  );
  if (coverageTouched) return null;
  const rules = delta.filesChangedInRange.filter(
    (f) => f.startsWith("src/rules/") || f.startsWith("src/review/finders/"),
  );
  const turnRef = artifact.turn_n === undefined ? "turn" : `turn ${artifact.turn_n}`;
  return {
    code: "coverage_md_not_regenerated",
    evidence: `${turnRef}: added ${rules.join(", ")}, coverage.md unchanged`,
  };
}

function detectHighCostUneventfulTurn(
  artifact: TurnArtifact,
  otherSignalCount: number,
): Signal | null {
  const cost = artifact.turn_cost;
  if (!cost || typeof cost.total_tokens !== "number") return null;
  if (cost.total_tokens <= HIGH_COST_TURN_TOKEN_THRESHOLD) return null;
  if (otherSignalCount > 0) return null;
  return {
    code: "high_cost_uneventful_turn",
    evidence: `${cost.total_tokens} tokens / ${cost.wall_seconds ?? "?"}s wall, no signals`,
  };
}

function passthroughSignals(
  arr: readonly { readonly code: string; readonly evidence: string }[] | undefined,
): Signal[] {
  if (!arr) return [];
  return arr
    .filter((s) => typeof s.code === "string" && s.code.length > 0)
    .map((s) => ({ code: s.code, evidence: typeof s.evidence === "string" ? s.evidence : "" }));
}

/**
 * Detect every deterministic failure-mode signal observable from the
 * turn artifact + git delta. Returns one entry per observation; the
 * caller (meta-reviewer) deduplicates and routes.
 */
export function detectFailureModes(artifact: TurnArtifact, delta: GitDelta): Signal[] {
  const out: Signal[] = [];

  for (const specialist of artifact.specialist_returns ?? []) {
    const blocked = detectBlockedSignal(specialist);
    if (blocked !== null) out.push(blocked);
    const drift = detectBranchDrift(specialist);
    if (drift !== null) out.push(drift);
    out.push(...detectCherryPickDrop(specialist, delta));
    const stall = detectStall(specialist);
    if (stall !== null) out.push(stall);
    const slow = detectSlowSpecialist(specialist);
    if (slow !== null) out.push(slow);
    out.push(...passthroughSignals(specialist.return?.signals));
  }

  out.push(...detectIntegratorErrors(artifact.integrator_return));
  out.push(...passthroughSignals(artifact.integrator_return?.signals));

  const coverageMiss = detectCoverageRegenMiss(artifact, delta);
  if (coverageMiss !== null) out.push(coverageMiss);

  // High-cost uneventful turn signal must be evaluated AFTER all other
  // signals, because its predicate is "no other signals fired."
  const uneventful = detectHighCostUneventfulTurn(artifact, out.length);
  if (uneventful !== null) out.push(uneventful);

  return out;
}

async function readArtifact(): Promise<TurnArtifact> {
  const args = process.argv.slice(2);
  const fileFlagIdx = args.indexOf("--file");
  let raw: string;
  if (fileFlagIdx !== -1 && args[fileFlagIdx + 1] !== undefined) {
    raw = readFileSync(args[fileFlagIdx + 1] as string, "utf8");
  } else {
    raw = await new Response(Bun.stdin.stream()).text();
  }
  return JSON.parse(raw) as TurnArtifact;
}

/**
 * Compute the git delta between `main_sha_before` and `main_sha_after`
 * if both are present in the artifact. Empty delta when the SHAs are
 * absent or git fails — the caller (meta-reviewer agent) can pre-compute
 * a richer delta and pass it directly to `detectFailureModes` instead.
 */
function computeGitDeltaFromArtifact(artifact: TurnArtifact, repoRoot: string): GitDelta {
  const before = artifact.main_sha_before;
  const after = artifact.main_sha_after;
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    before.length === 0 ||
    after.length === 0
  ) {
    return { commitShasInRange: new Set(), filesChangedInRange: [], commitRangeKnown: false };
  }
  const range = `${before}..${after}`;
  let commitShas = new Set<string>();
  try {
    const out = execSync(`git log --format=%H ${range}`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    commitShas = new Set(out.split("\n").filter((s) => s.length > 0));
  } catch {
    // git fails (range invalid, SHAs unknown) — leave empty
  }
  let filesChanged: string[] = [];
  try {
    const out = execSync(`git diff --name-only ${range}`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    filesChanged = out.split("\n").filter((s) => s.length > 0);
  } catch {
    filesChanged = [];
  }
  return {
    commitShasInRange: commitShas,
    filesChangedInRange: filesChanged,
    commitRangeKnown: true,
  };
}

async function main(): Promise<void> {
  let artifact: TurnArtifact;
  try {
    artifact = await readArtifact();
  } catch (err) {
    process.stderr.write(`✗ turn artifact is not valid JSON: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const repoRoot = join(import.meta.dir ?? process.cwd(), "..");
  const delta = computeGitDeltaFromArtifact(artifact, repoRoot);
  const signals = detectFailureModes(artifact, delta);
  process.stdout.write(`${JSON.stringify({ signals }, null, 2)}\n`);
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
