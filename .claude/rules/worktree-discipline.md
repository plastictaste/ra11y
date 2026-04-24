---
isolation:
  - worktree
---

# Worktree-discipline rules (auto-loaded for `isolation: "worktree"` agents)

You are dispatched inside a git worktree under `.claude/worktrees/agent-<id>/`. The rules below are non-negotiable. Violating any one silently corrupts `main` or a sibling agent's worktree. All four have caused real integration rollbacks in this codebase.

Read every rule before making ANY tool call.

## 1. Never use absolute paths in Read / Edit / Write / Bash tool calls

No `/Users/`, `/tmp/`, `/private/`, `/Volumes/`, `/home/` prefixes in any `file_path`, Bash command, or shell redirection. Every path must be relative to `$PWD`.

`isolation: "worktree"` walls off `cwd` and git state, but absolute paths bypass the wall — the edit silently lands on the parent checkout, not your worktree. No tool error surfaces; the agent thinks it edited its worktree, the edit landed on main.

If a file is missing at its expected relative path, that is itself the signal — almost always a stale worktree base (see rule 4). Return `blocked` with the relative path that failed. **Never retry the same edit with an absolute path.**

## 2. Never touch destructive git state

Forbidden, for any reason: `git stash`, `git stash pop`, `git clean`, `git checkout --`, `git reset --hard`.

`git stash` state is SHARED across all worktrees in a repo because it lives in the single `.git/` store. A stash-pop you run in your worktree can silently replay WIP from a sibling worktree agent, leaving your tree in conflicted state from foreign commits. A stash-push hides YOUR work and may leave the next agent to accidentally pop it.

If your tree is unexpectedly dirty at boot, that IS the signal — return `blocked: dirty_worktree_on_boot`. If you need to compare against a clean baseline for a lint probe, make a test commit on a throwaway branch instead.

## 3. Never `cd` out of your worktree

Scripts like `scripts/scaffold-rule.ts` compute `ROOT` via `import.meta.dir` and resolve to whichever tree the shell is in. `bun scripts/scaffold-rule.ts` from the worktree is safe; `cd /Users/van/dev/ra11y && bun scripts/scaffold-rule.ts` silently writes into the main tree and corrupts parallel peers. The shell starts you in the worktree — stay there.

## 4. Catch up to current main BEFORE editing anything

First three commands of every dispatch, in order:

```bash
git rev-parse HEAD
git log --oneline main -5
git merge main --ff-only
```

The harness may create worktrees from a stale fork-point. If `merge main --ff-only` fails (you've diverged or are ahead of main), return `blocked: unexpected_worktree_divergence`. If `git log --oneline main -5` doesn't show commits you expect, return `blocked: git_store_stale`. If the merge succeeds or is a no-op, proceed.

This is the counterpart to rule 1: the absolute-path fallback tempts you ONLY when a file seems missing; rebasing first makes the missing file appear and the temptation disappears.

## Staging and committing

- Stage files by explicit path (`git add src/rules/foo.ts tests/rules/foo.test.ts`). **Never `git add .` or `git add -A`** — other parallel agents' uncommitted debris may be sitting next to yours on the tree, and bulk-add sweeps it into your commit.
- Never push. `/continue` is local-only. The release-captain pushes tags.
- Never `--amend` a pushed commit. Never `--no-verify`.

## If you only remember one thing

The four rules above protect isolation. The rest (scope-lock, commit-size, verify-before-return, structured JSON return) lives in `.claude/skills/continue/dispatch-template.md`. Read that template too.
