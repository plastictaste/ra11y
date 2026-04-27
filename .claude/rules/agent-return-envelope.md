---
paths:
  - ".claude/agents/**/*.md"
  - ".claude/skills/continue/**/*.md"
---

# Agent return envelope — signal vocabulary

When you author or edit an agent definition or a `/continue`-orchestrated skill, the return contract is doctrine. Each role already has a tight, role-specific shape — specialists return `{ item, branch, sha, filesChanged, verifyPrecommit }`, the integrator returns `{ integrated, skipped, blocked, verifyOk, errors? }`, the planner returns `{ activeTracks, turns, deferred, blocked }`, reviewers return decision + findings. **Do not wrap these in a uniform envelope.** They were shaped deliberately and a generic wrapper would re-introduce the verbosity each shape was tuned away from.

What this rule formalizes is the *cross-role* contract: how returns expose machine-readable observations the orchestrator and the post-turn meta-reviewer consume mechanically.

## 1. Single JSON block, no prose around it

Every structured agent return is a single JSON code block. No prose before, no prose after, no narration. Reviewers (`code-reviewer`, `a11y-reviewer`) are the documented exception — they emit decision + findings in a documented prose-with-fields shape because their consumer is a human or a generator agent reading findings, not a structural orchestrator. Anything else is JSON-only.

## 2. Signal vocabulary

A **signal** is a `<code>: <evidence>` string the orchestrator (or the meta-reviewer in Phase 1) can grep on. Codes are stable identifiers; evidence is one or two lines of free-form context.

Existing surface locations the vocabulary already lives in:

- **Specialist `blocked` field** (per `dispatch-template.md` §5): `verify-red:`, `dirty_worktree_on_boot`, `scope_drift:`, `cherry_pick_conflict:`, `classification_mismatch:`, `suspected_worktree_escape`, `unexpected_worktree_divergence`, `git_store_stale`, `tooling_state_corruption`.
- **Integrator `errors[]` strings** (per `integrator.md` §6): `dirty_main:`, `cherry_pick_conflict:`, `verify_red:`, `cross_pick_interaction:`, `unknown_state:`, `branch_empty_sibling_has_work:` (when `note` carries the same signal).
- **Specialist returned `branch` mismatch** (per `SKILL.md` §3a): not a string token but a structural signal — when `branch !== worktree-agent-<id>`, the orchestrator records `branch_naming_drift`.
- **Meta-reviewer self-findings** (per `meta-reviewer.md` §3a, §8): `harness_patch_verify_red` (the patch the agent tried to land failed `bun run verify`), `correlated_signals` (a co-occurring pair where one half couldn't be auto-patched and the routing tree escalated). Emitted by the agent into its own `findings[]` for next-turn occurrence-count purposes.

When you add a new agent or extend an existing one, **draw signal codes from the vocabulary above before inventing new ones**. Add new codes to this rule file in the same commit that introduces them — the meta-reviewer's occurrence-count gate keys on stable code identity, and a renamed-without-aliasing token silently breaks the count.

## 3. Optional `signals[]` field

Any agent return MAY include an OPTIONAL top-level field:

```ts
signals?: { code: string, evidence: string }[]
```

Use it when:

- The role-specific shape has no natural slot for a structural observation — e.g. a successful specialist that noticed `dist/` was already stale before its commit, or an integrator that observed an empty branch alongside a sibling carrying the actual commits.
- The observation is relevant to *future* turns, not just this one — single-turn errors stay in the existing `errors[]` / `blocked` slots; cross-turn signals belong in `signals[]`.

Do NOT use it as a synonym for `blocked` or `errors[]`. If the signal is a stop condition, it belongs in the existing failure slot. The whole point of `signals[]` is the **success-with-observation** case the existing slots have no shape for.

`signals[]` is **present-when-meaningful** — omit when empty. Do not emit `signals: []` as a sentinel. (Same rule as `note` and `errors[]` on the integrator: empty means absent, not zero-result.)

## 4. Codes must be stable identifiers, not free-form strings

A code is a snake_case token that survives refactors:

- ✅ `cherry_pick_dropped_commits`
- ✅ `branch_naming_drift`
- ✅ `coverage_md_not_regenerated`
- ❌ `cherry-pick dropped commits` (free prose)
- ❌ `pickDroppedCommits` (camelCase drift)
- ❌ `pick failed at commit a1b2c3d` (evidence smuggled into the code slot)

Evidence goes in the `evidence` field; codes stay alphabet-stable. The meta-reviewer's N≥2 occurrence-count gate (Phase 2) keys on exact code equality across turns — a code that varies in casing or punctuation reads as N distinct codes and never crosses the threshold.

## 5. Cross-role signal channels at a glance

| Role | Failure channel | Success-observation channel |
|---|---|---|
| Specialist (worktree) | `blocked: <code>: <evidence>` | `signals[]` (optional) |
| Integrator | `errors[]` (prefix-token strings) | `note` (≤2 sentences) + `signals[]` (optional) |
| Planner | `blocked[]` per-item `reason` | `signals[]` (optional, e.g. mid-plan structural concerns) |
| Reviewer (code/a11y) | `decision: REJECTED` + `issues[]` | `decision: APPROVED` (no signal channel — reviewers don't observe orchestration) |
| Meta-reviewer (Phase 1) | n/a | `findings[]` (writes to memory / `.claude/rules/`) |

## 6. Why this rule exists (Phase 0 of meta-reviewer rollout)

The post-turn meta-reviewer (planned `.claude/agents/meta-reviewer.md`) compares planner predictions against actual turn outcomes and writes lessons back to harness, memory, or backlog (gated by N≥2 occurrence + portability test). For its analysis to be mechanical rather than NLP-flavored, signal codes must be stable, vocabulary must be shared across roles, and the optional `signals[]` channel must exist for success-with-observation cases the existing failure slots can't carry.

Without this rule, signals proliferate as ad-hoc prefixes scattered across role-specific shapes, the meta-reviewer's grep is unreliable, and the N≥2 occurrence gate flaps on token drift.

## 7. Adoption — additive only

Existing agent definitions are NOT migrated as part of this rule. Specialists, integrator, and planner already emit signals through their existing channels (the prefix-token vocabulary above). Adopt `signals[]` opt-in when:

- A new agent is authored.
- An existing agent's return contract is being touched anyway (don't open the file just to add `signals[]`).
- The meta-reviewer (Phase 1) needs a structural observation no existing channel carries.

The vocabulary is the durable contract; the optional `signals[]` field is the additive surface.
