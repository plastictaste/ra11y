# /continue gotchas

Known failure modes and how to avoid them. Update this file whenever an autonomous run surfaces a new issue.

## The specialist returns without committing

Symptom: after a subagent run, `git log` shows no new commits but the working tree has changes.

Fix: every subagent definition includes a commit-discipline section. If a subagent forgot to commit, re-dispatch with "You did not commit. Commit your work per the discipline in your definition and return." Do not commit on their behalf — that loses attribution and masks the bug.

## Backlog items that span phases

Symptom: an item like "adding this rule also requires updating the standards-audit checklist."

Fix: split the item in place before dispatching. Edit `.claude/backlog.md` to insert the missing sub-item, commit, then dispatch.

## Items classified to the wrong specialist

Symptom: `rule-implementer` refuses an item that's actually a types change.

Fix: re-read the item, reclassify, re-dispatch. Do not force a specialist to work outside its remit — the invariants in its definition will reject the work.

## Loop budget exhausted mid-phase

Symptom: hit 20 iterations and the phase isn't done.

Fix: this is normal. Summarize, check in the partial progress, yield. User runs `/continue` again when ready. The next run picks up where this one stopped.

## Verify fails between iterations

Symptom: item N+1 runs on a tree where item N introduced a regression.

Fix: `/continue` always runs `/verify` after every dispatch before checking off and moving on. If an iteration left verify red, the next iteration's first action is to fix it, not to pick up the next backlog item.

## Same item re-dispatched indefinitely

Symptom: re-dispatch loop never converges.

Fix: hard cap of 2 re-dispatches per item. After that, mark the item as BLOCKED in the summary and move on. Never loop forever.

## Worktree agent escapes into the main repo (`cd` OR absolute paths OR stale base)

Symptom: after dispatch, main tree has modifications from the agent even though the agent was in `isolation: "worktree"`. Concurrent agents then see "unexpected dirt" in their worktree starting state and report BLOCKED, OR the main tree collects orphaned files that match one agent's scope but never land on their branch.

Three distinct escape modes — dispatch prompts must prevent all three:

1. **`cd` out of the worktree.** Scripts like `scripts/scaffold-rule.ts` compute `ROOT` via `import.meta.dir` and resolve to the agent's cwd — safe from the worktree, corrupting when run from main. `bun scripts/scaffold-rule.ts` is safe; `cd <repo-root> && bun scripts/scaffold-rule.ts` is the corruption.

2. **Absolute paths in Read/Edit/Write/Bash tool calls.** `Edit` with `<repo-root>/src/mcp/foo.ts` as the target resolves to the main checkout, not the worktree — `isolation: "worktree"` walls off `cwd` and git state, but absolute paths bypass the wall silently. No tool error surfaces; the agent thinks it edited its worktree, the edit landed on main. Seen in the wild 2026-04-21 (/continue turn 2, SCAN-DERIVATIVE): agent couldn't find a file at the worktree-relative path (stale base — see mode 3), fell back to the absolute path, and its "edit" landed on main while its worktree stayed untouched.

3. **Stale worktree base.** The harness may snapshot the worktree base at session start; if an integrator lands commits mid-session, subsequently-dispatched worktrees can still branch from the pre-integration base. Files the current plan assumes exist may not exist in the worktree. Mode 2 then triggers silently — agent falls back to absolute path looking for the missing file. Prevention: agent's first commands rebase onto current main (`git rev-parse HEAD` → `git log --oneline main -5` → `git merge main --ff-only`), per the worktree-discipline rule and `dispatch-template.md` §2. If the merge fails, agent returns `blocked: unexpected_worktree_divergence`; if `git log` doesn't show expected commits, `blocked: git_store_stale`.

Fix (prevention): the load-bearing worktree rules auto-attach from `.claude/rules/worktree-discipline.md` for any agent spawned with `isolation: "worktree"` — covering `cd`-out, absolute paths, and rebase-first. Dispatch prompts include a one-sentence fallback referencing that rule file (per SKILL.md §2's prompt template) so the rules survive harness configurations where rule-file auto-loading doesn't fire.

Fix (recovery): if main tree dirt shows up post-dispatch, integrator's preflight will catch it (`dirty_main` error). Don't try to silently absorb. Orchestrator decides per-file whether to preserve (salvage as scoped commits per `CLAUDE.md` §9) or discard and re-dispatch. If the agent's work was incomplete (killed mid-flight or returned `blocked`), re-dispatch is usually cleaner than curating a partial leak.

## Biome "nested root configuration" lint failure after cherry-pick

Symptom: `bun run verify` passes on the worktree but fails on main with `× Found a nested root configuration, but there's already a root configuration` pointing at `.claude/worktrees/agent-*/biome.json`.

Cause: biome walks the entire repo by default. Worktrees sit under `.claude/worktrees/` inside the main repo's directory tree, so their copies of `biome.json` look like nested root configs to the root biome run.

Fix: **remove worktrees BEFORE running the integration `bun run verify`.** Sequence: cherry-pick → `git worktree remove -f -f <path>` (double `-f` — locked worktrees need override + unlock) → `git branch -D <branch>` → verify. Or add `.claude/worktrees` to biome's ignore list, but removal is cleaner because leftover worktrees are already a lifecycle bug.

## Cross-turn file collision produces cherry-pick conflicts

Symptom: turn N enriched `src/rules/forms/autocomplete-missing.ts` message text; turn N+1 independently rewrote the same message string; cherry-picking turn N+1's branch hits a merge conflict on the exact lines turn N touched.

Cause: selecting "non-overlapping files" at dispatch time only considers the current turn's picks, not prior turns' commits. The worktree branched from HEAD-before-turn-N, so turn N's edits look like new context the turn N+1 agent never saw.

Fix: when picking items, inspect `git log --oneline -20` for commits touching the same file in this invocation. If found, **include a pointer in the dispatch prompt** — "turn {N} (commit {sha}) already touched this file for {reason}; work on top of current HEAD; if your edit collides, combine both enrichments rather than overwriting." This turns a merge-resolve round into a no-op.

Conflicts at cherry-pick time are still recoverable: resolve inline by combining both edits, never by discarding the older one.
