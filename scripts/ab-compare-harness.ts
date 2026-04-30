#!/usr/bin/env bun
/**
 * A/B comparison across harness-state windows in the meta-reviewer ledger.
 *
 *   bun scripts/ab-compare-harness.ts                    # list every harness_sha window
 *   bun scripts/ab-compare-harness.ts --last 20 --prev 20  # compare last 20 turns vs prior 20
 *   bun scripts/ab-compare-harness.ts --since <sha>      # compare turns since <sha> vs everything before
 *
 * The meta-reviewer stamps each ledger entry with `harness_sha` (head of `main` at
 * turn start) and `cost.total_tokens` / `cost.wall_seconds` (when the orchestrator
 * forwarded them). This script groups entries by that SHA and reports turns landed,
 * average cost, signal rate, and uneventful-turn rate per window. It is read-only —
 * it never mutates the ledger and never spawns subprocesses.
 *
 * Entries written before `harness_sha` was added forward-fill to the most recent
 * prior SHA; entries without `cost.total_tokens` are skipped from cost arithmetic
 * (rather than counted as 0) so older runs don't skew averages downward.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface LedgerEntry {
  ts: string;
  invocation_id: string;
  turn_n: number;
  harness_sha?: string;
  cost?: { total_tokens?: number; wall_seconds?: number };
  signals?: Array<{ code: string; evidence?: string }>;
  writes?: { harness?: unknown[]; memory?: unknown[]; backlog_reopens?: unknown[] };
}

interface WindowStats {
  label: string;
  nTurns: number;
  avgTotalTokens: number | null;
  avgWallSeconds: number | null;
  totalSignals: number;
  uneventfulRate: number;
  topSignals: Array<{ code: string; count: number }>;
  harnessPatchesEmitted: number;
  memoryWritesEmitted: number;
}

const LEDGER_PATH = join(process.cwd(), ".claude", "turn-history.jsonl");

function readLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) {
    process.stderr.write(`Ledger not found at ${LEDGER_PATH}.\n`);
    process.stderr.write(
      "Run /continue at least once with the post-turn meta-reviewer to populate it.\n",
    );
    process.exit(1);
  }
  const raw = readFileSync(LEDGER_PATH, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const entries: LedgerEntry[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      process.stderr.write(`warning: skipping malformed ledger line ${i + 1}\n`);
    }
  }
  return entries;
}

function forwardFillHarnessSha(entries: LedgerEntry[]): LedgerEntry[] {
  let lastSha = "(unknown)";
  return entries.map((entry) => {
    if (entry.harness_sha) {
      lastSha = entry.harness_sha;
      return entry;
    }
    return { ...entry, harness_sha: lastSha };
  });
}

interface StatsAcc {
  tokensValues: number[];
  wallValues: number[];
  totalSignals: number;
  uneventful: number;
  harnessPatches: number;
  memoryWrites: number;
  codeCounts: Map<string, number>;
}

function emptyAcc(): StatsAcc {
  return {
    tokensValues: [],
    wallValues: [],
    totalSignals: 0,
    uneventful: 0,
    harnessPatches: 0,
    memoryWrites: 0,
    codeCounts: new Map(),
  };
}

function accumulateEntry(entry: LedgerEntry, acc: StatsAcc): void {
  if (typeof entry.cost?.total_tokens === "number") acc.tokensValues.push(entry.cost.total_tokens);
  if (typeof entry.cost?.wall_seconds === "number") acc.wallValues.push(entry.cost.wall_seconds);
  const signals = entry.signals ?? [];
  acc.totalSignals += signals.length;
  if (signals.length === 0) acc.uneventful += 1;
  for (const signal of signals) {
    acc.codeCounts.set(signal.code, (acc.codeCounts.get(signal.code) ?? 0) + 1);
  }
  if (Array.isArray(entry.writes?.harness) && entry.writes.harness.length > 0)
    acc.harnessPatches += 1;
  if (Array.isArray(entry.writes?.memory) && entry.writes.memory.length > 0) acc.memoryWrites += 1;
}

function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function topSignalsFrom(codeCounts: Map<string, number>): Array<{ code: string; count: number }> {
  return [...codeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([code, count]) => ({ code, count }));
}

function statsFor(entries: LedgerEntry[], label: string): WindowStats {
  const acc = emptyAcc();
  for (const entry of entries) accumulateEntry(entry, acc);
  return {
    label,
    nTurns: entries.length,
    avgTotalTokens: meanOf(acc.tokensValues),
    avgWallSeconds: meanOf(acc.wallValues),
    totalSignals: acc.totalSignals,
    uneventfulRate: entries.length === 0 ? 0 : acc.uneventful / entries.length,
    topSignals: topSignalsFrom(acc.codeCounts),
    harnessPatchesEmitted: acc.harnessPatches,
    memoryWritesEmitted: acc.memoryWrites,
  };
}

function fmtNum(n: number | null): string {
  if (n === null) return "(no data)";
  return n.toLocaleString();
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function printStats(stats: WindowStats): void {
  process.stdout.write(`\n${stats.label}\n`);
  process.stdout.write(`${"─".repeat(stats.label.length)}\n`);
  process.stdout.write(`  turns:               ${stats.nTurns}\n`);
  process.stdout.write(`  avg total_tokens:    ${fmtNum(stats.avgTotalTokens)}\n`);
  process.stdout.write(`  avg wall_seconds:    ${fmtNum(stats.avgWallSeconds)}\n`);
  process.stdout.write(
    `  signals total:       ${stats.totalSignals} (${
      stats.nTurns === 0 ? "n/a" : (stats.totalSignals / stats.nTurns).toFixed(2)
    } per turn)\n`,
  );
  process.stdout.write(`  uneventful turns:    ${fmtPct(stats.uneventfulRate)}\n`);
  process.stdout.write(`  harness patches:     ${stats.harnessPatchesEmitted}\n`);
  process.stdout.write(`  memory writes:       ${stats.memoryWritesEmitted}\n`);
  if (stats.topSignals.length > 0) {
    process.stdout.write(`  top signal codes:\n`);
    for (const { code, count } of stats.topSignals) {
      process.stdout.write(`    ${count.toString().padStart(3)}× ${code}\n`);
    }
  }
}

function parseArgs(argv: string[]): {
  mode: "all" | "last-vs-prev" | "since";
  last?: number;
  prev?: number;
  since?: string;
  until?: string;
} {
  const result: ReturnType<typeof parseArgs> = { mode: "all" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--last" && argv[i + 1]) {
      result.last = Number.parseInt(argv[i + 1] ?? "", 10);
      result.mode = "last-vs-prev";
      i += 1;
    } else if (arg === "--prev" && argv[i + 1]) {
      result.prev = Number.parseInt(argv[i + 1] ?? "", 10);
      result.mode = "last-vs-prev";
      i += 1;
    } else if (arg === "--since" && argv[i + 1]) {
      result.since = argv[i + 1];
      result.mode = "since";
      i += 1;
    } else if (arg === "--until" && argv[i + 1]) {
      result.until = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

function runLastVsPrev(entries: LedgerEntry[], args: { last?: number; prev?: number }): void {
  const last = args.last ?? 20;
  const prev = args.prev ?? last;
  const lastSlice = entries.slice(-last);
  const prevSlice = entries.slice(-(last + prev), -last);
  printStats(statsFor(prevSlice, `previous ${prev} turns`));
  printStats(statsFor(lastSlice, `last ${last} turns`));
}

function runSince(entries: LedgerEntry[], args: { since?: string; until?: string }): void {
  const cutoff = entries.findIndex((e) => e.harness_sha?.startsWith(args.since ?? ""));
  if (cutoff === -1) {
    process.stderr.write(`No entry found with harness_sha starting with ${args.since}.\n`);
    process.exit(1);
  }
  const before = entries.slice(0, cutoff);
  const untilIdx = args.until
    ? entries.findIndex((e) => e.harness_sha?.startsWith(args.until ?? ""))
    : -1;
  const after = untilIdx >= 0 ? entries.slice(cutoff, untilIdx + 1) : entries.slice(cutoff);
  const afterLabel = args.until ? `${args.since}..${args.until}` : `since ${args.since}`;
  printStats(statsFor(before, `before ${args.since}`));
  printStats(statsFor(after, afterLabel));
}

function runListAll(entries: LedgerEntry[]): void {
  const seen = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const sha = entry.harness_sha ?? "(unknown)";
    if (!seen.has(sha)) seen.set(sha, []);
    seen.get(sha)?.push(entry);
  }
  for (const [sha, slice] of seen.entries()) {
    printStats(statsFor(slice, `harness_sha ${sha.slice(0, 8)} (${slice.length} turns)`));
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const entries = forwardFillHarnessSha(readLedger());

  if (entries.length === 0) {
    process.stderr.write("Ledger is empty.\n");
    process.exit(0);
  }

  process.stdout.write(`A/B comparison across ${entries.length} ledger entries\n`);

  if (args.mode === "last-vs-prev") {
    runLastVsPrev(entries, args);
  } else if (args.mode === "since") {
    runSince(entries, args);
  } else {
    runListAll(entries);
  }
}

main();
