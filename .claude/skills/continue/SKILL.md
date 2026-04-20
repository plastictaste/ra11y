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

## Turn workflow

For each turn (up to `$1` or 10, whichever is smaller):

### 1. Select items (pick-one-per-track)

Read `.claude/backlog.md`. For each active track in order (D, M, R, F):

- Find the next unchecked `- [ ]` item in that track's section.
- Skip the item if:
  - A previous turn in this invocation already dispatched it (track its dispatch set in memory).
  - The item has `[!]` — blocked with a note; leave for the user.
  - The track has a **sequencing constraint** and the item's prerequisites aren't done. Sequenced tracks: **F** (ADR → harness prototype → 9 fixtures). For F, skip the fixture items until the ADR + prototype are checked off.
- Stop selecting once you have 3 items, or once all active tracks have been checked.

If zero items are selectable (all active tracks are either empty or sequencing-blocked), stop the loop and report.

### 2. Classify + prepare dispatch prompts

For each selected item, choose the specialist:

| Item pattern | Specialist agent |
|---|---|
| `src/rules/**` or "add rule for wcag22:…" | `rule-implementer` |
| `src/standards/**` or "add standard …" | `standard-builder` |
| `src/input/parsers/**` | `parser-author` |
| `src/output/formatters/**` | `formatter-author` |
| `src/types/**` or `src/engine/ast-helpers.ts` | `type-smith` |
| `src/mcp/**` | main session (no specialist) |
| `src/review/finders/**` | main session |
| `tests/fixtures/real-world/**` | `fixture-curator` |
| `tests/**` (edge cases, fuzz, property) | `test-author` |
| `docs/**` (user-facing) | `doc-writer` |
| `docs/kb/**` | `spec-researcher` (for specs) or `/fix-drift` |
| `scripts/**` | main session |
| `.github/workflows/**` | main session |
| `docs/adr/**` or release / demo / tag | main session |
| anything else | main session with a note in the summary |

Each dispatch prompt includes:

- The backlog item verbatim.
- Pointers to `CLAUDE.md`, relevant `docs/kb/patterns/…`, and recent ADRs that govern the decision space.
- An explicit "commit your own work before returning" instruction (per `CLAUDE.md` §11).
- **Anti-stash rule (non-negotiable):** "Your worktree is isolated — the initial state is clean. Do not run `git stash` for any reason. If you encounter unexpected dirt in your worktree, treat it as a bug: stop and report, do not stash, do not `git clean`, do not `checkout --`. Commit only the changes you authored."
- **Scope-lock rule:** "Edit only files listed in the backlog item and their direct test / snapshot / changelog counterparts. If an edit you think you need falls outside that set, stop and report."

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

### 4. Collect results — serialized integration

Worktree-isolated agents return `{ path, branch }` (per the Agent tool contract — "if the agent makes no changes the worktree is cleaned up; otherwise path and branch are returned"). The main session is the only party allowed to mutate `main`.

Integration loop (serialize, one agent at a time):

1. For each returned `{ branch }` that has commits not on `main`:
   a. `git cherry-pick <branch>` (or `git merge --ff-only <branch>` if the agent branched from the current HEAD and no earlier cherry-pick moved HEAD forward — fast-forward is cleaner when possible).
   b. `bun run verify`. If it fails:
      - If attributable to the just-picked branch, `git reset --hard HEAD~<n>` and mark the item BLOCKED in the turn summary. Do not re-dispatch on this turn — the worktree is gone; re-dispatch on the next turn with the verify output as feedback.
      - If attributable to an earlier pick interacting badly with this one, stop the loop and report. Don't guess-revert.
2. For each worktree whose agent reported "no changes," nothing to integrate.
3. After all branches are integrated and `bun run verify` is green, replace `- [ ]` with `- [x]` on each completed backlog item. Commit: `chore(backlog): check off <short item label>` — one commit per turn, batching all checked-off items.
4. **Never leave worktrees behind.** After integration, if the Agent tool didn't auto-clean, remove worktrees that were merged: `git worktree remove <path>` and `git branch -D <branch>`. If the agent made no changes, the tool already cleaned up.

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
