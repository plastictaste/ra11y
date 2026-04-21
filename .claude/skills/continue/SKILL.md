---
name: continue
description: Parallel-track dispatcher. Reads .claude/backlog.md, picks the next unchecked item from each of up to 3 active tracks, dispatches them in parallel to specialist subagents, verifies, commits, and checks off. The primary entry point for autonomous ra11y development.
disable-model-invocation: true
allowed-tools: Read Grep Glob Bash(git *) Bash(bun *)
argument-hint: [max-turns]
---

# /continue $ARGUMENTS

Drives ra11y forward by walking the **tracks** in `.claude/backlog.md` and dispatching work to specialist subagents. This is the main session acting as orchestrator in the Orchestrator-Workers pattern (`CLAUDE.md` section 10).

**Subagents cannot spawn subagents, so this skill runs in the main conversation** (not `context: fork`). It uses `disable-model-invocation: true` because it should only run when the user explicitly asks — running it implicitly would be surprising.

## What changed from the old phase-walker

The old `/continue` walked `## Phase N` sections in order, one item at a time. The backlog is now organized as independent **tracks** (D, M, R, F, S, E — see the `Dispatch model` section of `.claude/backlog.md`). Tracks are independent by design: work on one does not block another. `/continue` now **fans out** by picking one open item from each active track and dispatching them in parallel.

## Arguments

- `$1` (optional): maximum number of **turns** to run. Default `10`. Each turn fans out up to 3 agents. Hard cap `10` turns.

## Preconditions

1. Working tree is clean: `git status --porcelain` is empty. If dirty, stop and report — we don't pick up partial state.
2. `bun run verify` passes on current HEAD. If not, the first turn of this run is "fix whatever verify is complaining about" — do not move on until green.
3. `.claude/backlog.md` exists and has at least one `## Track X — …` section with unchecked items.

## Active vs staged tracks

- **Active** (dispatch eligible): tracks flagged in `.claude/backlog.md`'s `Dispatch model` line as active — currently **D, M, R, F**.
- **Staged** (do not dispatch): **S** (MCP sampling) and **E** (ecosystem) are deferred until after v0.2.0 ships. `/continue` ignores their items unless the Dispatch model line is updated to promote them.

## Pre-dispatch planning (step 0 — once per invocation)

Before the turn loop, dispatch the `planner` subagent **once**:

- Pass `{ maxTurns: <$1 or 10>, picksPerTurn: 3 }`.
- It reads `.claude/backlog.md` + `git log --oneline -30`, audits sequencing constraints, pre-classifies each pick to a specialist, and annotates cross-turn file collisions.
- It returns a structured plan (≤80 lines) with `activeTracks`, `stagedTracks`, `turns[]` (each turn: up to 3 `picks` with `item`, `track`, `specialist`, `backlogLine`, `inferredFiles`, `collisionWith`), `deferred[]`, and `blocked[]`.
- Cache the plan in main-session memory for the life of this invocation. **Do not re-read `.claude/backlog.md` during the turn loop** — the plan is authoritative. The only time the backlog file is touched during the loop is by the `integrator` subagent (backlog tickoff at end of each turn), and that happens in a separate context.

If the planner returns zero `turns`, stop and report — all active tracks are either empty, sequencing-blocked, or `[!]`-blocked.

The planner's classification table (for reference when you need to validate a pick):

| Item pattern | Specialist |
|---|---|
| `src/rules/**` | `rule-implementer` |
| `src/standards/**` | `standard-builder` |
| `src/input/parsers/**` | `parser-author` |
| `src/output/formatters/**` | `formatter-author` |
| `src/types/**`, `src/engine/ast-helpers.ts` | `type-smith` |
| `src/mcp/**`, `src/review/finders/**`, `scripts/**`, `.github/workflows/**`, `docs/adr/**`, release/demo/tag | `main-session` |
| `tests/fixtures/real-world/**` | `fixture-curator` |
| `tests/**` (edge/fuzz/property) | `test-author` |
| `docs/**` (user-facing) | `doc-writer` |
| `docs/kb/**` | `spec-researcher` or `/fix-drift` |

## Turn workflow

For each turn in `plan.turns` (up to `$1` or 10, whichever is smaller):

### 1. Read the turn slice from the cached plan

Pull `plan.turns[n]` — the picks are already selected, classified, sequencing-audited, and collision-annotated. Skip picks whose `item` appears in your in-memory "already dispatched this invocation" set (rare — only matters if a turn was reattempted).

If a pick's `collisionWith` is populated, note it for step 2's dispatch prompt.

### 2. Build dispatch prompts (template-referenced)

Every worktree-isolated dispatch prompt has the same shape:

```
You are handling a /continue pick. Read .claude/skills/continue/dispatch-template.md
in full and follow every rule it declares (scope-lock, worktree discipline,
commit discipline, precommit-verify-before-return, structured JSON return).

Backlog item: <pick.item> (line <pick.backlogLine> of .claude/backlog.md — re-read
for full description).

Inferred file scope: <pick.inferredFiles joined>.

<if pick.collisionWith>
Collision note: <pick.collisionWith>. Combine edits with the prior change; never
discard the older side.
</if>

<if specialist-specific>
Specialist guidance: <1-2 pointers to docs/kb/patterns/... or recent ADRs that
govern this decision space>.
</if>
```

That is the whole dispatch prompt. All the anti-stash / scope-lock / JSON-return boilerplate lives in `dispatch-template.md` — the orchestrator does not re-embed it per dispatch. Main-session picks (classified as `main-session`) are handled inline by the orchestrator and do not use this template.

### 3. Dispatch — parallel, worktree-isolated

**Each parallel Agent call MUST pass `isolation: "worktree"`.** This is the single biggest safety lever this skill unlocks; never dispatch parallel work without it.

Why: without isolation, every agent shares the main-session working tree. When agent A finishes its work and tries to commit, it finds dirty WIP from agent B still in the tree — the default reflex is `git stash` to clean-commit, which silently parks B's work. B then returns to a tree it no longer recognizes. We saw this failure mode in production; it created a 78-stash pile of parallel-tree debris and lost agent work. Worktrees make the race impossible.

**Dispatch envelope:**

- Send all 3 Agent calls in a single assistant message with multiple tool-use content blocks — in parallel, not serially.
- Every call to a parallel item uses `isolation: "worktree"`.
- Main-session items (scripts / docs/adr / release) run inline in the shared tree and count toward the 3-call budget. When a main-session item is in-flight, no other parallel Agent may dispatch that turn — the shared tree is not isolated and a parallel worktree-based agent branching from HEAD would miss the main-session's in-flight changes.

Fanout limits — non-negotiable:

- Never more than **3 concurrent** Agent calls in one turn. Keeps the audit log readable and sidesteps rate-limit edge cases.
- Never **two agents on the same track** in the same turn. Within a track, items may touch overlapping files; serializing inside a track avoids merge conflicts.
- Never **two agents touching the same file** in the same turn, regardless of track. Inspect the backlog item's file:line anchor and serialize across turns if file-sets overlap.

### 4. Integrate via the `integrator` subagent

Worktree-isolated agents return `{ path, branch }` (per the Agent tool contract — "if the agent makes no changes the worktree is cleaned up; otherwise path and branch are returned"). The main session is the only party allowed to mutate `main`, but **the orchestrator does not do the integration inline**. Cherry-pick + `bun run verify` + worktree cleanup + backlog tickoff all go through the `integrator` subagent, which swallows 30–50k tokens of tsc/biome/test output per turn and returns a ~40-line structured summary.

**Dispatch rules for the integrator:**

- **Never run `git cherry-pick` or `bun run verify` in the orchestrator during a turn.** If you feel the urge, you are reintroducing the context-bloat failure mode this indirection exists to fix.
- The integrator runs *after* all parallel specialists have returned — it is step 4, not parallel with step 3. You cannot dispatch it in the same message as the specialists; it needs their branches.
- The integrator does not use `isolation: "worktree"` — it must operate on the real `main` to land the picks.
- Only one integrator call per turn. If turn N has 3 picks, they all go in one call.
- Main-session-classified items (scripts / `docs/adr/**` / release) are NOT passed to the integrator — those committed directly on `main` during step 3 and are already landed.

**Input you pass to the integrator:**

    picks = [
      { "item": "D/demo-record",   "branch": "agent-abc123", "path": "...", "changed": true  },
      { "item": "M/tool-baseline", "branch": "agent-def456", "path": "...", "changed": true  },
      { "item": "R/nav",           "branch": "agent-ghi789", "path": "...", "changed": false }
    ]

`changed` reflects whether the specialist's JSON return contained `sha`/`filesChanged` (true) or `blocked` / no-changes (false). If a specialist returned `blocked`, include it in `picks` with `changed: false` — the integrator will record it under `skipped` and remove its worktree if present, but won't cherry-pick anything.

**Cross-turn collision pointer.** If `git log --oneline -20` shows a commit in this `/continue` invocation that touched a file also touched by the current turn's picks, include a one-liner in the integrator prompt: `"Note: commit <sha> already touched <path> earlier in this run; if cherry-pick conflicts, combine enrichments, never discard."`

**Orchestrator handling of the integrator's return:**

| Return | Orchestrator action |
|---|---|
| `verifyOk: true`, items in `integrated` | Log items + SHAs to the turn summary. Loop to next turn. |
| `blocked: [...]` | Record for the final `/continue` report. Items stay unchecked in the backlog; the next `/continue` can retry. |
| `error: "dirty_main"` | Stop the loop. Surface the detail. Do not attempt recovery blindly — investigate manually. |
| `error: "cross_pick_interaction"` | Stop the loop. Report the integrated and remaining lists. The next `/continue` will retry the remaining picks in isolation. |
| `error: "unknown_state"` | Stop the loop. Surface the detail. Never guess-revert — detached HEAD or mid-rebase states need human eyes. |

**What the orchestrator must still do itself** (tiny, cheap, does not leak verify output):

- Track the "picks dispatched this invocation" set so step 1 of the next turn doesn't re-pick them.
- Build the turn summary entry (one line: `turn N: ✓ D/demo-record (a1b2c3d), ✓ M/tool-baseline (b2c3d4e), — R/nav (no changes)`).
- Decide whether to continue to the next turn or stop.

### 5. Loop

Back to step 1. Stop when: `$1`/10 turns used, all active tracks empty, or unrecoverable failure.

## Termination

- Normal: all active tracks empty, or `$1`/10 turns handled.
- BLOCKED: one or more items could not be completed. Report each with the specialist and the error. Continue other tracks.
- Interrupted: user pressed Ctrl-C. Last committed state is always recoverable — subsequent `/continue` picks up where it stopped.

## Reporting

After the loop, output:

```
continue summary
----------------
turns: 4
fanout:
  turn 1: D/demo-record, M/tool-baseline, R/consistent-navigation
  turn 2: D/version-bump, M/tool-scan-diff, F/adr-0006
  turn 3: D/tag-and-publish, M/tool-apply-fix, F/harness-prototype
  turn 4: M/prompt-templates, F/tsx-generics-fixture, F/spa-shell-fixture
completed: 11 items
blocked: (none)
remaining_by_track: D:0 · M:5 · R:2 · F:9 · S:staged · E:staged
next_invocation: /continue (pick up at turn 5)
```

## Safety

- Never rewrite history. Only additive commits.
- Never force-push. Only push if the user explicitly asks.
- Never delete files without a corresponding backlog item asking you to.
- On any uncertainty about an item's scope, skip it and include it in the "blocked" list with a note — don't guess.
- If two items on different tracks would touch the **same file** (rare — flagged by inspecting the item text), serialize them within the turn: dispatch one, wait, then the other. Never race writes to the same file from parallel agents.

Gotchas: see [gotchas.md](gotchas.md).
