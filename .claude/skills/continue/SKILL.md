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

- `$1` (optional): maximum number of **turns** to run. Default `10`. Each turn fans out up to 3 agents (up to 4 on pure V-track turns — see "Dispatch — parallel, worktree-isolated" § fanout limits). Hard cap `10` turns.

## Preconditions

1. Working tree is clean: `git status --porcelain` is empty. If dirty, stop and report — we don't pick up partial state.
2. `bun run verify` passes on current HEAD. If not, the first turn of this run is "fix whatever verify is complaining about" — do not move on until green.
3. `.claude/backlog.md` exists and has at least one `## Track X — …` section with unchecked items.

## Active vs staged tracks

The `Dispatch model` line in `.claude/backlog.md` is the single source of truth — it names which tracks are dispatch-eligible (Active) and which are deferred (Staged). `/continue` ignores any track not flagged Active on that line. Track letters change as work ships and new tracks open; do not duplicate the list here, read it from the backlog.

## Pre-dispatch planning (step 0 — replan as needed)

Before the turn loop, dispatch the `planner` subagent:

- Pass `{ maxTurns: <$1 or 10>, picksPerTurn: 3, lookaheadTurns: 3 }`.
- It reads `.claude/backlog.md` + `git log --oneline -30`, audits sequencing constraints, pre-classifies each pick to a specialist, and annotates cross-turn file collisions.
- It returns a structured plan with `activeTracks`, `stagedTracks`, `more_available?`, `turns[]` (each turn: up to 3 `picks` with `item`, `track`, `specialist`, `backlogLine`, `inferredFiles`, `collisionWith`), `deferred[]` (capped at 5 entries), and `blocked[]`.
- Cache the plan in main-session memory. **Do not re-read `.claude/backlog.md` during the turn loop** — the plan is authoritative. The only time the backlog file is touched during the loop is by the `integrator` subagent (backlog closure tidy at end of each turn, when needed), and that happens in a separate context.
- **Validate the plan before consuming any turn.** Pipe the planner's JSON return into `bun scripts/check-planner-plan.ts` (or write it to a temp file and pass `--file <path>`). The script catches the deterministic class of planner regression — owner-mapping vs inferredFiles, intra/cross-turn file collisions, picksPerTurn arithmetic, crossCutting allocation, picksPerTurn=4 V-track-only conditions, already-shipped picks (Closes:/Drops: trailers in git), and stale backlogLine pointers. **Exit 1 means the plan is unsafe to dispatch — surface the diagnostics and replan once before falling back to the user.** Keep the prompt rules in `.claude/agents/planner.md` for the judgment-driven shape; the script enforces only what is provable from the plan + git + backlog.
- **Replan when the cached slice is exhausted.** When you've consumed all of `plan.turns[]` and `plan.more_available === true` and the invocation still has turn budget, re-invoke the planner with `lookaheadTurns: 3`. The fresh slice picks up where the prior one ended (the planner re-grep on `- [ ]` lines naturally excludes items closed by Closes-trailer commits earlier this run). Replanning is cheap; over-planning a 10-turn slice that the run never reaches is not.

If the planner returns zero `turns`, stop and report — all active tracks are either empty, sequencing-blocked, or `[!]`-blocked.

The planner's classification table (for reference when you need to validate a pick):

| Item pattern | Specialist |
|---|---|
| `src/rules/**` | `rule-implementer` |
| `src/standards/**` | `standard-builder` |
| `src/input/parsers/**` | `parser-author` |
| `src/output/formatters/**` | `formatter-author` |
| `src/types/**`, `src/engine/ast-helpers.ts` | `type-smith` |
| `src/mcp/**`, `src/review/finders/**` | `general-purpose` (worktree-isolated; empirical 2026-04-26 — narrow tool-shape and finder-predicate fixes parallelize cleanly when file-sets don't overlap) |
| `scripts/**`, `.github/workflows/**`, `docs/adr/**`, release/demo/tag | `main-session` |
| `tests/fixtures/real-world/**` | `fixture-curator` |
| `tests/**` (edge/fuzz/property) | `test-author` |
| `docs/**` (user-facing) | `doc-writer` |
| `docs/kb/**` | `spec-researcher` or `/fix-drift` |

## Turn workflow

For each turn in `plan.turns` (up to `$1` or 10, whichever is smaller):

### 1. Read the turn slice from the cached plan

Pull `plan.turns[n]` — the picks are already selected, classified, sequencing-audited, and collision-annotated. Skip picks whose `item` appears in your in-memory "already dispatched this invocation" set (rare — only matters if a turn was reattempted).

If a pick's `collisionWith` is populated, note it for step 2's dispatch prompt.

### 2. Build dispatch prompts (rule-file auto-load + one-sentence fallback)

Every worktree-isolated dispatch prompt has the same shape:

```
You are handling a /continue pick. Read .claude/skills/continue/dispatch-template.md
in full and follow every rule it declares (scope-lock, commit discipline,
precommit-verify-before-return, structured JSON return).

Worktree-discipline rules auto-load from .claude/rules/worktree-discipline.md
(relative paths only; no stash/reset/checkout --; no `cd` out; rebase onto main
first). If that rule file does not auto-load in your environment, read it
explicitly before any tool call.

Backlog item: <pick.item> (line <pick.backlogLine> of .claude/backlog.md — slice
attached below; re-read the file only if the slice seems incomplete).

Backlog slice:
<pick.backlogSlice verbatim>

Inferred file scope: <pick.inferredFiles joined>.

<if pick.collisionWith>
Collision note: <pick.collisionWith>. Combine edits with the prior change; never
discard the older side.
</if>

<if specialist-specific>
Specialist guidance: <≤5 lines, only what is specific to this pick — pointers
to docs/kb/patterns/... or recent ADRs, predicate-strength gotchas, the
canonical regression case. Never restate commit discipline, scope-lock,
verify-before-return, structured-JSON-return, or worktree rules — those auto-
load from CLAUDE.md, dispatch-template.md, and worktree-discipline.md, and
duplicating them inflates every dispatch prompt without value>.
</if>
```

The worktree-discipline rules live in `.claude/rules/worktree-discipline.md` and
are frontmatter-scoped to auto-attach for any agent spawned with
`isolation: "worktree"`. That keeps the dispatch prompt slim without sacrificing
the load-bearing rules that field tests (2026-04-22 parser-author escape via
absolute paths into `src/input/parsers/html.ts`; 2026-04-23 two stalled agents)
proved are non-optional.

The one-sentence fallback inside the prompt body is intentional: rule-file
auto-loading depends on the harness honoring the frontmatter scope, and if the
orchestrator runs in an older harness or an edge config, the fallback is what
keeps the agent from defaulting back to absolute paths. If you see evidence an
agent ignored the rule file, broaden the fallback back to a multi-line reminder
for the next dispatch.

The rest of the scope-lock / JSON-return boilerplate lives in
`dispatch-template.md` — the orchestrator does not re-embed it per dispatch.
Main-session picks (classified as `main-session`) are handled inline by the
orchestrator and do not use this template.

### 3. Dispatch — parallel, worktree-isolated

**Each parallel Agent call MUST pass `isolation: "worktree"`.** This is the single biggest safety lever this skill unlocks; never dispatch parallel work without it.

Why: without isolation, every agent shares the main-session working tree. When agent A finishes its work and tries to commit, it finds dirty WIP from agent B still in the tree — the default reflex is `git stash` to clean-commit, which silently parks B's work. B then returns to a tree it no longer recognizes. We saw this failure mode in production; it created a 78-stash pile of parallel-tree debris and lost agent work. Worktrees make the race impossible.

**Dispatch envelope:**

- **Send EVERY Agent call for the turn in ONE assistant message with multiple tool-use content blocks.** Sending pick 1 alone, then picks 2+3 together, then continuing is the canonical orchestration error — Agent calls in successive messages execute serially, doubling wall time. The 2026-04-29 turn 1 lost ~16 min to a one-message slip; prior runs lost more. Before pressing send on the first Agent call, audit: are all parallel-eligible picks of this turn included? If not, add them. The only Agent calls that legitimately run on their own message are (a) the integrator (step 4, after all specialists return) and (b) a single redispatched stalled pick (step 3a, after stall detection).
- Every call to a parallel item uses `isolation: "worktree"`.
- Main-session items (scripts / docs/adr / release) run inline in the shared tree and count toward the 3-call budget. When a main-session item is in-flight, no other parallel Agent may dispatch that turn — the shared tree is not isolated and a parallel worktree-based agent branching from HEAD would miss the main-session's in-flight changes.

Fanout limits — non-negotiable:

- **Default: max 3 concurrent** Agent calls in one turn. Keeps the audit log readable and sidesteps rate-limit edge cases.
- **Exception: max 4 concurrent on pure V-track turns.** When every pick in the turn is classified as V-track (narrow, file-scoped fixes — typically `rule-implementer`, `fixture-curator`, `test-author`, `formatter-author`, `parser-author`) AND every pick's `inferredFiles` is non-overlapping with every other pick in the turn AND no pick is classified as `main-session`, the planner may emit `picksPerTurn: 4` for that turn and the orchestrator dispatches 4 in parallel. The extra concurrency earns its keep only when all three conditions hold; even one `main-session` or shared-file pick in the turn drops the cap back to 3. This is a soft rule in the skill, not enforced by tooling — if the heuristic produces bad turns in the field, tighten the conditions rather than ripping the exception out.
- Never **two agents on the same track** in the same turn. Within a track, items may touch overlapping files; serializing inside a track avoids merge conflicts.
- Never **two agents touching the same file** in the same turn, regardless of track. Inspect the backlog item's file:line anchor and serialize across turns if file-sets overlap.

### 3a. Stall handling (new — 2026-04-23)

The 2026-04-23 five-turn run lost two agents to silent stalls (specialist returned without structured JSON; another returned with empty `filesChanged` after unexpectedly long wall time). Neither stall was cleanly detectable from the Agent tool's return shape alone — they required per-turn recognition and a one-shot redispatch.

Full automated stall polling needs a harness-level capability outside the Agent tool and is deferred to a future ADR. In the meantime, the orchestrator applies this in-skill heuristic **after** step 3's parallel dispatch returns, **before** invoking the integrator in step 4:

For each returned agent, treat the pick as a suspected stall if ANY of these cues fire:

- `changed: false` AND the agent's wall time exceeded ~5 minutes (stalls usually burn budget before returning empty)
- Return lacked structured JSON (free-form prose, truncated output, missing `sha`/`item`/`blocked` top-level keys)
- Return surfaced `internal-error` / tool-result error from the harness rather than an agent-authored payload
- Evidence of worktree-escape recovery in the agent's output (e.g. the agent mentioned restoring a tracked file on main, or `git status` dirt the dispatch prompt couldn't explain)
- Returned `branch` differs from the `worktree-agent-<id>` branch the harness assigned (specialist created a custom branch). The integrator will look at the wrong branch and silently skip the pick. When the returned `branch` doesn't match the worktree branch, do not redispatch — pass the actual returned branch name straight to the integrator.
- `blocked` reason is `tooling_state_corruption`, `edit_tool_silent_failure`, `disk_writes_unflushed`, or any similar self-diagnosis that blames the tooling. Combined with main being unexpectedly dirty (especially in files the agent listed as its scope), this is the canonical false-diagnosis-on-escape pattern. Treat as a worktree escape: redispatch in a fresh worktree, then `git restore` the leaked main edits after the redispatch's branch is verified.

Action when any cue fires:

1. Treat the pick as NOT integrated this turn. Do NOT pass it to the integrator with `changed: true` — that would cherry-pick phantom work.
2. Offer to **redispatch the pick once** in a fresh worktree. Redispatch uses the same prompt template, same specialist, same `backlogSlice`. The fresh worktree gets a new branch name; the stalled one's branch and worktree are cleaned up as part of the integrator's step-3 worktree-removal pass.
3. Cap redispatches at **1 per pick per `/continue` invocation.** If the redispatch also stalls, record the pick under `blocked` in the turn summary with reason `"stall: redispatch also failed"` and move on. Do not loop.
4. The redispatched agent runs in parallel with the surviving picks' integrator call, NOT with the current turn's other specialists — the dispatch order is: original parallel batch → stall detection → integrator(survivors) + redispatched-pick. On the next turn boundary, the redispatched pick's return is treated as a normal pick in turn N+1's integration.

Recognition cues are deliberately manual — the orchestrator reads each returned payload and decides. Don't try to encode the cues as regex or schema checks here; the false-positive cost (redispatching a clean `blocked` return) is worse than the current-turn skip. Full automated polling is tracked as a future ADR candidate.

### 4. Integrate via the `integrator` subagent

Worktree-isolated agents return `{ path, branch }` (per the Agent tool contract — "if the agent makes no changes the worktree is cleaned up; otherwise path and branch are returned"). The main session is the only party allowed to mutate `main`, but **the orchestrator does not do the integration inline**. Cherry-pick + `bun run verify` + worktree cleanup + backlog closure tidy (when needed) all go through the `integrator` subagent, which swallows 30–50k tokens of tsc/biome/test output per turn and returns a ~6–10 line structured summary (tight shape; with-note and error shapes stay under ~20 lines).

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

The integrator returns a tight `{ integrated, skipped, blocked, verifyOk, backlogCommitSha, note?, errors? }` shape. Per-entry payload is `{ item, sha }` — no per-entry `reason` field. Stops surface via top-level `errors[]` with grep-able prefix tokens.

| Return | Orchestrator action |
|---|---|
| `verifyOk: true`, items in `integrated`, no `errors` | Log items + SHAs to the turn summary. Loop to next turn. |
| `verifyOk: true`, `blocked: [...]` non-empty | Record the blocked items for the final `/continue` report. Items stay unchecked in the backlog; the next `/continue` can retry. |
| `verifyOk: true`, `note: "..."` present | Log the note alongside the turn summary — it usually describes a resolved conflict or an unexpected-but-recoverable state worth carrying forward. |
| `verifyOk: false`, `errors[]` starts with `"dirty_main:"` | Stop the loop. Surface the error text. Do not attempt recovery blindly — investigate manually. |
| `verifyOk: false`, `errors[]` starts with `"cross_pick_interaction:"` | Stop the loop. Report the `integrated` and `blocked` lists. The next `/continue` will retry the remaining picks in isolation. |
| `verifyOk: false`, `errors[]` starts with `"unknown_state:"` | Stop the loop. Surface the error text. Never guess-revert — detached HEAD or mid-rebase states need human eyes. |
| `verifyOk: false`, `errors[]` starts with `"verify_red:"` or `"cherry_pick_conflict:"` | The integrator already reverted and recorded the offending pick under `blocked`. If other picks `integrated` cleanly, keep going. |

**What the orchestrator must still do itself** (tiny, cheap, does not leak verify output):

- Track the "picks dispatched this invocation" set so step 1 of the next turn doesn't re-pick them.
- Build the turn summary entry (one line: `turn N: ✓ D/demo-record (a1b2c3d), ✓ M/tool-baseline (b2c3d4e), — R/nav (no changes)`).
- Decide whether to continue to the next turn or stop.

### 4a. Post-turn meta-review

After the integrator returns and before looping, dispatch the `meta-reviewer` subagent **once** with the turn artifact. Its job is to compare what the planner predicted to what actually happened, extract signals from the structured returns, and write durable lessons back — to memory for single-incident observations or to a small allowlist of harness files for recurring patterns (gated by N≥2 occurrences within the last 20 turns plus a portability test).

**Foreground, not background.** The meta-reviewer auto-commits harness patches as `chore(meta):` commits on `main`. Dispatching it in the background would race the next turn's specialist worktrees against an in-flight commit; foreground keeps the turn ordering clean. The agent is fast (read ledger, extract signals, decide, write 0–1 commits, return).

**Input you pass to the meta-reviewer:**

```json
{
  "turn_n": <N>,
  "invocation_id": "<uuid for this /continue run>",
  "ts_start": "<ISO timestamp at turn start>",
  "ts_end":   "<ISO timestamp now>",
  "main_sha_before": "<sha at turn start>",
  "main_sha_after":  "<sha after integrator's closure tidy commit (or last cherry-pick if no tidy was needed)>",
  "harness_sha": "<sha of HEAD at turn start — same as main_sha_before in the common case>",
  "planner_picks": <plan.turns[N-1].picks verbatim>,
  "specialist_returns": [
    { "branch_assigned": "<worktree-agent-X>",
      "branch_returned": "<the branch the specialist actually returned>",
      "wall_time_seconds": <int>,
      "total_tokens": <int — from the agent return envelope when present>,
      "return": <the specialist's JSON return verbatim> }
  ],
  "integrator_return": <the integrator's JSON return verbatim>,
  "turn_cost": { "total_tokens": <sum across all dispatched agents>, "wall_seconds": <ts_end - ts_start> }
}
```

`main_sha_before` is the SHA on `main` when this turn started (cache it before step 3); `main_sha_after` is the SHA after the integrator's last commit on this turn (the closure tidy commit if one was needed, else the final cherry-pick). The agent uses the range to detect cherry-pick drops and coverage-regen misses. `harness_sha` is `main_sha_before` in the common case (every harness file is committed); the meta-reviewer persists it on each ledger entry so `scripts/ab-compare-harness.ts` can group runs by harness state for token-cost A/B comparison.

`total_tokens` per specialist and `turn_cost` are **present-when-meaningful**: forward them when the agent harness reported `total_tokens` in the return envelope (Bun harness does — look for `<usage>total_tokens: ...</usage>` or the equivalent structured field on each Agent return). Omit the keys entirely when unavailable — the meta-reviewer's cost-aware signals (`high_cost_uneventful_turn`, `slow_specialist`) skip cleanly when fields are absent.

**Orchestrator handling of the meta-reviewer's return:**

The agent returns `{ turn_n, signals_observed, writes: { memory, harness, memory_retired, backlog_reopens }, correlations?, patch_effects?, findings, ledger_appended }`.

| Return | Orchestrator action |
|---|---|
| `signals_observed: 0`, `writes: { all empty }`, `findings: []` | Nothing to do. Append nothing to the user-facing turn summary. |
| `writes.harness[]` non-empty | Note the patch SHA(s) in the turn summary so the user sees the auto-edit landed. Continue. |
| `writes.memory[]` non-empty | No action — memory is silent by design. |
| `writes.memory_retired[]` non-empty | No action — informational. The retired memory files are recorded per-machine in the ledger; the durable cross-machine reference is the harness patch SHA in the same turn. |
| `writes.backlog_reopens[]` non-empty | The pick was reopened. Treat as if it had returned `blocked` for purposes of the "picks dispatched this invocation" set so it can be re-picked next invocation. |
| `correlations[]` non-empty | No action — informational. The pair is recorded in the ledger so next turn's meta-reviewer can decide whether to bundle a patch or escalate the unaddressed half. |
| `patch_effects[]` contains `verdict: "no_effect"` | Note the no-effect commit SHA and the original patch SHA in the turn summary. Surface in the final `/continue` report so the user sees which auto-patches earned a `git revert` review. |
| `patch_effects[]` only carries `"too_early"` / `"effective"` / `"inconclusive"` / `"aged_out"` / `"user_reverted"` | No action — informational; the verdicts live in the ledger and shape next-turn routing. |
| `findings[].kind: "structural_flag"` | Surface in the final `/continue` report (not the per-turn summary) so the user sees the structural concern at end-of-run. |
| `findings[].kind: "skill_patch_proposal"` | Surface in the final `/continue` report verbatim — including the `target`, `rationale`, `proposed_change` diff text, and `rule_patch_sha`. Frame as "user approval needed: a rule-file patch (sha X) earned `no_effect`; the meta-reviewer proposes promoting enforcement to `<target>`." Do NOT auto-apply — the meta-reviewer's allowlist explicitly forbids skill-file edits, and the orchestrator must respect that boundary. The user reviews and decides whether to apply manually. |
| `ledger_appended: false` | Surface in the per-turn summary as a warning. The next turn's occurrence counts will be off until the ledger is repaired. |

**Do not block the loop on the meta-reviewer.** If the agent returns `findings[]` with structural concerns or `ledger_appended: false`, log them and continue to the next turn. The meta-reviewer is advisory; only an explicit user-blocking item from a structural flag (rare) stops the loop.

**Skip the meta-reviewer when** the integrator returned `verifyOk: false` and main is in a partial state — the loop is stopping anyway, signals from a half-integrated turn are unreliable, and the orchestrator should prioritize surfacing the integrator's error to the user.

**Skip the meta-reviewer on uneventful turns to control invocation token cost.** Skip when ALL of these hold: `integrator.verifyOk === true`, `integrator.skipped` and `integrator.blocked` are both empty, every specialist's `signals[]` array is either empty OR contains only codes from the **lock-out set** (defined below), no specialist returned `branch_returned !== branch_assigned`, no agent stalled (per §3a), and the turn count since the last meta-review is `< 3`. **Force a meta-review every 3rd turn regardless** so slow-burn correlated patterns still surface in the ledger. This early-out only suppresses the call when the turn carried no observation worth correlating — the value of the agent is its cross-turn pattern detection, and three clean turns in a row carry exactly zero new evidence per turn. Track the "turns since last meta-review" counter in main-session memory alongside the dispatched-picks set.

**Lock-out set** (signals whose harness patches have already earned `no_effect` and where re-running the meta-reviewer cannot produce a new patch): currently empty. When the only signals on a turn are from this set, the meta-reviewer would re-issue the same structural flag with no new action — its overhead (~80–100k tokens) is wasted. Removal from the lock-out set requires either (a) the meta-reviewer's own log marking the structural flag resolved, or (b) a successful source-level fix (e.g. ADR-driven test deflake) that returns the signal's recurrence rate to baseline. Until then, treat the lock-out as authoritative — the lesson is durable in the ledger; the agent is paged only when something new is observable.

### 5. Loop

Back to step 1. Stop when: `$1`/10 turns used, all active tracks empty, or unrecoverable failure.

**Slice exhaustion is NOT a stop condition.** When you've consumed every turn in the cached `plan.turns[]` but `plan.more_available === true` and turn budget remains, re-invoke the planner per step 0 ("Replan as needed") with `lookaheadTurns: 3` and continue. The planner ships a 3-turn lookahead by design to keep step 0 cheap; the cache ending means refresh the plan, not end the run. The 2026-04-30 run stopped at 3/15 turns by pattern-matching slice exhaustion to "all active tracks empty" while the planner had `more_available: true` and ~22 open Q14 items plus 3 explicitly deferred picks. Before stopping, audit: is the planner saying `more_available: true`? Are active tracks actually empty per the dashboard line, or just empty in the current cached slice? If unsure, replan — replanning is cheap; over-stopping leaks user-visible turn budget.

## Termination

- Normal: all active tracks empty (verified by the planner returning zero `turns` AND `more_available: false` on a fresh replan), or `$1`/10 turns handled.
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
