# ADR 0027 — Pipelined integrator for /continue

- Status: Proposed
- Date: 2026-04-23
- Supersedes: none
- Superseded by: none
- Related: `.claude/skills/continue/SKILL.md`, `.claude/agents/planner.md`, `.claude/agents/integrator.md`, `.claude/skills/continue/gotchas.md`

## Context

Each `/continue` turn today runs serially: the orchestrator dispatches up to 3 specialists in parallel (step 3), waits for all three to return, then invokes the `integrator` subagent (step 4) to cherry-pick, verify, and tick off the backlog. The integrator is the dominant cost per turn — a full cherry-pick loop + `bun run verify` + worktree cleanup runs 2–5 minutes on a 3-pick turn, during which the specialists for turn N+1 are idle: the orchestrator can't safely dispatch them until it knows which files turn N's cherry-picks touched (worktree bases for N+1 must fork from post-N HEAD, and N+1 file-scope must avoid collisions with what N actually landed).

Observed dead time across the 2026-04-22 five-turn run: ~14 minutes of integrator wall time across five integrations, with specialist dispatch idle for ~75% of that span. On a run sized for the 10-turn cap, integrator-serial cost alone would reach ~25–30 minutes of otherwise-parallelizable work.

Two framings were considered:

**(1) Collapse integration into the orchestrator.** Inline cherry-pick in the main session after specialists return, skip the subagent, overlap verify with turn N+1 dispatch. Rejected: this is exactly the context-bloat failure mode the integrator indirection was introduced to fix — 30–50k tokens of tsc/biome/test output per turn flowing into main-session context, capping `/continue` at 3 turns before context exhaustion (`.claude/agents/integrator.md` "Why this agent exists"). Merging the two problems (integrator context cost + orchestrator serialization) does not solve either.

**(2) Pipelined integrator with speculative next-turn dispatch.** Keep the integrator subagent; dispatch turn N+1's specialists in parallel with turn N's integrator, guarded by safety predicates that guarantee the speculative dispatch is safe to land regardless of turn N's outcome. This is the shape this ADR captures.

## Decision

Add a speculative-dispatch mode to `/continue`:

1. After specialists for turn N return, the orchestrator **simultaneously** (a) dispatches the integrator for turn N and (b) dispatches the specialists for turn N+1, provided the safety predicates below hold. If any predicate fails, fall back to the current serial dispatch (wait for integrator, then dispatch N+1).

2. Turn N+1 specialists run in fresh worktrees forking from the pre-integration `main` HEAD (i.e. the same base turn N's specialists used). This is sound because the safety predicate "zero file-scope overlap across turns N and N+1" means turn N+1's specialists touch files turn N's cherry-picks won't change, so they never need to see post-N state.

3. When the integrator for turn N completes, the orchestrator reaps both results. If turn N integrated cleanly, turn N+1 specialists (still running or already returned) land on the new `main` via a second integrator invocation as usual. If turn N's integration failed, see rollback below.

Safety predicates — ALL must hold, or fall back to serial:

- **Cherry-pick graph clean.** No pick in turn N is annotated with `collisionWith` (intra-plan or cross-commit). Collision resolution may overwrite files in ways the speculative dispatch can't predict.
- **Zero file-scope overlap across turns N and N+1.** Comparing `turn[N].picks[*].inferredFiles` against `turn[N+1].picks[*].inferredFiles`, no file appears in both. If any file does, turn N+1 might edit it on a stale base and conflict at its own cherry-pick time.
- **Both turns are pure worktree picks.** Any main-session-classified pick in either turn (scripts/, docs/adr/, release/) disqualifies speculation — main-session items run inline on the shared tree, breaking the worktree-base invariant.
- **Turn N's verify budget is probably well-bounded.** Heuristic: if turn N's picks inferred files touch `src/engine/**`, `src/types/**`, or `src/input/**`, the integrator's verify pass is likelier to fail, making speculation wasteful. Prefer serial in that case.

## Status

Proposed. No code changes in this ADR; this is the design capture so a future implementation task has a shape to reference. The orchestrator continues to serialize integrator + next-turn dispatch until the implementation task lands.

## Consequences

Expected runtime reduction: 20–30% on 5+ turn runs, approaching the integrator's wall-time share of total loop time. Pure-V-track runs (every pick is a narrow file-scoped fix with no cross-cutting engine changes) should see the upper bound. Mixed D/M/R/F runs with main-session picks see less benefit because main-session picks always force serial fallback.

Rollback path when turn N's integration fails:

1. Turn N+1 specialists have already produced work on branches forked from the pre-N HEAD. Their commits are real but are NOT yet on main.
2. The orchestrator does not silently discard them. It reports the turn-N failure per the existing error-shape rules, records the turn-N+1 branches in its "dispatched-but-not-integrated" set, and stops the loop.
3. The next `/continue` invocation re-reads the backlog via the planner, and turn-N+1's picks are still marked `- [ ]` — they get re-planned. The pre-existing branches from the failed speculation are GC'd via `git worktree remove -f -f` + `git branch -D` as part of the orchestrator's cleanup pass at stop time.

This is intentional: the safety predicates already minimize speculation waste, and the alternative (try to reuse pre-existing branches) pulls the orchestrator into conflict-resolution logic that belongs in the integrator.

Risk surface:

- **Stale worktree bases grow likelier.** Turn N+1 specialists fork from pre-N HEAD; if turn N's integrator lands before they finish, their base is stale by the commits turn N landed. Today's worktree-discipline rule 4 (`git merge main --ff-only` before editing) handles this — a speculative specialist that sees a cleanly-fast-forwarded main on rebase is exactly the case the rule was written for. Violations of rule 4 become 2× likelier; the rule-file auto-load from ADR-adjacent improvement #1 mitigates this.
- **Cross-turn file collisions caught later.** Today's planner catches cross-turn collisions proactively by inspecting `git log --oneline -30`. With speculation, a collision that *would have* been caught by inspecting turn-N's commits (not yet on main at dispatch time) slips past the planner. The safety predicate "zero file-scope overlap across turns N and N+1" is the guard; it's stricter than the current `collisionWith` annotation because it runs at dispatch time, not integrator time.
- **Doubled concurrency during the overlap window.** When turn N's integrator runs in parallel with turn N+1's up-to-3 specialists, the machine sees up to 4 concurrent agents (integrator + 3 specialists). Integrator is I/O-bound (cherry-pick + verify); specialists are agent-call bound. This should not saturate, but monitor on the first few runs.

## Implementation notes

Three components change, in dependency order:

**Planner (`.claude/agents/planner.md`):**

- Emit a new top-level `fileScopeGraph` field alongside `turns[]`. Shape: `{ "turn-N/item-X": ["file1", "file2"], ... }`. Derived from each pick's `inferredFiles`, already computed today. This is just a reshape of existing data so the orchestrator can O(1) check turn-N ↔ turn-N+1 file overlap without re-walking `turns[]`.
- No changes to the per-pick schema beyond what improvement #2 (`backlogSlice`) already landed.

**Orchestrator (`.claude/skills/continue/SKILL.md`):**

- After dispatching turn N's integrator, evaluate the four safety predicates against `turn[N].picks` and `turn[N+1].picks`. If all pass, dispatch turn N+1's specialists **in the same message** as the integrator dispatch. Otherwise, the current serial sequence runs unchanged.
- Track a `speculative: boolean` flag in the turn summary so post-run reporting distinguishes speculative from serial turns. Useful for tuning the predicates.
- On turn-N integrator failure with speculation in flight: wait for turn N+1 specialists to return (they may have produced work), cleanup their worktrees without cherry-picking, report both the N failure and the N+1 picks-not-integrated. Do NOT attempt to integrate N+1 onto the rolled-back state — those picks go back to the planner on next invocation.

**Integrator (`.claude/agents/integrator.md`):**

- Return non-blocking as soon as verify is green and backlog is ticked off. Orchestrator can then proceed to integrate turn N+1 without waiting for worktree cleanup. (Worktree cleanup is the slowest part of the integrator today because `git worktree remove -f -f` blocks on locked worktrees.) This is an additive optimization; the integrator can keep its current behavior if the return timing is hard to restructure.
- No schema changes beyond the tight-return reshape improvement #3 already landed.

Predicate-failure telemetry: the orchestrator logs which predicate disqualified each speculative opportunity in the turn summary. After 3–5 runs, review the distribution and tune — if "heuristic verify budget" fails 80% of turns, the heuristic is too conservative and should move toward inclusive-by-default.

Out of scope for this ADR: pipelining two consecutive integrators (N and N+1 integrator in parallel). Integrators both mutate `main`; they must serialize. Pipelining is strictly specialist-dispatch ↔ integrator overlap.
