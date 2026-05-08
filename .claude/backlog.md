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

## Track Q19 — Multi-corpus AI-first sweep (2026-05-07)

Fourth multi-corpus AI-first sweep on four shape-distinct corpora (a vendor-heavy CSS framework with SCSS + JS sources; a Ruby static-site generator with mixed template directives; a tutorial-style HTML/CSS/JS collection of standalone lesson folders; a bulk HTML template catalog with vendor-heavy admin theme). 5 angles per corpus (scan_project / checklist / coverage / suggest_fix / bootstrap+detect_native_wrappers) returning structured JSON. ~93 raw findings → 12 actionable after dedupe against open Q16 + Q17 items (the bulk of repeat findings — empty warningsDetails payloads on present-when-meaningful BinaryPresenceMarker codes, cross-surface meta drift, truncation reporter overlap, per-finding fixClass-vs-kind drift, severity-vs-conceded-uncertainty — confirmed reproduction on all four corpora and remain captured under the existing open items).


- [ ] **Q19-SCAN-FILE-LANE-DRIFT-FROM-SCAN-PROJECT** `scan_file` and `scan_project` classify the same vendor file under contradictory lanes on identical input. Canonical case on a vendor-heavy admin template catalog: `scan_project` on the cwd ships `meta.scannedBuildArtifacts.classified[]` listing `adminlte.css` as `definite-vendor-distribution` with findings counted in `plan.fixesByClass.guidance.buildArtifact: 112`; `scan_file` on the same path ships those findings under `plan.fixesByClass.guidance.source: 28, .buildArtifact: 0` — the same file's lane label flips from buildArtifact to source between project-rooted and file-rooted surfaces. An agent calling `scan_file` first on a vendor stylesheet has no signal that the file is vendor (which scan_project would have given). Closure: route `scan_file`'s lane classification through the same shared scope-classifier helper that `scan_project` uses (vendor-distribution / min-infix predicates), so a vendor stylesheet stays buildArtifact-tagged regardless of which tool the agent called. Pin via integration test on identical input: `scanKind` agrees across `scan_project.files[].scanKind` and `scan_file.scanKind` for the same path. Per AI-first doctrine "Per-tool lane and warning-set classification must agree."
- [ ] **Q19-COVERAGE-SCALAR-TWINS-FOUR-PAIRS** Coverage payload ships four scalar pairs that name the same concept twice in two locations: `manualCandidateEmissionsTotal` (top-level) = `summary.actionable.emissionsTotal` (nested); `automatedCriteriaPassRate` (top-level) = `summary.automatedCoverage.automatedCriteriaPassRate` (nested); `untargetedCriteriaForProject` (top-level) = `summary.untargetedCriteriaForProject` (nested); `scanned.{mode,root}` (top-level) = `meta.scanned.{mode,root}` (nested). Reproduces on a tutorial-style JS collection and a bulk admin template catalog. Each scalar pair ships an identical number in both slots, forcing the agent to reconcile silently which is canonical — the cross-field-redundancy axis the sibling-fields rule names. Closure: pick one canonical location per concept (preferred: keep the `summary.*` nested scalars; remove the top-level twins); or rename when the two slots genuinely measure different slices (none of these four pairs do). Pin via integration test: enumerate the four conceptual counters and assert each appears at exactly one location in the coverage response. Per AI-first doctrine "Sibling fields naming the same concept must use one shape."

---

## Track V — v1.0.0 readiness

- [~] **V1-CHANGELOG-V1** Draft `## [1.0.0]` entry landed (1d784b7). Date placeholder `YYYY-MM-DD` stays until user says ship. Sections populated: Breaking Changes (exit-code freeze), Added (13 sub-groups), Changed (9 items), Deprecated (2 aliases), Fixed (19 items), Deferred (the four ADR 0018 items). New empty `## [Unreleased]` sits at top. Ready for `/release 1.0.0` when the user triggers.
