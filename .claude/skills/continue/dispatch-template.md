# /continue dispatch template

This file is the shared contract every parallel worker receives when `/continue` dispatches them to a worktree-isolated specialist. The dispatch prompt in `SKILL.md` step 2 references this file by path rather than re-embedding the full text — that keeps main-session context lean and the rules in a single source of truth.

Every dispatched specialist MUST read this file on boot and follow every rule below. The backlog item attached to your dispatch prompt is the *scope*; this file is the *shape*.

## 1. Scope-lock

Edit only files listed (or directly implied) by the backlog item:

- the target source file(s) named in the item
- their direct test / snapshot / changelog counterparts
- generated-doc counterparts if the item explicitly invokes a generator

If an edit you think you need falls outside that set, stop and return `blocked` with a one-line reason. Do not "drive-by fix" adjacent code.

## 2. Worktree discipline

Your working tree is a git worktree under `.claude/worktrees/agent-<id>/`. Initial state is clean.

- **Never `git stash`.** If your tree is unexpectedly dirty at start, that is a bug — return `blocked` with `reason: "dirty_worktree_on_boot"`. Do not stash it away.
- **Never `git clean`, `git checkout --`, or `git reset --hard`.** Same rationale. Surface the dirt, don't hide it.
- **Never `cd` out of your worktree.** Scripts like `scripts/scaffold-rule.ts` compute `ROOT` via `import.meta.dir`, so they resolve to whichever tree you're in. `bun scripts/scaffold-rule.ts` run from the worktree root writes into the worktree; `cd /Users/van/dev/ra11y && bun scripts/scaffold-rule.ts` silently writes into the main tree and corrupts parallel peers. The shell starts you in the worktree — stay there.
- **Never use absolute paths in Read/Edit/Write/Bash tool calls.** No `/Users/`, `/tmp/`, `/private/`, `/Volumes/`, `/home/` prefixes. Every path must be relative to `$PWD`. Rationale: `isolation: "worktree"` walls off `cwd` and git state, but an absolute path bypasses that wall — it resolves to the parent checkout. If your file is "missing" at its relative path, that is itself the signal (usually a stale worktree base, see below) — return `blocked` with the relative path that failed. Never retry the same edit with an absolute path; you will silently corrupt `main` and a sibling worktree agent's context.
- **Verify your worktree base before starting work.** First command: `git rev-parse HEAD`. If the orchestrator included an `expectedBase: <sha>` in your dispatch prompt, confirm the shas match; if they don't, return `blocked` with `reason: "stale_worktree_base: HEAD=<actual> expected=<expected>"`. If the orchestrator omitted `expectedBase`, log your HEAD in `notes` for the integrator to cross-check. A stale base means files the current plan assumes exist may not exist in your tree — the failure mode is silent if you just fall back to absolute paths.
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
