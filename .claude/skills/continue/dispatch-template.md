# /continue dispatch template

This file is the shared contract every parallel worker receives when `/continue` dispatches them to a worktree-isolated specialist. The dispatch prompt in `SKILL.md` step 2 references this file by path rather than re-embedding the full text — that keeps main-session context lean and the rules in a single source of truth.

Every dispatched specialist MUST read this file on boot and follow every rule below. The backlog item attached to your dispatch prompt is the *scope*; this file is the *shape*.

## 0. STOP — worktree-isolation non-negotiables (read FIRST, before any tool call)

Four rules that break isolation silently, corrupt `main`, and have caused real integration rollbacks in this codebase. Every dispatched agent MUST read these before making ANY tool call:

1. **Never use absolute paths in Read / Edit / Write / Bash tool calls.** NO `/Users/`, `/tmp/`, `/private/`, `/Volumes/`, `/home/` prefixes in ANY `file_path`, Bash command, or shell redirection. Every path must be relative to `$PWD`. `isolation: "worktree"` walls off `cwd` and git state, but absolute paths bypass the wall — the edit silently lands on the parent checkout, not your worktree. If a file is missing at its expected relative path, that is itself the signal — return `blocked` with the relative path. Never retry with an absolute path. This rule is the #1 cause of integration failures; violations have been observed even when documented in §2 (buried). It is here in §0 because position matters — if you skip this rule, you lose your work and corrupt a sibling agent's context.

2. **Never `git stash`, `git stash pop`, `git clean`, `git checkout --`, or `git reset --hard` — ever, for any reason.** `git stash` state is SHARED across all worktrees in a repo because it lives in the single `.git/` store. A stash-pop you run in your worktree can silently replay WIP from a sibling worktree agent, leaving your tree in conflicted state from foreign commits. A stash-push hides YOUR work and may leave the next agent to accidentally pop it. If your tree is unexpectedly dirty at boot, that IS the signal — return `blocked: dirty_worktree_on_boot`. If you need to "compare against a clean baseline" for a lint probe, make a test commit on a throwaway branch instead. There is no legitimate reason for a dispatched agent to touch stash. Violating this rule in turn 5 of this run corrupted an unrelated sibling worktree and required --force recovery.

3. **Never `cd` out of your worktree.** Scripts compute `ROOT` via `import.meta.dir` and resolve to whichever tree the shell is in. `bun scripts/scaffold-rule.ts` from the worktree is safe; `cd /Users/van/dev/ra11y && bun scripts/scaffold-rule.ts` writes to main. The shell starts you in the worktree — stay there.

4. **Catch up to current main BEFORE editing anything.** First three commands, in order:

   ```
   git rev-parse HEAD
   git log --oneline main -5
   git merge main --ff-only
   ```

   The harness may create worktrees from a stale fork-point. If `merge main --ff-only` fails (you've diverged or are ahead of main), return `blocked: unexpected_worktree_divergence`. If it succeeds, proceed. This is the counterpart to rule 1: the absolute-path fallback tempts you ONLY when a file seems missing; rebase first and the temptation disappears.

Only after these four rules are fully internalized should you read §1 (scope) and §2 (worktree discipline — deeper elaboration of the above).

## 1. Scope-lock

Edit only files listed (or directly implied) by the backlog item:

- the target source file(s) named in the item
- their direct test / snapshot / changelog counterparts
- generated-doc counterparts if the item explicitly invokes a generator

If an edit you think you need falls outside that set, stop and return `blocked` with a one-line reason. Do not "drive-by fix" adjacent code.

## 2. Worktree discipline

Your working tree is a git worktree under `.claude/worktrees/agent-<id>/`. Initial state is clean.

- **Never touch stash or destructive git state.** Re-read §0 rule 2 — `git stash`, `git stash pop`, `git clean`, `git checkout --`, `git reset --hard` are all forbidden for any reason. If your tree is unexpectedly dirty at start, return `blocked: dirty_worktree_on_boot` — surface the dirt, don't hide it. Stash state is SHARED across worktrees (single `.git/` store); a stash-pop can replay a sibling's WIP into your tree.
- **Never `cd` out of your worktree.** Scripts like `scripts/scaffold-rule.ts` compute `ROOT` via `import.meta.dir`, so they resolve to whichever tree you're in. `bun scripts/scaffold-rule.ts` run from the worktree root writes into the worktree; `cd /Users/van/dev/ra11y && bun scripts/scaffold-rule.ts` silently writes into the main tree and corrupts parallel peers. The shell starts you in the worktree — stay there.
- **Never use absolute paths in Read/Edit/Write/Bash tool calls.** No `/Users/`, `/tmp/`, `/private/`, `/Volumes/`, `/home/` prefixes. Every path must be relative to `$PWD`. Rationale: `isolation: "worktree"` walls off `cwd` and git state, but an absolute path bypasses that wall — it resolves to the parent checkout. If your file is "missing" at its relative path, that is itself the signal (usually a stale worktree base, see below) — return `blocked` with the relative path that failed. Never retry the same edit with an absolute path; you will silently corrupt `main` and a sibling worktree agent's context.
- **Catch up to current main before starting work.** The harness sometimes creates worktrees from a stale base (known behavior — the worktree-branch fork-point can trail `main` by 1-N commits if an integrator landed commits earlier in the session). First commands, in order:

  ```
  git rev-parse HEAD
  git log --oneline main -5
  git merge main --ff-only
  ```

  - If `git log --oneline main -5` doesn't show commits you expect (based on context the dispatch prompt gave you), your shared git store is broken — return `blocked: git_store_stale`.
  - If `git merge main --ff-only` fails because you're AHEAD of `main` or have diverged, return `blocked: unexpected_worktree_divergence`.
  - If the merge succeeds (or is a no-op because your branch was already at `main`), proceed.

  This is the counterpart to the absolute-path ban: the root cause of the absolute-path escape is usually a stale base — the file the agent needs doesn't exist at the expected relative path *in the worktree* because it was added to `main` after the worktree forked. Rebasing onto `main` upfront eliminates the fallback temptation. Never skip this even if your dispatch prompt didn't explicitly remind you.
- **Never push.** `/continue` is local-only. The release-captain pushes tags.

## 3. Commit your own work

Follow `CLAUDE.md` §9 commit discipline:

- One logical change per commit.
- ≤400 LOC net per commit (split by concern, not by ritual).
- Conventional commit subject: `feat(...)`, `fix(...)`, `test(...)`, `chore(kb):`, etc.
- Never `--amend` a pushed commit. Never `--no-verify`.

Stage files by explicit path (`git add src/rules/foo.ts tests/rules/foo.test.ts`). **Never `git add .` or `git add -A`** — other parallel agents' uncommitted debris may be sitting next to yours on the tree, and bulk-add sweeps it into your commit.

## 4. Precommit verify before returning

After your final commit in the worktree, run:

```bash
bun run verify:precommit
```

If it fails, fix the issue, make another commit, re-run. If you cannot get it green within your scope, return `blocked` with a one-line reason quoting the first failing line of output. **Do not return a `sha` for a worktree where `verify:precommit` is red** — the orchestrator's integrator would cherry-pick red commits onto `main` and discover the regression only after it's landed.

Your worktree is isolated, so the verify output stays in your context, not the orchestrator's. Absorb it and return a clean summary.

## 5. Structured return contract

Return a single JSON block, no prose before or after. The orchestrator does not read prose — long summaries waste context and get truncated.

**Success shape:**

```json
{
  "item": "<backlog label, e.g. R/nav>",
  "branch": "<your worktree branch>",
  "sha": "<HEAD sha after your last commit>",
  "filesChanged": ["path/one", "path/two"],
  "verifyPrecommit": "ok",
  "notes": "<≤2 sentences, optional>"
}
```

**Failure / blocked shape:**

```json
{
  "item": "<backlog label>",
  "blocked": "<≤2 sentences why>"
}
```

Blocked reasons should use a prefix token the orchestrator can grep on: `verify-red: <first failing line>`, `dirty_worktree_on_boot`, `scope_drift: <paths>`, `cherry_pick_conflict: <paths>`, `classification_mismatch: <note>`. Free-form prose is acceptable after the token.

`filesChanged` is the output of `git diff --name-only main...HEAD` on your branch. The integrator uses this to detect cross-pick file collisions in the next turn's dispatch — accurate filesChanged is how the next `/continue` turn avoids re-dispatching a colliding item.
