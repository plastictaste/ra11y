# ra11y backlog

The `/continue` skill reads this file and dispatches work to specialist subagents. Each item should be small enough that one specialist can finish it in under 20 minutes. When an item would produce more work, split it in place before dispatching.

Legend: `[ ]` open · `[~]` in progress · `[!]` blocked (reason in comment).

Closing an item = deleting its `- [ ] **<ID>**` line in the same commit that lands the work, with a `Closes: <ID>` (or `Drops: <ID>`) trailer in the commit message. The commit body carries the rationale; look it up later via `git log --grep "Closes: <ID>"` or `bun scripts/show-closed.ts <ID>`. See CLAUDE.md §9.7. The `[x]` state no longer exists — `scripts/check-commit.ts` rejects both untrailered deletions and `[x]` additions.

## Ship state

- **v0.1.0 — ready to tag.** Code-complete: 54 rules, 4 standards, 9 formatters, 10 MCP tools, 4 reports, CLI wired, release workflow configured. Remaining work is the demo + the tag + publish (Track D).
- **v0.2.0 — in flight.** MCP hardening (Track M), review-candidate coverage + focus-ring cross-ref (Track R), real-world fixture corpus (Track F). Target: 3–4 weeks post-0.1.0.
- **v0.3.0+ — staged, not started.** MCP sampling (Track S), ecosystem integrations + public benchmark (Track E). Phase 20 work is deliberately deferred until after 0.2.0 ships and user feedback tells us which sampling-backed tool matters most. See ADR 0005 for the sampling architecture.
- **v1.0.0 — readiness (Track V).** Conformance capstone work is done in Track C. Remaining v1.0 gates: (a) five **detection gaps** — alt-text walker scope (SVG image / role=img / canvas), button-name SVG `<title>` traversal, `<input type="image">` title recognition, contenteditable labels, `background-image` contrast surfacing; (b) nine **shape-honesty null sentinels** to conditional-spread; (c) eleven **fix-suggestion context-aware rewrites** (V1-FIX-AUDIT `[~]` acceptance gate); (d) **KB final sweep** to drain `GUIDANCE_BY_ID`; (e) **V1-CHANGELOG-V1** date-stamp on ship; (f) **V1-REGISTRY-AGGREGATE** layer-boundary hardening so ADR 0019's frozen `defineRule`/`defineStandard`/`defineCandidateFinder` exports function end-to-end instead of shipping as inert type-inference stubs (ADR 0022); (g) **V1-RESPONSE-ASSEMBLER** scan-family MCP response-shape seam so the AI-first consumer doctrine is enforced by one assembler call rather than 24 hand-rolled handlers before v1.0 freezes the shape (ADR 0024, proposed).

## Dispatch model (parallel tracks, not sequential phases)

Tracks below are independent. `/continue` picks the next open item from each of up to 3 active tracks per turn and dispatches them in parallel (details in `.claude/skills/continue/SKILL.md`). Within a track, items run in order — some tracks have sequencing; cross-track work is always parallelizable.

Active tracks: **Q4** (static-site-generator field test) · **Q5** (vanilla HTML/CSS/JS field test) · **Q6** (bulk-template field test) · **Q7** (multi-repo OSS field test) · **Q8b** (agent-consumer round, 2026-04-25 second pass) · **Q8c** (agent-consumer round, 2026-04-25 third pass) · **Q9** (multi-corpus AI-first sweep 2026-04-25 evening) · **Q10** (multi-corpus AI-first sweep 2026-04-26) · **Q11** (multi-corpus AI-first sweep 2026-04-26 round 2) · **Q12** (multi-corpus AI-first sweep 2026-04-26 round 3) · **V** (v1.0.0 readiness). Tracks **D**/**M**/**R**/**F**/**S**/**E** retired 2026-04-26 (no open items). Tracks Q (rounds 1-2), Q2, Q3, Q8 closed.

Staged tracks: **C** (conformance-claim gaps — v0.3.0 foundation + v1.0.0 capstone). Tracks S and E were promoted on 2026-04-17 after the user directed "go all the way without releasing until finalized" — M/R/F are complete, so the remaining pre-release work spans S and E. ADR 0005 §Follow-up work still applies to the speculative tool choices inside S; foundation items (sampling.ts, capability, prompt library, KB docs) are safe to build.

Track Q was added on 2026-04-17 in response to a 10-agent independent eval brief — MCP shape honesty + silent-failure elimination, all derived from real consumer pain on an external React codebase.

Track C was added on 2026-04-17 from a gap analysis on "what's missing to let an agent fully claim WCAG 2.1 AA." Four gaps: runtime-evidence ingest, attestation ledger, process-level scope, conformance statement. None widen detection (no new rules); they widen what an agent can defensibly *say* after using ra11y.

---

## Track D — Docs & release

Owner: `release-captain` + `doc-writer`. Blocks nothing; can ship independently.

### v0.1.0


### v0.2.0


---

## Track M — MCP hardening

Owner: main session. Internal ordering: baseline first (unlocks scan-diff), then apply-fix, then prompts/resources/capability, then structured errors, then tests last.

### v0.2.0


---

## Track R — Rules + review-candidate coverage

Owner: `rule-implementer` (rules) + main session (review finders). Rules within the track are independent; dispatch 3 in parallel when you have 3 open items.

### v0.2.0


### v0.3.0


---

## Track F — Real-world fixture corpus

Owner: `fixture-curator` + `test-author`. **Sequenced: ADR → harness prototype → fixture backfill (9 items in parallel).** The 9 fixture cases cannot start until the harness lands.

### v0.2.0


---

## Track S — MCP sampling

Owner: `parser-author` + main session. Promoted from staged 2026-04-17. Foundation items (sampling.ts, capability plumbing, prompt library, KB docs) land freely; the three speculative LLM-backed tools (`resolve-component`, `verdict-candidate`, `draft-vpat-narrative`) still need a concrete use-case selection per ADR 0005 §Follow-up work — surface them as review candidates before wiring.

### v0.2.0 (foundation)


---

## Track E — Ecosystem & public benchmark

Owner: `doc-writer` + main session. Promoted from staged 2026-04-17. Items expand the agent-host matrix and establish the public quality story.

### v0.2.0


---

## Track Q — Agent-consumer feedback

Owner: main session + general-purpose. Source: 10 independent agent runs against an external React codebase (2026-04-17 eval brief). All accepted items are MCP shape/honesty fixes — none touch detection logic. Dispatch in parallel; each touches a different surface.

### v0.2.0 — accepted (P0/P1)


### v0.2.0 — accepted (P2)


### v0.2.0 — accepted (round 2 additions)

Net-new items from round 2 of the consumer eval (round 2 explicitly probed edge cases — bogus `cwd`, `changedOnly`, subpath scans, large-directory overflow). 4 unanimous round-2 issues + several single-observer R2 finds; all are correctness or honest-shape, none are heuristic suppression.


### Considered and rejected (per CLAUDE.md §1)

- **P0-A** Heuristic pre-filter for `wcag22:2.2.1` setTimeout/setInterval candidates by filename (`hooks/useDebounce*`, `telemetry/`, `auth/`), enclosing-function name regex, and duration threshold. → rejected per **§1 "Numeric-threshold heuristics are suppression"** + **"No heuristic suppression, even for spec carve-outs"** + **§17** "Adding a numeric-threshold gate." A 4.5s debounce and a 4.5s session timeout are indistinguishable from static analysis. The reason-text enrichment shipped under Track F (`real-world/timing-role-hints`) — "session-keepalive / debounce / animation" — is the correct mechanism. If agents still struggle, sharpen the reason text further; do not filter the candidate list. **Re-affirmed in 20-run brief (P0-A there, 20/20 agreement on the noise — but the noise is real signal the agent dismisses, per CLAUDE.md §1.**
- **P0-B** Tighten `wcag22:3.2.2 On Input` to skip `onChange` handlers whose body is `(e) => setX(e.target.value)`. → rejected for the same reason. The agent reading the handler body is the only correct arbiter; a controlled-input setter and a `navigate()` call are both `onChange` from the AST. Enrich the `reason` text with the detected handler shape ("body calls a single React setter") as additive context if the existing reason is thin; do not drop the candidate.
- **P1-I (10-run brief)** SPA-mode / file-class awareness — auto-suppress `2.4.5 Multiple Ways` / `1.4.5 Images of Text` / `2.4.1 Bypass Blocks` on server-template SPA shells. → rejected per **§1 "No heuristic suppression, even for spec carve-outs."** Whether a template is "the SPA shell" or "the start of a content site" cannot be statically determined. The deterministic disable pragma (`<!-- ra11y-disable wcag22:2.4.5 -->`) is the durable mechanism. Reason-text enrichment ("template parsed as literal — verify whether navigation is owned by the SPA") is acceptable; suppression is not.
- **P2-W (10-run brief) / P2-Y (20-run brief)** Severity downgrade for `aria/hidden-focus` when descendants are `disabled` + container has `pointer-events-none`. → rejected per **§1 "Don't downgrade priority to hide things."** Severity is for sorting; downgrading hides the candidate from agents that filter by severity. The reason text already explains state-dependent nature; that is enough. If a `caveat` field would help, add it as additive metadata at the same severity.
- **P1-R (20-run brief)** Tailwind utility-class awareness on `layout/reflow-hardcoded-width` — skip or downgrade when the rule fires inside `.w-\[Npx\]` selectors on compiled-CSS paths and no JSX consumer exists. → rejected per **§1 "No heuristic suppression"**. Path-pattern + selector-shape suppression replaces honest "please verify" with false confidence; the agent reading the file can confirm "this is a Tailwind utility-class definition" in one read. Pair with **P2-BUILD** above (the build-artifact warning) so the agent gets the labeling signal without losing the candidate.

### Deferred (worth doing eventually, not in this batch)

- **P1-G** Auto-detect compiled-CSS output paths via vite/next/tsup config. The current `additionalPaths: ["dist/assets"]` hint is wrong for many projects. Worth doing properly (read config, surface as `meta.inferredBuildOutput`), but scope is larger than the rest of Track Q. Park for later sprint.
- **P2-Q** Batch variant of `suggest_fix({ findings: [...] })`. Nice-to-have; round-trip reduction is real but not urgent.
- **P2-S** `plan.candidateCountsByCriterion: { ... }` histogram. Cheap, but no agent in the brief said they were blocked on it. Park.
- **P2-T** Gate `unusedNativeWrappers` on full-scan only. Single-observer (run #8 only); the existing `unusedNativeWrappersNote` already disclaims. Low ROI.
- **P2-U** Promote `absentDeclaredWrappers` to `meta.configHealth.staleWrappers` on `scan_project`. Single-observer; nice but not urgent.

---

## Track Q2 — Agent-consumer feedback (round 3, 10-agent eval)

Owner: main session + general-purpose. Source: a 10-agent parallel eval against an external React/Vite/TS/Tailwind codebase — each agent exercised a different MCP slice in a "you-find, I-fix" workflow. Round 3 ran after Q (rounds 1-2) closed, on the post-Q shape. All accepted items are shape-honesty, batch-primitive, or workflow-gap fixes — none are heuristic suppression.

### v0.2.0 — accepted (P0)


### v0.2.0 — accepted (P1)


### v0.2.0 — accepted (P2)


### Considered and rejected (per CLAUDE.md §1)

- **Promote `editCandidate` to `kind: "edit"`** when the synthesis looks concrete (e.g. label-in-name's heuristic rewrite). → rejected per **§1 "Ambiguous field shapes are dishonest"**. `kind: "edit"` is a contract that the oldText/newText pair is a mechanical swap — the rule emitted it with certainty. `editCandidate` at `kind: "guidance"` is an LLM-synthesized guess from visible text + aria-label tokens (per P1-L). Promoting the guess to `kind: "edit"` would make the contract lie; the agent would batch-apply candidates that aren't verified. Current shape is correct.
- **Heuristic auto-dismissal** for "obvious debounces" (timer duration < 1s, pure-value-bubbleup onChange). → rejected per **§1 "Numeric-threshold heuristics are suppression"** + **"No heuristic suppression"**. Same reasoning as the original Q P0-A rejection. A 800ms animation and a 800ms auth-retry back-off are indistinguishable from static analysis; the agent reading the surrounding code is the only correct arbiter. Enrich `reason` text further if needed; do not filter the candidate list.
- **Weight cross-line signals** (`pointer-events-none`, `disabled`, `focus-visible:ring-*`) in `suggest_fix` ranking. → rejected per **§1 "Don't duplicate capability the agent already has"**. The agent reading the file sees those signals in one pass; a heuristic weighting in-tool produces output the agent can't tell to mistrust. The `focus-visible:ring-*` cross-reference IS already shipped for the `focus/outline-visible` rule (Track R) where the evidence is a concrete class-token link — but fix-ranking heuristics are the fuzzier form and belong to the agent.
- **Framework-version awareness in `suggest_fix`** (detect React 18 vs 19 from `package.json`, etc.). → rejected per **§1 "Don't duplicate capability"**. Agents read `package.json` trivially; building a detector in-tool is the kind of in-process inference that can be confidently wrong (monorepos, overrides, multiple React versions). Better: the agent reads the config and compose the fix itself.
- **Flatten `files[].findings[]` to `findings[]` with `file` inlined** when total < 10. → deferred (not rejected). Token-saving but introduces a shape branch on response-size — consumers that iterate by-file now have to handle both shapes. The current nested shape is fine; optimize only with a measured token budget goal.

### Deferred (worth doing eventually, not in this batch)

- **Rule-catalog reorganization** — resolve `parsing/duplicate-id` + `parsing/html-has-lang` vs `document/lang-attribute`; clarify `semantics/label-in-name` vs `forms/labels-required` vs `forms/non-empty-label`. Renames need a deprecation path (alias old IDs for one major release). Costs a semver major.
- **Server-side typecheck/parse verification** on `suggest_fix` suggestions. Expensive (spins up a parse per suggestion); might be worth it for high-stakes mechanical fixes but not across the board.
- **SARIF output for GitHub annotations** — already emit SARIF; "::error" annotation mapping is a small transform. Tied to Q2-SARIF-DOCS; promote if demand surfaces.

### v0.2.0 — round 2 retriage

Source: the 10-agent round-2 eval aggregation (`AGGREGATED.md`). Most items were *not* folded into Track Q (rounds 1-2, closed 2026-04-17) — the round-2 aggregation was produced around the same time but separately. Triage below retriages each item against CLAUDE.md §1 doctrine and existing Q/Q2 shipped work.

#### Accepted (P0 — structural/bug/shape parity)


#### Accepted (P1 — load-bearing capability)


#### Accepted (P2 — orchestration / DX)


#### Accepted (P3 — polish)


#### Considered and rejected (round 2 retriage)

- **Glob-ignore `*.stories.tsx` as default** → rejected per §1 "Default-exclude globs are suppression too." Story-file zero-findings is an honest signal (structurally unanalyzable). Fix: the `preset: "storybook"` that scans what stories exercise (Q2R2-STORYBOOK-PRESET above), not a filename carve-out. Severity-downgrade variants fail for the same reason.
- **Auto-suppress when `couldBeWrongBecause` escape hatch is provably present** → rejected per §1 "No heuristic suppression." The structured field is informational (Q2R2-CWBB); the agent reads the file and decides. Baking inference into the tool creates the silent-miss mode the doctrine exists to prevent.
- **`estimatedFpRate: number` on every finding** → rejected per §1 "Numeric-threshold heuristics are suppression." Any consumer filtering on `fp_rate > X` reintroduces silent-miss. Reason-text + `couldBeWrongBecause` carry the same information without the threshold.
- **`reportFalsePositive` as a persistent out-of-tree dismissal** → rejected as new surface; **superseded by C-ATTEST-TOOL** (Track C). Attestation ledger is the durable out-of-tree evidence channel with the evidence-slot the doctrine requires. Track here as "duplicates Track C."
- **Surface `limitations` once at session level** → rejected. `limitations` is a per-scan honest signal; the specific scan's inability to verify runtime criteria is what the agent needs for that specific claim. Session caching creates a "was this scan's limits the session's, or did they change?" gap — silent-miss risk. Keep per-response.

---

## Track Q3 — Design-system field test

Owner: main session + general-purpose. Source: 10-agent parallel eval against a design-system docs repo. Slices: components MDX (×4 agents), forms MDX, layout/utilities/helpers/content MDX, getting-started/about/customize/extend MDX, Astro pages/layouts/components, raw HTML test fixtures under `js/tests/`, and an MCP surface critique. All findings triaged against CLAUDE.md §1 and the AI-first-consumer doctrine.

A design-system doc-site tree is a useful stress-test because (a) it's the shape ra11y agents see most often; (b) it has genuine a11y content (accessibility.mdx, prose-embedded ARIA patterns); (c) it ships MDX + Astro + raw HTML + SCSS in one tree — four file classes at once.

**Parser-lifecycle discovery (process issue, not code gap):** `dist/cli.js` was rebuilt at 22:30 but the MCP subprocesses were started at 22:13 and kept running the pre-rebuild bundle. All 10 agents saw `.mdx` / `.astro` return `file-unsupported` and `filesAdded: 0` — a behavior that evaporates once the host re-spawns the MCP subprocess against the fresh bundle. The parser code itself (`src/input/parsers/{mdx,astro,scss}.ts` + `src/mcp/session.ts:440-457` dispatch + `src/utils/path.ts` allow-list) is correct. Items below are the findings that remain valid AFTER the MCP is restarted — the stale-process symptom is folded into a single lifecycle item.

### v0.2.0 — accepted (P0)


### v0.2.0 — accepted (P1 — shape honesty)


### v0.3.0 — accepted (P1 — rule gaps + tightening)

Rule folders with known issues (verified via source-read against /Users/van/dev/ra11y/src/rules/):


New rules (ordered by ROI):


### v0.3.0 — accepted (P2)


### Considered and rejected (per CLAUDE.md §1)

- **Filter `.mdx` template-literal HTML out of findings by default** (one agent suggested we treat `<Example code={``}>` as "docs-only, skip") → rejected per §1 "No heuristic suppression" + "Labeled buckets are suppression too." The HTML in those template strings is rendered to users on the docs site — real live markup. Canonical docs-site surface; failing to scan it is a silent miss.
- **`aria/hidden-focus` severity downgrade on `.modal` patterns** (one agent noted the tree toggles `aria-hidden` at runtime, so static analysis sees a false state) → rejected per §1 "Don't downgrade priority to hide things." The rule already emits honest reason text; additive `couldBeWrongBecause` metadata is appropriate (see Q2R2-CWBB), severity-downgrade is not.
- **Deduplicate `forms/autocomplete-missing` when it fires 28× on one file** (concentrated in `floating-label.html`) → rejected per §1 "Labeled buckets are suppression too." The meta `concentration: {file, count}` already surfaces the density honestly; letting the agent see 28 is correct. A `meta.rulePatternSummary` extension could enrich reason text, but the 28 candidates must stay individually visible.
- **Restore `<Example code={``}>` parsing via a Starlight-specific extractor** → deferred, not rejected. The Astro parser fix (Q3-MCP-RESTART-HINT unblocking the existing parseAstro wiring) closes the surrounding `.astro` case; a Starlight-specific content-prop extractor for `.mdx` is a separate engineering effort with a narrow scope (only helps docs sites using the `<Example>` pattern). Re-evaluate after a Starlight docs site actually parses end-to-end.

### Additional items


### Cross-track shared items


### Cross-track shared items (deeper pass)


### Cross-track shared items (re-sweep)


### Cross-track shared items (later sweep)


---

## Track Q4 — Static-site-generator field test

Owner: main session + general-purpose. Source: 10-agent parallel eval against a static-site-generator repo. Slices: `_layouts/`, `_includes/`, `pages/`, `_docs/` (alphabetical split), `_posts/` + `_tutorials/`, CSS/SCSS, raw `test/source/*.html`, `lib/` scaffold templates, Ruby source tree, and an MCP surface critique from a non-React-project angle.

A canonical static-site-generator tree: HTML templates with Liquid (`{% ... %}`, `{{ ... }}`), YAML frontmatter, `.md`/`.markdown` content, SCSS, ERB fixtures, Ruby source. Where Q3 probed the docs-site MDX/Astro axis, Q4 probes the Ruby/SSG/Liquid axis — the failure modes are different. Cross-referenced against Q3 to avoid duplication; items that overlap are tagged as such.

**MCP freshness:** one MCP subprocess spawned post-rebuild (pid 16243, started 23:07 vs dist rebuilt at 22:30), so findings reflect current bundle behavior — the Q3 stale-process confound does not apply here.

### v0.2.0 — accepted (P0 — parser correctness, load-bearing)


### v0.2.0 — accepted (P1 — template-awareness and fragment detection)


### v0.2.0 — accepted (P1 — MCP shape for non-React projects)


### v0.3.0 — accepted (P1 — rule gaps + tightenings)

Deduped against Q3 where applicable. Items marked `[dup-Q3]` overlap and should share implementation.


### v0.3.0 — accepted (P2)

### Considered and rejected (per CLAUDE.md §1)

- **Auto-suppress React-specific rules on non-React projects** → rejected per §1 "Labeled buckets are suppression too." The rules correctly no-op when `filesEligible: 0`; the agent sees that in `perRuleCoverage`. Don't filter — surface. Q4-RULES-EVALUATED-COMPOSITE is the right fix (make the empty-eligible-set state legible at the headline level, keep the per-rule data honest).
- **Auto-exclude `_site/`, `vendor/bundle/`, `node_modules/` in `propose_config`** → **accepted in a narrower form**: these are definitionally build output / vendor dumps where findings are not the user's to fix. Fold into `DEFAULT_EXCLUDED_PATTERNS` (see `src/input/discover.ts`) rather than `propose_config` — the exclude belongs at discovery, not config. CLAUDE.md §1 "Default-exclude globs are suppression too" permits this because findings in those paths are "definitionally wrong for any consumer." Add `_site/`, `.jekyll-cache/`, `vendor/bundle/`, `_build/` (Hugo), `public/` (Gatsby — though `public/` is ambiguous). Tracked as **Q4-DEFAULT-EXCLUDE-BUILD-DIRS** in P2 above if landed.
- **Heuristic "this looks like an SSG include, suppress skip-link finding"** → rejected as heuristic suppression. Q4-FRAGMENT-DETECTION is the principled alternative: detect partial/fragment structurally, not by path-pattern guessing.
- **Full markdown CommonMark parser as a P0** → deferred. Q4-MARKDOWN-SUPPORT option (b) — a lightweight HTML-in-markdown extractor — covers 80% of real findings at ~15% of the implementation cost. Revisit full parser after the extractor ships.
- **Auto-detect and scan `_site/` output when Jekyll is detected** → rejected as "tool should not run build toolchains." The agent reads `_config.yml` + `Gemfile` + knows `bundle exec jekyll build`; ra11y should point at the output, not produce it. Q4-SSG-BUILD-HINT is the right mechanism.

### Additional items


---

## Track Q5 — Vanilla HTML/CSS/JS field test

Owner: main session + general-purpose. Source: first pass against a hand-authored vanilla-JS tree — 50 pedagogical vanilla `.html` + `.css` + `.js` bundles, no framework, no build step, no template directives. Exercises ra11y on the shape most "starter" tutorials propagate to learners; findings that stick here ship to every hobbyist project that copies these patterns. Triaged against CLAUDE.md §1 — all items are rule/finder correctness or new detection on patterns statically provable from the source.

Why this axis matters: most field tests so far (Q3 design-system, Q4 SSG, Q6 bulk templates) exercise framework-heavy or bundled shapes. A vanilla-JS tree is the control — clean, hand-authored, no build pipeline confounds. When a rule misfires here, the miss is on bare markup the author wrote.

### v0.3.0 — accepted (P1)


### Additional items


---

## Track Q6 — Bulk-template catalog field test

Owner: main session + general-purpose. Source: first pass against a 40+ bulk-template tree. Each template is a pre-built marketing/landing-page bundle shipping jQuery-era vendor CSS/JS (bootstrap.css, font-awesome.css, jquery.fancybox.pack.js) alongside authored HTML. Exercises ra11y at scale — the scan hit the MCP token ceiling, surfaced several rule misfires against vendor bundles, and exposed at-scale quality gaps in the proposed config + build-artifact warning path.

Why this axis matters: a bulk template catalog is the "buy a template kit" shape that a huge fraction of small-business and freelance sites ship. The vendor-CSS noise ratio and jQuery-era link antipatterns (`href="javascript:void(0)"`, icon-only social links) are not framework-authoring problems — they are the default ra11y-on-real-purchased-templates experience. When the token budget overruns, legitimate findings never reach the agent.

Three cross-repo items moved out: `PROPOSE_CONFIG_EMITS_ABSOLUTE_PATHS_AND_TRAILING_COMMA` folds into `Q-SHARED-PROPOSE-CONFIG-RELATIVE-PATHS` (Track Q3 cross-repo section). Two Q6 items consolidate under one roof each: Q6-1 + Q6-13 → `Q6-BUDGET-UNDER-VENDOR-NOISE`; Q6-10 + Q6-11 + SSG-4 share scope with Q4-SCANNED-BUILD-ARTIFACTS-REASON (cross-refs inline).

### v0.3.0 — accepted (P0 — response budget + signal-to-noise)


### v0.3.0 — accepted (P1 — rule/finder correctness)


### v0.3.0 — accepted (P2 — build-artifact rollup + signal routing)


### Additional items


### Considered and rejected (per CLAUDE.md §1)

- **Auto-exclude `bootstrap.css` / `font-awesome.css` / `jquery*.js` via `DEFAULT_EXCLUDED_PATTERNS`** → rejected per §1 "Default-exclude globs are suppression too." Vendor-bundle findings ARE real findings — contrast in `bootstrap.css` is a real contrast issue on the rendered page, just not one the consumer edits. The existing `scannedBuildArtifacts` label + proposed rollups (Q6-SCANNED-BUILD-ARTIFACTS-GROUP-BY-BASENAME + Q6-MOTION-PAUSE-STOP-PER-FILE-AGGREGATION) give the agent the signal without discarding the findings. Pairing with the build-artifact-aware next-step rerouting (Q6-NEXTSTEP-AVOIDS-VENDOR-CSS) closes the "agent lands on unactionable file" failure mode.
- **Default-downgrade vendor findings to `severity: "note"`** → rejected per §1 "Don't downgrade priority to hide things." Severity is for sorting; a downgrade hides real contrast violations from agents that filter by severity. The `scannedBuildArtifacts` membership is the honest label — agents decide triage; the tool does not pre-decide severity.

---

## Track Q7 — Real-world OSS field test

Owner: main session + general-purpose. Source: 2026-04-24 multi-repo OSS field test — 20 scan agents (5 waves × 4 anonymized open-source codebases) probing detection accuracy, false-negative coverage, checklist quality, fix-suggestion quality, and response-shape adherence to AI-first doctrine. Sites span four shapes: a CSS-framework + docs tree, an SSG-templated content site, a vanilla HTML/CSS/JS demo collection, and a bulk-template catalog (≈4k files). Wave 5 is the doctrine cross-check; Waves 1-4 are correctness/coverage.

Cross-cutting themes (≥3-of-4-site recurrence) drive the P0 items below. Items with strong overlap against prior tracks are marked as cross-track shared rather than re-listed. All accepted items are correctness, surface-don't-suppress, or shape-honesty fixes — no heuristic suppression accepted (re-affirmed against doctrine).

### v0.2.0 — accepted (P0 — shape honesty / silent-failure)

- [ ] **V1-SUGGEST-FIX-MECHANICAL-LANE-REMAINING-RULES** (extends Q7-SUGGEST-FIX-EDIT-LANE-UNREACHABLE) Audit and wire kind: "edit" emission for remaining ~17 rules tagged fixClass: "mechanical": document/lang-attribute, media/alt-text-missing, plus ~15 others. Either populate Violation.fix.{oldText,newText} or re-tag fixClass to verifyInSource if the edit is content-dependent. Cross-references V1-FIX-LANG-AUTOCOMPLETE-ALT-MECHANICAL-DOWNGRADE (turn 6) and V1-SUGGEST-FIX-MECHANICAL-LANE-EMIT-EDIT (turn 7).

### v0.2.0 — accepted (P1 — shape honesty)

- [ ] **Q7-PARTIAL-PARSE-PARSED-THROUGH-LINE** (1/4) `partialParseFiles[]` entries ship `{ path, parser, reason }` but no indication of WHERE parsing stopped — e.g. `parsedThroughLine: N` or a byte/char range. The agent has no way to bound trust in per-rule findings on the file: the rule may have visited the first 5 lines or the first 500. Without the stop point, the agent must read every partial-parse file in full to verify coverage, defeating the static-scanner premise. Fix: emit `parsedThroughLine: N` (or `parsedThroughByte`/`parsedThroughOffset`) on every `partialParseFiles` entry. 12 partial-parse files on one observed scan — non-trivial fraction. Pairs with Q7-PARTIAL-PARSE-STRUCTURAL-RULE-DEGRADATION (different lever; this is metadata, that is rule-emission shape).
- [ ] **Q7-RULE-FINDING-STRUCTURED-EVIDENCE-FIELDS** (1/4 — high volume) High-density rules bury the discriminating evidence in prose: `semantics/list-structure` (59 fires) does not name `offendingChildTag` / `offendingChildClass` as structured fields, so an agent triaging cannot distinguish "intentional `<hr>`-as-divider sibling under `<ul>`" from "real list misnesting" without reading source. `aria/expanded-on-disclosure` (169 fires) does not surface which predicate-branch fired (`branch.kind: "data-toggle" | "class-token" | ...`). For any rule whose finding density is >50, expose the discriminating evidence as a structured field, not buried in the prose `reason` text. Fix: audit the high-density rules, add `evidence: { offendingChildTag?, offendingChildClass?, predicateBranch? }` substructure to their findings; promote the discriminator from prose. Doctrine: agents read structured fields fast; prose is a fallback. Pairs with Q7-LANDMARK-MAIN-REASON-IDENTICAL (different rule, same structural-evidence pattern).
- [ ] **Q7-PERRULECOVERAGE-EXTENSION-PRESENT-OUT-OF-SCOPE-SUBKIND** (1/4) `perRuleCoverage` entries with `coverageConfidence: "low"` conflate two different gaps: (a) `extension-absent` — the scan tree contains zero files of this extension (current message is correct); (b) `extension-present-but-out-of-scope` — files of this extension exist at the cwd but `additionalPaths`/`exclude` pruned them out (current message wrongly steers the agent toward "add additionalPaths for compiled output" when the actual issue is "narrow additionalPaths excluded source"). Fix: differentiate via `subkind: "extension-absent" | "extension-present-but-out-of-scope"`; emit `(b)` with remediation "files of this extension exist at cwd but were pruned by `additionalPaths`/`exclude`; rerun with broader scope or unset the path filter." Doctrine: present-when-meaningful structured data; agent decides remediation from the structured discriminator, not by guessing the right call.
- [ ] **Q7-RESPONSE-TOKEN-BUDGET-SORT-ORDER** (1/4) `warnings: ["response_token_budget_truncated"]` ships `warningsDetails: { requestedLimit: 25, effectiveLimit: 5 }` but does NOT document the sort order on truncation. Agent paginating doesn't know if `nextOffset: 5` orders by alphabetical / finding-density / severity; with N files the page-walk strategy depends on the order. Fix: extend `warningsDetails.response_token_budget_truncated` with `sortOrder: "<order>"` so the agent's page-walk strategy is informed. Pairs with Q7-RESPONSE-TOKEN-BUDGET-DETAIL (different metadata axis: that's the budget-blower; this is the iteration order).
- [ ] **Q7-CATALOG-SCAN-GROUPBY-DIRECTORY** (1/4) Bulk-template repos with N parallel sub-project subdirs at the top level have no first-class workflow for "scan all sub-projects but aggregate per-sub-project." Current options: (a) one whole-tree scan that exceeds token budget and conflates findings across templates; (b) N hand-scoped `scan_project` calls with `additionalPaths` set to each sub-project (174 round trips, 174 separate result blobs to merge); (c) per-file `scan_file` in a loop (loses rule-coverage telemetry's per-project meaning). Fix: add `groupBy: "directory" | "firstChildDir" | "extension"` to `scan_project`; on `groupBy: "firstChildDir"`, the response carries `summary.byGroup: { "<dir>": { violations: N, mostCommonRule, ... }, ... }` — one response with N rows. The full `files[]` payload can be lazily fetched per group via follow-up calls (offset/limit already supports paging — extend with group filter). Pairs with Q6-CATALOG-REPO-SIBLING-HINT (closed, the catalog *detection*) — this is the *aggregation* response shape. Doctrine-aligned: additive surface, no bucket-then-filter.
- [ ] **Q7-CHECKLIST-PERCRITERION-CLIPPED-HEADLINE** (1/4) When `perCriterionClipped: true`, summary headline `actionable: 2` reads as "2 things to verify" — but the actual unclipped count under each criterion can be 10+ (e.g. `maxCandidatesPerCriterion: 10` × 2 criteria = 20 unread, with more elided beyond the 10-cap). Composite headline that conflates "criteria with candidates" and "candidates" under one number. Fix: when `perCriterionClipped` is true, surface per-criterion uncapped count: `summary.actionable: { criteria: 2, candidatesUncapped: 24, candidatesReturned: 11 }`. Also: when `totalCandidates > limit*0.8`, emit `nextStepStructured: { tool: "checklist", args: { offset: <n>, limit: <n> } }` rather than today's generic "iterate items[]" prose. Doctrine: composite headline counts are dishonest; clipped pages hidden behind a complete-sounding count is silent under-surfacing.
- [ ] **Q7-VENDOR-DISMISSAL-KEY-FINGERPRINT** (1/4) Logo-image candidates emit identical reason text on every brand mark — observed 174× on a bulk-template tree, every dismissal a fresh decision because attestation is per-criterion, not per-candidate-pattern. Same issue applies to any high-cardinality candidate family with structurally identical evidence (sponsor avatars, contributor lists, vendor-CSS contrast violations sharing one selector). Fix: compute `candidate.dismissalKey: hash(rule, filename-pattern, src-basename-pattern)` (or analogous discriminator); the agent records one verdict ("logo images are brand marks, dismissed under 1.4.5 logotype exemption") keyed on the hash, and subsequent matches auto-apply via `attest`. Workflow scaffolding rather than rule-suppression — fully consistent with surface-don't-suppress doctrine. Pairs with Q7-CHECKLIST-1.4.5-SR-ONLY-DEDUPE (in-page contiguous-range axis; this is the cross-page pattern axis).

### v0.3.0 — accepted (P1 — rule correctness)

- [ ] **Q7-RULE-IMG-ALT-REPEATS-PROSE-SC-MISMAP** (2/4) 1.4.5 "Images of Text" finder fires when alt text repeats a sibling label or surrounding prose: `<img alt="fly">` next to `<p>Fly</p>`; sponsor-avatar grids with sequential alt-prefix-plus-index. SC 1.4.5 governs whether the image's PIXELS render text — orthogonal to alt-prose redundancy (which is a 1.1.1 concern). Concrete observations across two targets: 10+ candidates each on pictorial-image clusters and sponsor avatars. The criterion mismatch trains the agent to mistrust 1.4.5 candidates uniformly. Fix: either (a) drop the alt-repeats-prose finder for 1.4.5 entirely — the actual signal (text rendered in pixels) is invisible to static analysis without OCR, and the agent reading the alt+visible-prose pair is the only reliable arbiter; OR (b) keep the finder but reframe the reason as a 1.1.1 "redundant alternative text" candidate suggesting `alt=""` since the visible label already names the image. The 1.4.5 evidence (filename-suggests-text, e.g. `button.png`/`banner-headline.svg`) stays under 1.4.5; alt-repeats-prose moves to 1.1.1. Doctrine: spec-correctness on which criterion a candidate belongs to. Pairs with Q7-CHECKLIST-1.4.5-SR-ONLY-DEDUPE (different lever; that's contiguous-range dedup, this is criterion mapping).
- [ ] **Q7-RULE-NAME-RESOLUTION-TITLE-FALLBACK-CONSISTENCY** (1/4) Two rules treat the `title` attribute differently: `navigation/link-descriptive-text` accepts `title` as accessible name unconditionally (so icon-only social links with only `<i>` child + `title="Facebook"` silently pass); `tooltip/dismissable` treats the same `title` as supplementary tooltip content (and fires). The rules disagree on the same attribute on the same element. Per ARIA 1.2 `title` is a last-resort name source — many screen readers (NVDA at default verbosity, VoiceOver in some modes) suppress it. Fix: pick one model and apply it across all name-resolution rules: either (a) treat `title` as accessible name only when no other source exists AND emit info-severity "name-via-title-fallback" candidates so the agent can verify SR support, or (b) reject `title` as name and require aria-label / inner text / sr-only span. The current schism produces silent under-fire on the canonical icon-only social-link pattern (the textbook 2.4.4 risk surface). Pairs with Q7-RULE-TOOLTIP-DISMISSABLE-TITLE-IS-ACCNAME (same observation, complementary fix lane).
### v0.3.0 — accepted (P2 — finder coverage on untargeted-but-groundable criteria)

Cross-cutting theme #18 (4/4 sites). Several criteria currently ship as `untargetedCriteria` (bare-criterion prompts) when the deterministic grounding evidence sits in the parsed source. Each item below promotes one criterion to a grounded finder.

- [ ] **Q7-FINDER-3.2.2-ONCHANGE-CONTEXT-MUTATION** `wcag22:3.2.2 On Input` — JS handlers (`onchange`, `oninput`, `addEventListener('change'|'input')`) whose body mutates `location`, `window.open`, `innerHTML`, or calls a `navigate*`/`router.push*` identifier. Static evidence is grep-able. Pairs with Q7-RULE-FORMS-SELECT-ONCHANGE-CONTEXT-CHANGE (above) — different shape: that rule fires deterministically on the `<select onchange="...navigate...">` subset; this finder surfaces the broader candidate set for review.
- [ ] **Q7-FINDER-1.3.2-CSS-VISUAL-ORDER** `wcag22:1.3.2 Meaningful Sequence` — CSS `flex-direction: row-reverse` / `order: N` / `direction: rtl` on layout containers is grep-able. Cross-ref Q6-MEANINGFUL-SEQUENCE-UTILITY-CLASSES (closed) — that fixed the false-positive on utility-class definitions; this is the consumer-side finder that fires on the actual layout-reordering call sites.

### v0.3.0 — accepted (P2 — checklist quality)

- [ ] **Q7-CHECKLIST-1.4.5-SR-ONLY-DEDUPE** `wcag22:1.4.5 Images of Text` finder fires N times per page on adjacent sponsor-avatar / contributor-list image clusters — N near-identical candidates from contiguous line ranges. Fix: when ≥4 candidates share `(ruleId, criterionId, parent-element-shape)` within a contiguous line range, collapse to one entry with `siblingOccurrences: [{ line, alt }]` + reason "and N similar at lines X-Y." Pairs with Q4-LIKELY-REDUCIBLE-SIBLING-IMAGE-DEDUPE (closed, image-rule dedupe) and Q6-PATTERN-FINGERPRINT-CROSS-TEMPLATE (closed, cross-file). This is the within-page contiguous-range axis.
- [ ] **Q7-CHECKLIST-1.3.3-LOCATIVE-WITH-NOUN** (1/4) 1.3.3 sensory finder fires on prose like "Fill out the form below with some info" because of substring "form below" — but the position word is followed by a noun (`form`) that names the target. WCAG 1.3.3 prohibits sensory-only / position-only references when there is no other identifier; when a noun anchors the reference, the position is supplementary, not the sole locator. Fix: either (a) drop the candidate when a noun follows the position word (the noun anchors the reference), OR (b) rephrase reason to "verify users who linearize content (screen readers) can locate '<noun>' by its name — '<position>' is a layout cue, not a name." Pairs with Q7-CHECKLIST-1.3.3-LOCATIVE-CALLOUT-PROSE (different angle: that's about prose-callout containers; this is about position-with-noun).
- [ ] **Q7-CHECKLIST-2.4.5-FRAGMENT-FILE-CONTEXT** (1/4) 2.4.5 finder labels a `<head>`-only partial as "Likely root layout" because of `0 <nav>, 0 <a>` evidence. A `<head>`-only file (no `<body>`) cannot be a root layout — the conclusion is heuristic and wrong. Fix: the "Likely root layout" classifier should require the file to contain `<body>` OR be the only top-level `<html>` document in its directory tree. A `<head>`-only file should be classified as "head fragment" and skipped for 2.4.5 — the rule semantically applies to renderable pages with navigable content. Pairs with Q7-FRAGMENT-FILE-HEADING-HIERARCHY (same fragment-classification surface).

### Considered and rejected (per CLAUDE.md §1)

- **Auto-suppress `motion/pause-stop-hide` on transitions ≤ Xms** → rejected per §1 "Numeric-threshold heuristics are suppression." A 200ms transition might be a hover-effect debounce or might be a fast-flashing annotation; static analysis cannot tell. The spec-correctness fix in Q7-RULE-MOTION-DURATION-AND-TRIGGER-GATE (above) does NOT use a single threshold to suppress — it gates the *criterion choice* (2.2.2 vs 2.3.3) on parsed evidence (infinite loop, auto-play attribute, user-pseudo-class scoping), and encodes the duration as additive reason context. Both lanes still emit candidates.
- **Lower confidence on JS-driven panel containers (`carousel-item`, `tab-pane`, `accordion-item`) for `semantics/heading-hierarchy`** → rejected per §1 "No heuristic suppression, even for spec carve-outs." The hierarchy violation at the rendered shape may or may not be a real problem depending on whether the panel is opened simultaneously or one-at-a-time at runtime — only the agent reading the JS controller knows. Reason-enrichment ("heading sits inside a JS-driven panel container — verify whether siblings are visible together at runtime") is acceptable; confidence-downgrade is not.
- **Filter the `likelyIrrelevant` bucket more aggressively (sponsor avatars, brand marks)** → rejected per §1 "Labeled buckets are suppression too" and the existing "logotype exemption" doctrine carve-out. The bucket label is honest only when provable from code; "this is a sponsor avatar" is not provable. Reason-enrichment ("alt text matches a known logo/brand naming pattern — verify against the logotype exemption") is acceptable; bucket-then-filter is not. Cross-ref the existing rejected entries on logotype exemption in Track Q.
- **Auto-detect SPA shells from low file count and skip 2.4.5** → rejected per the existing rejection of P1-I in Track Q (heuristic suppression on spec carve-outs). Q7-RULE-LANDMARK-MAIN-FRAGMENT-SCOPE adds `couldBeWrongBecause: ["isolated_component_demo_page"]` as additive metadata for one specific shape (single-component demo pages), but that's a couldBeWrongBecause label on a specific structural pattern, not a heuristic skip on a criterion. The 2.4.5 single-page reason-enrichment lives in V1-2.4.5-SINGLE-PAGE-REASON-ENRICH (open).

### Cross-track shared items

These themes were observed on the 2026-04-24 sweep but are fully covered by prior backlog items; cross-referenced to avoid duplication.

- **`plan.safeEditsAvailable` vs `plan.fixesByClass.mechanical` 18×–145× disagreement on 4/4 sites** → covered by Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT (closed) and Q3-PLAN-MECHANICAL-EDITS-COUNTER-DRIFT (closed). The doctrine name is "composite headline counts are dishonest"; the closed items renamed/dropped the composite. If the composite still ships on current `main`, the bug is shipped-but-stale-MCP — see V1-MCP-DIST-STALE-CI-GATE (open).
- **`meta.configSearchedFrom` echoes `meta.scanned.root` verbatim on 3/4 sites** → covered by Q6-CONFIG-CONTEXT-TRIPLE-READOUT (closed). Same stale-MCP suspicion if reproducing on current `main`.
- **`forms/labels-required` misses adjacent unassociated label** → covered by Q5-LABEL-ADJACENT-UNASSOCIATED (closed) and Q6-RULE-LABEL-ADJACENT-UNASSOCIATED-NO-IDS (closed).
- **Icon-only buttons (icon-font / inline SVG) missing accessible name** → covered by Q5-RULE-ICON-FONT-ARIA-HIDDEN (closed) and Q6-LINK-ICON-ONLY-ACCNAME (closed). The new inline-SVG axis lives in Q7-RULE-MEDIA-SVG-ACCESSIBLE-NAME above.
- **Multi-project root not detected** → covered by Q6-CATALOG-REPO-SIBLING-HINT (closed). 2/4 sites in the sweep observed the same untriaged-catalog symptom; if the closed item's emission isn't firing on current `main`, the bug is shipped-but-stale-MCP — V1-MCP-DIST-STALE-CI-GATE.
- **`likelyIrrelevant` bucket sweeps real candidates (iframe embeds of YouTube/Vimeo classified as no-media)** → covered by Q-SHARED-LIKELY-IRRELEVANT-IFRAME-NOT-MEDIA (closed) and Q-SHARED-VIDEO-CAPTIONS-IFRAME-EMBEDS (closed).
- **`scan` says N, `checklist` says M for the same criterion** → covered by Q-SHARED-COVERAGE-FAILING-CRITERIA-DERIVATION (closed) and Q4-WARNING-DETAILS-CROSS-SURFACE-UNIFY (closed).
- **`plan.summary` prose sums automated + manual + bare-untargeted into one string** → covered by Q-SHARED-PLAN-SUMMARY-VERIFY-IN-SOURCE-INFLATION (closed) and Q3-PLAN-SUMMARY-PROSE (closed).
- **`stale_mcp_subprocess` warning fires every call without inline remediation** → covered by Q3-MCP-RESTART-HINT (closed) + Q3-MCP-RESTART-HINT-ERROR-ENVELOPE (closed) + Q3-MCP-RESTART-HINT-SUBPROCESS-RACE (closed) + Q3-META-BUILD-PROVENANCE (closed). The 4/4-site recurrence in this sweep on the same code suggests V1-MCP-DIST-STALE-CI-GATE (open) is the systemic fix.
- **`opaqueCustomComponentNames` returns minified-JS member-access expressions (`AG.y`, `H.length`, `Math.abs`)** → covered by Q6-AUTODETECT-WRAPPERS-LEAKS-JS-IDENTIFIER-NOISE (closed) + Q6-OPAQUE-COMPONENTS-MINIFIED-JS-REGRESSION (closed). Recurrence on this sweep suggests the closed items are shipped-but-stale-MCP, or the belt-and-braces second-layer fix is still pending parser-side work.
- **2026-04-24 second sweep recurrences (4 targets, second pass on the same shapes)** — the following all reproduced on at least one of the four second-sweep targets: 2.5.1 pointer-gestures identifier-substring false positive (covered by Q5-POINTER-GESTURES-SUBSTRING-FALSE-POSITIVE closed), `forms/label-adjacent-unassociated` missing the no-id case (covered by Q6-RULE-LABEL-ADJACENT-UNASSOCIATED-NO-IDS closed), minified-vendor-JS snippet pointing at a single long line with no column disambiguation (covered by Q6-MINIFIED-FILE-SNIPPET-COLUMN-ENRICHMENT closed), `configSource: null` + `configSearchedFrom` + `configNote` + `warnings: ["no_config_found"]` triple-readout (covered by Q6-CONFIG-CONTEXT-TRIPLE-READOUT closed). All four are shipped-but-stale-MCP suspects per V1-MCP-DIST-STALE-CI-GATE (open) — same systemic fix as the warnings-mixing recurrence above.

---

## Track Q8 — Multi-repo external scan field test (2026-04-25 round)

Owner: main session + `rule-implementer` (rules) + general-purpose. Source: 4 parallel scan agents against four unrelated public codebases — a static-template subproject set, a docs-site fragment tree, a vanilla-JS tutorial-exercise collection, and a bulk-template catalog (≈4k files / 1.8k vendor-JS files). All accepted items are correctness, surface-don't-suppress, or shape-honesty fixes per CLAUDE.md §1 + the AI-first-consumer doctrine; recurring-across-≥2-scans themes drive the P0 priorities.

Cross-cutting themes seen across ≥2 of the 4 scans: response-token-budget overruns even on medium repos; `.js` files routed through the tsx parser flooding `parseErrorFiles` with fake JSX errors; HTML files reported as `partialParseFiles` with "Stray closing tag at top level" on browser-renderable input; heuristic-mislabeled meta sub-fields recurring on `scannedBuildArtifacts[].reason`, `templateDirectivesFound`, and `coverageConfidence` reasons; cross-surface count drift between scan / checklist / coverage; composite-headline strings in checklist summaries.

### v0.2.0 — accepted (P0 — token-budget honesty / silent-failure)


### v0.2.0 — accepted (P0 — heuristic-mislabeled meta sub-fields)


### v0.2.0 — accepted (P0 — heuristic-emission / reason-severity disagreement)


### v0.2.0 — accepted (P1 — finder reason-text enrichment)

- [ ] **Q8-FINDER-2.4.5-CROSS-FILE-EVIDENCE** `review:wcag22:2.4.5` (Multiple Ways) fires on every standalone single-page demo without context. Add cross-file evidence to the reason — `scan covered N distinct directory roots with no cross-anchors` — so the agent dismisses standalone-page cases in one read. Pairs with V1-FINDER-2.4.5-MULTIPLE-WAYS-REQUIRE-BODY (closed) — different lever (gating); this is reason-enrichment.
- [ ] **Q8-FINDER-2.3.1-ITERATION-COUNT-PREDICATE** `review:wcag22:2.3.1` (motion/three-flashes) heuristic equates animation-duration with frequency, firing on single-shot 150ms transitions where `animation-iteration-count: 1`. Fix predicate to require iteration-count > 1 (or `infinite`) before synthesizing a per-second cycle rate; encode iteration count as additive reason text otherwise. Pairs with V1-MOTION-2.3.1-CYCLES-PER-SECOND-MATH (closed) and Q7-RULE-ANIMATION-ITERATION-COUNT-GATE (open) — convergent fix; this is the finder-axis closure assertion.

### v0.2.0 — accepted (P1 — rule scope widening)


### v0.2.0 — accepted (P1 — new rules)


### v0.2.0 — accepted (P2 — finder fix-suggestion polish)

- [ ] **Q8-SECTION-ACCESSIBLE-NAME-NEAREST-HEADING** `semantics/section-accessible-name-missing` reason text doesn't surface the nearest visible heading. The fix is mechanical when the heading is included in reason ("section sits below `<h2>Author bio</h2>`; consider `aria-labelledby` pointing at that heading's id"). Fix: enrich reason with `nearestVisibleHeading?: { text, line, idIfPresent? }` so the agent composes the fix without reading the file. Pairs with V1-RULE-SECTION-ACCESSIBLE-NAME-NEAREST-HEADING-PROPOSE (open) — same gap, this item locks the reason-enrichment shape.

### v0.2.0 — accepted (Q8b — 2nd-pass field test, 2026-04-25)

Source: 5-lens × 4-corpus replication pass over the same four codebases as Q8. Each repo received 5 parallel scout subagents (lenses A=coverage gaps, B=output correctness, C=parser/scanner, D=heuristic-mislabeled meta, E=response-shape drift). Aggregator deduped against existing Q8/V1 items. Net-new items below; Q8 confirmations and doctrine additions captured separately (the latter folded into `docs/kb/architecture/ai-first-consumer.md`).

#### Q8b — accepted (P0 — heuristic-mislabeled meta sub-fields)


#### Q8b — accepted (P0 — heuristic-emission / reason-severity disagreement)


#### Q8b — accepted (P0 — cross-surface drift)


#### Q8b — accepted (P1 — finder reason-text enrichment)

- [ ] **Q8b-FINDER-LANDMARK-MAIN-PROBABLE-CANDIDATE** `semantics/landmark-main` reason text is identical across page-shaped HTML files with no per-file context. Enrich with `probableMainHint?: { tag, line, selectorHint }` — identify the largest non-header/footer/nav block in the file and surface as a candidate to wrap or relabel. Reason-enrichment only; no severity change. Pairs with V1-FIX-LANDMARK-MAIN (closed) — that fix-text only triggered on multi-`<main>` files; this is the zero-`<main>` axis.
- [ ] **Q8b-FINDER-CAPTION-PRECEDING-HEADING-AS-LABELLEDBY-CANDIDATE** `semantics/table-caption-missing` reason and fix are identical across emits regardless of context. When a heading element precedes the table within the same section, propose `aria-labelledby` pointing at the heading's id (auto-id the heading if needed) as the mechanical-edit alternative to inserting a `<caption>`.
- [ ] **Q8b-FINDER-SCANNED-BUILD-ARTIFACTS-OVERSIZE-NEXT-STEP** When `scannedBuildArtifacts.grouped.length` is large AND `totalFilesWithFindings > threshold`, the canonical `nextStep` should swap from `suggest_fix` (which points at the first vendor-CSS finding) to `"add suggestedGlob entries to ra11y.config.ts exclude"` or `"rerun scan_project with additionalPaths narrowed"`. Otherwise the agent's first-tool-call routes into vendor noise instead of the structural fix.

#### Q8b — accepted (P1 — rule scope widening)


#### Q8b — accepted (P1 — new rules)


#### Q8b — accepted (P2 — finder fix-suggestion polish)

#### Q8 confirmations — cross-corpus signal (2nd-pass)

These existing Q8 items reproduced across multiple lenses/corpora in the 2nd-pass field test, signaling high priority for prompt closure (no new work — duplicate evidence, durable closure target):

- Q8-PARSER-ROUTING-JS-AS-TSX — confirmed by 4 corpora (lenses C across all 4 reports).
- Q8-COVERAGECONFIDENCE-MEDIUM-UNCONDITIONAL-DEFAULT — confirmed by 4 corpora (lens D across all 4 reports — idref / listener / custom-property / click-alternative variants).
- Q8-CROSS-SURFACE-UNTARGETED-COUNT-INVARIANT — confirmed by 4 corpora (lens E across all 4 reports — drift on every cwd).
- Q8-SCANNED-BUILD-ARTIFACTS-MINIFIED-SVG-LABEL — confirmed by 3 corpora (brand SVGs, glyph-font SVG, compact-distribution shim).
- Q8-RESPONSE-TRUNCATED-OVERSIZED-ENVELOPE — confirmed by 3 corpora (86KB, 88KB, post-clip 18× over host cap on bulk catalog).
- Q8-CHECKLIST-SUMMARY-COMPOSITE-PROSE — confirmed by 3 corpora (`criteriaManualReviewRequired` + `plan.summary` composite-headline class).
- Q8-COLOR-MEANING-BY-COLOR-ONLY-SEVERITY-CONTRADICTION — confirmed by 2 corpora (same conceding-reason / error-severity contradiction).
- Q8-RULE-CROSS-FILE-CLICK-HANDLER-NON-INTERACTIVE — confirmed by 2 corpora (vanilla-JS handler-in-sibling-`.js` pattern recurs).

### v0.2.0 — accepted (Q8c — 3rd-pass field test, 2026-04-25)

Source: 5-lens × 4-corpus replication pass over the same four codebases as Q8/Q8b. Each scout ran lenses A=coverage gaps, B=output correctness, C=parser/scanner, D=heuristic-mislabeled meta, E=response-shape drift; aggregator deduped against existing Q8/Q8b/V1 entries. Net-new items below; doctrine additions captured separately in `docs/kb/architecture/ai-first-consumer.md`.

Cross-cutting themes seen across ≥2 of the 4 scans this round: minified/build-artifact label leaks onto un-minified vendor distribution sources; per-finding `confidence: high` does not propagate the per-rule cross-file `coverageConfidence: medium` limitation, so `keyboard/handler-missing` ships hundreds of error-severity findings on native `<button>` elements wired up by sibling `.js`; `nextStep` routes the agent into the alphabetically-first finding (often a vendor file or scaffold dir) on truncated-response and bulk-corpus scans; review candidates emit at `priority: high` against files already classified as build-artifacts; the `scanned_build_artifacts_present` + `parse_errors_present` warning pair overlaps when minified vendor files reach the parser before the artifact classifier rules them out; HTML-residue parse classification on `.md` files routes every HTML-document rule across README/docs prose, producing identical "no `<h1>`" / "no `<main>`" findings the agent dismisses by reading the file once.

#### Q8c — accepted (P0 — token-budget honesty / silent-failure)

- [ ] **Q8c-PARSER-JS-INNERHTML-TEMPLATE-LITERAL-WARNING** `.js` files containing `innerHTML = …` / `insertAdjacentHTML(…)` / `document.write(…)` / `el.html('…')` template-literal HTML islands are silently dropped — no rule recurses into the HTML payload. Doctrine names `js_innerhtml_template_literal_unparsed` as the canonical warning code for this class but no surface emits it. Observed across all 4 corpora — dynamically-injected interactive controls, vendor-bundled DOM-construction strings, and runtime-populated content-placeholder shells. Fix: emit the named warning whenever a `.js` source contains a template-literal HTML pattern AND the routed parser produced no findings on that file; surface in `warningsDetails.js_innerhtml_template_literal_unparsed.fileSamples[]`. Symmetric twin of suppression doctrine — under-parsing a content surface is the same silent-miss failure mode as under-emitting.
- [ ] **Q8c-EXTENSION-SKIP-BINARY-VS-TEXT-SPLIT** `warningsDetails.extensions_skipped_no_parser` lumps binary-asset extensions (`.png`, `.jpg`, `.eot`, `.ttf`, `.woff`, `.mp3`, `.psd`, `.ico`) with text-source extensions the scanner could plausibly support (`.php`, `.coffee`, `.htc`, `.xhtml`, `.mkdn`, `.rmd`, `.erb`, `.hbs`). On a bulk catalog the `topExtension: ".jpg"` (1835) buries 30 `.php` files under `totalSkipped: 5341`; the agent reads the top extension and concludes "binary noise" while real text-bearing source goes silently unscanned. Fix: split `extensions_skipped_no_parser` into `binary_assets_skipped` (image/font/audio/video/archive) + `text_source_skipped` (scanner could plausibly route — split out so agent sees the actionable subset). Pairs with Q8-EXTENSIONS-SKIPPED-NO-PARSER-IMAGE-FILTER (filter axis) — this is the symmetric split that surfaces actionable subset rather than dropping it.

#### Q8c — accepted (P0 — heuristic-mislabeled meta sub-fields)

- [ ] **Q8c-PERRULECOVERAGE-PARSER-FIELD-NAME-AMBIGUOUS** `parseErrorFiles[].parser: "tsx"` reads as a content classification ("this file IS tsx") but is actually a routing decision (".js was sent to the tsx parser"). Agent reading a `.js` file with `parser: "tsx"` may infer "this codebase uses TSX" and re-route fix suggestions accordingly. Fix: rename to `parserAttempted` or `routedTo`; OR add a sibling `naturalParser` (per-extension default) so the agent can see the routing mismatch in one read. Pairs with Q8b-PARSE-ERROR-REASON-NAMES-WRONG-CULPRIT (reason text on parse error) — this is the field-naming axis on the meta record.
- [ ] **Q8c-COVERAGECONFIDENCE-REASON-SUFFIX-FRAMING** `perRuleCoverage[].coverageConfidence.reason: "cross_file_X_resolution_limited_on_this_input"` reads as "we tried this input and were limited" — the actual situation is "the rule never crosses files at all." The token frames a permanent rule-design limitation as an input-specific hiccup; agents may infer "maybe a different input would resolve it" and waste a re-scan. Fix: when the cross-file resolution is structurally not attempted by the rule, rename to `"cross_file_X_resolution_not_attempted_by_rule"` (or drop the `_on_this_input` suffix per Q8b-PERRULECOVERAGE-CONFIDENCE-REASON-SUFFIX-RENAME). Pairs with Q8b-PERRULECOVERAGE-CONFIDENCE-REASON-SUFFIX-RENAME (suffix-rename axis) — this is the framing-honesty closure for the cases where the rule provably never attempts the resolution.
- [ ] **Q8c-TEMPLATE-DIRECTIVE-CODE-FENCE-FALSE-POSITIVE** `templateDirectivesFound: ["erb-or-ejs"]` / `["jinja-or-liquid"]` fires when the directive token appears inside Markdown fenced code blocks or inline-code spans (e.g. a docs page quoting `<%= Time.now %>` in prose; release-notes markdown mentioning template syntax). The detector tokenizes everywhere in the source. Fix: when scanning a `.md`/`.markdown` file for template-family directives, exclude content inside triple-backtick fences AND inline-code spans before running the matcher. Pairs with V1-TEMPLATE-CLASSIFIER-MARKDOWN-PROSE-FALSE-POSITIVE (closed) — recurrence at the field-emission axis on a different corpus.

#### Q8c — accepted (P0 — heuristic-emission / reason-severity disagreement)

#### Q8c — accepted (P0 — cross-surface drift)

- [ ] **Q8c-FILESCANNED-OVERSTATES-RULE-REACH** `meta.filesScanned: 472` is the headline but per-rule `filesEvaluated` ranges from 6 (SVG-only rules) to 472 (focus-outline) — typical eligibility 327 (HTML-shape rules) with 145 files (SCSS + plain JS) evaluated by NO rule for that bucket. Headline overstates actual rule reach by ≥30% on multiple scans. Fix: surface `filesWithAnyRuleEvaluated: N` and `filesWithZeroRuleEvaluation: M` alongside `filesScanned`; agent can read in one pass how much of the input was a no-op. Pairs with V1-FILES-BY-EXTENSION-GROUND-TRUTH-UNDERCOUNT (open, denominator-honesty axis) — this is the rule-reach denominator companion.
- [ ] **Q8c-PERRULECOVERAGE-FIRED-FLAG-DERIVATION** `meta.rulesEvaluated: { loaded: 77, withEligibleInputs: 73, fired: 48 }` says 48 rules fired; `perRuleCoverage[]` lists 73 entries (matches `withEligibleInputs`). To verify the 48 number an agent must count entries with `findingsEmitted > 0`. Fix: add an explicit `fired: boolean` flag per `perRuleCoverage[]` entry, OR surface a sibling `notFired: ruleId[]` list, OR list only fired rules in `perRuleCoverage[]` with a separate `rulesWithEligibleInputsButNoFindings: ruleId[]`. Pairs with V1-META-RULES-EVALUATED-COVERAGE-DRIFT (closed, the count-derivation axis) — this is the agent-side derivation cost on the same surface.
- [ ] **Q8c-PERRULECOVERAGE-RULES-WITH-NO-ELIGIBLE-INPUTS-DROPPED** `perRuleCoverage[]` silently drops rules with zero eligible inputs (`navigation/link-target-blank-announcement`, `motion/animation-from-interactions`, `contrast/enhanced`, `parsing/invalid-id-shape` observed missing on a docs-site scan). Agent reading `perRuleCoverage[]` cannot distinguish "rule ran on 0 inputs" from "rule did not load" — the rules are simply gone. Fix: include them with `filesEvaluated: 0` + `reason: "no_eligible_inputs"`, OR surface a sibling `rulesWithNoEligibleInputs: ruleId[]` list. The corpus DOES have eligible inputs for `navigation/link-target-blank-announcement` (3 confirmed sites with `target="_blank"`), suggesting the eligibility predicate itself is buggy on `.html` partials without `<html>` envelope. Pairs with Q8c-PERRULECOVERAGE-FIRED-FLAG-DERIVATION (sibling shape axis) — this is the missing-from-list axis.
#### Q8c — accepted (P1 — finder reason-text enrichment)

- [ ] **Q8c-FINDER-2.2.1-VENDOR-ARTIFACT-PRIORITY-DOWNGRADE** `review:wcag22:2.2.1` setTimeout finder emits at `priority: high` against findings whose target file is already in `scannedBuildArtifacts` (e.g. minified `respond.min.js`, internal debounce inside legacy jQuery) — quotes obfuscated single-letter variable names (`setTimeout(p)`) as the duration. Reason concedes "minified file — match at byte col …" but priority stays high. Fix: when the candidate's file is in `scannedBuildArtifacts`, drop priority from `high` to `medium` AND surface `vendorContext: { signal, redirectTo: "consumer-override" }`. Surface-don't-suppress (still emit; agent reads context once). Pairs with Q8-FINDER-2.2.1-VENDOR-PATH-AND-DURATION-CLASSIFICATION (reason-text axis) — this is the priority-honesty axis on the same finder.
- [ ] **Q8c-FINDER-LOGOTYPE-CONCEDED-PREDICATE-PRIORITY** `review:wcag22:1.4.5` candidate emits at `priority: high` while the reason text concedes the logotype-pattern is satisfied (e.g. "a visually-hidden text sibling is present in the same parent — if the image is the textual logotype and the sibling is the SR-accessible equivalent, this is the documented logotype pattern"). Severity contradicts conceded predicate at the candidate-priority level — same shape as the rule-side rule (Q8-COLOR-MEANING-BY-COLOR-ONLY-SEVERITY-CONTRADICTION) but on the finder/priority axis. Fix: when the reason concedes the predicate may be satisfied, downgrade priority to `medium` (or `low`); reserve `high` for cases where evidence supports an unsatisfied predicate. Pairs with Q8-COLOR-MEANING-BY-COLOR-ONLY-SEVERITY-CONTRADICTION (rule-side severity axis) — this is the candidate-priority axis on the same shape.
- [ ] **Q8c-FINDER-2.4.5-HEAD-ONLY-FRAGMENT-PRIORITY** `review:wcag22:2.4.5` (Multiple Ways) emits at `priority: high` on a 19-line `<head>`-and-meta partial file — the criterion does not apply to head-fragments. Reason concedes "if this is a standalone single-page file or SPA, the criterion may not apply." Fix: when the file structurally cannot host page navigation (no `<body>`, no anchors, no nav elements), drop priority to `low` OR exclude the file from finder eligibility. Pairs with Q7-CHECKLIST-2.4.5-FRAGMENT-FILE-CONTEXT (closed, body-presence requirement) — this is the priority-axis closure for the head-fragment subset.
- [ ] **Q8c-FINDER-IFRAME-MEDIA-EXCLUDE-JS-STRING-LITERALS** Iframe-media review candidates fire on `.js` file string literals (`"<iframe id=\"frame\">…"`), treating the string as a rendered iframe. JS string literals containing `<iframe>` are library code building DOM at runtime, not iframes on the page. Fix: restrict iframe-finder eligibility to HTML-family inputs (`.html`, `.jsx`, `.tsx`, `.vue`, `.svelte`, `.astro`, `.mdx`, `.md`-as-residue); skip `.js`/`.ts` even when the parser exposed a string-literal HTML island. Pairs with Q6-CHECKLIST-IFRAME-FINDER-JS-STRING-LITERALS (closed, JS-source iframe-string axis) — this is the recurrence audit on the open finder family.
- [ ] **Q8c-FINDER-AUTOCOMPLETE-CROSS-FILE-FN-RESOLVED-HINT** `review:wcag22:3.2.2` (`onchange` on `<select>`) reason hedges `"low confidence, body not inline"` and asks the agent to "open the referenced fn and check for router/location/submit" — but the function name (e.g. `navigateToUrl`) is statically resolvable in this corpus (defined inline at sibling layout file). Cross-file resolution is the agent's job per doctrine; surface the function-name link so the agent can jump in one call. Fix: when the handler is a named function call, surface `handlerFunctionName: "navigateToUrl"` as additive evidence so the agent's next Read targets the right symbol. Pairs with Q8-FORMS-AUTOCOMPLETE-MISSING-NAVIGATION-SELECT (rule-side axis) — this is the candidate-side enrichment.
- [ ] **Q8c-FINDER-LANDMARK-MAIN-DEMO-FIXTURE-REASON** `semantics/landmark-main` fires at `severity: warning` uniformly on tiny single-component demo HTML files (test-fixture-shaped: one `<button>` + a styled background, ≤30 lines, no header/footer text). Doctrine forbids filename-pattern suppression but the structural shape is provable from the file (no `<header>`, no `<footer>`, ≤N text-tokens, ≤1 interactive control). Fix: when the file shape is provably "isolated component demo" (deterministic structural predicate), enrich `reason` with `couldBeWrongBecause: ["isolated_component_demo_page"]` so the agent dismisses faster. Reason-enrichment only — keep the candidate; surface evidence the agent verifies. Pairs with Q7-RULE-LANDMARK-MAIN-FRAGMENT-SCOPE (open, fragment-scope axis) — this is the demo-page-shape axis on the same rule.
- [ ] **Q8c-FINDER-EMPTY-HEADING-SKELETON-LOADER-COULDBEWRONG** `semantics/empty-heading` fires at `severity: error` on empty `<h3>` inside content-placeholder/skeleton-loader UIs (filled at runtime via `setTimeout(…, 'header.innerHTML = …')`). Reason doesn't acknowledge SPA loading patterns; severity remains error/high. Fix: when the file's same-shape sibling JS contains `innerHTML = …` / `textContent = …` writes targeting the empty-heading's id/class, enrich reason with `couldBeWrongBecause: ["runtime_innerhtml_population"]`. Reason-enrichment only — keep the finding. Pairs with V1-LIVE-REGION-RUNTIME-MUTATION-CANDIDATE (closed, status-message axis) — this is the heading-emptiness sibling axis.

#### Q8c — accepted (P1 — rule scope widening)

- [ ] **Q8c-RULE-INTERACTIVE-DIV-ROLE-MISSING-CROSS-FILE** When a `.js` file binds a click handler to a `<div>` / `<span>` / `<li>` / `<img>` resolved by selector, AND the target element in HTML has no `role` / `tabindex` / `aria-label`, emit a rule-side finding (not just a candidate). Observed pattern: a non-interactive element with a state-class receives a `dblclick` or `onclick` handler from a sibling script. Predicate is static-deterministic when the AST resolves the selector to a non-interactive tag. WCAG 4.1.2 + 2.1.1. Pairs with Q8-RULE-CROSS-FILE-CLICK-HANDLER-NON-INTERACTIVE (open, finder axis) — this is the rule-emission upgrade for the deterministic resolved-selector case.
- [ ] **Q8c-RULE-COLOR-CLASS-ACTIVE-STATE-UNANNOUNCED** Class-name idiom `.active`, `.selected`, `.checked` (toggled-state styling) on elements lacking `aria-pressed` / `aria-selected` / `aria-checked` is a 1.4.1 candidate the rule does not fire on. Observed pattern: an element with a state-class signaling color-only active state, no aria-state attribute, no text-state sibling. Fix: extend `color/meaning-by-color-only` to surface a review candidate when an element carries a state-class (`active`/`selected`/`checked`) AND no aria-state attribute AND no text-state sibling. WCAG 1.4.1 + 4.1.2. Pairs with Q8-COLOR-MEANING-BY-COLOR-ONLY-SEVERITY-CONTRADICTION (severity-axis closure) — this is the new state-class predicate.
- [ ] **Q8c-RULE-EXPANDED-DISCLOSURE-CLASS-COLLAPSED-PREDICATE** `aria/expanded-on-disclosure` fires on elements with framework `data-*-toggle="collapse"` attributes but misses class-only signal (`.collapsed` class without any data-* attribute) — common pattern in template catalogs. Fix: extend the rule predicate to recognize class-name `collapsed` / `expanded` toggling on `<button>` / `<a>` as disclosure evidence (additive to the data-* path), surface as candidate if not already a rule fire. WCAG 4.1.2. Pairs with V1-RULE-ARIA-EXPANDED-DISCLOSURE (closed, predicate axis) — this is the class-only widening.
- [ ] **Q8c-RULE-NESTED-INTERACTIVE-LINK-WITH-TEXT-AND-ICON** `navigation/link-descriptive-text` reason "every child is presentational (icon)" misclassifies `<a href="…"><i class="<icon>"></i> User Profile</a>` — text node sibling exists after the icon. Fix: the "every child is presentational" predicate must walk past the leading icon to the text node; when text is present, suppress the rule. Pairs with V1-FP-NESTED-INTERACTIVE-NONFOCUSABLE-OUTER (closed) — different rule, same composite-content predicate axis.

#### Q8c — accepted (P1 — new rules)

- [ ] **Q8c-RULE-PHP-MIXED-HTML-PARSER** Add `.php` to `PARSEABLE_EXTENSIONS` with HTML routing + PHP-island stripping (analogous to ERB / Liquid handling). Bulk catalog scan: 30 `.php` files with substantial HTML markup (DOCTYPE, body, nav, anchors) silently dropped via `extensions_skipped_no_parser`. PHP server-page templates carry a11y-relevant content. Fix: parser strips `<?php … ?>` / `<?= … ?>` blocks (literal text), routes the residue through the HTML parser; emit `php_islands_stripped` warning; rule-eligibility derives from parser registry (Q8-RULE-DUPLICATE-ID-PARSER-HTML pattern). Pairs with V1-PARSER-ERB (closed, sibling extension) and Q8-PARSER-ROUTING-JS-AS-TSX (parser-routing axis) — this is the new-extension addition.
- [ ] **Q8c-RULE-SVG-USE-XLINK-HREF-ICON-NAME** New rule `aria/svg-use-decorative-or-named`. Inline `<svg><use xlink:href="#icon-id" /></svg>` (or `<use href>`) with neither `aria-hidden="true"` nor accessible name (`<title>`, `aria-label`, `aria-labelledby`). Currently `semantics/svg-title-missing` only fires on standalone `.svg` files; inline `<svg><use>` icons in HTML are silently missed. Multiple corpora carry dozens. WCAG 1.1.1 + 4.1.2. Pairs with Q8-RULE-SVG-TITLE-INLINE-MARKUP (open, inline-svg axis) — this is the `<use>` element specialization.
- [ ] **Q8c-RULE-ALL-FORMS-LANDMARK-NAME** Cousin to `semantics/duplicate-landmark-unlabeled` (which fires speculatively per Q8-DUPLICATE-LANDMARK-UNLABELED-EMITS-ON-SPECULATION). Once the speculative composite is gated on confirmed sibling evidence, the genuine "every form on this page is unlabeled" case becomes a real finding worth a deterministic rule. Fix: surface `semantics/all-forms-unlabeled` rule for the in-file count ≥ 2 + zero `aria-label`/`aria-labelledby` deterministic case. WCAG 1.3.1 + 4.1.2. Pairs with Q8-DUPLICATE-LANDMARK-UNLABELED-EMITS-ON-SPECULATION (closure target) — this is the deterministic-emission cousin.

#### Q8c — accepted (P2 — finder fix-suggestion polish)

- [ ] **Q8c-FIX-DESCRIPTION-MARKDOWN-FOR-MD-FILES** `aria/role-from-class-only` finding's `suppressWith` field shows a JS line-comment pragma (`// ra11y-disable-next-line aria/role-from-class-only`) on a `.md` (markdown) file — JS-comment syntax renders as literal text in markdown output and would corrupt the rendered docs. Fix: when the file extension is `.md`/`.markdown`/`.mdx`, the suggested suppression pragma must be HTML-comment form (`<!-- ra11y-disable-next-line ... -->`) or JSX-comment form (`{/* ra11y-disable-next-line ... */}` for MDX). Pairs with the existing pragma syntax docs — this is the per-extension routing axis on `suppressWith`.
- [ ] **Q8c-PARSE-ERROR-REASON-LEAKS-FILE-CONTENT** SCSS parse-error reason text leaks raw multi-line file content as the "selector" token: `"SCSS nested selector \"/* Icon rotations & flippi*/\\n/* -----------------------*/\\n\\n.#\" under \"\" is too complex to flatten"`. The reason includes a comment block + newlines; agent reading the reason gets corrupted error context. Fix: sanitize selector tokens in error messages (strip newlines, truncate to ≤80 chars with `…` ellipsis). Pairs with V1-SIZE-LABEL-ECHO-CAP (closed, generic truncation helper) — this is the parse-error reason-text application of the same helper.
- [ ] **Q8c-EXTENSIONS-SKIPPED-NO-EXT-SCHEMA-SPLIT** `warningsDetails.extensions_skipped_no_parser.extensions: [..., "(no-ext)"]` mixes real extensions with the parenthesized sentinel for "no extension" files (LICENSE, COPYING, Makefile). Agent parsing the array as a glob/extension filter has to special-case the parenthesized form. Fix: split into `extensions: string[]` (dotted tokens only) + `noExtensionFiles: string[]` (well-known textual filenames inline: LICENSE / Makefile / Dockerfile) so the array stays type-honest. Pairs with Q8b-EXTENSIONS-SKIPPED-NO-EXT-BUCKET-NAMES-PATHS (bucket-naming axis) — this is the schema-shape axis on the same field.

---

## Track Q9 — Multi-corpus AI-first sweep (2026-04-25 evening, 4 corpora × 5 angles)

Field-test follow-ups from a 20-agent multi-corpus probe (CSS framework + static-site generator + vanilla mini-projects + bulk template gallery). Each item below was observed across ≥1 corpus during the round; recurrence counts noted inline. Items are bucketed by failure class. Net-new against Q8/Q8b/Q8c/V1; recurrence of already-named items folded into the existing rows there.

### Parser routing + coverage gaps

- [ ] **Q9-PARSER-INLINE-SCRIPT-BLOCK-IN-HTML-NOT-JOINED** `<script>…</script>` inline blocks inside `.html` files are not joined to surrounding markup for cross-element handler resolution; `keyboard/handler-missing` lists itself as eligible in `perRuleCoverage` but the inline body is never treated as a JS context. Recurring across CSS-framework + static-site corpora. Fix: parse inline `<script>` bodies and feed `addEventListener` / `onclick` resolutions back into the HTML rule pass; emit `inline_script_in_html_unparsed_for_handler_resolution` when the join is skipped. Pairs with Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS (cross-context resolution axis).
- [ ] **Q9-EXTENSIONS-SKIPPED-NO-PARSER-TOP-N-TRUNCATION** `warningsDetails.extensions_skipped_no_parser.extensions` caps at top-5 entries; bulk corpora skip 8+ distinct extension classes (`.php`, `.coffee`, `.ttf`, `.woff`, `.woff2`, `.eot`, `.otf`, `.psd`, `.htc`, `.ai`, `.pdf`) but only top-5 surface in the warning while the others remain silent in `meta.skippedByExtension`. Recurring across bulk corpora. Fix: enumerate ALL skipped extensions in the warning array (or add a `silentExtensionCount: N` sentinel naming the surplus). Per AI-first doctrine "Routing skips that drop content are the symmetric twin of suppression." Pairs with Q8-EXTENSIONS-SKIPPED-NO-PARSER-IMAGE-FILTER (filter-axis closed) — this is the truncation-axis follow-up.
- [ ] **Q9-PARSER-PHP-DROPS-EMBEDDED-HTML** `.php` files containing real HTML markup (forms, headings, images outside `<?php ?>` islands) are routed to `file-unsupported`; in one bulk corpus 30 `.php` files contain renderable HTML that scan_file silently rejects. Fix: when a `.php` file contains substantial HTML outside of `<?php ?>` blocks, strip the PHP islands and route the remainder through the HTML parser; alternatively add `.php` to the unsupported-with-context warning so the agent knows real HTML was dropped. Per AI-first doctrine "Routing skips that drop content are the symmetric twin of suppression."
- [ ] **Q9-MAP-SOURCEMAP-SILENT-EXCLUSION** `.map` sourcemap files (48 in one CSS-framework corpus) are silently dropped — not in `filesByExtension`, not in `extensions_skipped_no_parser`. Sourcemap exclusion is conventionally correct but should be declared as a structured warning so the agent can audit. Fix: add `sourcemap_files_excluded` warning code with `count` + `topPaths` + the exclusion rationale.
- [ ] **Q9-MIN-LINE-HEURISTIC-MISSES-MIN-JS-BUNDLES** `.min.js` single-line megabundles (e.g. `bootstrap.bundle.min.js` shipped in a CSS-framework corpus' `dist/`) escape `scannedBuildArtifacts` classification because the min-line predicate appears scoped to text/SVG only. Fix: extend the single-long-line classifier to `.js` files (one-long-line + size threshold + `.min.` filename token). Pairs with Q9-VENDOR-COPYRIGHT-BANNER-CLASSIFICATION (sibling vendor-detection axis).
- [ ] **Q9-SCAN-FILE-MIN-CSS-NO-CLASSIFICATION** `scan_file` on `.min.css` produces findings WITH NO `scannedBuildArtifacts` classification or `scanned_minified_file` warning, even though `scan_project` on the same file flags it as a build artifact. Cross-tool routing inconsistency. Fix: scan_file must apply the same min-line classifier and emit the same warnings as scan_project on identical input. Per AI-first doctrine "Cross-surface count invariant" (warning-telemetry analogue).
- [ ] **Q9-LINKED-MIN-CSS-NOT-CONSULTED-FROM-HTML** `.html` files linking `.min.css` are not transitively pulled into contrast-rule resolution (CSS-framework corpus: 14 `.html` files link bootstrap.min.css; HTML scan does not consult the linked sheet for token resolution). No warning emitted that the linked stylesheet was not consulted. Fix: emit `linked_stylesheet_not_resolved_for_contrast` warning naming the unresolved `<link href>` paths so the agent can scope a follow-up; deferring full resolution is acceptable, silent omission is not.
- [ ] **Q9-PARSER-BAILED-NON-JSX-IN-TSX-WARNING-ABSENT** Doctrine names `parser_bailed_on_non_jsx_in_tsx_route` as the canonical telemetry code but no warning fires when `.js` is routed through the tsx parser cleanly (no bail). Vanilla-JS corpora confirm `parseModeByExtension['.js'] === 'tsx'` with no warning emission. Fix: emit the warning whenever a `.js` file successfully parses via the tsx route — the agent can then decide whether to trust the result or scope around it. Telemetry-only; no behavioral change. Per AI-first doctrine "Routing skips that drop content are the symmetric twin of suppression."
- [ ] **Q9-SCSS-UNRESOLVED-VARIABLES-NO-COVERAGE-DOWNGRADE** `scss_unresolved_variables.files` (31 `.scss` files in one CSS-framework corpus) does NOT propagate to per-rule `coverageConfidence` downgrades for color-token / focus-token-driven rules (`contrast/*`, `focus/outline-visible`). Fix: when a file appears in `scss_unresolved_variables.files`, downgrade `perRuleCoverage[contrast/*][file].coverageConfidence` to `"medium"` with `reason: "scss_unresolved_variables"`. Same shape as parse-failed propagation. Per AI-first doctrine "Parser-failure invalidates per-file confidence" (extends to value-resolution failure).

### Per-rule / per-finding confidence drift

- [ ] **Q9-PERRULECOVERAGE-PARSE-ERROR-PER-FILE-NOT-CORPUSWIDE** A single parse-error file (1 of 429 in static-site corpus, 0.23%) blanket-degrades EVERY rule's per-rule confidence to `"low"` with `reason: "file-parse-error"`, regardless of which file each rule actually ran on; per-finding confidence on emitted rules stays `"high"/"error"`. The corpus-wide degradation is dishonest in two directions at once — over-pessimistic on rules that didn't touch the bad file, under-honest on rules that did. Fix: per-rule confidence must be per-rule-per-file (`perRuleCoverage[r].byFile[path].confidence`), not corpus-aggregated; the response-level scalar should fold from those.
- [ ] **Q9-META-PERRULECOVERAGE-DROPPED-NO-SENTINEL** When `meta.perRuleCoverage[]` is silently dropped under `response_meta_truncated`, the agent cannot distinguish "no per-rule coverage exists" from "meta was clipped." CSS-framework corpus observed. Fix: when a meta sub-field is dropped under truncation, replace it with a sentinel (`{truncated: true, fieldDroppedReason: "..."}` or pair with `warningsDetails.response_meta_truncated.fields: ["perRuleCoverage[]"]`) so absence is visible. Pairs with Q8-RESPONSE-META-TRUNCATED-FIELD-DETAIL (the warning-detail axis is open already; this is the in-place sentinel axis).
- [ ] **Q9-FRAGMENT-CLASSIFICATION-CROSS-SURFACE-DRIFT** `scan_file` returns `fragmentFiles[]: true` on `_includes/header.html` etc.; `scan_project` on the same files returns `fragmentFiles[]: false` (or omits the file). Recurring across CSS-framework + static-site corpora. Same root invariant as cross-surface count drift. Fix: shared fragment-classifier helper consumed by both surfaces; integration test pinning equality on identical input. Per AI-first doctrine "Cross-surface count invariant."

### Cross-surface count + warning drift

- [ ] **Q9-PARSE-COVERAGE-FILE-RESHUFFLE-BULK-ONLY** Bulk corpus shows `parseErrorFileCount` and `partialParseFileCount` reshuffling between buckets across surfaces (scan_project: 100/105 ; checklist+coverage: 92/113) with totals matching (205==205) — files migrate between bucket labels even though the union is stable. Narrow-scope agrees. Fix: shared parse-coverage helper consumed by both surfaces; integration test pinning per-bucket equality on the same cwd. Per AI-first doctrine "Cross-surface count invariant" (per-bucket axis).
- [ ] **Q9-COUNTSBYSURFACE-3-WAY-DISAGREEMENT** `scan_project.meta.countsBySurface` ships three disagreeing finding totals (`{plan:85, perRuleCoverage:86, filesSurface:85}`) within ONE response on a vanilla corpus. The 3-way variant of the worst-case 4-way spread the doctrine names. No narration of which is canonical. Fix: either reconcile the three (a single shared finding-count helper) or annotate each entry with what it includes (`{plan: {count, includes}, perRuleCoverage: {count, includes}, filesSurface: {count, includes}}`). Pairs with Q8b-COUNTSBYSURFACE-MULTI-DISAGREEMENT-HEADLINE (open, 4-way axis); this is the 3-way recurrence.
- [ ] **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** `scanned_build_artifacts_present` / `scanned_minified_file` / `bulk_catalog_detected` only ship on `scan_project`; `checklist` and `coverage` on the identical bulk-vendor cwd produce neither warning nor `warningsDetails` entry. Agent calling `checklist` first on a bulk corpus has zero signal that 996 minified files exist. Fix: every project-rooted tool emits the same scan-confidence warning telemetry on identical cwd. Per AI-first doctrine, this is the warning-telemetry analogue of the cross-surface count invariant — worth promoting to a sub-rule of that bullet (see Q9-DOCTRINE-CROSS-SURFACE-WARNING-INVARIANT).
- [ ] **Q9-COVERAGE-CRITERIA-AUTOMATABLE-DRIFTS-NARROW-VS-BULK** `coverage.criteriaAutomatable` reports 32 at narrow scope vs 34 at bulk on the same standard/level. Should be standard-fixed metadata, not corpus-derived. Fix: route `criteriaAutomatable` from the standard-module registry, not from `(rules ∩ files)` evaluation; integration test pinning equality across narrow/bulk on the same standard.
- [ ] **Q9-SCAN-PROJECT-OMITS-PARSE-COVERAGE-COUNTERS** `scan_project` omits `parseErrorFileCount` / `partialParseFileCount` / `fragmentFileCount` entirely while `coverage` exposes them. Agent reading `scan_project` alone cannot tell whether 0 parse errors or telemetry-not-collected — same shape as the doctrine `Zero-output success is ambiguous failure` ambiguity but at the field level. Fix: either always populate the three counters on `scan_project.meta` (defaulting to `0` when telemetry was collected) or omit-when-meaningful with conditional spread + a `warnings: ["parse_coverage_telemetry_skipped"]` companion; ambiguous absence is not acceptable. Per AI-first doctrine "Ambiguous field shapes are dishonest."
- [~] **Q9-VERIFYINSOURCE-COMPOSITE-HEADLINE-DISHONESTY** `plan.fixesByClass.verifyInSource: 254` ships next to `plan.actionableManualItems: 7` (vanilla corpus); `verifyInSource` sums all rule emissions whose fix lane is guidance-only — agent reading the headline budgets against 254 not the ~50 grounded checklist totalCandidates. Same shape as the documented `fixesByClass.mechanical:266` vs `safeEditsAvailable:14` case (closed by deletion). Fix: verify `verifyInSource` measures one concept; if it sums actionable-with-file-line + non-actionable-prose, split into two siblings (`verifyInSourceGrounded` + `verifyInSourcePromptOnly`) and stop summing. Per AI-first doctrine "Composite headline counts are dishonest" worked precedent. **classification_mismatch_premise_false (verified by general-purpose specialist 2026-04-26):** the proposed Grounded/PromptOnly split keys on fixPaths.primary.edit presence — the exact payload-availability axis the deleted plan.safeEditsAvailable composite measured (closed by Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT, CHANGELOG.md line 50). Re-introducing it under verifyInSource{Grounded,PromptOnly} would re-create the dishonest shape the doctrine deleted: two siblings keyed off different axes (rule-demanded lane vs. payload presence) framed as 'how much verifyInSource work.' Premise that verifyInSource 'sums all rule emissions whose fix lane is guidance-only' is also factually inaccurate — it sums emissions whose rule declares fixClass: 'verify-in-source', including the 5/69 rules that DO ship inline fixPaths.primary.edit (lang-attribute, button-name, inline-display-none-on-focusable, expanded-on-disclosure, hidden-focus). fixesByClass answers 'which remediation lane does the rule route into?' — one kind per key; payload availability is orthogonal and intentionally NOT surfaced after the safeEditsAvailable deletion. Closure: TSDoc enrichment on FixesByClass.verifyInSource pre-empting the 'apply-fix can act on each' misreading is the durable answer if any closure is needed.

### suggest_fix shape + correctness bugs

- [ ] **Q9-SUGGEST-FIX-MISSING-ALTERNATIVES-ARRAY** `suggest_fix` returns `kind: "guidance"` / `spec_restatement` with NO `alternatives` array; schema promises primary+alternatives and only primary returned. Explanation duplicates the rule's own `message` verbatim — no per-call enrichment. Recurring across CSS-framework + static-site corpora. Fix: when `kind === "guidance"`, populate `alternatives` with at least one per-call enrichment shape (suppression pragma form, citation link, "verify by reading" prompt) so the slot isn't a phantom; OR omit the field via conditional spread when no alternatives exist. Per AI-first doctrine "Ambiguous field shapes are dishonest."
- [ ] **Q9-SUGGEST-FIX-WRONG-ATTRIBUTE-ARIA-EXPANDED-VS-CONTROLS** `aria/expanded-on-disclosure` fires "missing aria-expanded"; suggest_fix returns "Add aria-controls" — rule predicate name and fix attribute don't agree. Element already carries `aria-expanded="false"` in some cases. CSS-framework corpus, dropdown trigger. Fix: assert rule emission and suggested fix attribute name match for the disclosure-attribute family (`aria-expanded` / `aria-controls` / `aria-haspopup`); when the rule fires on the absence of `aria-expanded`, the suggested fix must add `aria-expanded`, not `aria-controls`.
- [ ] **Q9-SUGGEST-FIX-NESTED-INTERACTIVE-A-TO-BUTTON-IGNORES-PARENT** `suggest_fix` recommends changing `<a>` to `<button>` inside `<ul class="dropdown-menu">` (or any ancestor whose role contract requires anchor-shaped descendants). Replacing the anchor would break documented dropdown structure and ARIA semantics. CSS-framework corpus. Fix: before recommending an element-tag swap, walk ancestors and gate the suggestion on absence of a structural-ancestor constraint (`<ul role="menu">`, `<select>`, `<datalist>`, `<table>` etc.); when a constraint exists, surface it in the reason and propose the within-constraint alternative.
- [ ] **Q9-SUGGEST-FIX-NATIVE-BUTTON-ADDS-KEYDOWN-HANDLER** `keyboard/handler-missing` FP on `const btn = document.createElement('button'); btn.addEventListener('click', ...)`; suggest_fix recommends adding a keydown handler with `preventDefault` on Space — would break native Space activation and introduces a NEW violation. Vanilla corpus. Fix: suggest_fix must check whether the addEventListener receiver resolves to a native interactive element (button, a[href], input, select, textarea); when it does, refuse to recommend a keyboard-handler addition and either suggest dismissal-via-pragma or surface "no fix needed — native element handles keyboard" as the primary path. Pairs with Q9-RULE-KEYBOARD-HANDLER-FP-NATIVE-BUTTON-CREATE-ELEMENT (rule-side closure).
- [ ] **Q9-SUGGEST-FIX-PLACEHOLDER-LABEL-IGNORES-VISIBLE-LABEL** `forms/labels-required` fires; suggest_fix uses placeholder `<label for="field">Label</label>` instead of the visible adjacent `<label>Email</label>` already present in the same DOM subtree. Vanilla corpus, multiple form-input demos. Fix: when suggesting `for=` wiring, scan adjacent siblings (within parent + immediate-prev/immediate-next) for an existing `<label>` element with usable text content and use that text in the suggested fix; reserve generic "Label" placeholder for the case where no visible label exists.
- [ ] **Q9-SUGGEST-FIX-VENDOR-CONTRAST-RECOLOR** `contrast/minimum` fires on vendor `bootstrap.css`; suggest_fix recommends recoloring `.text-muted` in the unminified vendor stylesheet. No awareness the file is third-party. Bulk corpus. Fix: gate suggest_fix on `meta.scannedBuildArtifacts` membership — when the target file is classified as a build artifact, return guidance shaped as "this file is third-party; consider overriding the rule in your own stylesheet OR upgrading the vendor library" rather than a direct edit. Pairs with Q9-VENDOR-COPYRIGHT-BANNER-CLASSIFICATION (vendor detection axis) — fix follows once classification is honest.
- [ ] **Q9-SUGGEST-FIX-WRONG-FOR-TEMPLATE-DIRECTIVE-CONTENT** `semantics/empty-heading` on `<h4>{{ section.title }}</h4>` produces suggest_fix "fill `<h4>` with primary section title" (already filled via the template binding); `parsing/duplicate-id` on a markdown fragment suggests "Add id=output" when `#output` is generated by the markdown adapter from a later `## Output` heading. Static-site corpus, 6+ cases. Fix: suggest_fix must detect templating-directive presence in the target node (`{{ }}`, `{% %}`, `${ }`, `<%= %>`, ERB, JSP) and reframe the primary path as "verify the binding resolves to non-empty text at render time" rather than "hard-code a value." Pairs with the existing template-aware reason-text rules on `semantics/empty-heading`.

### Heuristic-mislabeled meta sub-fields

- [ ] **Q9-MINIFIED-LABEL-MISLABELS-SVG-FONTS** `scanned_minified_file` mislabels SVG fonts (FontAwesome-style: hand-authored vector glyph paths with long lines). Recurring across 3 corpora; bulk corpus 122/996 minified-flagged files (12%) are SVG fonts. Fix: refine heuristic — SVG content with `<font>` element, `<glyph>` elements, or pretty-printed line-count > 100 and authored copyright header should NOT be classified `"minified"`. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest." Pairs with Q8-SCANNED-BUILD-ARTIFACTS-MINIFIED-SVG-LABEL (the inline-SVG-extension carve-out) — this is the SVG-FONT-specific recurrence.
- [ ] **Q9-MINIFIED-LABEL-MISLABELS-LONG-LINE-SCSS** `scannedBuildArtifacts[].reason: "minified"` (or `likely-vendored-data-url-css`) fires on hand-authored 1350-line SCSS files (e.g. `_style.scss` opening with `/* Base */` block and a single inline `data:image/...` marker triggering the data-url heuristic). CSS-framework corpus. Fix: require token-cooccurrence (data-url + line-stats + sourcemap-sibling-presence) instead of any single-marker firing; surface the underlying signals (`dataUrlByteCount`, `medianLineLength`, `sourcemapSiblingExists`) as additive evidence the agent can read without the deterministic-sounding label. Pairs with Q8-SCANNED-BUILD-ARTIFACTS-DATA-URL-GRADIENT-LABEL (open, the gradient-token axis) and Q8b-MINIFIED-LABEL-NEEDS-DISCRIMINATOR-AXIS (open, the discriminator axis).
- [ ] **Q9-SCANNED-BUILD-ARTIFACTS-TOP-N-WITH-REASONS-AT-DEFAULT** `scanned_build_artifacts_present` ships `{count: 997, topPath: "...jquery-1.10.2.js"}` with no array, no per-file reason at default verbosity; `verboseMeta: true` unlocks the array but default-verbosity callers cannot audit reason tokens. Bulk corpus. Fix: ship top-10 `{path, reason}` inline at default verbosity — sufficient for the agent to dismiss "vendor-and-vendor-only" cases in one read; the long-tail array stays gated behind verboseMeta. Pairs with V1-TOOL-VERBOSE-META-INVERTED-DEFAULT (open, the verbose-default inversion).
- [ ] **Q9-TEMPLATE-DIRECTIVES-LIQUID-AS-HANDLEBARS** `templateDirectivesFound: ["handlebars-or-mustache"]` fires on Liquid `{{ }}` interpolation (which shares brace syntax with handlebars/mustache but is a distinct dialect). Static-site corpus. Fix: token co-occurrence required (`{% ... %}` Liquid tag tokens vs `{{# ... }}` handlebars block-helper tokens) before stamping a dialect label; absent disambiguating evidence, surface `templateInterpolationFound: { token: "{{x}}", count: N }` and let the agent disambiguate. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest." Pairs with V1-TEMPLATE-CLASSIFIER-LIQUID-PIPE-FILTER-EVIDENCE (closed, the pipe-evidence axis) and Q8-TEMPLATE-DIRECTIVES-HANDLEBARS-OR-MUSTACHE-DIALECT (open).

### Reason-severity mismatches (recurring)

- [ ] **Q9-MOTION-PAUSE-STOP-RUNTIME-CONCESSION-AT-WARNING** `motion/pause-stop-hide` reason concedes `"verify keyboard focus + announcement carry pause semantics before dismissing"` while severity stays `"warning"`. Recurring. Closure: move to review-candidate. Per AI-first doctrine "Reason text and severity must agree." Pairs with Q8b-MOTION-PAUSE-STOP-USER-TRIGGERED-CITATION (open, the citation-honesty axis).
- [ ] **Q9-COLOR-MEANING-VISUAL-STYLE-AT-ERROR** `color/meaning-by-color-only` emits at `error` on `<button class="btn-success">Search</button>` and `<button class="btn-danger">Take this action</button>` — visual class names without status semantics; in the second case, the parent `<div role="alert" class="alert alert-danger">` already conveys danger context. Recurring across 4 corpora (2-5 cases per corpus). Closure: rewrite reason to "color may still be the *sole* cue for users with dark/high-contrast themes that override class colors" OR gate predicate on absence of parent live-region / role=alert announcement. Per AI-first doctrine "Reason text and severity must agree."
- [ ] **Q9-IN-PAGE-LINK-FRAGMENT-FRAGMENT-FILE-CONCESSION** `navigation/in-page-link-fragment-missing` reason: `"anchor links to fragment #X but no element with that id exists in this document. Verify the id is added or correct the href."` ships at `severity: "warning"` even when the host file is fragment-classified (`_includes/_partials/`) and the id may be supplied by the parent layout. Closure: move to review-candidate when host file is fragment-classified (composes with Q9-FRAGMENT-CLASSIFICATION-NO-PER-RULE-DOWNGRADE).
- [ ] **Q9-EXPANDED-ON-DISCLOSURE-SR-ONLY-CHILD-CONCESSION** `aria/expanded-on-disclosure` reason: `"(note: element has a visually-hidden text child (.sr-only) — if that is the disclosure label, verify the accessible name is complete..."` ships at `severity: "error"`. Bulk corpus. Closure: rewrite reason to surface what is *actually* still in question, OR move to review-candidate. Per AI-first doctrine "Reason text and severity must agree."

### Rule predicate gaps (false negatives)

- [ ] **Q9-RULE-FOCUS-OUTLINE-BOXSHADOW-VAR-UNRESOLVED** `focus/outline-visible` trusts `box-shadow: 0 0 0 var(--focus-width)` as a sufficient replacement focus indicator even when the CSS variable is unresolved (no token resolution available). CSS-framework corpus, `_navbar.scss:166`. Fix: when a `box-shadow` value contains an unresolved `var(...)`, degrade `coverageConfidence` for the rule on that file to `medium` with `reason: "focus_replacement_uses_unresolved_css_var"`; do not silently credit the unresolved var as a valid replacement. Per AI-first doctrine "Heuristic emission is the symmetric twin of heuristic suppression" (over-trusting evidence is the same predicate-strength mistake).
- [ ] **Q9-RULE-POPOVER-TOOLTIP-TRIGGER-DISCLOSURE** No rule fires on popover/tooltip triggers (`data-bs-toggle="popover"`, `data-bs-toggle="tooltip"`, and other component-library toggle attributes) missing `aria-haspopup` / `aria-expanded`. `aria/expanded-on-disclosure` is gated to `data-bs-toggle="dropdown"` / `"collapse"`. CSS-framework corpus. Fix: extend the disclosure predicate or add a new rule `aria/popover-trigger-missing-haspopup` covering the tooltip/popover toggle vocabulary. Satisfies wcag22:4.1.2.
- [ ] **Q9-RULE-ARIA-LIVE-MISSING-ON-INNERHTML-TARGET** No rule pairs `innerHTML` / `textContent` mutations in `setInterval` / `setTimeout` / event handlers with the target element's missing `aria-live` / `role="status"` / `role="alert"`. Vanilla corpus, `insect-catch-game` updates `#score` / `#time` via `innerHTML` in `setInterval` but neither node has live-region semantics. Fix: add a rule targeting `<el id=X>` where sibling JS contains `document.getElementById(X).innerHTML =` (or `.textContent =`) inside a recurring scheduler; require `aria-live` / `role=status` / `<output>` on the target. Satisfies wcag22:4.1.3 (Status Messages). Pairs with Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS (parser-recursion axis required for cross-context resolution).
- [ ] **Q9-RULE-CROSS-FILE-CLICK-HANDLER-DYNAMIC-NON-INTERACTIVE** No rule detects clickable-div pattern when the click target is created dynamically and wired in a separate JS context (e.g. `insect.addEventListener('click', catchInsect)` on dynamically-created `<div class="insect">`). Vanilla corpus. Fix: cross-check JS-attached click target's resolved kind in the rendered markup (or via cross-file resolution), not only the static-text absence-of-keyboard-sibling signal. Pairs with Q8-RULE-CROSS-FILE-CLICK-HANDLER-NON-INTERACTIVE (open, the static-DOM axis); this is the dynamic-creation extension. Satisfies wcag22:2.1.1 + 4.1.2.
- [ ] **Q9-FINDER-2.5.7-DRAG-EVENTS** No finder fires on SC 2.5.7 (Dragging Movements) for elements wiring `dragstart` / `dragenter` / `dragover` / `drop` event listeners. Vanilla corpus, `drag-n-drop` exercise has 6 native HTML5 drag handlers; SC 2.5.7 absent from `items` / `untargetedCriteriaList` / `likelyIrrelevantCriteria`. Fix: add a review-candidate finder for SC 2.5.7 detecting `addEventListener('dragstart'|'drop'|...)` calls; reason frames the question (`single-pointer alternative — verify a click/keyboard alternative exists`). Satisfies wcag22:2.5.7.
- [ ] **Q9-FINDER-2.5.1-MOUSE-ONLY-PATTERNS** No finder fires on SC 2.5.1 (Pointer Gestures) for `mousedown` / `mousemove` / `mouseup` patterns lacking `touchstart` / `pointerdown` fallbacks. Vanilla corpus, `drawing-app` uses mouse-only events. SC 2.5.1 absent from candidates. Fix: add a review-candidate finder detecting mouse-event listener patterns without sibling pointer/touch listeners; reason frames the question (`pointer-event compatibility — verify touch/pointer fallback exists`). Satisfies wcag22:2.5.1.

### Rule predicate too-broad (false positives)

- [ ] **Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON** `keyboard/handler-missing` FP on cross-file resolved native button (e.g. `document.querySelector('#send')` resolves to `<button id="send">` in sibling `.html`). Confidence:high + severity:error. 4/4 cases tested in vanilla corpus. Per Q9-PERFINDING-COULDBEWRONG-EMPTY-WHEN-PERRULE-DEGRADED — paired drift class. Fix: when cross-file listener resolution is degraded (per `perRuleCoverage`), per-finding emissions on candidate native-element targets must downgrade `confidence` to `medium` and surface the limitation in `couldBeWrongBecause`.
- [ ] **Q9-RULE-CROSS-TEMPLATE-3.2.3-HEURISTIC** Cross-template `wcag22:3.2.3` heuristic treats N unrelated sub-template directories as one site (bulk corpus: 174 sub-template-dirs evaluated jointly). The reason itself flags the heuristic. Fix: gate cross-template comparison on a configured `processes: []` config primitive OR a sibling-detection threshold (max N templates per cross-comparison), and either suppress the predicate or move to review-candidate when the heuristic is unsafe.

### nextStep routing dishonesty

- [ ] **Q9-TRUNCATED-FILES-DROPPED-COUNT-WARNING** Truncated responses drop file-level findings without a per-rule index of what was dropped. Static-site corpus: `warnings: ["response_meta_truncated"]` ships but no `truncated_files_dropped_count` code names how many files lost coverage; topline counts disagree with returned file findings, forcing scan_file follow-ups. Fix: add a structured `truncated_files_dropped` warning naming `{droppedFileCount, ruleFamiliesAffected: ["..."], topDroppedRules: [{ruleId, droppedCount}]}` so the agent can decide whether to re-scope or re-call with `verboseMeta: true`. Per AI-first doctrine "Oversize-success is ambiguous failure" (file-level analogue).

### Templating-driven false positives

- [ ] **Q9-LINK-DESCRIPTIVE-TEXT-TEMPLATE-EXPRESSION-CONTENT** `navigation/link-descriptive-text` fires on `<a>{{ post.title }}</a>` (template-directive-only content). Same shape as Q9-EMPTY-HEADING-TEMPLATE-EXPRESSION-CONTENT, recurring across 4 files in one static-site corpus. Fix: when the anchor's only child is a template directive, promote to review-candidate with reason framing the binding-resolves question. Per AI-first doctrine — cross-rule consistency with the `semantics/empty-heading` template-aware fix. Pairs with Q8-LINK-DESCRIPTIVE-TEXT-TEMPLATE-AWARE-REASON (open, the reason-text axis).

### Pragma extension mismatch

- [ ] **Q9-SUGGESTWITH-PER-EXTENSION-PRAGMA-FORM** `suggestWith` ships only the `<!-- ra11y-disable -->` HTML-comment pragma form; candidates emit on `.scss` / `.css` / `.js` files where HTML-comment syntax is invalid and would corrupt source. Recurring across 3 corpora. Fix: extend `suggestWith` to ship per-extension pragma forms — `/* ra11y-disable */` for `.css` / `.scss` / `.sass` / `.less` / `.js` / `.ts`, `{/* ra11y-disable */}` for `.jsx` / `.tsx` / `.mdx`, `<!-- ra11y-disable -->` for `.html` / `.htm` / `.xhtml` / `.markdown` / `.md`. Pairs with Q8c-FIX-DESCRIPTION-MARKDOWN-FOR-MD-FILES (open, markdown-axis already named) — this is the across-file-extensions superset.

### 2026-04-26 round recurrences (folded onto existing Q9 rows)

Each line: `Q9 row id — N recurrences observed in 2026-04-26 round, evidence summary`. The 2026-04-26 sweep replayed the 4-corpora × 5-angles probe; items below recurred without behavior change against the same Q9 closure framing, so this round folds them as recurrence counts rather than new rows.

- **Q9-MINIFIED-LABEL-MISLABELS-SVG-FONTS** — +2 recurrences: hand-authored single-line SVG brand assets mislabeled `minified` AND `scanned_build_artifacts_present.topPath` points at the same hand-authored SVG (sibling-warning axis).
- **Q9-MINIFIED-LABEL-MISLABELS-LONG-LINE-SCSS** — +1 recurrence: hand-authored 1350-line SCSS flagged `likely-vendored-data-url-css` solely on inline `url(data:image/...)` marker presence; mislabel compounds with suggest_fix vendor-redirect (see Q10-SUGGEST-FIX-VENDOR-REDIRECT-COMPOUNDS-MISLABEL).
- **Q9-TEMPLATE-DIRECTIVES-LIQUID-AS-HANDLEBARS** — +1 recurrence: `templateDirectivesFound` emits `handlebars-or-mustache` on a corpus where 100% of `{{ }}` usage is Liquid-style templating (verified by `{{ var | filter }}` and `{% include %}` co-occurrence).
- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +4 recurrences (all 4 corpora): scope-level warnings (`scanned_build_artifacts_present`, `scanned_minified_file`, `bulk_catalog_detected`, `response_dropped_files_oversize`, `scss_unresolved_variables`, `response_token_budget_truncated`) silently absent from `checklist` and partially absent from `coverage` on identical cwd; widest spread on the bulk-template corpus (5 codes drop on checklist).
- **Q9-PERRULECOVERAGE-PARSE-ERROR-PER-FILE-NOT-CORPUSWIDE** — +1 recurrence: single parse-error file (1 of 410) blanket-degrades 92 of 104 perRuleCoverage entries to `low`, including rules whose `filesEvaluated/filesEligible == 408/410`.
- **Q9-FRAGMENT-CLASSIFICATION-NO-PER-RULE-DOWNGRADE** — +2 recurrences: document-shaped rules (`semantics/landmark-main`, `semantics/heading-hierarchy`, `document/page-titled`, `document/lang-attribute`) report `coverageConfidence: "high"` on fragment-only inputs; per-rule coverage not downgraded on partial-parse files (sibling axis — partial-parse twin of the fragment-files variant).
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +3 recurrences: post-clip envelope still exceeds host cap on multiple bulk corpora — 87KB after clipping to 2 files; 86KB at default `limit=25` on a 156-file corpus; 120KB after the minimum-honest envelope already engaged (post-clip transport-rejected on a 567MB corpus).
- **Q9-PARSE-COVERAGE-FILE-RESHUFFLE-BULK-ONLY** — +1 recurrence: scan_project 100/105, checklist 92/113, coverage 92/113 for parseError/partialParse on identical cwd — bucket reshuffle observed at three-tool spread, not just the original two-tool spread.
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: `nextStepStructured` routes to a fragment markdown file whose evidence is medium-confidence; routes to an underscore-prefixed scaffold-directory `index.html` ahead of higher-impact `topRules[0]` findings on a non-truncated response.
- **Q9-NEXTSTEP-CWD-ECHOES-CALLER-AFTER-DROP** — +2 recurrences: `nextStepStructured` echoes original cwd verbatim after `response_dropped_files_oversize` + `response_token_budget_truncated`; `bulk_catalog_detected.suggestedExcludes` already carries concrete narrowing tokens that `nextStepStructured` fails to propagate.
- **Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS** — +1 recurrence: multiple `.js` files inject HTML strings via `element.innerHTML = \`...\`` and `insertAdjacentHTML(\`<i class='fa…'>\`)`; no `js_innerhtml_template_literal_unparsed` warning fires; `media/alt-text-missing`, `navigation/link-target-blank-announcement`, `semantics/button-name` produce zero findings on injected widgets.
- **Q9-COUNTSBYSURFACE-3-WAY-DISAGREEMENT** — +1 recurrence: `countsBySurface = {plan:359, perRuleCoverage:369, filesSurface:359}` consistent across `offset=0/75/100` pages — 10-finding silent gap.
- **Q9-PERFINDING-COULDBEWRONG-EMPTY-WHEN-PERRULE-DEGRADED** — +1 recurrence: `keyboard/handler-missing` per-rule confidence `medium` with `cross_file_listener_resolution_limited_on_this_input` reason while every per-finding emission ships `confidence: high, severity: error, couldBeWrongBecause: null` — the canonical case from 2026-04-25 third-pass sweep recurs unchanged.
- **Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON** — +1 recurrence: rule fires error/high on JS `addEventListener('click', ...)` calls whose target selector resolves to a native `<button>` in the sibling HTML file the same scan parsed; 4 confirmed FPs on a one-hop selector lookup the scanner already has the AST for.
- **Q9-RULE-HREF-EMPTY-FRAGMENT-FP-IN-DOCS-EXAMPLE-PROP** — +1 recurrence: `navigation/href-empty-fragment` fires 1284 times on documentation `.mdx` pages where `<a href='#'>` lives inside JSX template-literal `code` props — dominant rule fire crowds out real findings under the truncation cap.
- **Q9-RULESBYEXTENSION-DUP-PAYLOAD** — +1 recurrence: byte-identical `rulesFiredByExtension` and `rulesByExtension` ship together (~half the meta payload); deprecation warning has no `warningsDetails` entry naming the alias-removal version.
- **Q9-EXTENSIONS-SKIPPED-NO-PARSER-TOP-N-TRUNCATION** — +1 recurrence: `.cjs` extension hits `extensions_skipped_no_parser` and is silently dropped while sibling `.js` routes through tsx — JS-vs-CJS split is module-system metadata, not parser-evidence.
- **Q9 mid-word truncation preamble** — +2 recurrences: `suggest_fix.primary.approach` truncates at exactly 80 chars mid-word with ellipsis sentinel while `primary.explanation` carries the full uncapped string; observed across 5+ rules including `document/lang-attribute`, `forms/labels-required`, `color/meaning-by-color-only`, `semantics/landmark-main`.

---

## Track Q10 — Multi-corpus AI-first sweep (2026-04-26 round, 4 corpora × 5 angles)

Field-test follow-ups from a 20-agent multi-corpus probe (CSS framework + static-site generator + vanilla mini-projects + bulk template gallery). Each item below is **net-new** against Q9; the substantial fraction of this round's findings that recurred without behavior change against existing Q9 closure framings folded as recurrence counts under the Q9 "2026-04-26 round recurrences" subsection above. Items are bucketed by failure class.

### Parser routing + coverage gaps

- [ ] **Q10-FRAGMENTFILES-CLASSIFIES-FULL-PAGE-LAYOUT-AS-FRAGMENT** Full-page layout files whose source opens with frontmatter-only-then-markup are tagged `fragmentFiles` even though they render as full HTML documents at build time; document-shaped rules silently downgrade. The fragment label is a heuristic dressed as a deterministic classification. Fix: require token co-occurrence (no `<html>` opener AND no layout-include directive AND not in a known layouts dir) before stamping the fragment label; surface the underlying signals as additive evidence. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest."
- [ ] **Q10-SCSS-PARTIALS-MISLABELED-AS-PARSE-ERROR-NOT-FRAGMENT** SCSS partials (`_*.scss` declaring `&.foo` selectors intended for inclusion in another file) ship as `parseErrorFiles` rather than fragment-classified, inflating parse-error counts and routing the agent toward "fix the parse error" instead of "this is a fragment, route around it." Fix: classify SCSS partials (`_`-prefixed basename + presence of dangling `&` parent-references) as fragments; add a `scss_partial_input` reason on per-rule confidence rather than treating the bail as a hard parse error. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest."
- [ ] **Q10-LINK-TARGET-BLANK-APPLIESTO-EXCLUDES-ERB-MD-RESIDUE** `navigation/link-target-blank-announcement` `appliesTo.fileExtensions` is hardcoded to `['.html','.htm','.tsx','.jsx']`; ERB and markdown files with embedded `<a target="_blank">` parse as html but cannot be evaluated by the rule. Fix: extend `appliesTo.fileExtensions` to every extension whose `parseModeByExtension` resolves to `html`. Per AI-first doctrine "Routing skips that drop content."
- [ ] **Q10-IE-CONDITIONAL-HTML-LANG-NOT-FLAGGED** `document/lang-attribute` silently does not fire on files whose `<html lang="...">` is declared only inside `<!--[if IE]>` conditional comments — the parser elides the conditional but the rule does not surface a `couldBeWrongBecause: ["html_element_inside_ie_conditional_comment"]`. Fix: detect the IE-conditional `<html>` pattern and either fire the rule (real false negative — assistive tech receives the bare `<html>`) or emit a finding with the cited `couldBeWrongBecause` token so the agent can investigate. Per AI-first doctrine "Routing skips that drop content."

### Per-rule / per-finding confidence drift

- [ ] **Q10-COVERAGE-PERRULECOVERAGE-EMPTY-VS-SCAN-FILE-FULL** `coverage` with `verboseMeta: true` ships an empty `perRuleCoverage[]` while `scan_file` on the same input ships ~95 rows; the doctrine's parser-failure-invalidates-confidence invariant is unauditable from the canonical confidence-dashboard tool. Fix: shared per-rule-coverage helper consumed by both surfaces; integration test pinning row-count parity on identical input. Per AI-first doctrine "Cross-surface count invariant."

### Cross-surface count + warning drift

- [ ] **Q10-DEPRECATION-WARNING-ASYMMETRIC-ACROSS-SURFACES** `deprecated_field_id_renamed_criterionId` ships on `coverage` but not on `checklist` despite both surfaces emitting the renamed field; the same rename should be narrated identically on every surface that touches the field. Fix: emit deprecation warnings from the shared field-emission helper, not at the surface boundary; integration test pinning warning-set parity across project-rooted tools for any field touched by `rule-aliases.ts`. Per AI-first doctrine "Cross-surface count invariant."
- [ ] **Q10-YML-SKIPPED-BUT-TEMPLATE-LITERAL-CO-FIRES-NO-DETAIL** `extensions_skipped_no_parser` reports `.yml` as topExtension while `template_files_parsed_as_literal` ALSO fires; the two warnings co-fire on the same files but mean different things. The `template_files_parsed_as_literal` warning has no `files[]` / `extensions[]` detail to disambiguate. Fix: ship `warningsDetails.template_files_parsed_as_literal: {files: [...], extensions: [...]}` so the agent can tell which `.yml` was skipped vs parsed-as-literal. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest."

### suggest_fix shape + correctness bugs

- [ ] **Q10-SUGGEST-FIX-VERIFYCOMMAND-DUPLICATE-PROSE-VS-STRUCTURED** `suggest_fix` ships both `verifyCommand` (prose string) and `verifyCommandStructured` (object with `tool`/`args`/`verifyRuleId`). Drift between the two is silent and the agent cannot tell which is canonical — same shape as the documented triple-readout failures. Fix: drop the prose `verifyCommand` string; keep only `verifyCommandStructured`. Per AI-first doctrine "Verbose meta is signal — but de-duplicate triple readouts."
- [ ] **Q10-SUGGEST-FIX-VENDOR-REDIRECT-COMPOUNDS-MISLABEL** When `suggest_fix` is called on a finding whose file was classified as a build artifact, it returns `kind: "none"` with `vendorContext.redirectTo: "consumer-override"` instead of a fix. Combined with a heuristic mis-classification (Q9-MINIFIED-LABEL-MISLABELS-LONG-LINE-SCSS recurrence), the agent is silently denied fix help on hand-authored source. Two failure modes compound. Fix: gate vendor-redirect on a high-confidence build-artifact classifier (token co-occurrence, not single-marker) AND surface the underlying classification signals in `vendorContext` so the agent can decide whether to trust the redirect. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest."
- [ ] **Q10-PARSE-ERROR-REASON-DIRECTION-INVERTED** A `parseErrorFiles[].reason` describing layout-tail elision narrates the wrong direction: claims `</html>` is the elided closer when the file's actual content has `</html>` on its last line and the OPENING `<html>` is what's elided (supplied by an included partial). Fix: parse-error reason text must reflect which tag is actually elided; integration test on a synthetic include-pattern fixture asserting reason matches the elided side. Per AI-first doctrine "Heuristic-mislabeled meta sub-fields are dishonest" (reason-text honesty extension).

### Reason-severity mismatches

- [ ] **Q10-FIX-DESCRIPTION-CONCEDES-PREDICATE-AT-ERROR-SEVERITY** `keyboard/handler-missing` emits at `severity: "error"` while the per-finding `fix.description` literally instructs `"Cross-file check: grep the selector in your HTML to confirm the target isn't already a <button> or <a href>"` — fix description concedes the predicate may not hold; severity claims it does. Same shape as "reason text and severity must agree" applied to the fix-description text channel. Fix: when fix.description hedges with a verify-before-fixing instruction, downgrade severity to `warning` AND populate per-finding `couldBeWrongBecause` with the limitation; OR perform the cross-file check the description prescribes (the scanner already has the HTML AST). Per AI-first doctrine "Reason text and severity must agree."
- [ ] **Q10-ROLE-FROM-CLASS-ONLY-FRAGMENT-FILE-CONCEDED-UNCERTAINTY** `aria/role-from-class-only` fires at `severity: "warning"` `confidence: "medium"` on fragment markdown files containing component-library-style admonition divs (`<div class="note info">`); message asserts deterministic AT-stripping while host file is fragment+template (rendered output may carry role-via-CSS, ARIA injection, or theme wrapper). Reason concedes uncertainty (file is fragment+template); severity does not match. Fix: when host file is fragment-classified AND template directives are present, downgrade to a review candidate OR populate per-finding `couldBeWrongBecause: ["fragment_input_no_document_envelope", "template_directives_present"]`. Per AI-first doctrine "Reason text and severity must agree" (conceded-uncertainty extension).

### Rule predicate gaps (false negatives)

- [ ] **Q10-RULE-VALUE-AS-LABEL-ANTIPATTERN** No rule fires on the `<input type="text" value="Username" />` value-as-label antipattern (default `value=` used as the visible label, often cleared on focus by inline JS). The placeholder-as-label rule captures a sibling antipattern; the value-as-label variant prevalent in older templates is uncovered. Fix: add `forms/value-as-label` (or extend `forms/placeholder-as-label`) detecting `<input type="text|email|search">` elements with `value` attribute equal to a label-shaped string, no `<label>`, no `aria-label`, no `aria-labelledby`. Satisfies wcag22:1.3.1 + 4.1.2.

### Rule predicate too-broad (false positives)

- [ ] **Q10-RULE-TABLE-CAPTION-MISSING-FIRES-ON-MD-FENCED-TABLES** `semantics/table-caption-missing` fires on `<table>` elements rendered from markdown table syntax (kramdown / GFM) — markdown source has no caption mechanism in the syntax, so the rule cannot honestly establish that an authoring choice was made. Fix: when the table's source file is `.md`/`.markdown`/`.mkdn`, OR the file is in `fragmentFiles[]`, attach `couldBeWrongBecause: ["markdown_table_no_caption_syntax_in_md"]` AND downgrade per-finding confidence to `medium`. Per AI-first doctrine "Reason text and severity must agree."

### Finding-emission shape bugs

- [ ] **Q10-DUPLICATE-FINDING-IDS-ACROSS-DISTINCT-EMISSIONS** `forms/placeholder-as-label` emits 6 separate finding entries on consecutive lines that share the same `findingId` AND `groupKey`, while `forms/labels-required` on the exact same input collapses to one entry with `siblingInstances: [...]`. Identical IDs across distinct entries break consumer dedup keyed by `findingId`. Fix: assert `findingId` uniqueness across emissions in the same response; emit one entry with `siblingInstances: []` when multiple consecutive findings collapse. Per AI-first doctrine "Ambiguous field shapes are dishonest" (id-collision is the worst-case ambiguity).

### scan_file surface gaps

- [ ] **Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION** `scan_file` has no `limit`/`offset`/`restrictToPaths` and no oversize-success protection; a single dense HTML file produces 68k–84k character responses that blow the host token cap, returning only a transport error with no `truncated` flag, no warning, no minimum-honest envelope. Same silent failure mode as `scan_project` but worse because there's no scope-down lever. Fix: add `limit`/`offset`/`maxBytes` parameters; pre-serialization size estimator; minimum-honest envelope fallback (drop `findings[]` body, keep `meta + warnings + nextStep`) when the post-clip envelope still exceeds the host cap. Per AI-first doctrine "Oversize-success is ambiguous failure" — extends Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION to the scan_file surface.

### Considered and rejected (per CLAUDE.md §1)

- **AAA→AA promotion of `navigation/link-target-blank-announcement`** — A scanner finding asked for AA-level emission of the rule (citing field evidence of unflagged `<a target="_blank">` patterns). Rejected: WCAG 3.2.5 is normatively AAA. Spec-correct closure already named in Q9-RULE-LINK-TARGET-BLANK-NEVER-FIRES — the AA-axis ask would be spec-incorrect emission and the deterministic escape hatch (source-level pragma) covers the rare case where the agent decides the rule should fire. The Q10-LINK-TARGET-BLANK-APPLIESTO-EXCLUDES-ERB-MD-RESIDUE row above is the legitimate fix (extend AAA-eligible extensions to match `parseModeByExtension`), separable from the level-axis question.

---

## Track Q11 — Multi-corpus AI-first sweep (2026-04-26 round, 4 corpora × 5 angles)

Field-test follow-ups from a 20-agent multi-corpus probe (CSS framework + static-site generator + vanilla mini-projects + bulk template gallery). Each item below is **net-new** against Q9/Q10; recurrences of already-named items folded as recurrence counts under the existing rows there. Items bucketed by failure class.

### Rule predicate gaps (false positives — parent-walk + multi-rule overlap)


### Missing rules (corpus-driven, recurring across ≥2 corpora)

- [ ] **Q11-RULE-TABLIST-ON-NON-TAB-CONTAINER** No rule fires on `role="tablist"` applied to a tabpanels container (e.g. `<div class="tab-content" role="tablist">` housing `role="tabpanel"` children). This is a real ARIA misuse — assistive tech announces a tablist but the children are panels, not tabs. CSS-framework corpus, `tab.html:35`. Fix: add `aria/tablist-on-non-tab-container` — fires when a `role="tablist"` element's children carry `role="tabpanel"` (or no `role="tab"` descendant at any depth). Satisfies wcag22:1.3.1 + 4.1.2.
- [ ] **Q11-RULE-VISUALLY-HIDDEN-ONLY-NAME-CAROUSEL-CONTROL** No rule fires on `<a href="#prev"><span class="visually-hidden">Previous</span><span aria-hidden="true" class="icon-prev"></span></a>` patterns where the only accessible name is a visually-hidden span and the visible content is icon-only. Currently `media/svg-accessible-name` only addresses the inner-svg shape; the carousel-control sr-only-text + aria-hidden-icon-sibling shape is uncovered. CSS-framework corpus carousel demos, recurring. Fix: add `forms/visually-hidden-only-name` (or extend `media/svg-accessible-name`) — fires when an interactive element's only accessible name source is a `.visually-hidden` / `.sr-only` text node alongside an `aria-hidden="true"` icon sibling. Surface a review-candidate at the SC level rather than auto-flag (the pattern is borderline-correct — the SR-text IS the accessible name; the question is whether a sighted user without icons would understand the affordance). Satisfies wcag22:2.4.4.
- [ ] **Q11-RULE-DROPDOWN-TOGGLE-TRIPLE-ARIA-MISSING** No rule fires on Bootstrap-style dropdown triggers (`<a class="dropdown-toggle" data-toggle="dropdown">` or `data-bs-toggle="dropdown"`) missing the canonical `aria-haspopup="menu"` + `aria-controls` + `aria-expanded` triple. `aria/expanded-on-disclosure` only addresses the expanded-attribute axis on the broader disclosure namespace. Bulk-template corpus, recurring 50+ instances. Pairs with Q9-RULE-POPOVER-TOOLTIP-TRIGGER-DISCLOSURE (popover/tooltip axis); this is the dropdown-trigger axis. Fix: add `aria/dropdown-toggle-triple-aria-missing` — fires when an element has a `data-(bs-)?toggle="dropdown"` attribute and lacks any of `aria-haspopup`, `aria-controls`, or `aria-expanded`. Satisfies wcag22:4.1.2.
- [ ] **Q11-RULE-MULTIPLE-LABEL-FOR-SAME-ID** No rule fires when two `<label for="X">` elements reference the same `id="X"` (e.g. duplicate label declarations across visible + visually-hidden variants). Vanilla-JS corpus, `password-strength-background/index.html:21,31` both `for="email"`. Fix: add `forms/multiple-label-for-same-id` (or extend `parsing/duplicate-id`'s sibling-label scan) — fires when ≥2 `<label for=>` elements in the same document target the same id. Satisfies wcag22:1.3.1 + 4.1.2.
- [ ] **Q11-RULE-DIV-DATASRC-CSS-BACKGROUND-IMAGE-INVISIBLE** No rule fires on `<div data-src="path/to/image.jpg">` patterns used by carousel/lightbox libraries to bind CSS background-image at runtime. The image is content-bearing but `media/alt-text-missing` cannot fire on `<div>` and no `aria-label` finder addresses the data-attribute-driven shape. Bulk-template corpus, every `.camera_wrap`/`.flexslider`/`.owl-carousel` instance. Fix: add a review-candidate finder for `<div data-src=>` / `<div data-bg=>` patterns where the data attribute resolves to an image extension; reason frames the question (`background-image bound at runtime — verify aria-label or sibling text describes the image content`). Satisfies wcag22:1.1.1. Pairs with V1-CONTRAST-BG-IMAGE-SURFACE (open) on the contrast axis.

### Response-shape: ambiguous / type-polymorphic / dangling fields

- [ ] **Q11-WARNINGSDETAILS-EMPTY-OBJECT-VALUE-AS-FIELD** `warningsDetails.{scanned_build_artifacts_present, partial_parse_files_present, deprecated_field_id_renamed_criterionId}: {}` ships empty objects as field values when the warning fires but the substantive context is dropped under truncation. Agent cannot distinguish "warning fired with no details" from "details were truncated and gutted." Bulk-template corpus. Same shape as ambiguous-empty-string at the object-value level. Fix: when a warning fires without details, omit the warningsDetails entry entirely and rely on the warning code in the `warnings: []` array; when details existed but were truncated, replace with `{truncated: true, fieldsDropped: ["..."]}` sentinel. Per AI-first doctrine "Ambiguous field shapes are dishonest" (extends to `{}` value alongside `""`/`null`); pairs with Q10-META-TRUNCATED-FIELD-NAME-RETAINED-WHEN-GUTTED.
- [ ] **Q11-REFERENCEGUIDE-DANGLING-POINTER-ON-TRUNCATION** `findings[].fix.descriptionRef.hash` references a top-level `referenceGuide.fixDescriptions[hash]` entry; when truncation drops `referenceGuide` (or clips its body) but findings retain `descriptionRef`, the agent gets dangling pointers that resolve to undefined. Recurring shape in oversize bulk responses. Fix: response-assembly site must pin the invariant — when a `descriptionRef` is emitted, the matching `referenceGuide.fixDescriptions[hash]` must be retained. Either hoist used references AHEAD of the truncation pass, or inline the description string under each finding when truncation forces dropping the guide. Per AI-first doctrine "Truncated containers must rename or sentinel, not retain" extended to cross-field reference invariants.
- [ ] **Q11-RESPONSE-DROPPED-FILES-OVERSIZE-COUNTER-UNDERREPORTS** `warningsDetails.response_dropped_files_oversize` ships `{droppedFileCount: 1, requestedLimit: 25, effectiveLimit: 1}` on a 4936-files-with-findings corpus. The headline `droppedFileCount: 1` reads as "we dropped one file" — what actually happened is "we serialized one of 4936 files-with-findings, the requestedLimit ceiling was 25, effective ceiling was 1." Bulk-template corpus. Fix: rename `droppedFileCount` to `droppedFileCountFromRequestedLimit` AND ship a sibling `totalFilesWithFindings: N` (already shipped on `files.totalFilesWithFindings` — propagate to the warning detail). Per AI-first doctrine "Composite headline counts are dishonest" applied to truncation telemetry.
- [ ] **Q11-COVERAGE-CRITERIATOTAL-NO-LEVEL-QUALIFIER** `coverage.criteriaTotal: 55` is unanchored from the conformance-level qualifier (55 = WCAG 2.2 A+AA cumulative). Same field name shipped alongside `--profile wcag22-a` (30) and `--profile wcag22-aaa` (87) varies — the field's denominator changes silently. Fix: rename to `criteriaTotalForProfile` AND ship a sibling `criteriaByLevel: {A: N, AA: N, AAA: N}` map so the total never disagrees with the level breakdown. Per AI-first doctrine "Ambiguous field shapes are dishonest."

### Cross-surface drift / counter splits

- [ ] **Q11-FIXESBYCLASS-NOT-SPLIT-BY-SCAN-KIND** `plan.violationsByScanKind: {source: 1229, buildArtifact: 147}` correctly splits source vs vendor on `scan_project`; `plan.fixesByClass: {mechanical: 1376, verifyInSource: ..., guidance: ..., none: ...}` does NOT split by scanKind. Agent reading `mechanical: 1376` cannot tell how many target user-editable source vs vendor (where `apply_fix` would edit a build artifact). Bulk-template corpus. Fix: ship `fixesByClass: {mechanical: {source: N, buildArtifact: N}, verifyInSource: ...}` so each lane carries the same scanKind axis as `violationsByScanKind`; integration test pinning `sum(fixesByClass.mechanical) == fixesByClass.mechanicalTotal == violationsByScanKind sum where fixClass=mechanical`. Per AI-first doctrine "Composite headline counts are dishonest" — same-axis decomposition must be available where the parent counter is.
- [ ] **Q11-DEFAULT-EXCLUDED-DIST-NO-SCANNED-BUILD-ARTIFACTS-ENTRY** Repos where `dist/`, `build/`, or `.next/` contain bundle output that is silently filtered by `DEFAULT_EXCLUDED_PATTERNS` produce zero `scannedBuildArtifacts[]` entries — the file-discovery walker dropped them BEFORE classification ran. Agent has no signal that 30+ minified+sourcemap files exist on disk in vendor-shaped directories. CSS-framework corpus, `dist/css/` + `dist/js/` + `js/dist/` (~30 files total) all silent. Fix: emit a `default_excluded_artifact_paths` warning naming `{path, fileCount, sampleFiles}` for every `DEFAULT_EXCLUDED_PATTERNS` glob that matched ≥1 file in the scope; per AI-first doctrine "Default-exclude globs are suppression too" — the agent dismisses build-output paths in one read but cannot un-suppress files that never got walked. Pairs with Q9-BULK-WARNINGS-NOT-CROSS-SURFACE on the propagation axis.
- [ ] **Q11-BULK-CATALOG-SUGGESTEDEXCLUDES-NOT-ADDITIONALPATHS-INVERSE** `bulk_catalog_detected.suggestedExcludes` returns filename-pattern globs (`**/bootstrap.min.js`) shaped for config-file edits; `nextStepStructured` doesn't propagate the inverse — a concrete `additionalPaths: [<top-non-vendor-subdir>]` for the immediate next call. Agent receiving the response after `response_dropped_files_oversize` reads "narrow scope" prose but the structured args repeat the failing cwd. Bulk-template corpus. Fix: when `bulk_catalog_detected` fires, populate `nextStepStructured.args.additionalPaths` (or `restrictToPaths`) with the inverse of `suggestedExcludes` — the single highest-impact non-vendor subtree. Per AI-first doctrine "NextStep prioritization on truncated/bulk responses must avoid first-by-filename routing" (extends to "must propose a concrete in-call narrowing, not just config-file changes"); pairs with Q9-NEXTSTEP-CWD-ECHOES-CALLER-AFTER-DROP.

### Routing edge cases

- [ ] **Q11-PARSER-DOUBLE-EXTENSION-ERB-MARKDOWN-ROUTING** `.md.erb` files (templated markdown — common in static-site themes for theme-template README files) route via the `.erb` half (→html parser) rather than the `.md` half (→markdown parser); content scanned as HTML produces no findings even when real markdown content is present. Static-site corpus, `lib/theme_template/README.md.erb`. Fix: when an extension chain ends in a known templating extension (`.erb` / `.liquid` / `.ejs`), route by the leading extension — strip the templating tail before mode lookup. Per AI-first doctrine "Routing skips that drop content are the symmetric twin of suppression." Edge case but the file class is real.

### 2026-04-26 round recurrences (folded onto existing Q9/Q10 rows)

Each line: `<row id> — N recurrences observed in 2026-04-26 round, evidence summary`. The 2026-04-26 sweep replayed the 4-corpora × 5-angles probe; items below recurred without behavior change against the same Q9/Q10 closure framing, so this round folds them as recurrence counts rather than new rows.

- **Q10-SUGGEST-FIX-MECHANICALINPRINCIPLE-CONTRADICTS-KIND-GUIDANCE** — +4 recurrences (all 4 corpora): `kind: "guidance"` + `meta.mechanicalInPrinciple: true` returned for `document/lang-attribute`, `forms/labels-required`, `aria/icon-child-missing-aria-hidden`, `media/alt-text-placeholder`, `parsing/html-has-lang`, `semantics/button-name`, `aria/expanded-on-disclosure`, `forms/placeholder-as-label`, `forms/autocomplete-missing`, `navigation/href-empty-fragment` — 0/5 mechanical findings probed produced `kind: "edit"` on the CSS-framework corpus.
- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +4 recurrences (all 4 corpora): `scss_unresolved_variables` ships on `scan_project` only (CSS-framework, 31 SCSS files); `scanned_minified_file` + `scanned_build_artifacts_present` ship on `scan_project` only (static-site, jquery in `docs/js/`); `scanned_build_artifacts_present` ships on `scan_project` only (vanilla-JS); same warnings split asymmetrically across `scan_project`/`checklist`/`coverage` (bulk-template).
- **Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS** — +3 recurrences: tooltip/popover string-concatenated HTML templates inside `.js` (CSS-framework `js/src/tooltip.js:73-76`, `js/src/popover.js:25-29`); innerHTML template-literal `<img alt="${user.name}">` in vanilla-JS exercise `script.js:33-50`; multiple inline `<script>` JS-side template literals across bulk-template corpora — no `js_innerhtml_template_literal_unparsed` warning emitted in any case.
- **Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON** — +2 recurrences: 43 instances on vanilla-JS corpus (every demo's `script.js` resolves the click target to a sibling `<button>` in `index.html`); recurring on bulk-template corpus where `$("a[href='#top']")` selectors resolve to native anchors. Fix.description literally instructs "Cross-file check: grep the selector in your HTML to confirm" — the rule has the AST one hop away.
- **Q10-META-TRUNCATED-FIELD-NAME-RETAINED-WHEN-GUTTED** — +3 recurrences: `coverage(verboseMeta:true).meta.perRuleCoverage` silently absent under truncation while `warningsDetails.response_meta_truncated.fields` doesn't enumerate it (CSS-framework); `meta` retained but stripped of `analysisCoverage`/`scannedBuildArtifacts.ungrouped` (bulk-template); `files: []` retained as empty array under `effectiveLimit: 1` of 4936 (bulk-template — array-shape variant of the doctrine bullet).
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: routes to `_project_starter_/index.html` ahead of higher-impact findings on a vanilla-JS corpus mixing scaffold + real source; routes to `js/tests/integration/index.html` (test-fixture path) on a CSS-framework corpus despite production source available. Pairs with Q9-NEXTSTEP-CWD-ECHOES-CALLER-AFTER-DROP (already at 2 recurrences).
- **Q9-PERFINDING-COULDBEWRONG-EMPTY-WHEN-PERRULE-DEGRADED** — +2 recurrences (closed item, evidence of regression): `keyboard/handler-missing` per-rule confidence labeled `medium` with `cross_file_listener_resolution_limited_on_this_input` while every per-finding emission ships `confidence: "high", severity: "error"` on the vanilla-JS corpus (43 instances) and bulk-template corpus. The closure shipped (commit reference in original Q9 row) but field evidence shows the degradation isn't propagating uniformly — re-open if integration test confirms the regression.
- **Q9-EXPANDED-ON-DISCLOSURE-SR-ONLY-CHILD-CONCESSION** — +2 recurrences: `<button class="navbar-toggle"><span class="sr-only">Toggle navigation</span>…</button>` shape recurs on bulk-template + static-site corpora; severity stays `error` while reason concedes "if .sr-only is the disclosure label, accessible name is complete."
- **Q9-EMPTY-HEADING-TEMPLATE-EXPRESSION-AT-ERROR** — +1 recurrence: static-site corpus `_includes/news_item.html:2` and `news_item_archive.html:11` both `<h2>{{ post.title }}</h2>` — Liquid stripped, severity stays `error`.
- **Q9-RULE-HREF-EMPTY-FRAGMENT-FP-IN-DOCS-EXAMPLE-PROP** — +2 recurrences: 1284 fires inside `<Example code={\`...\`}/>` JSX template-literal `code` props on a CSS-framework `.mdx` documentation tree; 44 fires inside `<div class="highlight result" data-proofer-ignore>` rendered-example markup blocks on a static-site corpus tutorial — adjacent shape (attribute-marker container) under the same closure mechanism.
- **Q9-PARSE-ERROR-REASON-DIRECTION-INVERTED** — +2 recurrences: `_layouts/default.html` and `_layouts/error.html` on a static-site corpus both classified `parseErrorFiles` with `reason` text claiming `</html>` is the elided closer when the file's actual content has `</html>` on its last line and the OPENING `<html>` is what's elided.
- **Q9-MINIFIED-LABEL-MISLABELS-LONG-LINE-SCSS** — +1 recurrence: SCSS function bodies with long type signatures + inline `data:image/...` markers fire `likely-vendored-data-url-css` on hand-authored sources (CSS-framework `_buttons.scss`/`_grid.scss`).
- **Q9-RULESBYEXTENSION-DUP-PAYLOAD** + **Q9-DUPLICATE-ID-AND-CRITERIONID-AFTER-RENAME** — +2 recurrences each: byte-identical deprecated/renamed field pairs continue to ship; deprecation warnings have no `warningsDetails` entry naming the alias-removal version (per ADR-0021 alias contract).
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +3 recurrences: 74KB CSS-framework `scan_project(limit=25)` (post-clip envelope still over host cap); 87KB static-site `scan_project` (post-clip 87269 chars on 429 files); 60KB+ vanilla-JS `scan_project` returns InputValidationError instead of minimum-honest envelope. Closure in flight per the original Q9 row but the recurrence count crossed the "promote to integration test" bar.
- **Q9-BULK-CATALOG-DETECTED.SUGGESTEDEXCLUDES-NOT-ADDITIONALPATHS** — already in Q11-BULK-CATALOG-SUGGESTEDEXCLUDES-NOT-ADDITIONALPATHS-INVERSE above (this round's primary surface).
- **J-6 (performance budget at 4k-file vendor-heavy scale)** — +1 recurrence (concrete evidence): bulk-template corpus 4936 files / 26.3s on a hot scan = 75% over linear extrapolation of the 1000-file 3s budget AND 75% over the documented 4000-file 15s budget. CLAUDE.md §11 row warrants update OR the discovery walker needs a `largeRepoHint` warning emission.

### Considered and rejected (per CLAUDE.md §1)

- **Suppress wcag22:1.4.5 candidates on standalone-mini-site corpora where every subdir is a single-page demo** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. The single-page-mini-site predicate is a heuristic on weaker evidence than the agent has; the deterministic escape hatch (source-level disable pragma) covers the dismissal cost. Reason-text enrichment (`couldBeWrongBecause: ["isolated_component_demo_page"]`) already applies via Q7-RULE-LANDMARK-MAIN-FRAGMENT-SCOPE for the document-shaped case.
- **Auto-promote `scannedBuildArtifacts`-classified files to a deprioritized bucket so suggest_fix doesn't recommend edits to vendor** — Rejected per "Labeled buckets are suppression too" doctrine. The legitimate fix is Q9-SUGGEST-FIX-VENDOR-CONTRAST-RECOLOR (gate suggest_fix on the classification at the per-call site, not the response-shape bucket); same-shape suppression at the response layer would discard signal the agent uses for its own routing.

---

## Track Q12 — Multi-corpus AI-first sweep (2026-04-26 round, 4 corpora × 5 angles)

Field-test follow-ups from a 4-corpus probe (CSS framework + static-site generator + vanilla mini-projects + bulk-template gallery). Each item below is **net-new** against Q9/Q10/Q11; recurrences fold under the existing rows there. Items bucketed by failure class.

### Per-finding confidence drift (file-scope vs corpus-scope)

### Truncation telemetry honesty (minimum-honest envelope shape)

### Vendor-classification schema split

- [ ] **Q12-SCANNED-BUILD-ARTIFACTS-VENDORLIBRARIES-PARALLEL-SURFACES** `scannedBuildArtifacts` ships TWO concurrent vendor-classification surfaces in the same response: `scannedBuildArtifacts.ungrouped[]` (path/min-infix-based, e.g. `html5shiv.min.js` + `respond.min.js`) AND `scannedBuildArtifacts.vendorLibraries[]` (registry/version-based, e.g. `_normalize.scss` 7.0.0). Both classify "vendor" but the schema splits them, leaving an agent reading `scannedBuildArtifacts` to do its own union. The split is also asymmetric across surfaces — `vendorLibraries` rides only on `scan_project`, not on `coverage` or `checklist`. Closure: merge into a single `scannedBuildArtifacts.classified[]` array with a `classification` discriminator (`min-infix` | `path-prefix` | `vendor-library-version-detected`); deprecate the split via the alias table; populate identically on every surface that emits `scannedBuildArtifacts`. Per AI-first doctrine "Composite headline counts are dishonest" extended to vendor-classification fan-out (one concept = one shape) AND "Cross-surface count invariant" (warning + classification telemetry on identical cwd must agree across project-rooted tools). Pairs with Q9-BULK-WARNINGS-NOT-CROSS-SURFACE on the propagation axis.

### 2026-04-26 round recurrences (folded onto existing Q9/Q10/Q11 rows)

Each line: `<row id> — N recurrences observed in this round, evidence summary`. Replays of the 4-corpora probe; items below recurred without behavior change against the same Q9/Q10/Q11 closure framing.

- **Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON** — +1 recurrence: vanilla-corpus `keyboard/handler-missing` count=43 with per-rule `cross_file_listener_resolution_limited_on_this_input` reason while every per-finding emission ships `confidence: "high", severity: "error"` (Q9-PERFINDING-COULDBEWRONG-EMPTY-WHEN-PERRULE-DEGRADED axis still leaking on this rule).
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: routes to `_project_starter_/index.html` (vanilla scaffold dir) and to `js/tests/integration/index.html` (CSS-framework test fixture path) ahead of higher-impact authored findings.
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +1 recurrence: bulk-template `scan_project` returned `preDropBytes: 548283` post-clip 89238 chars, still over the host cap. Closure attempt is in flight; new sub-axis captured as Q12-MIN-ENVELOPE-OVER-HOST-CAP-ON-VENDOR-HEAVY-CORPORA above.
- **Q11-RESPONSE-DROPPED-FILES-OVERSIZE-COUNTER-UNDERREPORTS** — +1 recurrence: bulk-template ships `droppedFileCount: 1, requestedLimit: 2, effectiveLimit: 1` while `totalFilesWithFindings` is absent — agent can't reconcile.
- **Q11-BULK-CATALOG-SUGGESTEDEXCLUDES-NOT-ADDITIONALPATHS-INVERSE** — +1 recurrence: bulk-template `nextStepStructured.args` echoes the failing `cwd` with no `additionalPaths` / `restrictToPaths` proposed despite `bulk_catalog_detected.suggestedExcludes` being populated (5 patterns).
- **Q10-RESPONSE-TOKEN-BUDGET-TRUNCATED-WITHOUT-TRUNCATED-FLAG** — +1 recurrence: bulk-template ships `truncated: null`/absent while `response_token_budget_truncated` AND `response_dropped_files_oversize` AND `bulk_catalog_detected` all fire. New related axis (`totalFilesWithFindings` absence) captured as Q12-MIN-ENVELOPE-DROPS-COUNTERS-WITHOUT-SENTINEL above.
- **Q10-META-TRUNCATED-FIELD-NAME-RETAINED-WHEN-GUTTED** — +2 recurrences: static-site corpus and CSS-framework corpus both ship `response_meta_truncated.fields: ["analysisCoverage.fragmentFiles"]` — closure shipped (`fragmentFilesTruncated: {shown, total}` sentinel populated) but `response_meta_truncated` warning still fires alongside, ambiguous whether more fields than the named one were dropped. Closure: when the only truncation is `fragmentFiles` clipping with sentinel, suppress the warning; emit the warning ONLY when fields are dropped without sentinel.
- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +2 recurrences: `scss_unresolved_variables` ships on CSS-framework `scan_project` (31 SCSS files); `scanned_minified_file` + `scanned_build_artifacts_present` ship on static-site `scan_project` (`html5shiv.min.js`, `respond.min.js`). Cross-surface propagation to `coverage`/`checklist` not verified this round (host-cap budget exhausted) — re-probe needed if closure work claims completion.
- **Q11-RULE-EXPANDED-DISCLOSURE-FIX-CONCEDES-MAY-NOT-APPLY-AT-ERROR** — +1 recurrence: CSS-framework `aria/expanded-on-disclosure` count=166 across `dropdowns.mdx`, `navs-tabs.mdx` — every finding still at `severity: "error"` despite the closed-bullet doctrine.

### Considered and rejected (per CLAUDE.md §1)

- **Suppress `aria/role-from-class-only` on fragment-classified `.md` files where the admonition `<div class="note info">` shape is rendered through a known kramdown / Liquid include** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. The fragment-rendered admonition COULD carry a sibling Liquid `{% capture %}` block that supplies the role — or it could be raw HTML residue with no extra runtime injection. Static evidence cannot distinguish the two, and the deterministic escape hatch (source-level disable pragma) covers the rare case where the agent confirms the fragment runs through an ARIA-injecting layer. Reason-text enrichment via `couldBeWrongBecause: ["fragment_input_no_document_envelope", "kramdown_admonition_class_token"]` is a legitimate additive change; folded into Q10-ROLE-FROM-CLASS-ONLY-FRAGMENT-FILE-CONCEDED-UNCERTAINTY (already open).
- **Down-bucket findings on files in `scannedBuildArtifacts.ungrouped[]` so they sort below authored-source findings in `topRules`** — Rejected per "Labeled buckets are suppression too" doctrine. `topRules.count` is a deterministic count of emissions; sorting by classification would replace honest count with attention-budget heuristic. Q11-FIXESBYCLASS-NOT-SPLIT-BY-SCAN-KIND covers the legitimate split-axis at the structured field; `topRules` summary stays honest.

---

## Needs judgment — 2026-04-21 field test (resolved 2026-04-26)

Strategy/doctrine questions formerly blocking specific Q items. Resolved 2026-04-26 via a research-and-decide pass anchored in `docs/kb/architecture/ai-first-consumer.md` + light industry comparable lookup. Each decision below carries the rationale; the corresponding Q items above act on these resolutions on next pickup. Items J-1, J-3, J-7 are dropped here because their resolution shipped this round (commits e8e04029, doctrine entry on 2026-04-24, 13c54d5b respectively).

- **J-2 — vendor CSS noise primary mitigation. Decided: land both independently.** `Q6-SCANNED-BUILD-ARTIFACTS-GROUP-BY-BASENAME` improves the labeling signal (per "verbose meta is signal"); `Q6-BUDGET-UNDER-VENDOR-NOISE` protects the envelope (per "oversize-success is ambiguous failure"). Orthogonal levers — labels without budget still produces token-overflow drops; budget without labels still routes the agent to vendor first. Both Q6 items proceed independently.

- **J-4 — rulesEvaluated semantic. Decided: loaded-and-invoked (54).** Per "verbose meta is signal" the honest read of `rulesEvaluated: 54` is "every loaded rule had its turn against this corpus." Distinguishing 0-applicable-files from non-applicable belongs in `perRuleCoverage[]` (where `coverageConfidence` + `subkind` already encode it). The "fired-on-something-applicable" semantic conflates loading with firing and silently shrinks at the same input cwd as the registry rolls. Q-SHARED-RULES-EVALUATED-SSOT pins this semantic cross-surface.

- **J-5 — likelyIrrelevant + parse-coverage caveat. Decided: suppress the bucket entirely when content extensions are unparsed; do not auto-enrich.** Per "Labeled buckets are suppression too" the label must be provable from the code. "No video in scanned files" is not provable when `extensions_skipped_no_parser` includes content extensions — the scanner did not look at the content layer. Reason-enrichment keeps a dishonest label sitting next to its disclaimer (same critique as the renamed-composite case in J-3); the durable answer is to drop the bucket on that input. Q4-RELEVANCE-REASON-PARSE-COVERAGE-CAVEAT reframes from "enrich reason" to "suppress bucket on unparsed-content evidence."

- **J-6 — 4k-file vendor-heavy perf budget. Decided: ≤ 25 s with `large_repo_hint` warning above 1000 files.** Industry comparables on similar shapes: ESLint full repo on a 4k-file vendor-heavy tree commonly 30-60 s; Biome targets ~10× ESLint and lands 5-15 s on similar; axe-core CLI is runtime-rendered so not directly comparable. ra11y at ~26 s sits in the Biome+ band, defensible for a zero-dep static scanner. CLAUDE.md §11 row updated to 25 s ceiling with scope-down guidance; pushing lower would either drop rules or require parallel workers (out of scope for v1.0). V1-BENCH-4K-FILE-VENDOR-HEAVY-SCENARIO budget = 25 s.

- **J-8 — scan_file error discrimination. Decided: three distinct codes.** `file-not-found` / `unsupported-extension` / `file-unreadable`. Industry comparables (GitHub MCP, Postgres MCP) shape errors as discrete `code` strings with structured `details`, not umbrella codes with sub-discriminators — JSON-RPC consumers branch on `code` directly, and a sub-discriminator inside `details.reason` forces a two-step parse with silent-fallback if the discriminator is missing. Per "ambiguous field shapes are dishonest" an umbrella `file-unsupported` that sometimes means "wrong extension" and sometimes "couldn't open" forces prose disambiguation. Q-SHARED-SCAN-FILE-ERROR-DISCRIMINATION implements the three-code split.

---

## Track C — Conformance-claim gaps

Owner: main session + `spec-researcher` + `doc-writer`. Staged; do not dispatch alongside active tracks. ra11y today produces *signals* (findings, review candidates, coverage hints). It does not produce a *claim*. Track C closes the four gaps that separate the two — attestation ledger, runtime-evidence ingest, process-level scope, conformance statement. **No new rules**; the track widens what an agent can defensibly say after using the tool.

Sequencing (cross-gap, soft): attestations first (unlocks evidence semantics everywhere else), then runtime ingest (wide-reach runtime coverage), then process scope, then conformance capstone. Within each gap items are ordered by the ADR-then-foundation-then-surface pattern.

### v0.3.0 — attestation ledger (foundation)


### Rejected — runtime evidence bridge

A prior plan proposed ingesting vendor runtime results (vendor JSON → normalized shape → ledger) as the path to close runtime-only WCAG criteria. Rejected: vendor-specific ingest adapters duplicate capability agents already have via their own test harnesses, and the tool's job is to point at the source — not at another tool's output. The ingest shape is also fragile to vendor schema drift, and the normalized layer re-buckets findings in ways the reading agent can't re-audit. Agents that run runtime checks bridge their results through the existing `attest` tool — the reason text is the evidence, and the attestation ledger is the durable, vendor-neutral channel.

Items struck: C-RUNTIME-ADR, C-RUNTIME-SCHEMA, C-RUNTIME-INGEST, C-RUNTIME-MAP. C-COVERAGE-MERGE is re-scoped below.


### v0.3.0 — process-level scope


### v1.0.0 — conformance capstone


### Dependencies + interactions with Track S

Track S speculative tools (`verdict-candidate`, `draft-vpat-narrative`, `resolve-component`) become concretely useful once **C-ATTEST-TOOL** lands — their output is evidence the agent writes to the ledger. Track C resolves Track S's "pick 1–2 speculative tools" decision (ADR 0005 §Follow-up): `verdict-candidate` is the natural first pick because its output IS an attestation entry. Promote Track S `[!]` items to `[ ]` once C-ATTEST-TOOL is merged.

### Considered and rejected

- **Embed a vendor runtime scanner as a runtime dep.** Rejected per **§3 invariant 1** (zero runtime deps). Don't pull any vendor scanner into the install. Agents already run their preferred runtime harness in their test setup; they bridge results through `attest`.
- **In-tool headless browser (Playwright / Puppeteer).** Rejected per zero-deps + MCP-first-consumer framing — the agent already runs the browser in its test harness. We ingest; we don't drive.
- **Blanket "ra11y verifies conformance" marketing.** Rejected — the conformance statement will cite evidence sources; ra11y is the aggregator, the attestation is the agent's (or human's) word, and the signed bundle is what survives audit. Honesty > reach.

---

## Track V — v1.0.0 readiness

Owner: main session + `doc-writer` + `fixture-curator` + `test-author` + specialists as indicated per item. Source: 2026-04-19 three-agent gap analysis (rule coverage vs WCAG 2.1/2.2 A+AA, MCP shape discipline, backlog + semver + CI infra). The conformance capstone in Track C is shipped; these are the remaining gates for the "find all violations" bar.

No item here proposes new rule detection logic — Track V is about honesty surfaces, decision closure, and coverage verification. Items that WOULD add detection get logged as Track R or Track C items.

### v1.0.0 — certification claim blockers

Source: two independent pre-ship subagent sweeps (spec-researcher normative angle + general-purpose tooling/reproducibility angle). Both flagged overlapping blockers that would sink a real WCAG/VPAT/Section 508 certification submission. Each item has a concrete file:line anchor; together these are the gate to `/release 1.0.0`. Dispatch in parallel where non-overlapping; B1 and B6 block on B2's shape work.


### v1.0.0 — coverage honesty


### v1.0.0 — surface discoverability


### v1.0.0 — real-world fixture push

Track F shipped 10 fixtures, all guarding scanner infrastructure (wrappers, templates, TSX generics). Zero fixtures exercise rule-territory behavior in production-like shape. Each item below lands one sanitized fixture under `tests/fixtures/real-world/<case>/` with `source/` + `assertions.ts`, following the ADR 0006 harness. Dispatch in parallel — independent fixtures.


### v1.0.0 — deferred-decision closure

Each item closes one deferred ADR or semver-major decision. Acceptance for each: an ADR marked Accepted (or Superseded / Rejected) + the corresponding backlog item flipped.


### v1.0.0 — plugin API integrity

Source: 2026-04-20 architectural audit — two independent Explore passes converged on the same finding, verified by grep. `grep -rln "BUILTIN_RULES\|BUILTIN_STANDARDS" src/` returns 33 files; 31 of those are non-barrel leaks past the existing `src/engine/registry/{criteria,rules,standards}.ts` primitives. The leak means CLAUDE.md §3.8 is aspirational, not enforced, and ADR 0019's frozen `defineRule`/`defineStandard`/`defineCandidateFinder` exports function as type-inference helpers only — user-authored rules have no wiring path to `list_rules`, `suggest_fix`, or any scan. ADR 0022 has the full design and 7-commit migration plan. Dispatch sequential within this subsection: stages 1 → 2 → {3, 5} → 4 → 6 → 7, with 3/4/5 parallelizable across agents once 2 lands. Every stage is additive and reversible until V1-REGISTRY-LINT.


### v1.0.0 — MCP response-assembly seam

Source: 2026-04-20 architectural audit (Explore-agent survey of `src/mcp/**` + grep verification). Same class of leak as V1-REGISTRY-AGGREGATE but one layer up: the AI-first consumer doctrine in `docs/kb/architecture/ai-first-consumer.md` (conditional-spread on zero counts, `warnings` on zero-output success, split composite headline counters, present-when-meaningful optional fields, honest `fixesByClass` tally) is currently enforced in 24 separate `src/mcp/tool-*.ts` files by convention + the path-scoped rule at `.claude/rules/mcp-response-shapes.md`. Verified counts on 2026-04-20:

| measurement                                                                 | count |
|-----------------------------------------------------------------------------|------:|
| `src/mcp/tool-*.ts` files                                                   | 24    |
| Tool files routing through `runScanAndFormat` (the existing near-assembler) | **2** (`tool-scan-project.ts`, `tool-scan-diff.ts`) |
| Tool files hand-rolling `meta: {` blocks directly                           | 10    |
| Tool files calling `buildAgentFinding` or composing `AgentFinding` manually | 8+    |
| `scan` + `scan_file` tool definitions                                       | inline in `src/mcp/tools.ts` (625 LOC mixing schemas + handlers) |
| `src/mcp/tools-helpers.ts` current size                                     | 856 LOC (hosts `runScanAndFormat` + fraying) |
| `scripts/check-response-nullability.ts` allowlist entries                   | 1 (catches a narrow slice; doesn't catch field-presence drift) |

The partial assembler `src/mcp/scan-assembly.ts` (`buildScanPlan` / `buildScanMeta` / `buildAnalysisCoverage` / `suppressionsMetaBlock` / `wrappersMetaBlock`) is already the right shape, but it lives underneath a non-authoritative wrapper (`runScanAndFormat`) and is only consumed by 2 of 24 tools. Every new scan-family field (future sampling outputs, new fix-class lanes, new `warnings` codes, new honest-counter splits) currently requires touching ≤24 sites with no CI gate forcing synchrony — silent cross-surface drift is the waiting failure mode, and the invariants called out in `ai-first-consumer.md` ("`scan` says 21, `checklist` says 4") are exactly what this seam prevents.

Why v1.0 blocker: the MCP response shape is part of the public contract v1.0 freezes (ADR 0019 + the migration table in `docs/migrations/0.1-to-0.2.md`). Freezing the shape before codifying the single-path invariant means third-party tooling pattern-matches on hand-rolled examples; changing the pattern later is a semver-breaking event. This is structurally identical to the Registry aggregate work (ADR 0022) — an internal seam that must be in place before the surface it backs becomes immutable.

Design captured in ADR 0024 (Proposed, 2026-04-20). Dispatch sequential within this subsection: stage 1 (assembler) → 2 (handler extract from `tools.ts`) → {3, 4, 5 parallel} → 6 (lint) → 7 (handler-size budget). Stages 3-5 are parallelizable across agents on separate worktrees (no shared files — each touches a disjoint set of `tool-*.ts`). Every stage is additive and reversible until V1-RESPONSE-LINT. Golden snapshots under `tests/snapshots/mcp/**` must stay byte-identical through every refactor commit — any intentional shape change splits into a separate `feat(mcp):` commit with rationale.


### v1.0.0 — release hygiene

- [~] **V1-CHANGELOG-V1** Draft `## [1.0.0]` entry landed (1d784b7). Date placeholder `YYYY-MM-DD` stays until user says ship. Sections populated: Breaking Changes (exit-code freeze), Added (13 sub-groups), Changed (9 items), Deprecated (2 aliases), Fixed (19 items), Deferred (the four ADR 0018 items). New empty `## [Unreleased]` sits at top. Ready for `/release 1.0.0` when the user triggers.

### v1.0.0 — test coverage gates

MCP surface and several CLI commands have severe coverage deficits that contradict the "find all violations" bar. Every item here lands tests against committed behavior; no behavioral changes.


### v1.0.0 — CI + release pipeline gates


### v1.0.0 — code-quality polish


### v1.0.0 — detection gaps

Source: "find all violations" bar re-raised 2026-04-19. Four-agent gap audit against WCAG 2.2 A+AA surface. Each item widens detection on an existing rule or adds a small new primitive — none reshape the engine. Gaps are where a real violation on common production patterns walks past our rules undetected. Dispatch in parallel — independent files.


### v1.0.0 — shape-honesty sweep

Source: same audit. Verified file:line hits on shape-honesty violations that survived Q/Q2/Q2R2. Every item below is a null-sentinel that CLAUDE.md §1 "Ambiguous field shapes are dishonest" calls out directly — forcing agents to disambiguate "field unavailable" vs "field empty."


### v1.0.0 — fix-suggestion context-aware sweep

Source: V1-FIX-AUDIT (`[~]` above) enumerates 11 rules with generic fix text. Acceptance requires zero generic rows before v1.0 tag. Each item is sized for one ≤400-LOC commit per CLAUDE.md §9. Plans derived from fix-suggestion-audit.md. Dispatch in parallel — independent rules.


### v1.0.0 — criterion KB final sweep


### v1.0.0 — external-codebase scan findings


### v1.0.0 — external-codebase scan findings (continued)


### v1.0.0 — external-codebase scan findings (cont.)


### v1.0.0 — external-codebase scan findings (cont.)


### v1.0.0 — external-codebase scan findings (cont.)

Composite-headline counts (doctrine: "composite headline counts are dishonest — must count one kind of thing"):


Envelope honesty (doctrine: "verbose meta is scan-confidence signal; warnings are the silent-failure channel"):


Filter/correctness bugs:


Rule-metadata drift against spec (CLAUDE.md §3 invariant 4 — every rule cites every criterion it checks):


Review-finder reason-text enrichment:


New review finders (detection gaps — zero candidates on strong static evidence):


Conformance-claim honesty (the surfaces agents use to decide "should I claim this?"):


Generator-script footgun (tooling, surfaced repeatedly by agents running /fix-drift inside worktrees):


### v1.0.0 — four-repo field test findings

Parser / language coverage:


Rule correctness / detection:


Response shape / honesty:


Fix-suggestion regressions:


Minification / build-artifact classification:


Checklist / review-candidate shape:


`additionalPaths` / scope:


Catalog-scale perf / scoping:

- [ ] **V1-BENCH-4K-FILE-VENDOR-HEAVY-SCENARIO** Add a `scripts/bench.ts` scenario that synthesizes a 4000-file vendor-heavy corpus (≥50 near-duplicate vendor CSS copies, mixed HTML + JSX leaf templates) and asserts the CLAUDE.md §11 row (`≤ 25 s` ceiling). Without this fixture, the budget row is aspirational. Pair with V1-BULK-CATALOG-SCAN-PERF-12S so both the warning emission AND the budget enforcement are tested. Budget anchored in 2026-04-26 J-6 research outcome — Biome+ band defensible for a zero-dep static scanner; pushing lower would either drop rules or require parallel workers (out of scope for v1.0).
- [ ] **V1-LIMITATIONS-EXTERNAL-HANDLER-RESOLUTION** Add the structured limitation code `external_handler_resolution_unavailable` to the `limitations[]` vocabulary on `scan_project` / `scan` / `scan_file` responses. The code surfaces when a finder needs cross-file evidence to confidently resolve a click/change handler binding (separate `.js` modules attaching listeners via `addEventListener`, JSX importing handler identifiers from sibling files). Test coverage: an integration test on a vanilla-JS fixture where a `<div class="btn">` has no inline handler but a sibling `.js` file calls `querySelector('.btn').addEventListener('click', …)` — the response surfaces the limitation code in `limitations[]` even though the rule fires confidently. Doctrine: don't duplicate capability the agent already has; the limitation surfacing is the structured pointer that lets the agent decide when to follow up with Read+Grep. Decision rationale captured in 2026-04-24 J-7 research outcome; gotcha doc lives at `docs/kb/gotchas/cross-file-handler-resolution.md`.
- [ ] **V1-GROUPKEY-COLLAPSED-RESPONSE-MODE** `groupKey` is emitted on every finding and is cross-file for location-agnostic groupings. No response-shape option compresses `(ruleId, groupKey)` into one entry with the file list. On a template catalog 40k findings likely collapse to <500 unique groups. Fix: add `collapseByGroupKey?: boolean` to `scan_project` (default false, preserves current shape). When true: response emits one entry per unique `(ruleId, groupKey)` with `occurrences: [{path, line, column}]` — same paging/truncation semantics. Additive — callers opt in. Doctrine: one tool call should answer "what next?" on scale. Pairs with Q6-PATTERN-FINGERPRINT-CROSS-TEMPLATE (open, cross-template pattern ID).

### Additional items

Parser / language coverage:


Rule correctness / detection:


Fix-suggestion regressions:


Response shape / honesty:

- [ ] **V1-TEMPLATE-DIRECTIVES-FOUND-STRUCTURED** `analysisCoverage.templateDirectivesFound` ships as bare string tags (`["erb-or-ejs", "jinja-or-liquid"]`). An agent can't tell whether `erb-or-ejs` means "`<% %>` literals inside an HTML file the parser saw" (rules ran) or "an `.erb` file got fully skipped" (rules invisible). On an SSG source tree both sources contribute to the same bucket. Fix: emit `templateDirectivesFound: [{ kind, extension, fileCount, source: "literal-in-parseable-file" | "skipped-extension" }]` so agents branch deterministically. Doctrine: ambiguous field shapes are dishonest.
- [ ] **V1-SCAN-PROJECT-FINDINGS-BY-FILE-HISTOGRAM** `scan_project` exposes `totalFilesWithFindings: N` but no per-file or per-rule distribution at the response root — agents paginating to understand distribution walk every page blind. Fix: add `plan.findingsByFile: [{path, count}]` (top-N rank-ordered) OR `plan.findingsByRule: {ruleId: count}` (whole-scan histogram). Pairs with V1-CROSS-FILE-ROLLUP-PRIMITIVE (top rules) — this item is the per-file orthogonal. Additive; no information loss. Doctrine: one tool call should answer "what next?" on scale.
- [ ] **V1-COVERAGE-MANUAL-CANDIDATES-TOTAL-CROSS-SURFACE** `checklist.summary.totalCandidates` (pre-paging per-candidate count) has no sibling on `coverage` — an agent asking "how many manual-review items" reads `coverage.manualWithCandidates: N` (criteria count) and `checklist.summary.actionable: M` (same criteria count) and `checklist.totalCandidates: K` (candidate count) — three numbers, one concept, disambiguated only by reading field names carefully. Fix: expose `coverage.manualCandidatesTotal: K` alongside the existing criteria-level counters, with the "candidates vs criteria" split explicit in both `coverage` and `checklist`. Doctrine: composite headline counts are dishonest; labels must make kind explicit.
- [ ] **V1-CHECKLIST-HEADLINE-COMPOSITE-SPLIT** `checklist.summary.headline` renders `"12 actionable · 12 untargeted · 0 likely irrelevant"` on one line — while `meta.plan.actionableManualItems` + `untargetedCriteria` live separately as structured counters. The adjacent rendering invites agents to sum "12+12 = 24 things to review." Fix: drop the one-line composite headline; keep the structured per-kind counters; rename the headline string to explicitly name the split (`"12 actionable items; 12 untargeted criteria; 0 likely irrelevant criteria"`) OR emit as `headline: { actionable: 12, untargeted: 12, likelyIrrelevant: 0 }` object. Minor but canonical composite-headline-lie shape. Doctrine: composite headline counts are dishonest.

Tool-orchestration / bootstrap / suppress / write-gate:

- [ ] **V1-BOOTSTRAP-SUGGESTED-CONFIG-EXCLUDE-LOUD** `bootstrap` tool emits a `suggestedConfig.exclude` mechanically derived from `scannedBuildArtifacts` entries — on one design-system scan the suggestion was `exclude: ["js/**", "scss/_functions.scss", "site/**"]`, which covers every source tree in the project (54 mis-classified artifact entries × a `.*/**` generalization). An agent pasting this into `ra11y.config.ts` would drop 2273 findings to near-zero. Fix: cap `suggestedConfig.exclude` at a conservative set (≤ 3 entries, require ≥N independent mis-classification signals per entry) OR route build-artifact paths through a commented-out `likely-build-paths` block the agent must opt into. Never emit blanket `js/**` / `site/**` excludes from artifact heuristics. Pairs with V1-BUILD-ARTIFACT-REGRESSION-AUDIT-MINIFIED downstream — but even with the classifier fixed, the generator should not amplify single heuristic signals into tree-sized excludes. Doctrine: surface-don't-suppress, applied at the generator step (an agent can't un-exclude a tree that was never parsed).
- [ ] **V1-PLAN-SAFE-EDITS-STALE-MCP-SERVER** Commit `fce189c8 refactor(mcp): drop plan.safeEditsAvailable composite counter` removed `plan.safeEditsAvailable` per the composite-headline-lies doctrine — but the live MCP server still emits it on both `scan_project` and `bootstrap` responses. Either (a) the MCP subprocess is serving a pre-drop bundle, (b) the MCP server's build artifact isn't being picked up by `npm link` / the smoke harness, or (c) the drop landed in one code path but not the other. Fix: audit the MCP server build / release pipeline — add a CI smoke test that scans a fixture and asserts `plan.safeEditsAvailable` is absent from the response; confirm the dropped-field refactor reaches every invocation path. Doctrine: doctrine changes must propagate to the shipped artifact, not just the source.

Checklist / review-candidate shape:

- [ ] **V1-REVIEW-CANDIDATES-SIBLING-REASON-DEDUP** `reviewCandidates[*].reason` duplicates prose across sibling findings for the same criterion — on `sound-board/index.html` six `<audio>` elements emit 6 identical candidates per criterion for `wcag22:1.2.1`, `1.2.3`, `1.2.5` (18 rows with 3 unique reason strings). The `reviewCandidates.prompts[criterionId].text` dedup already exists for top-level prompts but per-finding `reason` strings are not deduped by `(ruleId, criterionId, reason)` tuple. Fix: hoist the shared reason to `prompts[criterionId].genericReason` alongside existing `.text`, keep per-location `snippet`; OR cap sibling candidates of the same shape at `N=3` + emit `additionalSiblingCount: <rest>`. Doctrine-consistent precedent: the prompt-text dedup is the same move one level up.

Minification / build-artifact classification:

Catalog-scale perf / scoping:

- [ ] **V1-PATTERN-ID-DEAD-INFRASTRUCTURE** Commit `feba3df8` added `patternId` (cross-template fingerprint) to `Violation` with the engine stamping at `src/engine/rule-runner.ts:182` and `src/engine/stamp-project-emission.ts:47` — both gate on `emitted.snippet` being a non-empty string. Grep of `src/rules/` for `snippet:` returns **zero** hits — no in-tree rule populates the `snippet` field that the stamp predicate requires. Verified on a 40,132-finding at-scale scan: `patternId` occurrences in the response = 0. Particularly fatal at this scale: the three biggest-volume rules (`motion/pause-stop-hide`, `contrast/minimum`, `contrast/non-text` — ~43 % of findings combined) are CSS-declaration rules with no natural snippet source, so `patternId` can never reach them under the current design. Fix: decide — either (a) populate `emitted.snippet` on at least one snippet-emitting rule (HTML/JSX shape rules are the realistic candidates: `navigation/href-javascript-void`, `semantics/button-name`, `aria/expanded-on-disclosure`, `media/alt-text-missing`) so `patternId` is non-empty on at least one finding family; OR (b) remove the type field and delete the stamp sites — current state advertises an affordance that no finding carries. Pairs with Q6-PATTERN-FINGERPRINT-CROSS-TEMPLATE (open — proposes the cross-template fingerprint for CSS findings via a different hash path that does not depend on `snippet`). Doctrine: advertising an affordance that never reaches the wire is dishonest.
- [ ] **V1-CSS-CROSS-TEMPLATE-FINGERPRINT** CSS-declaration rules (`motion/pause-stop-hide` 8956, `contrast/minimum` 5458, `contrast/non-text` 2805) fire tens of thousands of times on a template catalog where 117 near-identical copies of `bootstrap.css` ship across 172 template dirs. `patternId` cannot fingerprint these (see V1-PATTERN-ID-DEAD-INFRASTRUCTURE — it gates on `snippet`) and `groupKey` operates per-file, so 117 identical `.img-thumbnail` transitions collapse to 117 distinct finding groups. Fix: add a CSS-rule-specific fingerprint — `cssPatternId = hash(ruleId + selectorFamily + propertyFamily + valueShape)` — that collapses "same selector + same declaration shape" across files. Likely reduces the 17k CSS-rule findings on this corpus to ~40 canonical patterns. Pairs with Q6-CONTRAST-VENDOR-CSS-CROSS-FILE-DEDUPE (open, same-basename) and Q6-PATTERN-FINGERPRINT-CROSS-TEMPLATE (open, HTML/JSX element-level). This item is the CSS-declaration sibling that neither covers. Doctrine: the agent has no honest way to say "this is one canonical a canonical CSS transition, 117 copies" without such an affordance.
- [ ] **V1-PROJECT-DIRECTORY-ROLLUP** is a mono-repo of 50 independent mini-projects under one root; `scan_project` treats it as one repo and merges findings. `meta.perRuleCoverage.findingsEmitted` tells per-rule but not per-project / per-directory. An agent triaging a mono-repo-of-demos or a website-template catalog benefits from `plan.topDirectories: [{path, violationCount, topRule}]` — rank-ordered to expose uneven distribution and let the agent pick the sub-tree that matters first. Additive extension of V1-CROSS-FILE-ROLLUP-PRIMITIVE (which proposes `plan.topRules`). Doctrine: one tool call should answer "what next?" — on a 50-project mono-repo, per-project scoping is the first "what next" question.

Rule correctness / detection (false positives + missing scope):


Review-finder noise / dedup:

- [ ] **V1-CHECKLIST-CRITERION-CANDIDATE-DEDUPE-ACROSS-IDS** Same `(file, line, reason)` candidate fires under multiple criterion IDs with byte-identical reason text. On `ratio.mdx:14` cited 3× under `wcag22:1.2.1`/`1.2.3`/`1.2.5`; sound-board `<audio>` rows fire 6 elements × 3 criteria = 18 candidates with 3 unique reason strings; template-catalog `fancybox.pack.js:4` cited 74× × 3 criteria = 222 likelyIrrelevant rows. Fix: when a candidate's `(ruleId, snippet, reason)` tuple is identical across N criterion IDs, fold to one candidate with `criterionIds: [...]` array; `verdict_candidate` then applies one verdict to all listed criteria. Pairs with V1-REVIEW-CANDIDATES-SIBLING-REASON-DEDUP (per-criterion sibling axis); this is the cross-criterion same-candidate axis.

Response shape / cross-surface drift / honesty:

- [ ] **V1-PERRULE-COVERAGE-CONFIDENCE-PARSE-ERROR-CORPUS** At corpus scope on templates (4043 files, 501 parse-error files, 12.4% parse-error rate), `perRuleCoverage` reports `coverageConfidence: "high"` for **71/71 rules** — zero rules report `low` or `medium` despite 12% of files crashing the tsx parser. The single-file `scan_file` response *does* report `low` honestly (8/71 rules). The aggregation step turns "no .css scanned" into "0 .css files" but still flips `coverageConfidence` to `high` because the project-wide directory contained 8 .css files. Fix: a rule whose `filesEligible` includes ≥10% parse-errored or partial-parsed files should flip to `medium`; ≥25% to `low`. Distinct from V1-PERRULE-COVERAGE-HONESTY-ON-PARSE-ERRORS (per-file axis); this is the corpus-aggregation axis.
- [ ] **V1-FINDINGS-SNIPPET-FIELD-OMITTED-ON-SCAN-SURFACES** `scan_project` and `scan_file` `findings[*]` lack `snippet` field; `checklist.items[*].candidates[*]` includes it. The asymmetry forces extra Read calls per finding and inflates `fix.description` prose. Source check: `src/output/agent-response/types.ts:127` declares `snippet?: string` (present-when-meaningful); the rule layer doesn't populate it for scan-side findings. Adding 1-3 lines per finding would (a) collapse the dishonest "is this fix mechanical?" question for cases like motion/pause-stop-hide, and (b) reduce per-finding `fix.description` prose. Pairs with V1-PATTERN-ID-DEAD-INFRASTRUCTURE which gates `patternId` on `emitted.snippet` being non-empty — populating snippets unblocks both.
- [ ] **V1-SUGGEST-FIX-SCHEMA-PRIMARY-ALTERNATIVES** The `suggest_fix` tool description promises "guidance with a ranked primary fix and alternatives" but `kind: "guidance"` ships a single `explanation` string with alternatives concatenated as prose ("`<label for>` ... or `aria-label` ... or `aria-labelledby`"). Schema-vs-reality drift. Fix: structure `kind: "guidance"` as `{primary: {description}, alternatives: [{description, rationale?}]}` so the agent can rank fixes without prose parsing. Also add missing fields: `nextStep`, `findingId` echo.
- [ ] **V1-SUGGEST-FIX-KIND-SUPPRESS-RECOMMENDED** `suggest_fix` on `semantics/heading-hierarchy` for a `_includes/` partial returns `kind: "guidance"` with explanation that primarily describes a *suppression* (pragma) rather than a fix. The guidance/edit/none discriminator is doing double duty as "structural recommendation" and "I give up — please add a pragma." Splitting `kind: "suppress-recommended"` from `kind: "guidance"` would make the agent's branching honest.
- [ ] **V1-DETECTED-FRAMEWORK-CONFIDENCE-AND-INHERITANCE** `meta.detectedFramework: {name: "jekyll", buildOutput: "_site/", buildCommand: "bundle exec jekyll build"}` fires on a single sentinel `_config.yml` at the corpus root with no `Gemfile`/`_layouts/`/`_includes/` corroboration. On templates (174 independent un-built static-template snapshots) the advice is wrong — `_site/` would be near-empty. Worse: scanning a sub-template directory inherits `detectedFramework: jekyll` even when the sub-tree has no `_config.yml` (the detector walked up to an ancestor). Fix: add `detectedFramework.confidence: "high" | "medium" | "low"` derived from corroborating evidence count; on sub-scope scans, only inherit the parent's framework label when the sub-tree has its own corroborating evidence.
- [ ] **V1-PROPOSE-CONFIG-EXCLUDES-DOWNSTREAM-AMPLIFICATION** `propose_config` writes blanket `exclude: ["docs/**"]` on (the only directory with content), `exclude: ["js/**", "site/**"]` on (the source trees), and `exclude` lists 167 template directories at scale (95% of repo). Pasting any of these silences ~99% of real signal. Root cause: the heuristic gates on directory-name patterns or on `scannedBuildArtifacts` mis-classifications and propagates them into config. Fix: `propose_config` should never exclude a directory that contains files with active findings — gate on "does this dir have grounded findings? if yes, do not exclude." Pairs with V1-BUILD-ARTIFACT-CLASSIFIER-BYPASS-HTML-FP and V1-BOOTSTRAP-SUGGESTED-CONFIG-EXCLUDE-LOUD — both upstream amplifiers. Doctrine: surface-don't-suppress, applied at the generator step.
- [ ] **V1-PROPOSE-CONFIG-EXCLUDES-RATIONALE** `propose_config` ships an exclude list with no per-entry rationale. Agent cannot tell which entries came from `scannedBuildArtifacts` mis-classification vs. `node_modules`-style definitional vs. ad-hoc heuristic. Add `excludesReason: [{glob, reason: "labelled minified by scan_project" | "definitional" | "heuristic"}]` per entry so the agent can audit before pasting. Pairs with V1-PROPOSE-CONFIG-EXCLUDES-DOWNSTREAM-AMPLIFICATION (the gate).
- [ ] **V1-DEFAULT-EXCLUDED-PATTERNS-TEST-STORY-DROP** `DEFAULT_EXCLUDED_PATTERNS` (verified at `src/input/discover.ts:60-70`) hard-codes `**/*.test.*`, `**/*.spec.*`, `**/*.stories.*`, `**/*.story.*`, `**/__tests__/**`, `**/stories/**`, `**/dev-tools/**`, `**/devtools/**` — the header comment literally says "scanning them produces noise (onChange on filter bars, render assertions, sample copy that happens to contain 'click below')." That's verbatim "human-attention suppression," which the AI-first doctrine rules out. A test file that uses `<button>` without an accessible name CAN be a real a11y bug — fixture code gets copy-pasted into production routinely. Drop: `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/*.stories.*`, `**/*.story.*`, `**/stories/**`, `**/dev-tools/**`, `**/devtools/**`. Keep: `**/__mocks__/**`. The `includeTests` opt-out escape hatch is the right shape; the default is wrong per doctrine.
- [ ] **V1-VERDICT-CANDIDATE-CANDIDATE-ID-PASSTHROUGH** `verdict_candidate` requires the caller to hand-build `{candidate: {criterionId, location, reason, snippet, confidence}, reviewPrompt}` from prior `checklist`/`review_candidates` responses (6 keys re-stitched). No `candidateId` link, no batch entry. At scale (5003 candidates on templates) one round-trip per candidate is unfeasible. Fix: add `candidateId` shortcut (`verdict_candidate({candidateId, reviewPrompt})`) that back-loads the snippet from the original call. Pairs with V1-CHECKLIST-ITEM-REVIEW-PROMPT-FIELD.
- [ ] **V1-CHECKLIST-ITEM-REVIEW-PROMPT-FIELD** `checklist.items[*]` does not carry `reviewPrompt` — but `verdict_candidate` requires it. The natural workflow is `checklist → verdict_candidate`, but the prompt-text lives only on `review_candidates.prompts[criterionId].text`. An agent has to call `review_candidates` separately or hand-author the prompt. Fix: include `reviewPrompt` per criterion in `checklist.items[]` so the workflow is one tool call shorter.
- [ ] **V1-FINDING-CATEGORY-VS-FIXCLASS-CONTRADICTION** Same finding ships `fixClass: "runtime-only"` AND `category: "auto-fix"` AND `effort: "trivial"`. On `theme-clock/style.css:13` motion/pause-stop-hide finding — `runtime-only` per `fixesByClass` means "the scanner can't ground a deterministic fix here" but `category: auto-fix` reads as "apply_fix can do this." Same finding has `fix.safety: "safe"` and a `fix.description` that DOES specify the exact CSS rewrite. Fix: one of the two labels must be retracted. Doctrine: ambiguous field shapes are dishonest.
- [ ] **V1-MISSING-WARNING-COVERAGE-CONFIDENCE-INCONSISTENT** When `parseErrorFileCount > 0` AND every rule reports `coverageConfidence: "high"`, the meta is internally inconsistent. Add structured warning `coverage_confidence_uniformly_high_with_parse_errors`. Tied to V1-PERRULE-COVERAGE-CONFIDENCE-PARSE-ERROR-CORPUS.

Tool-orchestration / new tool surfaces:

- [ ] **V1-TOOL-SCAN-PROJECT-SUMMARY-MODE** Add `scan_project({summaryOnly: true})` that returns `plan + meta + topRules: [{ruleId, count}] + topFiles: [{path, count}] + filesByExtension + plan.summary` and *omits* per-file `files` array entirely. Fits under 20 KB. First-call ergonomics on bulk catalogs (templates 4043 files / 40k findings). Pairs with V1-RESPONSE-SIZE-PRE-ESTIMATOR.
- [ ] **V1-TOOL-FINDING-BY-ID** No tool retrieves a finding by `findingId` after the scan. `suggest_fix` requires `ruleId + file + line` — but `scan_project` returns `findingId: "b0d1b34c01d1"` opaque IDs. Add `get_finding({findingId})`.
- [ ] **V1-TOOL-FINDINGS-BY-RULE** `scan_project` paginates by file; an agent triaging "all 169 `aria/expanded-on-disclosure` findings" must page 110 files. Add `findings_by_rule({ruleId, cwd})` that returns just the findings for one rule across the project. Replaces 22 paginated calls with one. Pairs with V1-CROSS-FILE-ROLLUP-PRIMITIVE.
- [ ] **V1-TOOL-SESSION-INSPECT** No read-only tool to retrieve current session state. After `sessionConfigure`, agents have no way to verify rule overrides, native wrappers, or excludes without making a no-op `scan` call. Add `sessionInspect()` returning the same shape `sessionConfigure.active` returns plus `rules`, `nativeWrappers`, `cwd`. Pairs with V1-SESSION-CONFIGURE-ECHO-STATE.
- [ ] **V1-TOOL-LIST-FINDERS** Manual-review finders (`review/multiple-ways`, `review/pointer-input`, etc. — visible in `review_candidates.prompts[*].finderId`) are NOT enumerated by any tool. Agents discover them only by accident through `review_candidates` results. Per the rules-silently-defer / finders-silently-fire pattern, having a `list_finders` tool would expose the manual-review surface area for audit.
- [ ] **V1-TOOL-AUDIT-RULE-COVERAGE** No tool surfaces "rule X did not fire on file Y, but heuristic predicates suggest it should have." The only way to discover an FN is to manually inspect `perRuleCoverage` and reason about it. Add `audit_rule_coverage({ruleId, file})` returning `{fired: false, eligibleByExtension: true, predicateMissed: true, hint: "trigger requires static-text child; file contains Liquid expression"}`.

Catalog-scale perf / scoping:

- [ ] **V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE** `checklist.likelyIrrelevant` ships 74 candidates per criterion × 4 criteria = 296 rows for templates corpus, all pointing at identical `<iframe id="fancybox-frame{rnd}"...` template literals in 74 copies of `fancybox.pack.js:4`. The bucket label is doctrine-correct (deterministic "no `<video>`/`<audio>` parsed") but the *quantity* is not — every fancybox install ships an identical line. Fix: collapse to one entry with `occurrences: 74`. Pairs with V1-CSS-CROSS-TEMPLATE-FINGERPRINT and V1-CHECKLIST-VENDOR-FILE-FINGERPRINT-COLLAPSE.
- [ ] **V1-CHECKLIST-IFRAME-EMBEDDED-MEDIA-NOT-IRRELEVANT** `checklist.likelyIrrelevant: 4` on groups SCs 1.2.1/1.2.3/1.2.5 under "no `<video>` or `<audio>` detected" — bucket label is provable from code (deterministic fact), but the candidates inside include `docs/_tutorials/video-walkthroughs.md:10` (`<iframe src="https://www.youtube.com/embed/T1itpPvFWHI">`) and `docs/pages/jekyllconf.md:16` (parameterized YouTube embed via Liquid). YouTube iframes ARE WCAG 1.2.x in scope. The bucket sweeps real candidates into "likely irrelevant" because the heuristic confuses "no native `<video>` tag" with "no media." Fix: either (a) detect `<iframe src*=youtube|vimeo|twitch|brightcove|wistia>` and demote those candidates from `likelyIrrelevant` back to `actionable`, or (b) keep them in main `items[]` with reason "iframe embed of likely media (`youtube.com/embed/...`) — no native `<video>` tag but media accessibility still applies." Doctrine: a bucket is honest only when label-AND-implication are both 100% from evidence; here the implication is heuristic.
- [ ] **V1-PLAN-FINDINGS-BY-FILE-AND-RULE-HISTOGRAM** `scan_project` exposes `totalFilesWithFindings` but no per-file or per-rule distribution at the response root. On an SSG docs tree (71 files-with-findings) the agent can't budget pagination cost without iterating all 71. On templates (1793 files) paging 1793× costs hours of round-trips. Fix: add `plan.findingsByFile: [{path, count}]` (top-N rank-ordered) AND `plan.findingsByRule: {ruleId: count}`. Pairs with V1-CROSS-FILE-ROLLUP-PRIMITIVE.
- [ ] **V1-AGENT-RESPONSE-REFERENCE-GUIDE-OPT-IN** `scan_file` on dense HTML (>100 LOC) blows the MCP token ceiling because `referenceGuide.suppressPlacement` + `referenceGuide.fixDescriptions` ship on every per-file response (~30-40 KB each call). Fix: ship `referenceGuide` only on the first call per session, OR behind `includeReferenceGuide: true` opt-in. Pairs with V1-TOOL-VERBOSE-META-INVERTED-DEFAULT.
- [ ] **V1-FILES-BY-EXTENSION-GROUND-TRUTH-UNDERCOUNT** `meta.filesByExtension` undercounts actual file counts on the a design-system docs corpus: reports `.css:31, .js:56, .scss:114, .md:13` while ground-truth `find -type f -name '*.css'` returns 47, `.js` 116, `.scss` 122, `.md` 17 — deltas of -16 / -60 / -8 / -4 with no obvious default-exclusion explaining them. Deltas are not consistent with `DEFAULT_EXCLUDED_PATTERNS` paths; silent drops somewhere between discovery and the bucket-by-ext counter. Fix: add an invariant test that `sum(filesByExtension.values()) + sum(skippedByExtension.values()) + excludedByPattern` equals the raw `find` count on a known fixture corpus; instrument the discovery pipeline to emit `meta.filesByExtension.excludedByPatternPerExt: {ext: count}` so the drop axis is visible. Doctrine: verbose meta is scan-confidence signal — a count that silently misses 60 JS files trains the agent to trust a dishonest denominator.
- [ ] **V1-SCSS-RULES-COVERAGE-HOLE-JEKYLL** On an SSG source tree (18 `.scss` files, zero `.css`), `meta.analysisCoverage.rulesByExtension[".scss"]` lists only `focus/outline-visible` + `wrapper/drift` — the CSS-family rules (`contrast/minimum`, `contrast/non-text`, `contrast/enhanced`, `layout/*`, `focus/not-obscured`) never run despite SCSS containing plain CSS declarations the alias pipeline should route. Q4-SCSS-DISCOVERY-WIRE (closed) verified SCSS parses cleanly and fires `contrast/minimum` on the initial audit; the current SSG tree does NOT show those rules running. Either (a) the extensionMatches alias regressed, (b) the rule selectors themselves decline on SCSS substrate, or (c) the MCP subprocess is serving a stale bundle (V1-MCP-DIST-STALE-CI-GATE umbrella). Fix: add a cross-surface invariant test asserting every `.scss`-scanned repo fires at least one `contrast/*` rule when the source contains a low-contrast declaration; if the alias path is intact but selectors decline on `.scss`, widen the selector gate so CSS-family rules run on `.scss` after SCSS-only syntax is stripped. Pairs with Q6-SCSS-PARSING-DISCLOSURE (closed, telemetry axis) — this item is the detection axis.
- [ ] **V1-SCAN-FILE-META-CROSS-FILE-STATE-LEAK** `scan_file` on `docs/_includes/top.html` returns `meta.analysisCoverage.partialParseFiles` containing `error.html` (a different file in the same project). Per-file scans should report per-file diagnostics only; leaking project-scan state into a single-file response forces the agent to re-read and disambiguate whether `error.html` was actually involved in evaluating `top.html`. Fix: `scan_file` must filter `parseErrorFiles` / `partialParseFiles` / `scannedBuildArtifacts` / `opaqueCustomComponentNames` to only entries whose path equals the scanned file. Doctrine: cross-surface shape drift — `scan_file` and `scan_project` must not share the same unfiltered meta blob.
- [ ] **V1-CHECKLIST-AUTOMATED-PASS-RATE-SEMANTICS-UNCLEAR** `checklist.summary.automatedCoverage.automatedCriteriaPassRate: 58` on that ALSO carries 323 active violations and 71 files-with-findings reads to an agent as "most criteria pass" — but the denominator / numerator are undocumented in the response. Q-SHARED-PASS-RATE-COMPOSITE (closed) specified the split (`criteriaEvaluated / criteriaClean / criteriaWithFindings / criteriaUntestable`); the shipped field is still a bare scalar with no companion split on the checklist surface. Fix: either (a) ship the structured split alongside (or instead of) the scalar, (b) rename the field to `automatedCriteriaCleanRate` so the label names what it measures, or (c) drop the scalar entirely in favor of the per-bucket sibling counters. Distinct from V1-ZERO-SCAN-PASS-RATE-SENTINEL (zero-file edge case); this is the healthy-scan semantic-ambiguity axis. Doctrine: ambiguous field shapes are dishonest.
- [ ] **V1-FINDER-ACCESSIBLE-NAME-SR-ONLY-IMG-ALT-REDUNDANT** Canonical logo-link shape `<a href="/"><span class="sr-only">Brand</span><img src="logo.png" alt="Brand Logo"></a>` concatenates to accessible name "Brand Brand Logo" — duplicate token + redundant "Logo" suffix (AT announces the role automatically). On `docs/_includes/header.html:4-9` this shape ships unflagged; no rule or finder surfaces the sr-only + alt redundancy pattern. Fix: new review finder `review/accessible-name-redundant-composition` — compute accessible name for anchors / buttons whose children mix visually-hidden text (`.sr-only`, `.visually-hidden`, `[aria-hidden]`) with `<img alt="…">`; when the concatenated name contains case-insensitive duplicate tokens OR role-suffix redundancy (`logo|image|icon|button|link`), emit a 2.4.6 / 4.1.2 review candidate. Satisfies wcag22:2.4.6 + 4.1.2.
- [ ] **V1-FINDER-ALT-DUPLICATES-SIBLING-TEXT-INSIDE-BUTTON** Pattern `<button><p>Fly</p><img alt="fly"></button>` (`insect-catch-game/index.html:19-49`, 4 instances) — alt text duplicates a visible sibling text node inside the same interactive ancestor. 1.1.1 guidance says decorative/redundant images should use `alt=""`; the current duplication inflates accessible name ("Fly fly") and burdens AT. `media/alt-text-placeholder` misses this because the alt value is authored-looking ("fly" is not in the placeholder token list), yet in context it IS placeholder. Fix: extend `media/alt-text-placeholder` OR new review finder — when `<img alt="X">` is a descendant of `<button>` or `<a>` AND a sibling text node (direct or via `<p>`/`<span>`/`<strong>`) contains case-insensitive `X` (or X is a substring of the sibling), emit a 1.1.1 candidate recommending `alt=""`. Satisfies wcag22:1.1.1.
- [ ] **V1-RULE-TOGGLE-BUTTON-ARIA-PRESSED** `<button class="toggle">Dark mode</button>` on `theme-clock/index.html:12` flips `html.dark` — persistent on/off state, distinct from disclosure (which toggles visibility of a related region). Needs `aria-pressed="true|false"`, not `aria-expanded`. V1-RULE-EXPANDED-ON-DISCLOSURE-FIRES-ABSENT-ATTRIBUTE covers the disclosure-shape-without-attribute axis; this item is the toggle-button-without-pressed axis — different ARIA pattern. Fix: new review finder `aria/toggle-button-pressed-missing` — fire on `<button>` where class contains `/toggle|switch|mode/` OR visible text matches `/^(dark|light|night|day|on|off)\s*(mode)?$/i` AND element has no `aria-pressed`/`aria-checked`. Confidence `medium` (cross-file handler resolution lossy). Satisfies wcag22:4.1.2.
- [ ] **V1-FINDER-STATUS-MESSAGES-PLUS-MINUS-READOUT** 4.1.3 Status Messages finder does not fire on the plus/minus counter pattern: `<button>+</button><span id="size">10</span><button>-</button>` where the readout mutates on button click but has no `role="status"` / `aria-live`. `drawing-app/index.html:13` has the canonical shape. V1-LIVE-REGION-RUNTIME-MUTATION-CANDIDATE (open) covers the cross-file `elem.innerHTML = …` JS axis; this item is the static-DOM signal — provable from the HTML shape alone, higher-confidence than cross-file handler resolution. Fix: new review-candidate finder `review/status-message-plus-minus-readout` — fire on `<span>`/`<div>`/`<output>` sibling to two buttons whose trimmed text or class matches `/^[\+\-]$/` or `/\b(plus|minus|increase|decrease|up|down)\b/i`, where the target lacks `aria-live|role=status|role=alert|<output>`. Confidence `high` (fully static). Satisfies wcag22:4.1.3.
- [ ] **V1-TRUNCATED-RESPONSE-NEXTSTEP-PAGING-HINT** When `truncated: true` and `nextOffset` is present, `nextStep` prose still reads "call suggest_fix on the top finding" — ignoring that the agent has 80 files-with-findings and paged only 25. An agent following `nextStep` proceeds to single-finding triage and never pages the rest. Fix: when `truncated: true`, prepend `nextStep` with "Response truncated — {totalFilesWithFindings} files-with-findings, {filesReturned} returned. Call scan_project with offset:{nextOffset} to continue, OR triage the top returned finding first via: …" — AND ensure `nextStepStructured` offers a paging shape (`{tool: "scan_project", args: {offset: N}}`) alongside the finding-triage shape. Doctrine: one tool call should answer "what next?" — the current response points at the second-order question while hiding the first-order pagination cost. Pairs with Q-SHARED-LIMIT-REQUEST-VS-EFFECTIVE (closed, `effectiveLimit` surface axis).
- [ ] **V1-EMPTY-ROOT-DIV-SCRIPT-ONLY-WARNING** Canonical vanilla-JS demo shape: body contains `<div id="buttons"></div>` + `<script src="script.js"></script>` and nothing else; all interactive controls are created by the script at runtime. ra11y returns 0 findings for `sound-board`, `hoverboard`, `pokedex`, `toast-notification`; `plan.summary` reads "No automated findings." Zero-output success per doctrine — agent concludes "clean page" when the real answer is "static scan cannot evaluate runtime-generated DOM." Fix: emit structured warning `warnings: ["dynamic_content_container_detected"]` + sibling `warningsDetails.dynamic_content_container_detected: {bodyChildCount, emptyContainerIds, scriptSources}` when body has ≤3 non-script visible children AND contains an empty `<div id>` AND a sibling `<script src>`. Pairs with V1-LIVE-REGION-RUNTIME-MUTATION-CANDIDATE (runtime-mutation axis on populated DOM) — this is the never-populated-at-parse-time axis. Doctrine: zero-output success is ambiguous failure.
- [ ] **V1-REVIEW-CANDIDATE-CROSS-FILE-REPETITION-COLLAPSE** Website-templates' 528 HTML files trigger the same 2.4.5 candidate with byte-identical reason "Likely root layout has no search/sitemap/breadcrumb" on each `index.html`; `uniquePerCriterion` doesn't help because every candidate anchors to a different file path. V1-CHECKLIST-CRITERION-CANDIDATE-DEDUPE-ACROSS-IDS covers the same-candidate-across-criteria axis; V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE covers the vendor-file same-path axis. This item is the cross-file cross-template pattern-repetition axis. Fix: when the same `(ruleId, reasonHash)` fires on N files with N > threshold (e.g. 20), collapse to one top-level entry with `{pattern, occurrences: N, sampleFiles: [top-5-paths], totalFiles: N}` and elide the rest; the agent gets the signal once + sample coverage + the total without 528 near-identical rows. Doctrine: labeled buckets honest when the label is provable — "same-reason pattern fires on N files" is a deterministic fact.


### v1.0.0 — orchestrator follow-ups

Items surfaced during the /continue orchestrator run that landed the tenth-pass batch. Not user-surfaced drift — engineering follow-ups.

- [ ] **V1-SILENT-DROP-TYPEOF-BOOLEAN-AUDIT** — the V1-SESSION-CONFIGURE-ALLOWWRITE-SILENT-DROP fix (commits 7fd25c08, ded4616e) revealed a `typeof x === "boolean"` guard that silently discarded non-boolean inputs. Audit other MCP tool-input parsers for the same pattern — any `typeof` guard that quietly drops mismatched inputs instead of emitting a structured `invalid-param` error. Candidates: `sessionConfigure.autoDetectWrappers`, `scan_project.additionalPaths` shape, `suggest_fix.maxCandidates`, `checklist.maxCandidatesPerCriterion`, any other input shape assertions in src/mcp/*.ts. Fix with the discriminated `{ok, opts} | {ok:false, error}` pattern established in src/mcp/configure-opts.ts. Per AI-first doctrine, silent drops are dishonest — the agent thinks it configured a setting that never took effect.
- [ ] **V1-ANALYSIS-COVERAGE-FILE-LIMIT-APPROACHING** — `src/mcp/analysis-coverage.ts` hit 503 effective lines during the V1-FRONTMATTER-AS-TEMPLATE-DIRECTIVE-TRIGGER + V1-TEMPLATE-CLASSIFIER-MARKDOWN-PROSE-FALSE-POSITIVE integration; integrator self-refactored to drop back under 500. The file is absorbing markdown + frontmatter + code-span + template-engine classification all at once. Split into `markdown-classifier.ts` + `frontmatter-classifier.ts` + a thinner `analysis-coverage.ts` orchestrator before the next markdown-classifier item lands, or the next addition will bounce off the limits guard again.
- [ ] **V1-MDX-FENCED-CODE-BLOCK-INDENTED-PARITY** — `src/input/parsers/mdx.ts` has duplicated fenced/inline-code stripping logic from `markdown.ts` but is missing the indented-code-block strip that turn 7 of the 2026-04-25 /continue run added (commit 2af3e5f3). Port the indented-code-block prepass into `mdx.ts` so MDX gets the same false-positive coverage. Surfaced by parser-author specialist during Q7-MARKDOWN-FENCED-CODE-BLOCK-SCOPE — flagged as out-of-scope for that pick but worth following up.
- [ ] **V1-CORPUS-REFRESH-POST-DIST-FRESHNESS-GATE** — V1-MCP-DIST-STALE-CI-GATE (shipped 2026-04-25 in commit effb2645) caught a stale `dist/cli.js` on `main` itself. The 2026-04-25 multi-repo corpus probe that generated the Q8 + much of the V1 backlog ran against the pre-gate stale subprocess, so 4 of ~30 picks in the same /continue run returned `classification_mismatch: already_landed` (Q7-RULE-ANIMATION-ITERATION-COUNT-GATE, Q7-RULE-TABLE-TH-SCOPE-IMPLICIT-COL-NARROWING, V1-SCANNED-BUILD-ARTIFACTS-ENVELOPE-DRIFT, V1-RESPONSE-SIZE-PRE-ESTIMATOR). Re-run the multi-repo probe now that dist is gated and tick off any other already-landed items still sitting open in Q8 + V1. Per `feedback_regression_audit_stale_subprocess` memory: grep + verify rather than blind-re-implement.
- [ ] **V1-PLANNER-PRE-GREP-STALE-DETECTION** — The /continue planner subagent (`.claude/agents/planner.md`) currently classifies picks but does not pre-flight check whether the pick's predicate is already implemented. When 4 of 30 picks in a single run return `classification_mismatch: already_landed`, that's wasted dispatch budget the planner could have absorbed. Extend the planner to grep `git log --oneline --grep=<rule_id_or_predicate>` and `src/rules/<path>` for each pick before classifying; if there's strong evidence the predicate is implemented, mark the pick `deferred: stale_already_landed: <evidence>` so the orchestrator ticks it off without dispatching. Pairs with V1-CORPUS-REFRESH-POST-DIST-FRESHNESS-GATE (the corpus refresh removes the input; this item removes the wasted-dispatch failure mode for whichever stale items survive).
- [ ] **V1-COLLECT-MANUAL-CRITERION-IDS-PARTIAL-AUTOMATABLE** — `collectManualCriterionIds` in `src/engine/scanner.ts` only includes criteria with `automatable: "manual"`, so review finders citing `automatable: "partial"` criteria (e.g. the new `review/finders/reduced-motion-candidate.ts` on 2.3.3, plus `review/finders/carousel-pattern.ts` on 2.2.2 if applicable) may not activate via the production scanner. Surfaced by the `review/finders/reduced-motion-candidate` rule-implementer during /continue 2026-04-25 turn 10. Audit which finders cite partial-automatable criteria; either widen `collectManualCriterionIds` to include partial-automatable criteria when they have an associated finder, OR document the rule that finders must cite manual-only criteria. WCAG-side correctness: 2.3.3 IS partial-automatable (the `prefers-reduced-motion` media-query check is a deterministic predicate even though the SC overall is judgment-bearing). Bias toward widening — the failure mode is silent under-emission.
- [ ] **V1-CLI-REPORT-COMMAND-PARSE-ROUTE-NARROW** — `src/cli/commands/{coverage,vpat,checklist,certification}.ts` each carry a minimalist `parseFor` helper that routes only `.html` / `.htm` / `.xhtml` + `.tsx` / `.jsx` / `.ts` / `.js` and silently drops every other parseable extension (`.astro`, `.mdx`, `.svg`, `.md`, `.markdown`, `.mkdn`, `.erb`, `.css`, `.scss`, `.less`). Same routing-skip-as-suppression shape as the .astro routing fix shipped 2026-04-27 but at the CLI-handler layer instead of the parser-route layer. Surfaced by the parseAstro specialist as an out-of-scope adjacent finding. Fix: share a single canonical `parseFor` helper across the four reporting commands (and the scan command) so the route table is one place. Per AI-first doctrine, "Routing skips that drop content are the symmetric twin of suppression."
- [ ] **V1-FIXTURE-RUNNER-EXTENSION-GAPS** — `tests/fixtures/real-world/runner.ts` `SUPPORTED_EXTENSIONS` does not include `.astro`, so the `bootstrap-astro-template-single-long-line` fixture's `.astro` source files are silently skipped (already documented as a known TODO in that fixture's `blog-rtl.tsx` header). Fix: extend `SUPPORTED_EXTENSIONS` to mirror the production parser-route table (all extensions parseHtml / parseTsx / parseAstro / parseMdx / parseMarkdown / parseSvg / parseErb / parseCss accept). Without this, real-world fixtures cannot regression-guard parser routing for their own extensions; the unit-test layer becomes the only safety net for routing decisions. Surfaced by the parseAstro specialist as an out-of-scope adjacent finding.

---


- **Implement the remaining manual-only criteria as finders.** The coverage matrix (V1-COVERAGE-MATRIX) will enumerate actual gaps — per finder review the finder list confirms most are already covered. If V1-COVERAGE-MATRIX surfaces genuine gaps, each becomes a Track R `R-<criterion>-<topic>` item, NOT a Track V item. Track V verifies; Track R implements detection.
- **Widen real-world fixtures beyond the five above.** SPA routing, internationalization, dark-mode contrast, reduced-motion — all worth fixtures, none are "find all violations" gates. Log as Track F `F-V1.x` items if the v1.0 bar rises.
- **OSSF Scorecard / npm audit workflows.** Nice-to-have for supply-chain posture; zero-dep invariant already covers most of the surface. Skip unless a real signal arrives.

---

