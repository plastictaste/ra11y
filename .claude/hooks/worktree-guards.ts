#!/usr/bin/env bun
// PreToolUse + PostToolUse guards that prevent the worktree-escape
// failure modes catalogued in .claude/rules/worktree-discipline.md.
//
// Active only when the tool call's cwd is inside a worktree directory
// (`.claude/worktrees/agent-*`). In the orchestrator's main checkout
// these guards are no-ops, so the same hook can be wired against the
// global Edit|Write|Bash matchers without affecting non-worktree work.
//
// What gets blocked, all from real /continue incidents:
//
//   PreToolUse:
//     - Edit/Write to absolute paths outside the worktree (the agent
//       thinks it's editing its tree; the bytes land on the parent
//       checkout). Rule 1 of worktree-discipline.md.
//     - Bash invoking `git checkout -b`, `git switch -c`, `git stash*`,
//       `cd` to an absolute path outside the worktree, or `git commit
//       --amend`. Rules 2, 3, 5.
//
//   PostToolUse:
//     - Edit/Write that "succeeded" yet left no trace in `git status`.
//       This is the canonical false-`tooling_state_corruption` signature
//       — every "successful" Edit is silently landing on main via an
//       absolute path. Rule 6.
//
// Hooks NEVER block in the main checkout. This avoids interfering with
// orchestrator-level work in the parent repo, where absolute paths and
// branch creation are routine.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { audit } from "./lib/audit.ts";
import { readHookInput } from "./lib/input.ts";
import { block, ok } from "./lib/output.ts";
import type { CommonHookInput, PostToolUseInput, PreToolUseInput } from "./lib/types.ts";

const WORKTREE_PATH_FRAGMENT = "/.claude/worktrees/agent-";

// Path roots that almost always indicate "outside any project worktree."
// macOS, Linux, and common ephemeral mounts. Generic — no per-machine
// tuning. If a user's project lives under one of these (e.g. a custom
// `/home/<user>/...` checkout), the cwd check above already gates: the
// hook only fires when cwd is in a worktree subdir, so the rejection
// only triggers on paths that point OUT of the worktree.
const ABSOLUTE_PATH_PREFIXES = [
  "/Users/",
  "/home/",
  "/root/",
  "/tmp/",
  "/private/",
  "/Volumes/",
  "/mnt/",
  "/opt/",
];

const FORBIDDEN_BASH_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  {
    regex: /\bgit\s+(checkout|switch)\s+-[bB]\b/,
    reason:
      "refusing: creating a new branch (`git checkout -b` / `git switch -c`) inside a worktree leaves the worktree branch unchanged, so the integrator's `git cherry-pick main..<worktree-branch>` finds zero new commits and silently skips the pick. Commit on the branch your worktree starts on.",
  },
  {
    regex: /\bgit\s+stash\b/,
    reason:
      "refusing: `git stash` state is shared across all worktrees in the repo (it lives in the single .git store). A stash-pop here can replay another agent's WIP into your tree. If your tree is unexpectedly dirty at boot, return `blocked: dirty_worktree_on_boot` instead.",
  },
  {
    regex: /\bgit\s+clean\b/,
    reason:
      "refusing: `git clean` deletes untracked files, which may belong to a sibling agent or be the only copy of the orchestrator's recovery scratchpad. Investigate before clearing.",
  },
  {
    regex: /\bgit\s+commit\s+(?:[^-]|-[^-]|--[^n])*--amend/,
    reason:
      "refusing: `git commit --amend` rewrites the previous commit. The integrator's `git cherry-pick main..<branch>` contract assumes append-only commits; amending breaks the cherry-pick range. Make a new commit instead.",
  },
  {
    regex: /\bgit\s+(checkout|reset)\b[^|&;]*--\b/,
    reason:
      "refusing: `git checkout --` and `git reset --hard` destroy uncommitted work. If recovery is needed, return `blocked` and let the orchestrator decide what to preserve.",
  },
  {
    regex: /\bgit\s+reset\s+.*--hard\b/,
    reason:
      "refusing: `git reset --hard` destroys uncommitted work. Return `blocked` and let the orchestrator decide.",
  },
];

const input = await readHookInput<PreToolUseInput | PostToolUseInput>();

if (!isInWorktree(input)) {
  ok();
}

const worktreeRoot = extractWorktreeRoot(input.cwd);

if (input.hook_event_name === "PreToolUse") {
  handlePreToolUse(input as PreToolUseInput, worktreeRoot);
} else if (input.hook_event_name === "PostToolUse") {
  handlePostToolUse(input as PostToolUseInput, worktreeRoot);
}

ok();

function isInWorktree(payload: CommonHookInput): boolean {
  return typeof payload.cwd === "string" && payload.cwd.includes(WORKTREE_PATH_FRAGMENT);
}

function extractWorktreeRoot(cwd: string): string {
  // cwd looks like `<project>/.claude/worktrees/agent-<id>` (or a
  // subdirectory). Trim back to the worktree root so subsequent
  // `git status` runs against the right tree.
  const idx = cwd.indexOf(WORKTREE_PATH_FRAGMENT);
  if (idx < 0) return cwd;
  const tail = cwd.slice(idx + WORKTREE_PATH_FRAGMENT.length);
  const slash = tail.indexOf("/");
  const agentSegment = slash < 0 ? tail : tail.slice(0, slash);
  return `${cwd.slice(0, idx)}${WORKTREE_PATH_FRAGMENT}${agentSegment}`;
}

function handlePreToolUse(payload: PreToolUseInput, worktreeRoot: string): void {
  const tool = payload.tool_name;

  if (tool === "Edit" || tool === "Write") {
    const filePath = String(payload.tool_input.file_path ?? "");
    if (isAbsolutePathOutsideWorktree(filePath, worktreeRoot)) {
      audit({
        event: "PreToolUse:worktree-guard",
        action: "block-absolute-path",
        detail: { tool, file_path: filePath, worktree: worktreeRoot },
      });
      block(
        `refusing: ${tool} on absolute path "${filePath}" from inside worktree "${worktreeRoot}". Absolute paths bypass worktree isolation — the bytes would land on the parent checkout, not your tree. Use a relative path. If the file seems missing at its relative path, that's likely a stale worktree base — return blocked: unexpected_worktree_divergence rather than retrying with an absolute path.`,
      );
    }
  }

  if (tool === "Bash") {
    const command = String(payload.tool_input.command ?? "");
    for (const { regex, reason } of FORBIDDEN_BASH_PATTERNS) {
      if (regex.test(command)) {
        audit({
          event: "PreToolUse:worktree-guard",
          action: "block-bash",
          detail: { command, worktree: worktreeRoot, pattern: regex.source },
        });
        block(reason);
      }
    }

    if (containsCdOutOfWorktree(command, worktreeRoot)) {
      audit({
        event: "PreToolUse:worktree-guard",
        action: "block-cd-out",
        detail: { command, worktree: worktreeRoot },
      });
      block(
        `refusing: \`cd\` out of the worktree corrupts sibling worktrees — scripts that compute their root via \`import.meta.dir\` will resolve to whichever tree the shell is in. Stay in the worktree. If you need to compare against the main checkout, do it from a different terminal, not from your dispatched session.`,
      );
    }
  }
}

function handlePostToolUse(payload: PostToolUseInput, worktreeRoot: string): void {
  const tool = payload.tool_name;
  if (tool !== "Edit" && tool !== "Write") return;

  const filePath = String(payload.tool_input.file_path ?? "");
  if (!filePath) return;
  if (isAbsolutePathOutsideWorktree(filePath, worktreeRoot)) return; // already blocked PreToolUse

  // The Edit/Write claims to have changed `filePath`. If git status in the
  // worktree shows neither that file nor any unstaged change at all,
  // the bytes landed somewhere else — almost certainly via a relative
  // path that resolved against a non-worktree cwd. Surface the
  // mismatch as additionalContext (PostToolUse cannot block) so the
  // agent sees it before its next tool call.
  const status = gitStatusPorcelain(worktreeRoot);
  if (status === null) return; // git not happy — don't second-guess

  if (status.length === 0) {
    audit({
      event: "PostToolUse:worktree-guard",
      action: "warn-clean-after-edit",
      detail: { tool, file_path: filePath, worktree: worktreeRoot },
    });
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `worktree-guard: ${tool} reported success on \`${filePath}\` but \`git status --porcelain\` in worktree \`${worktreeRoot}\` is empty. The bytes did NOT land in this worktree. This is the canonical worktree-escape signature — do NOT diagnose as tool corruption, do NOT retry with absolute paths. Return \`blocked: suspected_worktree_escape\` with the relative paths you tried to edit so the orchestrator can recover the leaked main-tree edits.`,
        },
      })}\n`,
    );
    process.exit(0);
  }

  // If git status has changes but the edited file's basename doesn't appear
  // in any of them, also signal — the edit landed on a different tree but
  // there's pre-existing dirt here.
  const expectedBase = basename(filePath);
  const present = status.some(
    (line) => line.endsWith(`/${expectedBase}`) || line.endsWith(expectedBase),
  );
  if (!present) {
    audit({
      event: "PostToolUse:worktree-guard",
      action: "warn-file-not-in-status",
      detail: { tool, file_path: filePath, worktree: worktreeRoot, status_count: status.length },
    });
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `worktree-guard: ${tool} on \`${filePath}\` claims success but the file does not appear in this worktree's \`git status --porcelain\` output (which has ${status.length} other changed entries). Confirm the edit landed in this tree before continuing — otherwise the bytes leaked to a sibling checkout.`,
        },
      })}\n`,
    );
    process.exit(0);
  }
}

function isAbsolutePathOutsideWorktree(filePath: string, worktreeRoot: string): boolean {
  if (!filePath.startsWith("/")) return false;
  if (filePath.startsWith(worktreeRoot)) return false;
  return ABSOLUTE_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function containsCdOutOfWorktree(command: string, worktreeRoot: string): boolean {
  // Match `cd <path>` where path is absolute. Allow `cd <relative>` and
  // `cd <worktreeRoot>/...` because both stay inside the worktree.
  const matches = command.matchAll(/(?:^|[\s;&|])cd\s+([^\s;&|]+)/g);
  for (const match of matches) {
    const target = match[1];
    if (!target) continue;
    const stripped = target.replace(/^['"]|['"]$/g, "");
    if (!stripped.startsWith("/")) continue;
    if (stripped.startsWith(worktreeRoot)) continue;
    if (ABSOLUTE_PATH_PREFIXES.some((prefix) => stripped.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

function gitStatusPorcelain(cwd: string): string[] | null {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    timeout: 3000,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3))
    .filter((line) => line.length > 0);
}
