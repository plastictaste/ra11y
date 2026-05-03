#!/usr/bin/env bun
/**
 * Validates a `/continue` planner plan against deterministic structural
 * rules from `.claude/agents/planner.md`. The planner itself is
 * judgment-driven; this script catches the cheap-deterministic class of
 * mistake that prompt patches keep drifting away from — owner-mapping
 * misclassification, intra-turn file collisions, already-shipped picks,
 * stale backlogLine pointers, and the picksPerTurn arithmetic.
 *
 * Reads JSON from stdin or `--file <path>`. Exits 0 on pass with no
 * output; exits 1 on fail with one diagnostic per line on stderr.
 *
 * Wiring: the orchestrator runs this after the planner returns its
 * plan and before consuming any turn. A non-zero exit means the plan
 * is unsafe to dispatch — replan or escalate.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PlanPick {
  readonly item: string;
  readonly track: string;
  readonly specialist: string;
  readonly backlogLine?: number;
  readonly inferredFiles?: readonly string[];
  readonly collisionWith?: string | null;
  readonly crossCutting?: boolean;
}

export interface PlanTurn {
  readonly n: number;
  readonly picksPerTurn: number;
  readonly picks: readonly PlanPick[];
  readonly slotWasteWarning?: boolean;
}

export interface Plan {
  readonly turns: readonly PlanTurn[];
}

export interface ValidationContext {
  /** Item IDs that already carry a `Closes:` or `Drops:` trailer in git history. */
  readonly closedItemIds: ReadonlySet<string>;
  /** Lines of `.claude/backlog.md`, 0-indexed. `backlogLine` field is 1-indexed. */
  readonly backlogLines: readonly string[];
}

const OWNER_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly owner: string }> = [
  { pattern: /^src\/rules\//, owner: "rule-implementer" },
  { pattern: /^src\/standards\//, owner: "standard-builder" },
  { pattern: /^src\/input\/parsers\//, owner: "parser-author" },
  { pattern: /^src\/output\/formatters\//, owner: "formatter-author" },
  { pattern: /^src\/types\//, owner: "type-smith" },
  { pattern: /^src\/engine\/ast-helpers\.ts$/, owner: "type-smith" },
  { pattern: /^src\/mcp\//, owner: "main-session" },
  { pattern: /^src\/review\/finders\//, owner: "main-session" },
  { pattern: /^src\/engine\//, owner: "main-session" },
  { pattern: /^scripts\//, owner: "main-session" },
  { pattern: /^\.github\/workflows\//, owner: "main-session" },
  { pattern: /^\.claude\//, owner: "main-session" },
  { pattern: /^docs\/adr\//, owner: "main-session" },
  { pattern: /^tests\/fixtures\/real-world\//, owner: "fixture-curator" },
  { pattern: /^tests\//, owner: "test-author" },
  { pattern: /^docs\/kb\//, owner: "spec-researcher" },
  { pattern: /^docs\//, owner: "doc-writer" },
];

const V_TRACK_SPECIALISTS: ReadonlySet<string> = new Set([
  "rule-implementer",
  "fixture-curator",
  "test-author",
  "formatter-author",
  "parser-author",
  "standard-builder",
  "type-smith",
  "doc-writer",
  "spec-researcher",
]);

export function ownerForFile(file: string): string {
  for (const { pattern, owner } of OWNER_PATTERNS) {
    if (pattern.test(file)) return owner;
  }
  return "main-session";
}

/**
 * `main-session` and `general-purpose` are both catch-all classifiers
 * the planner can assign for files no V-track specialist owns. The
 * orchestrator routes `main-session`-classified picks inline and
 * `general-purpose`-classified picks into a worktree-isolated
 * Anthropic agent — but for owner-mapping purposes both are equally
 * valid for any file path.
 */
function isCatchAllSpecialist(specialist: string): boolean {
  return specialist === "main-session" || specialist === "general-purpose";
}

function checkPicksPerTurnArithmetic(turn: PlanTurn): string[] {
  if (turn.picks.length === turn.picksPerTurn) return [];
  return [
    `turn ${turn.n}: picksPerTurn=${turn.picksPerTurn} but picks.length=${turn.picks.length}`,
  ];
}

function checkCrossCuttingAllocation(turn: PlanTurn): string[] {
  const hasCrossCutting = turn.picks.some((p) => p.crossCutting === true);
  if (!hasCrossCutting) return [];
  if (turn.picksPerTurn === 1) return [];
  if (turn.slotWasteWarning === true) return [];
  return [
    `turn ${turn.n}: crossCutting pick requires picksPerTurn=1 unless slotWasteWarning=true (planner.md §4 allocation rule)`,
  ];
}

function checkPicksPerTurnFour(turn: PlanTurn): string[] {
  if (turn.picksPerTurn !== 4) return [];
  const errors: string[] = [];
  for (const pick of turn.picks) {
    if (!V_TRACK_SPECIALISTS.has(pick.specialist)) {
      errors.push(
        `turn ${turn.n}: picksPerTurn=4 but pick "${pick.item}" has non-V-track specialist "${pick.specialist}"`,
      );
    }
    if (pick.collisionWith != null && pick.collisionWith !== "") {
      errors.push(
        `turn ${turn.n}: picksPerTurn=4 but pick "${pick.item}" carries collisionWith — drop the cap to 3`,
      );
    }
  }
  return errors;
}

function checkIntraTurnFileCollision(turn: PlanTurn): string[] {
  const errors: string[] = [];
  const fileToPick = new Map<string, string>();
  for (const pick of turn.picks) {
    for (const file of pick.inferredFiles ?? []) {
      const prior = fileToPick.get(file);
      if (prior === undefined) {
        fileToPick.set(file, pick.item);
      } else {
        errors.push(
          `turn ${turn.n}: intra-turn collision on "${file}" between picks "${prior}" and "${pick.item}"`,
        );
      }
    }
  }
  return errors;
}

function checkSameTrackAndSpecialist(turn: PlanTurn): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const pick of turn.picks) {
    const key = `${pick.track}::${pick.specialist}`;
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, pick.item);
    } else {
      errors.push(
        `turn ${turn.n}: two picks share track+specialist "${key}": "${prior}" and "${pick.item}"`,
      );
    }
  }
  return errors;
}

function buildFileFirstSeenIndex(
  turns: readonly PlanTurn[],
): Map<string, { turn: number; item: string }> {
  const fileFirstSeen = new Map<string, { turn: number; item: string }>();
  for (const turn of turns) {
    for (const pick of turn.picks) {
      for (const file of pick.inferredFiles ?? []) {
        if (!fileFirstSeen.has(file)) {
          fileFirstSeen.set(file, { turn: turn.n, item: pick.item });
        }
      }
    }
  }
  return fileFirstSeen;
}

function checkCrossTurnCollisionForPick(
  turn: PlanTurn,
  pick: PlanPick,
  fileFirstSeen: ReadonlyMap<string, { turn: number; item: string }>,
): string[] {
  const errors: string[] = [];
  for (const file of pick.inferredFiles ?? []) {
    const first = fileFirstSeen.get(file);
    if (first === undefined || first.turn >= turn.n) continue;
    const collision = pick.collisionWith ?? "";
    const referencesEarlier =
      collision.includes(`turn-${first.turn}`) || collision.includes(first.item);
    if (!referencesEarlier) {
      errors.push(
        `turn ${turn.n}: pick "${pick.item}" inferredFile "${file}" collides with turn ${first.turn} pick "${first.item}" but collisionWith does not reference it`,
      );
    }
  }
  return errors;
}

function checkOwnerMappingForPick(turn: PlanTurn, pick: PlanPick): string[] {
  const files = pick.inferredFiles ?? [];
  if (files.length === 0) return [];
  const owners = new Set<string>(files.map(ownerForFile));
  const nonMain = [...owners].filter((o) => o !== "main-session");
  if (nonMain.length === 0) {
    if (isCatchAllSpecialist(pick.specialist)) return [];
    return [
      `turn ${turn.n}: pick "${pick.item}" specialist="${pick.specialist}" but inferredFiles map only to main-session paths`,
    ];
  }
  if (nonMain.length === 1) {
    const expected = nonMain[0];
    if (pick.specialist === expected || isCatchAllSpecialist(pick.specialist)) return [];
    return [
      `turn ${turn.n}: pick "${pick.item}" specialist="${pick.specialist}" but inferredFiles imply "${expected}"`,
    ];
  }
  const isTypeSmithCascade =
    pick.specialist === "type-smith" && files.some((f) => f.startsWith("src/types/"));
  if (isCatchAllSpecialist(pick.specialist) || isTypeSmithCascade) return [];
  return [
    `turn ${turn.n}: pick "${pick.item}" specialist="${pick.specialist}" but inferredFiles span multiple specialist groups (${[...owners].join("/")})`,
  ];
}

function checkAlreadyShippedForPick(
  turn: PlanTurn,
  pick: PlanPick,
  closedItemIds: ReadonlySet<string>,
): string[] {
  if (!closedItemIds.has(pick.item)) return [];
  return [`turn ${turn.n}: pick "${pick.item}" already shipped — found in Closes:/Drops: trailer`];
}

function checkBacklogLinePointer(
  turn: PlanTurn,
  pick: PlanPick,
  backlogLines: readonly string[],
): string[] {
  if (pick.backlogLine === undefined) return [];
  const line = backlogLines[pick.backlogLine - 1] ?? "";
  if (!/^- \[ \]/.test(line)) {
    return [
      `turn ${turn.n}: pick "${pick.item}" backlogLine=${pick.backlogLine} is not an open [ ] bullet`,
    ];
  }
  if (!line.includes(pick.item)) {
    return [
      `turn ${turn.n}: pick "${pick.item}" backlogLine=${pick.backlogLine} does not contain the item ID`,
    ];
  }
  return [];
}

/**
 * Validates a plan against the deterministic rules. Returns one
 * human-readable diagnostic per violation. Empty array = pass.
 */
export function validatePlan(plan: Plan, ctx: ValidationContext): string[] {
  if (!Array.isArray(plan.turns)) return ["plan.turns is not an array"];
  const errors: string[] = [];
  const fileFirstSeen = buildFileFirstSeenIndex(plan.turns);
  for (const turn of plan.turns) {
    errors.push(...checkPicksPerTurnArithmetic(turn));
    errors.push(...checkCrossCuttingAllocation(turn));
    errors.push(...checkPicksPerTurnFour(turn));
    errors.push(...checkIntraTurnFileCollision(turn));
    errors.push(...checkSameTrackAndSpecialist(turn));
    for (const pick of turn.picks) {
      errors.push(...checkCrossTurnCollisionForPick(turn, pick, fileFirstSeen));
      errors.push(...checkOwnerMappingForPick(turn, pick));
      errors.push(...checkAlreadyShippedForPick(turn, pick, ctx.closedItemIds));
      errors.push(...checkBacklogLinePointer(turn, pick, ctx.backlogLines));
    }
  }
  return errors;
}

/**
 * Reads the project's git log + backlog into a ValidationContext.
 * Cheap (one git invocation, one file read) and shared across all
 * checks so each pick doesn't pay its own subprocess.
 */
export function buildContext(repoRoot: string): ValidationContext {
  let logBody = "";
  try {
    logBody = execSync(`git log --all --grep="^Closes: \\|^Drops: " --format=%B`, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
  } catch {
    logBody = "";
  }
  const closedItemIds = new Set<string>();
  for (const line of logBody.split("\n")) {
    const match = /^(?:Closes|Drops):\s+(\S+)/.exec(line);
    if (match?.[1]) closedItemIds.add(match[1]);
  }
  let backlogLines: string[] = [];
  try {
    backlogLines = readFileSync(join(repoRoot, ".claude", "backlog.md"), "utf8").split("\n");
  } catch {
    backlogLines = [];
  }
  return { closedItemIds, backlogLines };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileFlagIdx = args.indexOf("--file");
  let raw: string;
  if (fileFlagIdx !== -1 && args[fileFlagIdx + 1] !== undefined) {
    raw = readFileSync(args[fileFlagIdx + 1] as string, "utf8");
  } else {
    raw = await new Response(Bun.stdin.stream()).text();
  }
  let plan: Plan;
  try {
    plan = JSON.parse(raw) as Plan;
  } catch (err) {
    process.stderr.write(`✗ planner plan is not valid JSON: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const repoRoot = join(import.meta.dir ?? process.cwd(), "..");
  const ctx = buildContext(repoRoot);
  const errors = validatePlan(plan, ctx);
  if (errors.length === 0) {
    process.exit(0);
  }
  process.stderr.write(`✗ planner plan failed ${errors.length} check(s):\n`);
  for (const e of errors) process.stderr.write(`  ${e}\n`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
