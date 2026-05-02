# /continue dispatch template

This file is the shared contract every parallel worker receives when `/continue` dispatches them to a worktree-isolated specialist. The dispatch prompt in `SKILL.md` step 2 references this file by path rather than re-embedding the full text — that keeps main-session context lean and the rules in a single source of truth.

Every dispatched specialist MUST read this file on boot and follow every rule below. The backlog item attached to your dispatch prompt is the *scope*; this file is the *shape*.

## 0. STOP — worktree-isolation non-negotiables (read FIRST, before any tool call)

The load-bearing worktree-isolation rules live in `.claude/rules/worktree-discipline.md` and auto-attach for any agent spawned with `isolation: "worktree"`. Read that file in full before any tool call — it is authoritative and this template defers to it.

If rule-file auto-loading does not fire in your environment (older harness, edge config), the orchestrator's dispatch prompt repeats a one-sentence fallback. Either way, the discipline rules are non-negotiable: violations silently corrupt `main` or sibling worktrees, or cause the integrator to drop your work.

Only after the discipline rules are fully internalized should you read §1 (scope) and the rest of this template.

## 1. Scope-lock

The dispatch prompt carries a `Backlog slice:` block (the verbatim 3–5 lines the planner extracted for this pick) and a `backlogLine: <N>` pointer. The slice is authoritative for scope in the common case — trust it and skip the `.claude/backlog.md` re-read. The pointer is a fallback: re-read `.claude/backlog.md` around the line only if the slice seems ambiguous, incomplete, or references a sibling item the slice didn't include. Don't re-read by default.

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

**Cross-cutting exemption.** If your dispatch prompt flags the pick with `crossCutting: true` (the planner sets this for type-shape cascades, interface widening across a producer-consumer graph, ≥8-file mechanical renames, and similar items where splitting would leave verify red in the middle of the range), the 400-LOC guideline is relaxed to: **split only if splitting keeps verify green at every commit; otherwise one commit is fine.** When you land a single cross-cutting commit above 400 LOC, the commit message body must note the justification — e.g. `"cross-cutting type-shape change; splitting would leave verify red between the types/-change commit and the callers-update commit"`. Don't use the exemption as a license to bundle unrelated changes; the planner's `crossCutting: true` is a scoped permission for this pick only.

**Combine when extending shared registries.** When one dispatch closes 2+ backlog items and BOTH commits would append to the same shared data file (e.g. `src/mcp/warnings.ts` `ScanWarningCode` list, `src/rules/index.ts` registry, `src/engine/rule-aliases.ts` table, a discriminated-union enum, a types union), combine the additions into ONE feat() commit — do NOT split per-item. Cherry-picking sibling commits that both append to the same file produces resolvable but expensive 3-way conflicts (the second commit's diff base mismatches HEAD because the first already touched neighboring lines). The 400-LOC guideline rarely binds when the union is small. Independent of the standard 2-commit feat+chore(kb) split — chore(kb) commits don't conflict because regen overwrites.

Stage files by explicit path (`git add src/rules/foo.ts tests/rules/foo.test.ts`). **Never `git add .` or `git add -A`** — other parallel agents' uncommitted debris may be sitting next to yours on the tree, and bulk-add sweeps it into your commit.

**No backlog IDs in source or test code.** Tokens like `V1-…`, `Q7-…`, `Q3-…`, `R/nav` etc. belong in the commit message and `.claude/backlog.md` — not in source comments, JSDoc, test names, fixture filenames, or `it("…")` strings. PM trace rots in the codebase: items get renumbered, closed, superseded; the comment then misleads. Commit messages and ADRs are the durable trail.

**Tick off your backlog item in the closing commit.** Before returning, your work is not complete unless the `- [ ] **<ID>**` line for the pick is deleted from `.claude/backlog.md` and the closing commit message carries a `Closes: <ID>` (shipped) or `Drops: <ID>` (rejected/superseded) trailer per CLAUDE.md §9 #7. Stage the backlog edit alongside your last logical commit, or in a sibling `chore(backlog):` commit if your feat/fix landed first. Specialists who skip the tickoff force the integrator to do it on their behalf, costing an extra round-trip and burning context. If the worktree-guard hook blocks the edit, return `signals[].code: backlog_tickoff_blocked` with the hook output in `evidence`; do not silently leave the line.

## 4. Precommit verify before returning

After your final commit in the worktree, run:

```bash
bun run verify:precommit
```

**"After your final commit" means the last `git commit` you make before returning — run verify AFTER that commit, not before it.** A common gap: verify passes on state N, then a new file is committed in state N+1, and verify is never re-run on state N+1. The integrator will run full `bun run verify` post-cherry-pick regardless and will catch the regression there, costing an extra round-trip.

If it fails, fix the issue, make another commit, re-run. If you cannot get it green within your scope, return `blocked` with a one-line reason quoting the first failing line of output. **Do not return a `sha` for a worktree where `verify:precommit` is red** — the orchestrator's integrator would cherry-pick red commits onto `main` and discover the regression only after it's landed.

**Timing-flake exemption.** If the only failures are integration tests that time out under concurrent full-verify load but pass when re-run in isolation, treat as a subprocess startup-ordering flake — not a real failure. Re-run `bun run verify:precommit` once alone (no parallel verify in other worktrees) before treating as red. If the isolation retry passes, treat as green and proceed. Signal this in your return as `signals[].code: verify_flaky_mcp_subprocess` with the test names in `evidence`, but do NOT return `blocked`. The integrator has the same exemption at final-verify time; this ensures consistent handling at the specialist pre-commit verify stage too.

**Pre-existing-debt attribution requires concrete evidence.** When a lint, format, or type failure occurs in `verify:precommit`, do NOT claim the failure is pre-existing main debt unless you have verified it with `git show main:<path>` and can cite the exact output confirming the failing lines exist on `main` unmodified. Free-form attestation ("I verified each line exists on main") is not credible evidence and will be re-checked by the integrator's independent verify. If you cannot confirm the failure is pre-existing with a concrete citation, treat it as your own regression and fix it before returning `verifyPrecommit: "ok"`. Emitting a false `signals[].code: verify_red_pre_existing_on_main` claim degrades the integrator's trust calibration; the integrator always re-runs full verify post-cherry-pick regardless.

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
