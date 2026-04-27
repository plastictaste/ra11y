#!/usr/bin/env bun
// PreToolUse hook for `git commit *`. The actual check sequence is owned
// by `scripts/verify.ts --precommit` (single source of truth — same script
// CI, the `/verify` skill, and `bun run verify:precommit` all call). This
// hook is the event handler that:
//
//   1. Confirms the Bash command is actually `git commit *` (defensive —
//      the settings.json `if` filter should already scope this).
//   2. Greps staged source/test files for backlog IDs (hook-only — needs
//      the staged set, which doesn't exist outside a commit).
//   3. Delegates to `bun scripts/verify.ts --precommit` for the full
//      precommit check set: typecheck, typecheck-tests, lint, the full
//      test suite, zero-deps, network-isolation, cycles, etc. Each check
//      self-skips via its `affectedBy(changed)` predicate when nothing
//      in the diff matches, so narrow commits stay fast.
//   4. Runs `scripts/check-commit.ts` with RA11Y_COMMIT_MESSAGE in env
//      (hook-only — the commit message lives in the Bash command, not
//      on disk, so this can't move into verify.ts).
//
// Never --no-verify. If a check fails, fix the underlying issue.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./lib/audit.ts";
import { readHookInput } from "./lib/input.ts";
import { block, ok } from "./lib/output.ts";
import type { PreToolUseInput } from "./lib/types.ts";

const input = await readHookInput<PreToolUseInput>();
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const rawCommand = typeof input.tool_input.command === "string" ? input.tool_input.command : "";

// Defensive: only run checks when the command is actually a git commit.
// The settings.json `if` filter should already scope this, but if a
// future matcher change sends non-commit Bash through here, we shouldn't
// silently gate every command on the commit pipeline.
if (!/\bgit\s+commit\b/.test(rawCommand)) {
  ok();
  process.exit(0);
}

const stagedFiles = getStagedFiles(projectDir);
const commitMessage = extractCommitMessage(rawCommand);

// Backlog-ID grep across staged source/test files. PM trace (V1-…, Q7-…,
// R/…, P3-…) belongs in commit messages and .claude/backlog.md, not
// committed code where it rots once items get renumbered or closed.
// Hook-only because it operates on the staged set, not the worktree.
const BACKLOG_ID_REGEX =
  /\b(?:V\d+-[A-Z][A-Z0-9_-]+|Q\d+-[A-Z][A-Z0-9_-]+|P\d+-[A-Z][A-Z0-9_-]+|R\/[a-z][a-z0-9-]+)\b/;
const BACKLOG_GREP_SCOPED = /^(src|tests|scripts)\//;
const BACKLOG_GREP_EXTENSIONS = /\.(ts|tsx|cts|mts|js|jsx|html|css|md)$/;
const stagedBacklogTargets = stagedFiles.filter(
  (f) => BACKLOG_GREP_SCOPED.test(f) && BACKLOG_GREP_EXTENSIONS.test(f),
);
const backlogIdHits: Array<{ file: string; line: number; text: string }> = [];
for (const file of stagedBacklogTargets) {
  const abs = join(projectDir, file);
  if (!existsSync(abs)) continue;
  const lines = readFileSync(abs, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = BACKLOG_ID_REGEX.exec(line);
    if (match) {
      backlogIdHits.push({ file, line: i + 1, text: match[0] });
    }
  }
}
if (backlogIdHits.length > 0) {
  audit({
    event: "PreToolUse:git-commit",
    action: "block-backlog-id-in-source",
    detail: { hits: backlogIdHits.slice(0, 10) },
  });
  const lines = backlogIdHits
    .slice(0, 10)
    .map((h) => `  ${h.file}:${h.line}  ${h.text}`)
    .join("\n");
  const more = backlogIdHits.length > 10 ? `\n  ... and ${backlogIdHits.length - 10} more` : "";
  block(
    `pre-commit verification failed — backlog IDs in source/test code (PM trace belongs in commit messages and .claude/backlog.md, not committed code where it rots):\n${lines}${more}\n\nIf the token is genuinely meant as code (rare — e.g. matching against backlog IDs in a tool), confirm by editing the file once more after this rejection.`,
  );
}

const failures: string[] = [];

// Single source of truth for the precommit check sequence. The script
// itself owns scope-filtering via `affectedBy(changed)` predicates, so a
// rule-only commit skips most checks; a docs-only commit skips typecheck,
// test, zero-deps, etc. Spawned via `bun scripts/verify.ts` directly
// rather than `bun run verify:precommit` to avoid the package.json
// script-resolution overhead.
const verify = spawnSync("bun scripts/verify.ts --precommit", {
  cwd: projectDir,
  shell: true,
  encoding: "utf8",
  env: process.env,
});
if (verify.status !== 0) {
  const output = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
  failures.push(`✗ bun scripts/verify.ts --precommit\n${output}`);
}

// Conventional-commit message format check. Hook-only because the
// message lives in the Bash command (-m / heredoc), not on disk —
// scripts/verify.ts has no way to reach it.
if (existsSync(join(projectDir, "scripts", "check-commit.ts"))) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (commitMessage) env.RA11Y_COMMIT_MESSAGE = commitMessage;
  const result = spawnSync("bun scripts/check-commit.ts", {
    cwd: projectDir,
    shell: true,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    failures.push(`✗ scripts/check-commit.ts\n${output}`);
  }
}

if (failures.length > 0) {
  audit({
    event: "PreToolUse:git-commit",
    action: "block",
    detail: { failureCount: failures.length },
  });
  block(
    `pre-commit verification failed — fix these and retry (do NOT --no-verify):\n\n${failures.join("\n\n")}`,
  );
}

audit({ event: "PreToolUse:git-commit", action: "allow" });
ok();

function getStagedFiles(cwd: string): string[] {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Best-effort extraction of the commit message from a `git commit`
 * command. Handles:
 *   - git commit -m "subject"
 *   - git commit -m 'subject'
 *   - git commit --message "subject"
 *   - git commit -m "$(cat <<'EOF' ... EOF)" (heredoc)
 * Returns the message body (first line + rest) or null if no message
 * is embedded inline (e.g., `git commit` with an editor).
 */
function extractCommitMessage(cmd: string): string | null {
  const heredocMatch = /\$\(\s*cat\s+<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*\)/.exec(cmd);
  if (heredocMatch?.[2]) {
    return heredocMatch[2].trim();
  }

  const dq = /(?:^|\s)(?:-m|--message)\s+"([^"\\]*(?:\\.[^"\\]*)*)"/m.exec(cmd);
  if (dq?.[1]) return unescapeShell(dq[1]);

  const sq = /(?:^|\s)(?:-m|--message)\s+'([^']*)'/m.exec(cmd);
  if (sq?.[1]) return sq[1];

  return null;
}

function unescapeShell(s: string): string {
  return s.replace(/\\(["\\$`])/g, "$1");
}
