# ra11y backlog

The `/continue` skill reads this file and dispatches work to specialist subagents. Each item should be small enough that one specialist can finish it in under 20 minutes. When an item would produce more work, split it in place before dispatching.

Legend: `[ ]` open · `[~]` in progress · `[!]` blocked (reason in comment).

Closing an item = deleting its `- [ ] **<ID>**` line in the same commit that lands the work, with a `Closes: <ID>` (or `Drops: <ID>`) trailer in the commit message. The commit body carries the rationale; look it up later via `git log --grep "Closes: <ID>"` or `bun scripts/show-closed.ts <ID>`. See CLAUDE.md §9.7. Only the three states in the legend above are valid; `scripts/check-commit.ts` rejects untrailered deletions and any other state.

---

## Track Q15 — Multi-corpus AI-first sweep (2026-05-02)


---

## Track Q16 — Multi-corpus AI-first sweep (2026-05-05)

Second multi-corpus AI-first sweep on four shape-distinct corpora (CSS-framework distribution with documentation site; static-site-generator with mixed Liquid/ERB templates; vanilla-stack catalog of ~50 sibling demo subdirectories; vendor-template bulk catalog of ~100 sibling subdirectories with extensive duplicated vendor JS/CSS). 54 raw findings → 22 after cross-corpus dedupe → 18 actionable after filtering against existing Track Q15 items.

---

## Track Q17 — Multi-corpus AI-first sweep (2026-05-06)

Third multi-corpus AI-first sweep on four shape-distinct corpora (vendor-heavy CSS framework with SCSS + JS; Ruby static-site generator with template directives; tutorial-style HTML/CSS/JS collection; bulk HTML template catalog with vendor-heavy admin theme). 5 angles per corpus (scan_project / checklist / coverage / suggest_fix / bootstrap+detect_native_wrappers) returning structured JSON. ~80 raw findings → ~14 actionable after dedupe against Q15 + Q16 (the bulk of repeat findings — empty warningsDetails payloads, cross-surface meta drift, truncation reporter overlap, per-finding fixClass-vs-kind drift, severity-vs-conceded-uncertainty — confirmed reproduction on all four corpora and remain captured under the open Q16 items).

---

## Track Q18 — Targeted gap audit (2026-05-07)

Targeted gap audit across `src/mcp/`, `src/reports/`, response-shape sibling files, and the integration test suite — looking for AI-first consumer-doctrine drift not yet captured under Q15/Q16/Q17 and for invariant rules in the doctrine that ship without a pinning integration test. Findings ground out at four shape-level violations (concrete file:line evidence) and two invariant pins (named doctrine rules with no pinning test in `tests/integration/`).

---

## Track V — v1.0.0 readiness

- [~] **V1-CHANGELOG-V1** Draft `## [1.0.0]` entry landed (1d784b7). Date placeholder `YYYY-MM-DD` stays until user says ship. Sections populated: Breaking Changes (exit-code freeze), Added (13 sub-groups), Changed (9 items), Deprecated (2 aliases), Fixed (19 items), Deferred (the four ADR 0018 items). New empty `## [Unreleased]` sits at top. Ready for `/release 1.0.0` when the user triggers.
