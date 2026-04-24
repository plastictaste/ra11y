# /continue dispatch template

This file is the shared contract every parallel worker receives when `/continue` dispatches them to a worktree-isolated specialist. The dispatch prompt in `SKILL.md` step 2 references this file by path rather than re-embedding the full text — that keeps main-session context lean and the rules in a single source of truth.

Every dispatched specialist MUST read this file on boot and follow every rule below. The backlog item attached to your dispatch prompt is the *scope*; this file is the *shape*.

## 0. STOP — worktree-isolation non-negotiables (read FIRST, before any tool call)

The four load-bearing worktree-isolation rules (relative paths only; no destructive git state; no `cd` out; rebase onto main first) live in `.claude/rules/worktree-discipline.md` and auto-attach for any agent spawned with `isolation: "worktree"`. Read that file in full before any tool call — it is authoritative and this template defers to it.

If rule-file auto-loading does not fire in your environment (older harness, edge config), the orchestrator's dispatch prompt repeats a one-sentence fallback. Either way, the discipline rules are non-negotiable: violating them has caused real integration rollbacks and corrupted sibling worktrees in this codebase (2026-04-22 parser-author escape via absolute paths; 2026-04-23 two stalled agents).

Only after the discipline rules are fully internalized should you read §1 (scope) and the rest of this template.

## 1. Scope-lock

Edit only files listed (or directly implied) by the backlog item:

- the target source file(s) named in the item
- their direct test / snapshot / changelog counterparts
- generated-doc counterparts if the item explicitly invokes a generator

If an edit you think you need falls outside that set, stop and return `blocked` with a one-line reason. Do not "drive-by fix" adjacent code.

## 2. Worktree discipline

Your working tree is a git worktree under `.claude/worktrees/agent-<id>/`. Initial state is clean. The full ruleset lives in `.claude/rules/worktree-discipline.md` (auto-loaded); this section lists only the invariants most often violated in context.

- **No destructive git state; no `cd` out; no absolute paths.** See the rule file.
- **Rebase onto main first.** `git rev-parse HEAD` → `git log --oneline main -5` → `git merge main --ff-only`. If the harness forked the worktree from a stale base (known behavior — occurs when an integrator lands commits mid-session), the expected file may not exist at its relative path. Rebasing makes it appear. If the merge fails, return `blocked: unexpected_worktree_divergence`; if `git log` doesn't show the commits your dispatch prompt implied, return `blocked: git_store_stale`.
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
