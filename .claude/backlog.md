# ra11y backlog

The `/continue` skill reads this file and dispatches work to specialist subagents. Each item should be small enough that one specialist can finish it in under 20 minutes. When an item would produce more work, split it in place before dispatching.

Legend: `[ ]` open · `[~]` in progress · `[!]` blocked (reason in comment).

Closing an item = deleting its `- [ ] **<ID>**` line in the same commit that lands the work, with a `Closes: <ID>` (or `Drops: <ID>`) trailer in the commit message. The commit body carries the rationale; look it up later via `git log --grep "Closes: <ID>"` or `bun scripts/show-closed.ts <ID>`. See CLAUDE.md §9.7. Only the three states in the legend above are valid; `scripts/check-commit.ts` rejects untrailered deletions and any other state.

## Ship state

- **v0.1.0 — ready to tag.** Code-complete: 54 rules, 4 standards, 9 formatters, 10 MCP tools, 4 reports, CLI wired, release workflow configured. Remaining work is the demo + the tag + publish (Track D).
- **v0.2.0 — in flight.** MCP hardening (Track M), review-candidate coverage + focus-ring cross-ref (Track R), real-world fixture corpus (Track F). Target: 3–4 weeks post-0.1.0.
- **v0.3.0+ — staged, not started.** MCP sampling (Track S), ecosystem integrations + public benchmark (Track E). Phase 20 work is deliberately deferred until after 0.2.0 ships and user feedback tells us which sampling-backed tool matters most. See ADR 0005 for the sampling architecture.
- **v1.0.0 — readiness (Track V).** Conformance capstone work is done in Track C. Remaining v1.0 gates: (a) five **detection gaps** — alt-text walker scope (SVG image / role=img / canvas), button-name SVG `<title>` traversal, `<input type="image">` title recognition, contenteditable labels, `background-image` contrast surfacing; (b) nine **shape-honesty null sentinels** to conditional-spread; (c) eleven **fix-suggestion context-aware rewrites** (V1-FIX-AUDIT `[~]` acceptance gate); (d) **KB final sweep** to drain `GUIDANCE_BY_ID`; (e) **V1-CHANGELOG-V1** date-stamp on ship; (f) **V1-REGISTRY-AGGREGATE** layer-boundary hardening so ADR 0019's frozen `defineRule`/`defineStandard`/`defineCandidateFinder` exports function end-to-end instead of shipping as inert type-inference stubs (ADR 0022); (g) **V1-RESPONSE-ASSEMBLER** scan-family MCP response-shape seam so the AI-first consumer doctrine is enforced by one assembler call rather than 24 hand-rolled handlers before v1.0 freezes the shape (ADR 0024, proposed).

## Dispatch model (parallel tracks, not sequential phases)

Tracks below are independent. `/continue` picks the next open item from each of up to 3 active tracks per turn and dispatches them in parallel (details in `.claude/skills/continue/SKILL.md`). Within a track, items run in order — some tracks have sequencing; cross-track work is always parallelizable.

Active tracks: **Q14** (multi-corpus AI-first sweep) · **Q15** (multi-corpus AI-first sweep) · **V** (v1.0.0 readiness). Tracks **D**/**M**/**R**/**F**/**S**/**E** retired 2026-04-26. Tracks Q (rounds 1-2), Q2-Q6, Q7, Q8 (a/b/c), Q9, Q10, Q11, Q12, Q13 drained.

Staged tracks: **C** (conformance-claim gaps — v0.3.0 foundation + v1.0.0 capstone). Tracks S and E were promoted on 2026-04-17 after the user directed "go all the way without releasing until finalized" — M/R/F are complete, so the remaining pre-release work spans S and E. ADR 0005 §Follow-up work still applies to the speculative tool choices inside S; foundation items (sampling.ts, capability, prompt library, KB docs) are safe to build.

Track Q was added on 2026-04-17 in response to a 10-agent independent eval brief — MCP shape honesty + silent-failure elimination, all derived from real consumer pain on an external React codebase.

Track C was added on 2026-04-17 from a gap analysis on "what's missing to let an agent fully claim WCAG 2.1 AA." Four gaps: runtime-evidence ingest, attestation ledger, process-level scope, conformance statement. None widen detection (no new rules); they widen what an agent can defensibly *say* after using ra11y.

---

## Track Q — Agent-consumer feedback (closed)

Owner: main session + general-purpose. Source: 10 independent agent runs against an external React codebase (2026-04-17 eval brief). All accepted items are MCP shape/honesty fixes — none touch detection logic. Dispatch in parallel; each touches a different surface.

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

## Track Q2 — Agent-consumer feedback (round 3, 10-agent eval) (closed)

Owner: main session + general-purpose. Source: a 10-agent parallel eval against an external React/Vite/TS/Tailwind codebase — each agent exercised a different MCP slice in a "you-find, I-fix" workflow. Round 3 ran after Q (rounds 1-2) closed, on the post-Q shape. All accepted items are shape-honesty, batch-primitive, or workflow-gap fixes — none are heuristic suppression.

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

#### Considered and rejected (round 2 retriage)

- **Glob-ignore `*.stories.tsx` as default** → rejected per §1 "Default-exclude globs are suppression too." Story-file zero-findings is an honest signal (structurally unanalyzable). Fix: the `preset: "storybook"` that scans what stories exercise (Q2R2-STORYBOOK-PRESET above), not a filename carve-out. Severity-downgrade variants fail for the same reason.
- **Auto-suppress when `couldBeWrongBecause` escape hatch is provably present** → rejected per §1 "No heuristic suppression." The structured field is informational (Q2R2-CWBB); the agent reads the file and decides. Baking inference into the tool creates the silent-miss mode the doctrine exists to prevent.
- **`estimatedFpRate: number` on every finding** → rejected per §1 "Numeric-threshold heuristics are suppression." Any consumer filtering on `fp_rate > X` reintroduces silent-miss. Reason-text + `couldBeWrongBecause` carry the same information without the threshold.
- **`reportFalsePositive` as a persistent out-of-tree dismissal** → rejected as new surface; **superseded by C-ATTEST-TOOL** (Track C). Attestation ledger is the durable out-of-tree evidence channel with the evidence-slot the doctrine requires. Track here as "duplicates Track C."
- **Surface `limitations` once at session level** → rejected. `limitations` is a per-scan honest signal; the specific scan's inability to verify runtime criteria is what the agent needs for that specific claim. Session caching creates a "was this scan's limits the session's, or did they change?" gap — silent-miss risk. Keep per-response.

---

## Track Q3 — Design-system field test (closed)

Owner: main session + general-purpose. Source: 10-agent parallel eval against a design-system docs repo. Slices: components MDX (×4 agents), forms MDX, layout/utilities/helpers/content MDX, getting-started/about/customize/extend MDX, Astro pages/layouts/components, raw HTML test fixtures under `js/tests/`, and an MCP surface critique. All findings triaged against CLAUDE.md §1 and the AI-first-consumer doctrine.

A design-system doc-site tree is a useful stress-test because (a) it's the shape ra11y agents see most often; (b) it has genuine a11y content (accessibility.mdx, prose-embedded ARIA patterns); (c) it ships MDX + Astro + raw HTML + SCSS in one tree — four file classes at once.

### Considered and rejected (per CLAUDE.md §1)

- **Filter `.mdx` template-literal HTML out of findings by default** (one agent suggested we treat `<Example code={``}>` as "docs-only, skip") → rejected per §1 "No heuristic suppression" + "Labeled buckets are suppression too." The HTML in those template strings is rendered to users on the docs site — real live markup. Canonical docs-site surface; failing to scan it is a silent miss.
- **`aria/hidden-focus` severity downgrade on `.modal` patterns** (one agent noted the tree toggles `aria-hidden` at runtime, so static analysis sees a false state) → rejected per §1 "Don't downgrade priority to hide things." The rule already emits honest reason text; additive `couldBeWrongBecause` metadata is appropriate (see Q2R2-CWBB), severity-downgrade is not.
- **Deduplicate `forms/autocomplete-missing` when it fires 28× on one file** (concentrated in `floating-label.html`) → rejected per §1 "Labeled buckets are suppression too." The meta `concentration: {file, count}` already surfaces the density honestly; letting the agent see 28 is correct. A `meta.rulePatternSummary` extension could enrich reason text, but the 28 candidates must stay individually visible.
- **Restore `<Example code={``}>` parsing via a Starlight-specific extractor** → deferred, not rejected. The Astro parser fix (Q3-MCP-RESTART-HINT unblocking the existing parseAstro wiring) closes the surrounding `.astro` case; a Starlight-specific content-prop extractor for `.mdx` is a separate engineering effort with a narrow scope (only helps docs sites using the `<Example>` pattern). Re-evaluate after a Starlight docs site actually parses end-to-end.

---

## Track Q4 — Static-site-generator field test (closed)

Owner: main session + general-purpose. Source: 10-agent parallel eval against a static-site-generator repo. A canonical static-site-generator tree: HTML templates with Liquid, YAML frontmatter, `.md`/`.markdown` content, SCSS, ERB fixtures, Ruby source. Where Q3 probed the docs-site MDX/Astro axis, Q4 probes the Ruby/SSG/Liquid axis.

### Considered and rejected (per CLAUDE.md §1)

- **Auto-suppress React-specific rules on non-React projects** → rejected per §1 "Labeled buckets are suppression too." The rules correctly no-op when `filesEligible: 0`; the agent sees that in `perRuleCoverage`. Don't filter — surface. Q4-RULES-EVALUATED-COMPOSITE is the right fix (make the empty-eligible-set state legible at the headline level, keep the per-rule data honest).
- **Auto-exclude `_site/`, `vendor/bundle/`, `node_modules/` in `propose_config`** → **accepted in a narrower form**: these are definitionally build output / vendor dumps where findings are not the user's to fix. Fold into `DEFAULT_EXCLUDED_PATTERNS` (see `src/input/discover.ts`) rather than `propose_config` — the exclude belongs at discovery, not config. CLAUDE.md §1 "Default-exclude globs are suppression too" permits this because findings in those paths are "definitionally wrong for any consumer." Add `_site/`, `.jekyll-cache/`, `vendor/bundle/`, `_build/` (Hugo), `public/` (Gatsby — though `public/` is ambiguous). Tracked as **Q4-DEFAULT-EXCLUDE-BUILD-DIRS** in P2 above if landed.
- **Heuristic "this looks like an SSG include, suppress skip-link finding"** → rejected as heuristic suppression. Q4-FRAGMENT-DETECTION is the principled alternative: detect partial/fragment structurally, not by path-pattern guessing.
- **Full markdown CommonMark parser as a P0** → deferred. Q4-MARKDOWN-SUPPORT option (b) — a lightweight HTML-in-markdown extractor — covers 80% of real findings at ~15% of the implementation cost. Revisit full parser after the extractor ships.
- **Auto-detect and scan `_site/` output when Jekyll is detected** → rejected as "tool should not run build toolchains." The agent reads `_config.yml` + `Gemfile` + knows `bundle exec jekyll build`; ra11y should point at the output, not produce it. Q4-SSG-BUILD-HINT is the right mechanism.

---

## Track Q5 — Vanilla HTML/CSS/JS field test (closed)

Owner: main session + general-purpose. Source: first pass against a hand-authored vanilla-JS tree — 50 pedagogical vanilla `.html` + `.css` + `.js` bundles, no framework, no build step, no template directives. A vanilla-JS tree is the control — clean, hand-authored, no build pipeline confounds.

---

## Track Q6 — Bulk-template catalog field test (closed)

Owner: main session + general-purpose. Source: first pass against a 40+ bulk-template tree. Each template is a pre-built marketing/landing-page bundle shipping jQuery-era vendor CSS/JS (bootstrap.css, font-awesome.css, jquery.fancybox.pack.js) alongside authored HTML. Exercises ra11y at scale — the scan hit the MCP token ceiling, surfaced several rule misfires against vendor bundles, and exposed at-scale quality gaps in the proposed config + build-artifact warning path.

### Considered and rejected (per CLAUDE.md §1)

- **Auto-exclude `bootstrap.css` / `font-awesome.css` / `jquery*.js` via `DEFAULT_EXCLUDED_PATTERNS`** → rejected per §1 "Default-exclude globs are suppression too." Vendor-bundle findings ARE real findings — contrast in `bootstrap.css` is a real contrast issue on the rendered page, just not one the consumer edits. The existing `scannedBuildArtifacts` label + proposed rollups (Q6-SCANNED-BUILD-ARTIFACTS-GROUP-BY-BASENAME + Q6-MOTION-PAUSE-STOP-PER-FILE-AGGREGATION) give the agent the signal without discarding the findings. Pairing with the build-artifact-aware next-step rerouting (Q6-NEXTSTEP-AVOIDS-VENDOR-CSS) closes the "agent lands on unactionable file" failure mode.
- **Default-downgrade vendor findings to `severity: "note"`** → rejected per §1 "Don't downgrade priority to hide things." Severity is for sorting; a downgrade hides real contrast violations from agents that filter by severity. The `scannedBuildArtifacts` membership is the honest label — agents decide triage; the tool does not pre-decide severity.

---

## Track Q7 — Real-world OSS field test

Owner: main session + general-purpose. Source: 2026-04-24 multi-repo OSS field test — 20 scan agents (5 waves × 4 anonymized open-source codebases) probing detection accuracy, false-negative coverage, checklist quality, fix-suggestion quality, and response-shape adherence to AI-first doctrine. Sites span four shapes: a CSS-framework + docs tree, an SSG-templated content site, a vanilla HTML/CSS/JS demo collection, and a bulk-template catalog (≈4k files). Wave 5 is the doctrine cross-check; Waves 1-4 are correctness/coverage.

Cross-cutting themes (≥3-of-4-site recurrence) drive the P0 items below. Items with strong overlap against prior tracks are marked as cross-track shared rather than re-listed. All accepted items are correctness, surface-don't-suppress, or shape-honesty fixes — no heuristic suppression accepted (re-affirmed against doctrine).

### v0.2.0 — accepted (P0 — shape honesty / silent-failure)


### v0.2.0 — accepted (P1 — shape honesty)

### v0.3.0 — accepted (P1 — rule correctness)

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

### v0.2.0 — accepted (Q8b — 2nd-pass field test, 2026-04-25)

Source: 5-lens × 4-corpus replication pass over the same four codebases as Q8. Each repo received 5 parallel scout subagents (lenses A=coverage gaps, B=output correctness, C=parser/scanner, D=heuristic-mislabeled meta, E=response-shape drift). Aggregator deduped against existing Q8/V1 items.

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

#### Q8c — accepted (P1 — finder reason-text enrichment)

#### Q8c — accepted (P1 — rule scope widening)

#### Q8c — accepted (P1 — new rules)

#### Q8c — accepted (P2 — finder fix-suggestion polish)


---

## Track Q9 — Multi-corpus AI-first sweep (2026-04-25 evening, 4 corpora × 5 angles)

Field-test follow-ups from a 20-agent multi-corpus probe (CSS framework + static-site generator + vanilla mini-projects + bulk template gallery). Each item below was observed across ≥1 corpus during the round; recurrence counts noted inline. Items are bucketed by failure class. Net-new against Q8/Q8b/Q8c/V1; recurrence of already-named items folded into the existing rows there.

### Parser routing + coverage gaps


### Per-rule / per-finding confidence drift

### Cross-surface count + warning drift

- [~] **Q9-VERIFYINSOURCE-COMPOSITE-HEADLINE-DISHONESTY** `plan.fixesByClass.verifyInSource: 254` ships next to `plan.actionableManualItems: 7` (vanilla corpus); `verifyInSource` sums all rule emissions whose fix lane is guidance-only — agent reading the headline budgets against 254 not the ~50 grounded checklist totalCandidates. Same shape as the documented `fixesByClass.mechanical:266` vs `safeEditsAvailable:14` case (closed by deletion). Fix: verify `verifyInSource` measures one concept; if it sums actionable-with-file-line + non-actionable-prose, split into two siblings (`verifyInSourceGrounded` + `verifyInSourcePromptOnly`) and stop summing. Per AI-first doctrine "Composite headline counts are dishonest" worked precedent. **classification_mismatch_premise_false (verified by general-purpose specialist 2026-04-26):** the proposed Grounded/PromptOnly split keys on fixPaths.primary.edit presence — the exact payload-availability axis the deleted plan.safeEditsAvailable composite measured (closed by Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT, CHANGELOG.md line 50). Re-introducing it under verifyInSource{Grounded,PromptOnly} would re-create the dishonest shape the doctrine deleted: two siblings keyed off different axes (rule-demanded lane vs. payload presence) framed as 'how much verifyInSource work.' Premise that verifyInSource 'sums all rule emissions whose fix lane is guidance-only' is also factually inaccurate — it sums emissions whose rule declares fixClass: 'verify-in-source', including the 5/69 rules that DO ship inline fixPaths.primary.edit (lang-attribute, button-name, inline-display-none-on-focusable, expanded-on-disclosure, hidden-focus). fixesByClass answers 'which remediation lane does the rule route into?' — one kind per key; payload availability is orthogonal and intentionally NOT surfaced after the safeEditsAvailable deletion. Closure: TSDoc enrichment on FixesByClass.verifyInSource pre-empting the 'apply-fix can act on each' misreading is the durable answer if any closure is needed.

### suggest_fix shape + correctness bugs

### Heuristic-mislabeled meta sub-fields


### Rule predicate gaps (false negatives)

### Rule predicate too-broad (false positives)


### nextStep routing dishonesty

### 2026-04-26 round recurrences (folded onto existing Q9 rows)

Each line: `Q9 row id — N recurrences observed in 2026-04-26 round, evidence summary`. The 2026-04-26 sweep replayed the 4-corpora × 5-angles probe; items below recurred without behavior change against the same Q9 closure framing, so this round folds them as recurrence counts rather than new rows.

- **Q9-MINIFIED-LABEL-MISLABELS-LONG-LINE-SCSS** — +1 recurrence: hand-authored 1350-line SCSS flagged `likely-vendored-data-url-css` solely on inline `url(data:image/...)` marker presence; mislabel compounds with suggest_fix vendor-redirect (see Q10-SUGGEST-FIX-VENDOR-REDIRECT-COMPOUNDS-MISLABEL).
- **Q9-TEMPLATE-DIRECTIVES-LIQUID-AS-HANDLEBARS** — +1 recurrence: `templateDirectivesFound` emits `handlebars-or-mustache` on a corpus where 100% of `{{ }}` usage is Liquid-style templating (verified by `{{ var | filter }}` and `{% include %}` co-occurrence).
- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +4 recurrences (all 4 corpora): scope-level warnings (`scanned_build_artifacts_present`, `scanned_minified_file`, `bulk_catalog_detected`, `response_dropped_files_oversize`, `scss_unresolved_variables`, `response_token_budget_truncated`) silently absent from `checklist` and partially absent from `coverage` on identical cwd; widest spread on the bulk-template corpus (5 codes drop on checklist).
- **Q9-FRAGMENT-CLASSIFICATION-NO-PER-RULE-DOWNGRADE** — +2 recurrences: document-shaped rules (`semantics/landmark-main`, `semantics/heading-hierarchy`, `document/page-titled`, `document/lang-attribute`) report `coverageConfidence: "high"` on fragment-only inputs; per-rule coverage not downgraded on partial-parse files (sibling axis — partial-parse twin of the fragment-files variant).
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +3 recurrences: post-clip envelope still exceeds host cap on multiple bulk corpora — 87KB after clipping to 2 files; 86KB at default `limit=25` on a 156-file corpus; 120KB after the minimum-honest envelope already engaged (post-clip transport-rejected on a 567MB corpus).
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: `nextStepStructured` routes to a fragment markdown file whose evidence is medium-confidence; routes to an underscore-prefixed scaffold-directory `index.html` ahead of higher-impact `topRules[0]` findings on a non-truncated response.
- **Q9-NEXTSTEP-CWD-ECHOES-CALLER-AFTER-DROP** — +2 recurrences: `nextStepStructured` echoes original cwd verbatim after `response_dropped_files_oversize` + `response_token_budget_truncated`; `bulk_catalog_detected.suggestedExcludes` already carries concrete narrowing tokens that `nextStepStructured` fails to propagate.
- **Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS** — +1 recurrence: multiple `.js` files inject HTML strings via `element.innerHTML = \`...\`` and `insertAdjacentHTML(\`<i class='fa…'>\`)`; no `js_innerhtml_template_literal_unparsed` warning fires; `media/alt-text-missing`, `navigation/link-target-blank-announcement`, `semantics/button-name` produce zero findings on injected widgets.
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



### Per-rule / per-finding confidence drift


### Cross-surface count + warning drift

### suggest_fix shape + correctness bugs


### Reason-severity mismatches

### Rule predicate gaps (false negatives)

### Rule predicate too-broad (false positives)

### scan_file surface gaps

### Considered and rejected (per CLAUDE.md §1)

- **AAA→AA promotion of `navigation/link-target-blank-announcement`** — A scanner finding asked for AA-level emission of the rule (citing field evidence of unflagged `<a target="_blank">` patterns). Rejected: WCAG 3.2.5 is normatively AAA. Spec-correct closure already named in Q9-RULE-LINK-TARGET-BLANK-NEVER-FIRES — the AA-axis ask would be spec-incorrect emission and the deterministic escape hatch (source-level pragma) covers the rare case where the agent decides the rule should fire. The Q10-LINK-TARGET-BLANK-APPLIESTO-EXCLUDES-ERB-MD-RESIDUE row above is the legitimate fix (extend AAA-eligible extensions to match `parseModeByExtension`), separable from the level-axis question.

---

## Track Q11 — Multi-corpus AI-first sweep (2026-04-26 round, 4 corpora × 5 angles)

Field-test follow-ups from a 20-agent multi-corpus probe (CSS framework + static-site generator + vanilla mini-projects + bulk template gallery). Each item below is **net-new** against Q9/Q10; recurrences of already-named items folded as recurrence counts under the existing rows there. Items bucketed by failure class.

### Missing rules (corpus-driven, recurring across ≥2 corpora)

### Response-shape: ambiguous / type-polymorphic / dangling fields

### Cross-surface drift / counter splits

### Routing edge cases


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

### Vendor-classification schema split

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

## Track Q13 — Multi-corpus AI-first sweep (4 corpora × 5 angles)

Field-test follow-ups from a 4-corpus probe (4 corpora × 5 angles). Each item below is **net-new** against Q9/Q10/Q11/Q12; recurrences fold under the existing rows there. Items bucketed by failure class.

### Empty / dishonest warning payloads


### Ambiguous / empty-when-meaningful field shapes

### Cross-surface drift (counts + warnings + lane)

### Truncation reporters disagree


### Reason / severity / priority / confidence channel mismatch


### Heuristic-mislabeled meta sub-fields

### Heuristic emission (rule false-positive on speculative composition)


### Parser routing skips

### suggest_fix shape contradictions


### Rule predicate gaps (false negatives)

### 2026-04-29 round recurrences (folded onto existing Q9/Q10/Q11/Q12 rows)

- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +3 recurrences: corpus-level warnings (`bulk_catalog_detected`, `response_token_budget_truncated`, `truncated_files_dropped`, `response_dropped_files_oversize`) ship on `scan_project` only and silently absent from `checklist`/`coverage` on identical cwd; bulk-template corpus surfaces 4 missing codes on each of checklist + coverage; same-cwd warning-set drift now observed across 3 of 4 corpora.
- **Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS** — +1 recurrence: `js_innerhtml_template_literal_unparsed` warning absent from a static-site corpus despite a 5-file `.js` set including a livereload-style helper; corpus 3 ships `declinedCount: 11` without per-file enumeration.
- **Q9-MINIFIED-LABEL-MISLABELS-LONG-LINE-SCSS** — +1 recurrence: hand-authored SCSS partial flagged `likely-vendor-distribution` on banner-comment-only signal; closure path (token co-occurrence gating) unchanged.
- **Q9-PERFINDING-COULDBEWRONG-EMPTY-WHEN-PERRULE-DEGRADED** — +2 recurrences: `keyboard/handler-missing` ships `couldBeWrongBecause: ["cross_file_listener_resolution_limited"]` on per-finding emissions while per-rule coverage carries `_not_attempted_by_rule` — the suffix-honesty closure (Q9 row) shipped but the per-finding leak persists across 2 corpora (43 + 7 hits).
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: routes to a visual-test fixture file on a CSS-framework corpus; routes to a `keyboard/handler-missing` finding on a vanilla corpus despite the rule's hedge fix-description being one of the lowest-confidence routes.
- **Q9-NEXTSTEP-CWD-ECHOES-CALLER-AFTER-DROP** — +2 recurrences: `nextStepStructured.args: {}` ships after `response_dropped_files_oversize` + `response_token_budget_truncated` across 2 corpora; new sub-axis (Q13-NEXTSTEP-STRUCTURED-ARGS-EMPTY-OBJECT) splits this from the cwd-echo case.
- **Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON** — +2 recurrences: 43 instances on a vanilla corpus + 7 instances on a CSS-framework corpus where `addEventListener` selectors resolve to native `<button>`/`<a>` in sibling HTML; closure path unchanged.
- **Q9-EXPANDED-ON-DISCLOSURE-SR-ONLY-CHILD-CONCESSION** — +1 recurrence: bulk-template corpus ships severity `error` while `aria/expanded-on-disclosure` divergent confidence fires on the same evidence (Q13-EXPANDED-DISCLOSURE-DIVERGENT-CONFIDENCE-IDENTICAL-EVIDENCE captures the new sub-axis).
- **Q9-RULE-LINK-TARGET-BLANK-NEVER-FIRES** (related) — +0 recurrences this round, but Q13-GATED-BY-LEVEL-RULES-IN-PER-RULE-COVERAGE-AT-LOW captures a related visibility-in-coverage axis.
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +2 recurrences: post-clip envelope still over host cap on 2 corpora; closure work still in flight per Q9 row.
- **Q10-META-TRUNCATED-FIELD-NAME-RETAINED-WHEN-GUTTED** — +3 recurrences: `meta` retained while 8-9 sub-fields silently dropped; 67 keys remain after a corpus-level truncation pass, no per-field sentinels (CSS-framework, static-site, bulk-template).
- **Q11-BULK-CATALOG-SUGGESTEDEXCLUDES-NOT-ADDITIONALPATHS-INVERSE** — +1 recurrence: bulk-template `nextStepStructured.args: {}` echoes failing `cwd` despite `bulk_catalog_detected.suggestedExcludes` being populated; new sub-axis (Q13-NEXTSTEP-STRUCTURED-ARGS-EMPTY-OBJECT) captures the empty-object case directly.

### Considered and rejected (per CLAUDE.md §1)

- **Suppress `keyboard/handler-missing` on `.spec.js` / `.test.js` paths so it stops emitting on test files** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. Path-pattern matching is a heuristic on weaker evidence than the agent has — a `.spec.js` file may contain real production-shape interactive code (test fixtures, in-page demo harnesses). The legitimate fix is Q13-RULE-KEYBOARD-HANDLER-ON-TEST-SPEC-FILE (downgrade to review candidate when test-shape evidence is present) — same closure path the canonical "heuristic emission" doctrine bullet prescribes. The deterministic source-level disable pragma covers the rare case where the agent confirms the test file is genuinely not a runtime concern.
- **Auto-dismiss wcag22:2.2.1 candidates when the `setTimeout` duration is ≤ 5 seconds** — Rejected per "Numeric-threshold heuristics are suppression" doctrine. A real session-timeout of 4.5 seconds is indistinguishable from a debounce of 4.5 seconds from static analysis alone; encoding the threshold hides everything on one side of the line. The legitimate fix is reason-text enrichment (encode the duration literal in `couldBeWrongBecause: ["setTimeout_duration_2000ms_likely_debounce"]`) so the agent reads the duration as additive context and decides per-candidate.
- **Down-bucket findings on `vendorPathHint: true` paths so they sort below authored-source findings in `topRules`** — Rejected per "Labeled buckets are suppression too" doctrine. Same critique as the Q12-rejected `scannedBuildArtifacts.ungrouped` down-bucket proposal — `topRules.count` is a deterministic count of emissions, sorting by classification replaces honest count with attention-budget heuristic. Q11-FIXESBYCLASS-NOT-SPLIT-BY-SCAN-KIND covers the legitimate split-axis at the structured field; `topRules` summary stays honest.
- **Suppress `landmark-main` emission on isolated single-page demo files where the file is the only consumer** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. The "isolated single-page demo" predicate is a heuristic on weaker evidence than the agent has. The legitimate fix is Q13-RULE-LANDMARK-MAIN-ISOLATED-DEMO-PAGE-AT-WARNING (downgrade to review candidate when `couldBeWrongBecause` includes `isolated_component_demo_page`) — same closure path the doctrine prescribes.

### Token-reduction proposals (no behavior change)

- **Audit + close every warning code shipping `warningsDetails.<code>: {}`.** Already a doctrine bullet; concrete byte savings on each closure (either populate with actionable evidence or omit the code from `warnings[]`). Repeat offenders this round: `partial_parse_files_present`, `parser_bailed_on_non_jsx_in_tsx_route`, `redundant_additional_paths`, `results_truncated_use_nextcursor`, `php_islands_stripped`. Audit pass: enumerate every code in `src/types/warnings.ts`; for each, assert either `details !== {}` or absence from `warnings[]`. Net byte savings: ~80-200 bytes per occurrence × 5 codes × 4 surfaces.
- **Conditional-spread present-when-meaningful for empty-string and empty-array sentinels.** Repeat offenders: `pathHint: ""` (63/63 entries on one corpus), `couldBeWrongBecause: []` (per-finding when no concessions apply), `untestableCriteria: []` parallel to `criteriaUntestable: 0`. Replace with `...(value ? { field: value } : {})` at the response-assembly site; saves the field key + empty-value bytes on every absent occurrence. Audit byte cost is O(field-count × occurrence-count); net savings on sparse fields are substantial. Already covered by the "Ambiguous field shapes" doctrine; this is the implementation sweep.
- **Per-finding `groupKey` elision when file-level `groupFixDescriptionRefs` carries the same string.** When a file's `groupFixDescriptionRefs: ["nav-href-empty-fragment-edit"]` maps a groupKey to a referenceGuide entry, every per-finding `groupKey: "nav-href-empty-fragment-edit"` repeats the same string. Replace per-finding with `groupRef: 0` (index into the file-level array); the referenceGuide stays at the response level. Saves ~30-50 bytes per finding on rules with 20+ emissions in one file. Implementation: per-finding shape carries `groupRef: number` (file-level array index) instead of `groupKey: string`.
- **Drop `snippet` field on `vendorPathHint: true` candidates.** Minified-vendor snippets ship as long-line context (e.g. `&&g&&p>r-g)return a.clearTimeout(h),h=a.setTimeout(u,p)`) with no positional anchor — the agent cannot use the snippet for triage and the candidate is already classified `scannedBuildArtifacts`. Replace with `snippetOmitted: "minified_vendor_no_actionable_context"` or omit the field entirely. Saves ~150-400 bytes per minified-vendor candidate.
- **Dictionary-style snippet/fix-description deduplication via `groupFixDescriptionRefs`.** When 21 emissions of the same rule on the same file all share an identical fix description, the file-level `groupFixDescriptionRefs` already references the top-level `referenceGuide.fixDescriptions[ruleId]`. Audit whether the per-finding `fix.description` text is still inlined alongside the reference — if so, elide the inline text when `fix.descriptionRef` is populated. Saves ~100-300 bytes per duplicate-description occurrence; net depends on `topRules` distribution.
- **Drop redundant `untargetedCriteriaList` when `untargetedCriteria` scalar is derivable from a sibling enumeration.** Per the new "Sibling fields naming the same concept must use one shape" doctrine bullet — the array IS the enumeration; the scalar is `array.length`. Pick one shape; saves the redundant scalar key + value on every coverage response.

---

## Track Q14 — Multi-corpus AI-first sweep (4 corpora × 5 angles)

Field-test follow-ups from a 4-corpus probe (4 corpora × 5 angles). Each item below is **net-new** against Q9/Q10/Q11/Q12/Q13; recurrences fold under the existing rows there. Items bucketed by failure class.

### Empty / dishonest warning payloads

### Ambiguous / empty-when-meaningful field shapes

### Cross-surface drift (counts + warnings + lane)

### Reason / severity / priority / confidence channel mismatch

### Heuristic-mislabeled meta sub-fields


### Heuristic emission (rule false-positive on speculative composition)

### Parser routing skips

### NextStep / nextStepStructured routing

### suggest_fix shape contradictions

### Citation correctness


### 2026-04-30 round recurrences (folded onto existing Q9/Q10/Q11/Q12/Q13 rows)

- **Q13-NEXTSTEP-STRUCTURED-ARGS-EMPTY-OBJECT** — +4 recurrences (all 4 corpora): `nextStepStructured.args: {}` ships across CSS-framework / SSG / vanilla-mini / bulk-template responses while prose `nextStep` recommends concrete narrowing (`additionalPaths` / `restrictToPaths` / tighter `cwd`).
- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +4 recurrences (all 4 corpora): `bulk_catalog_detected` / `scanned_minified_file` / `scss_unresolved_variables` / `response_token_budget_truncated` / `truncated_files_dropped` / `response_dropped_files_oversize` ship on `scan_project` only; bulk-template observed on coverage 14/15 vs scan_project 18 codes.
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +3 recurrences: scan_project pre-drop 99.5KB on CSS-framework, 171.5KB on SSG, 783.8KB on bulk-template; closure work in flight on the pre-serialization estimator.
- **Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION** — +4 recurrences (all 4 corpora): scan_file on a 167-finding mdx → 141KB host transport error; scan_file on bootstrap.css → 176KB; checklist 80KB / coverage 76KB on SSG; vanilla-mini scan_project 76KB.
- **Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS** — +3 recurrences: CSS-framework `.spec.js` test fixtures ship `declinedCount: 1` despite many spec files; vanilla-mini `script.js \`<img alt="${title}">\`` declined unparsed; bulk-template `jquery.html(...)` fileSamples present but no findings emitted from the islands.
- **Q13-LINKED-STYLESHEET-TEMPLATE-EXPRESSION-AS-UNRESOLVED-HREF** — +3 recurrences: `topUnresolvedHrefs` contains `{extraCss}` (CSS-framework); contains Liquid `{{ ... | relative_url }}` tokens (SSG); `{{ template }}` tokens on bulk-template.
- **Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON** — +2 recurrences: vanilla-mini fix.description literally instructs "Cross-file check: grep the selector in your HTML to confirm the target isn't already a `<button>` or `<a href>`" while the same scan parsed `index.html` showing the target IS a `<button>`; bulk-template `$("a[href='#top']")` resolves to native anchors.
- **Q13-FINDING-ID-NON-UNIQUE-PER-FILE-LINE** — +3 recurrences: CSS-framework scan_file ships 167 findings with 28 unique findingIds (worst id covers 26 distinct line:column pairs); bulk-template scan_file `bootstrap.css` collision id `4d97f664060c` at lines 210 AND 5989; vanilla-mini same shape.
- **Q10-META-TRUNCATED-FIELD-NAME-RETAINED-WHEN-GUTTED** — +3 recurrences: scan_project `metaFieldsDropped: [analysisCoverage, scannedBuildArtifacts, perRuleCoverageSummary, ...8 fields]` on CSS-framework; bulk-template ships `meta:{9 keys}` after dropping 9 sub-fields with no per-field sentinels; SSG matches.
- **Q13-TRUNCATION-REPORTERS-OVERLAP-META-FIELDS-DROPPED** — +3 recurrences: `response_meta_truncated.fields(2)` vs `response_dropped_files_oversize.metaFieldsDropped(8-9)` overlap on `analysisCoverage` across CSS-framework/SSG/bulk-template; `metaArrayTruncated` floats as third reporter.
- **Q11-RULE-EXPANDED-DISCLOSURE-FIX-CONCEDES-MAY-NOT-APPLY-AT-ERROR** + **Q9-EXPANDED-ON-DISCLOSURE-SR-ONLY-CHILD-CONCESSION** — +2 recurrences: bulk-template `<button class="navbar-toggle"><span class="sr-only">Toggle navigation</span>…</button>` severity stays `error` while reason concedes ".sr-only is the disclosure label, only state attribute missing"; CSS-framework count=166.
- **Q13-TEXT-SOURCE-SKIPPED-TOPEXTENSION-FOR-FILENAME** + **Q13-TEXT-SOURCE-SKIPPED-EXTENSIONS-INCLUDE-BINARY-AND-NON-HTML-ISLAND** — +3 recurrences: `topExtension: "LICENSE"` with `extensions: []` (vanilla-mini); `noExtensionFiles:["LICENSE","Makefile"]` (bulk-template); `.htc/.mno/.wd3/.db` lumped into `extensions[]` (bulk-template).
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: vanilla-mini routes to `_project_starter_/index.html` scaffold; CSS-framework routes to `js/tests/integration/index.html` test-fixture path ahead of authored source.
- **Q9 mid-word truncation preamble** — +3 recurrences: `suggest_fix.primary.approach` truncates mid-word with ellipsis ("reaches 4", "renders the…") while `primary.explanation` carries the full uncapped string across `contrast/minimum`, `media/audio-video-no-controls`, and additional rules across vanilla-mini and CSS-framework corpora; `approach` reads as a clipped duplicate, not a labeled summary.

### Considered and rejected (per CLAUDE.md §1)

- **Suppress `linked_stylesheet_not_resolved_for_contrast` when `dist/` excluded artifact paths exist alongside the html file** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. The dist/ co-presence is path-based heuristic evidence; the legitimate fix is Q14-LINKED-STYLESHEET-RESOLVER-FAILS-SAME-DIR-SIBLING (resolve sibling scope properly) or surface a `additionalPaths` nudge so the agent can opt the dist/ tree in for resolution.
- **Auto-down-bucket findings on `partialParseFiles[]` so they sort below clean-parse findings in `topRules`** — Rejected per "Labeled buckets are suppression too" doctrine. The legitimate fix is per-rule confidence propagation (already covered by the existing doctrine bullet on parser-failure invalidating per-file confidence) and per-finding `couldBeWrongBecause` enrichment with the parse-state token; `topRules.count` stays an honest emission count.
- **Suppress `aria/expanded-on-disclosure` when an `<span class="sr-only">` child is present** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. The `.sr-only` content might be the disclosure label or it might be a sibling utility text; static evidence cannot tell. The deterministic source-level disable pragma covers the dismissal cost; reason-text enrichment is the additive answer (already at Q9-EXPANDED-ON-DISCLOSURE-SR-ONLY-CHILD-CONCESSION on the severity axis).

### Token-reduction proposals (no behavior change)

- **Hoist `referenceGuide.fixDescriptions` to per-ruleId once per response, not per-finding-occurrence.** A 167-finding `.mdx` scan_file ballooned to 141KB because per-occurrence fix-description bodies serialize verbatim; the ruleId is the natural cache key. Replace per-finding inline body with `fix.descriptionRef: <ruleId>` and ship the body once at response level. Saves ~600B-2KB per repeated rule-finding occurrence; converts the `navigation/href-empty-fragment 1284-fire` worst-case into a single entry plus 1284 references.
- **Apply minimum-honest envelope at `scan_file` / `checklist` / `coverage`.** All three surfaces routinely exceed the host token cap with no `truncated:true` / no oversize warning / no fallback — `scan_project` already implements this and its corpus-pass succeeds where checklist+coverage on identical cwd transport-fail. Pre-serialization sentinel + drop the largest array (`findings[]` on scan_file, `items[]` on checklist, `perRuleCoverage[]` on coverage), retain `summary`+`plan`+`meta`+`warnings`+`nextStep`.
- **Centralize scope-level evidence (linked-stylesheet hrefs, fragment files, scss unresolved vars) once per cwd and surface by reference.** Coverage ships `scssUnresolvedVariableFiles[34]` AND `buildArtifactEntries[]` AND `buildArtifactsMetaField` AND `warningsDetails.scss_unresolved_variables.files[34]` — same 34-path list 4 ways. Scope-classifier helper computes once, surfaces reference by `meta.cwdEvidenceRef` rather than re-marshaling on every response within one session.
- **Cap `linked_stylesheet_not_resolved_for_contrast.htmlFiles` to top-N + remainder count.** Single warning consumed 46KB / 60% of post-truncation envelope on a bulk-template corpus by inlining 517 absolute paths; agent reading the response cannot iterate that many anyway. Cap at 10 + `remainderCount: <n>`; full list under `verboseMeta:true`.
- **Per-rule-coverage row roll-up: unfired-and-clean rules ship as count + ruleIds[].** `coverage.perRuleCoverage[]` ships 100+ rows per response with most showing `coverageConfidence: high / findingsEmitted: 0 / fired: false` — uniform null state per row. scan_project meta already does this compaction; apply the same to coverage default verbosity, with full per-row payload only under `verboseMeta:true`.
- **Per-finding `groupKey` elision via file-level `groupFixDescriptionRefs` index.** Already proposed in Q13's token-reduction subsection; recurrence in this round across all 4 corpora confirms the lever. Saves ~30-50 bytes per finding on rules with 20+ emissions in one file.
- **Hoist `perRuleCoverageSummary.ruleIds` to a session-scoped reference.** All 112 rule IDs ship verbatim on every meta block within a sweep (project + file + checklist + coverage = 4× ~3.1KB redundant). Hash by `ra11yVersion+commitHash` + ship `ruleCount + sessionRef` after the first response.

---

## Track Q15 — Multi-corpus AI-first sweep (2026-05-02)

Field-test follow-ups from a 4-corpus blind probe (CSS-framework + dist build, SSG with Liquid/ERB tokens, vanilla-mini demo catalog, bulk-template catalog). Each item below is **net-new** against Q9-Q14; cross-round recurrences fold under the existing rows in the trailing recurrences subsection. Items bucketed by failure class.

### Empty / dishonest warning payloads

### Ambiguous / empty-when-meaningful field shapes

- [ ] **Q15-CONFIG-SOURCE-AND-DETECTED-FRAMEWORK-NULL-ON-CLEAR-SSG-EVIDENCE** `meta.configSource: null` and `meta.detectedFramework: null` on a corpus with unambiguous SSG signals (frontmatter fences in 336 files, `_layouts/`, `_includes/`, mixed Liquid+ERB tokens). The null sentinel reads as "we looked and found nothing" but the corroborating evidence the scanner has access to was ignored. Closure: framework detection consumes `_layouts/`+`_includes/`+frontmatter+template-token signals as corroborating evidence; surface in `meta.detectedFramework` even when no config file exists, with `confidence` set per evidence count. Per AI-first doctrine "Verbose meta is signal, not clutter."

### Cross-surface drift (counts + warnings + lane)

- [ ] **Q15-UNTARGETED-CRITERIA-PROJECT-VS-FILE-SAME-FIELD-NAME** `scan_project.plan.untargetedCriteria: 7` on a bulk corpus root; `scan_file` on a single HTML in the same corpus reports `plan.untargetedCriteria: 18`; `scan_file` on a `*.min.js` reports `plan.untargetedCriteria: 19`. Per-file untargeted-count cannot logically exceed the project total — the field name names one concept while two slices ship under it. Closure: rename per-file vs per-project so the slice difference is explicit (`untargetedCriteriaForFile` vs `untargetedCriteriaForProject`), or drop the per-file scalar in favor of `criteriaCoverage.byFile[file]`. Per AI-first doctrine "Composite headline counts are dishonest."

### Reason / severity / priority / confidence channel mismatch

- [ ] **Q15-PERFINDING-CONFIDENCE-HIGH-WITH-CROSSFILE-NOT-ATTEMPTED-LIMITATION** Three findings for `aria/tab-controls-missing` ship `confidence: high, severity: error` with `couldBeWrongBecause: ["cross_file_evidence_bounded_not_attempted_by_rule"]` — per-finding confidence does not reflect the rule's `crossFileCapable: false` design constraint. Closure: when per-rule `coverageConfidence` is `medium`/`low` from a `_not_attempted_by_rule` reason, every per-finding emission from that rule downgrades `confidence` to match. This is a recurrence path of Q9-PERFINDING-COULDBEWRONG-EMPTY-WHEN-PERRULE-DEGRADED on a different rule (`aria/tab-controls-missing` instead of `keyboard/handler-missing`), suggesting the propagation is rule-by-rule rather than centralized. Per AI-first doctrine "Per-finding confidence must reflect per-rule coverage limitations."
- [ ] **Q15-VENDOR-MINIFIED-CANDIDATES-AT-PRIORITY-HIGH-DESPITE-PATHHINT** `scan_file` on a `*.min.js` (classified `definite-min-infix`, `vendor-library-version-detected`) ships 15+ review candidates at `priority: "high"` for `innerHTML` / `setTimeout` patterns, every one carrying `vendorPathHint: true` AND `couldBeWrongBecause: ["minified_vendor_no_sourcemap"]`. The `priority: high` channel disagrees with the `vendorPathHint` + `minified_vendor_no_sourcemap` evidence the same candidate ships. Closure: when `vendorPathHint: true` AND `couldBeWrongBecause` contains `minified_vendor_no_sourcemap`, `priority` downgrades to `low` automatically; integration test pinning the rule. Per AI-first doctrine "Reason / priority / fix-description must agree across all three channels."

### Heuristic-mislabeled meta sub-fields

- [ ] **Q15-FINDINGS-EMITTED-BEYOND-PARTIAL-PARSE-BOUNDARY** `scan_file` on a partial-parsed HTML reports `limitations[].reason: "partial_parse"`, `parsedThroughLine: 221`, but ships 229 findings — many at lines 263, 399, 405, 408, 412 (well beyond the parse boundary). Findings beyond `parsedThroughLine` should either be impossible or must downgrade. Closure: drop findings emitted beyond `parsedThroughLine`, OR tag with `confidence: "low"` + `couldBeWrongBecause: ["beyond_partial_parse_boundary"]`; integration test pinning that no finding's `line > parsedThroughLine` on a partial-parse response without the downgrade. Per AI-first doctrine "Parser-failure invalidates per-file confidence."

### Heuristic emission (rule false-positive on speculative composition)

- [ ] **Q15-AUDIO-DOUBLE-FLAGGED-FINDING-AND-CANDIDATE-SAME-LINE** Same `<audio>` element ships as a finding (`media/audio-controls-or-transcript-missing`, `severity: error`) AND as a review candidate (criteria 1.2.1/1.2.8/1.2.9/1.4.7, `priority: high`) with overlapping but non-identical `findingId`s. Two channels narrate the same element. Closure: when a rule emission already covers an element/criterion, the criterion's review candidate elides for that file:line. Pairs with Q14-REVIEW-CANDIDATE-DUPLICATES-FINDING-SAME-LINE — extends the dedup invariant from `aria/expanded-on-disclosure` to media-element rules. Per AI-first doctrine "Surface, don't suppress" inverse — signal redundancy without dedup is its own dishonesty.
- [ ] **Q15-LANDMARK-MAIN-LOW-CONF-NOT-COUNTED-IN-MANUAL-ITEMS** `scan_file` ships `plan.actionableManualItems: 0` while emitting a `confidence: low` `semantics/landmark-main` finding with `couldBeWrongBecause: ["isolated_component_demo_page"]`. The finding IS an explicit "please verify" — yet the manual-items counter excludes it. Closure: low-confidence findings whose `couldBeWrongBecause` names a verify-this-in-source token contribute to `actionableManualItems`. Per AI-first doctrine "Composite headline counts are dishonest."
- [ ] **Q15-MIN-CSS-ACTIONABLE-MANUAL-ITEMS-INCLUDES-VENDOR-LANE** `scan_file` on `dist/*.min.css` ships `plan.actionableManualItems: 1` despite zero source-lane findings — all 137 emissions are `buildArtifact`-lane. The manual-items counter does not split by lane the way `fixesByClass` does. Closure: split `actionableManualItems` by lane (`actionableManualItemsBySource: { source: N, buildArtifact: M }`) or restrict the counter to `source`-lane findings; integration test pinning the lane filter. Per AI-first doctrine "Composite headline counts are dishonest."

### Parser routing skips

- [ ] **Q15-TEMPLATE-INTERPOLATION-NO-PER-STYLE-CLASSIFIER** `meta.templateInterpolationFound` reports `{{x}}: 3396, {%x%}: 704, <%x%>: 9` — three template engines mixed (Liquid + ERB + Mustache-shape). No per-style classifier (e.g. `liquid_directives_unparsed` / `erb_directives_unparsed`) is emitted; the agent cannot scope around a specific engine. Closure: split `template_files_parsed_as_literal` into per-token-style codes (`liquid_directives_unparsed`, `erb_directives_unparsed`, `mustache_directives_unparsed`); each ships its own file list and count. Per AI-first doctrine "Routing skips that drop content are the symmetric twin of suppression" — split-by-predicate closure path.

### NextStep / nextStepStructured routing

- [ ] **Q15-NO-GROUPBY-FIRSTCHILDDIR-NEXTSTEP-ON-BULK-CATALOG** `scan_project` default `groupBy: none` on a bulk-catalog corpus (≥30 sibling subdirs each shaped `<dir>/index.html` + `<dir>/style.css` + `<dir>/script.js`) ships `nextStep` mentioning paging but never recommending `groupBy: "firstChildDir"`. The catalog shape is the canonical case for that grouping. Closure: when bulk-catalog shape is detected (per the small-N gate in V1-BULK-CATALOG-DETECTED-SMALL-N-THRESHOLD), `nextStepStructured` proposes `groupBy: "firstChildDir"` as an alternative narrowing path. Per AI-first doctrine "One tool call should answer 'what next?'"

### suggest_fix shape contradictions

### Truncation reporters disagree

- [ ] **Q15-CHECKLIST-PAGECLIPREASON-VS-WARNING-MISSING-TRUNCATED-BOOLEAN** `checklist` ships `pageClipReason: "per_criterion_cap"` AND `warnings: ["results_truncated_use_nextcursor"]` AND `truncated` is omitted from response keys entirely. Three concurrent truncation signals; the canonical `truncated: boolean` is the missing one. Closure: pick one canonical (`truncated: true` OR `pageClipReason`) and cross-link from the warning's `seeAlso`. Per AI-first doctrine "Truncation reporters must reconcile across warnings."

### Bootstrap response shape

- [ ] **Q15-BOOTSTRAP-OMITS-BULK-CATALOG-WORKFLOW-RECOMMENDATION** On a corpus shaped as ≥30 parallel sibling demo subdirs, `bootstrap.suggestedConfig` proposes only rule-severity tuning — no recommendation to set `groupBy: "firstChildDir"` or per-subdir `restrictToPaths`. Output is paste-safe but workflow-incomplete: the agent gets severity overrides and no scope guidance for the catalog shape that drives the noise floor. Closure: when bulk-catalog shape is detected, `suggestedConfig` includes `groupBy` and/or example `restrictToPaths` block alongside severity tuning; integration test on a bulk-catalog fixture asserting the workflow recommendation appears. Per AI-first doctrine "Bootstrap output must be paste-safe" — extension: paste-safety covers workflow recommendations on detected shapes.

### Rule predicate gaps (false negatives)

- [ ] **Q15-LIVE-REGION-RULE-MISSES-CROSS-FILE-INNERHTML-TARGET** An `index.html` declares `<div id="insert">...</div>`; sibling `script.js` writes `insert.innerHTML = \`<div>${event.key}...\`` on every keydown — a visible status update channel. `aria/live-region-missing-on-innerhtml-target` shipped `fired: false` at `coverageConfidence: high` on `scan_file`, with no cross-file annotation. Same shape as Q9-RULE-KEYBOARD-HANDLER-FP-CROSS-FILE-NATIVE-BUTTON applied to live-region targeting. Closure: when the rule cannot resolve cross-file `innerHTML` targets, downgrade per-rule `coverageConfidence` + emit `cross_file_innerhtml_target_resolution_not_attempted_by_rule` (using the `_not_attempted_by_rule` suffix per Q9 honesty closure). Per AI-first doctrine "Per-finding confidence must reflect per-rule coverage limitations."
- [ ] **Q15-LANG-ZXX-WITH-PROSE-NOT-FLAGGED** `scan_file` on a `<html lang="zxx">` document with visible English UI prose does not emit a finding. `zxx` is valid BCP-47 ("no linguistic content") but inappropriate when the document carries non-symbol prose. Closure: add a review candidate for `document/lang-zxx-with-prose` that fires when `lang="zxx"` is present AND the document contains visible non-symbol text content; the candidate carries `criterion: wcag22:3.1.1` and reason text framing the question. Per AI-first doctrine "Surface, don't suppress."

### Cross-template / per-rule fingerprint dedup

- [ ] **Q15-VENDOR-FILE-SHA-FINGERPRINT-DEDUP-ACROSS-TEMPLATE-SUBDIRS** On a 100+ template-subdir bulk catalog, identical vendor files repeat verbatim — `bootstrap.min.css` × 116, `bootstrap.min.js` × 115, `font-awesome.min.css` × 89, `jquery.fancybox.css` × 64. Each instance is parsed and findings are emitted N times. Pairs with V1-CSS-CROSS-TEMPLATE-FINGERPRINT (same-CSS-pattern across files via selector hash) and V1-CHECKLIST-VENDOR-FILE-FINGERPRINT-COLLAPSE (vendor file collapse on candidates). This item is the deterministic-fingerprint variant: hash the first N bytes of the vendor file (or the full sha-1) and emit findings once with `occurrenceCount` + `occurrenceLocations` rather than N times. Avoids re-parsing AND collapses the response shape. Closure: file-fingerprint pre-pass on extension allowlist (`.css` / `.js` / `.svg` / `.woff2`) emits one canonical entry per distinct hash with the path list. Per AI-first doctrine "Composite headline counts are dishonest" — extension: composite emission counts.
- [ ] **Q15-REFERENCE-GUIDE-FIX-DESCRIPTIONS-PER-FINDING-DUPLICATION** `scan_file` on an HTML with `limit: 5` returns `referenceGuide.fixDescriptions["aria/tab-controls-missing"]` containing 22 keyed entries, every one a near-identical 320-char string differing only in the panel-id token. The reference-guide shape ships duplicates per-finding when one canonical description with a `${panelId}` placeholder would suffice. Closure: dedupe `referenceGuide.fixDescriptions` to one canonical description per `(ruleId, fix-shape)` pair, with template-placeholder substitution materialized at read time, OR only ship descriptions for findings actually returned in the page. Pairs with the existing token-reduction proposal "Hoist `referenceGuide.fixDescriptions` to per-ruleId once per response." Per AI-first doctrine "Composite headline counts are dishonest" — extension: per-finding fix-description duplication.

### Citation correctness

- [ ] **Q15-CHECKLIST-PROMPT-TEXT-CONCATENATED-ACROSS-CRITERIA** A single review candidate ships its `reason` as a `" | "`-joined concatenation across 4 distinct WCAG criteria (`1.2.1`, `1.2.8`, `1.2.9`, `1.4.7`) into one string. Per-criterion dismissal is ambiguous — the agent reading the joined string cannot dismiss one criterion without dismissing the union. Closure: split into N separate candidates (one per criterion), OR ship `reason` as `{ criterionId: text }` map so the agent can address one criterion at a time. Per AI-first doctrine "Composite headline counts are dishonest" — extension: composite reason text.

### Fixture-todo follow-ups


### 2026-05-02 round recurrences (folded onto existing Q9-Q14 rows)

- **Q9-BULK-WARNINGS-NOT-CROSS-SURFACE** — +4 recurrences (all 4 corpora): `scan_file` on a `dist/*.min.css` emits `scanned_build_artifacts_present` / `scanned_minified_file` / `dist_only_scan_detected` while `scan_project` on the parent cwd ships zero findings + zero warnings + `meta.scannedBuildArtifacts.length: 0` for the same file (default-excluded silently); `coverage` on the bulk-template + vanilla corpora ships zero `warnings`/`warningsDetails` while `scan_project` on identical cwd ships `text_source_skipped` / `binary_assets_skipped` / `js_innerhtml_template_literal_unparsed` / `linked_stylesheet_not_resolved_for_contrast`; `checklist` on identical cwd ships `response_dropped_files_oversize` while `coverage` does not; `untargetedCriteriaList` populated on `checklist` (18 ids) but empty array on `coverage` despite same `untargetedCriteria: 18` scalar.
- **Q9-OVERSIZE-MITIGATION-DOES-NOT-ENGAGE-PRE-SERIALIZATION** — +4 recurrences (all 4 corpora): `scan_project` on CSS-framework `requestedLimit: 25 → effectiveLimit: 1` (single retained file is a test-fixture path) — dominant contributor `fix_description` prose; SSG `scan_project` 81,340 chars over host cap with no minimum-honest envelope; vanilla-mini `scan_project` 78,982 chars over host cap; bulk-template `coverage` post-truncation 389,992 chars (4× over host cap despite internal `response_dropped_files_oversize` already firing).
- **Q10-SCAN-FILE-NO-TRUNCATION-NO-OVERSIZE-PROTECTION** — +4 recurrences (all 4 corpora): SSG `checklist` 78,756 chars + `coverage` 64,129 chars both transport-fail with no minimum-honest envelope; bulk-template `checklist` 112,772 chars + `coverage` 389,992 chars + `scan_file` on `*.min.css` 73,049 chars all transport-fail; vanilla-mini same shape on a 156-file corpus. Closure path: minimum-honest envelope on `scan_file` / `checklist` / `coverage` matching the `scan_project` precedent (already a token-reduction proposal item above).
- **Q10-META-TRUNCATED-FIELD-NAME-RETAINED-WHEN-GUTTED** — +3 recurrences: `scan_project.meta` retains `filesByExtension` and `rulesEvaluated` set to `null` per `response_token_budget_truncated.metaFieldsDropped` (CSS-framework); `coverage.meta.perRuleCoverage: []` retained empty while `perRuleCoverageSummary` lists 112 ruleIds and `metaArrayTruncated: true` (SSG); `response_meta_truncated.fields: ["analysisCoverage.fragmentFiles", "scannedBuildArtifacts.classified"]` retains the meta containers as absent keys rather than sentinels (bulk-template).
- **Q13-TRUNCATION-REPORTERS-OVERLAP-META-FIELDS-DROPPED** — +2 recurrences: bulk-template `response_meta_truncated.fields(2)` vs `response_dropped_files_oversize.metaFieldsDropped(8-9)` overlap on `analysisCoverage` with `metaArrayTruncated` floating as the third reporter (covered above on Q15-COVERAGE-METAARRAY-TRUNCATED-AS-THIRD-REPORTER).
- **Q13-FRAGMENT-FILES-MARKDOWN-RESIDUE-UNIFORM-CLASSIFIER** — +1 recurrence: SSG corpus flags 224 markdown content files as `fragmentFiles[].kind: "markdown_residue"` with all classification signals false (`hasHtmlOpener: false, hasLayoutDirective: false, inLayoutsDir: false`) — kind label determined purely by extension. Many files are top-level content pages with frontmatter, not partials.
- **Q13-FINDING-ID-NON-UNIQUE-PER-FILE-LINE** — +1 recurrence: same `findingId` resolves to multiple file:line pairs on bulk-template `scan_file` (covered above); cross-surface variant captured as net-new Q15-FINDINGID-DISAGREES-CHECKLIST-VS-SCAN-FILE-SAME-LOCATION.
- **Q9-NEXTSTEP-FIRST-BY-FILENAME-RECURRENCE** — +2 recurrences: bulk-template truncated `scan_project.nextStepStructured.args = {path: <admin-scaffold demo HTML>}` (alphabetically-first by-name, 206 vendor-form-template findings); CSS-framework truncated retention single file is a `js/tests/integration/index.html` (test-fixture path) over higher-impact authored source.
- **Q9-PARSER-INNERHTML-TEMPLATE-LITERAL-ISLANDS-IN-JS** — +1 recurrence: bulk-template `*.min.js` emits `scan_file_parser_bail_no_findings` (`parserAttempted: tsx`, `naturalParser: js`) yet still produces `reviewCandidates` somehow — routing question (`.js` through tsx parser) covered as net-new on Q15-PARSER-BAIL-ROWS-STILL-CONFIDENCE-HIGH but the routing-skip axis recurs here.
- **Q9-NO-CONFIG-FOUND-SEARCHED-FROM-REDUNDANT** — +4 recurrences (all 4 corpora): `warningsDetails.no_config_found.searchedFrom` duplicates `cwd` and `meta.scanned.root` on every surface. Closure path is the existing present-when-meaningful conditional spread already at the doctrine bullet; this round confirms the regression scope.
- **Q11-RULE-EXPANDED-DISCLOSURE-FIX-CONCEDES-MAY-NOT-APPLY-AT-ERROR** — +1 recurrence: SSG corpus + CSS-framework `scan_project` both ship `aria/expanded-on-disclosure` at counts of 134 and 166 respectively, every emission still at `severity: "error"` despite the closed-bullet doctrine. Field evidence suggests the closure is rule-by-rule rather than centralized; treat as evidence for promotion to a registry-level severity gate.
- **Q14-LINKED-STYLESHEET-RESOLVER-FAILS-SAME-DIR-SIBLING** — +2 recurrences: bulk-template `linked_stylesheet_not_resolved_for_contrast.unresolvedHrefCount: 2134` across 300+ HTML files for paths like `../bower_components/bootstrap/dist/css/bootstrap.min.css` that exist on disk relative to the HTML; vanilla-mini same shape. Resolution failure looks like a relative-href resolver bug consistent with the closed Q14 row.
- **Q14-NEXTSTEP-ROUTES-TO-MINIFIED-VENDOR-IN-SUGGEST-FIX** — +1 recurrence: SSG `wcag22:2.2.1` rank-0 candidate routes to a `*.min.js` already classified `definite-min-infix` vendor — same shape as the original Q14 row applied to the candidate-rank surface. Already covered by V1-CHECKLIST-CANDIDATE-VENDOR-EXCLUSION.
- **Q14-BOOTSTRAP-SUGGESTED-CONFIG-INVALID-TS-AND-EXCLUDES-AUTHORED** — +1 recurrence: bulk-template `bootstrap.suggestedConfig.exclude` lists 130+ entries including 100+ authored-source subdirs as `<subdir>/**`. Same shape as the original Q14 row, with the worst-case net surface confirmed at 100+ authored subtrees swept.
- **Q14-REVIEW-CANDIDATE-DUPLICATES-FINDING-SAME-LINE** — +1 recurrence: vanilla-mini `<audio>` element ships as both a `media/audio-controls-or-transcript-missing` finding AND a parallel review candidate at criteria 1.2.1/1.2.8/1.2.9/1.4.7 (covered as net-new on Q15-AUDIO-DOUBLE-FLAGGED-FINDING-AND-CANDIDATE-SAME-LINE).
- **V1-CHECKLIST-CANDIDATE-VENDOR-EXCLUSION** — +1 recurrence: SSG checklist routes the 2.2.1 rank-0 candidate into a `*.min.js` listed in `scannedBuildArtifacts.grouped` of the same response. Closure path already in flight per the V1 row.
- **V1-BULK-CATALOG-DETECTED-SMALL-N-THRESHOLD** — +1 recurrence: vanilla-mini ~50 sibling subdirs each shaped `<dir>/index.html + style.css + script.js` did not trigger `bulk_catalog_detected`. Closure path already in flight per the V1 row; this round confirms the small-N gate scope.
- **Q9 mid-word truncation preamble** — +2 recurrences: `suggest_fix.approach` mid-word ellipsis on CSS-framework + bulk-template — already a known regression pattern; net-new entry above (Q15-SUGGEST-FIX-APPROACH-MID-WORD-TRUNCATION) tightens the closure path.

### Considered and rejected (per CLAUDE.md §1)

- **Auto-skip findings on paths matching `cdnjs.cloudflare.com` / `unpkg.com` / Tailwind CDN URLs** — Rejected per "no heuristic suppression, even for spec carve-outs" doctrine. The CDN-href shape is a path-based heuristic; the legitimate fix is Q15-LINKED-STYLESHEET-WARNING-LUMPS-CDN-AND-SIBLING (split-by-predicate) so the agent can branch on the actionable subset rather than swallowing the high-volume external-stylesheet noise.
- **Downgrade per-finding `priority` automatically when `vendorPathHint: true`** — covered above as Q15-VENDOR-MINIFIED-CANDIDATES-AT-PRIORITY-HIGH-DESPITE-PATHHINT (closure ships the downgrade keyed on conjunction with `couldBeWrongBecause: ["minified_vendor_no_sourcemap"]`). The vendorPathHint scalar alone is not sufficient evidence — a minified-but-authored vendor extract can still carry actionable findings; pairing the two evidence tokens is what clears the priority-downgrade bar.
- **Auto-fold all multi-criterion review-candidate reasons into one summary** — Rejected. The fold loses per-criterion dismissal addressability the agent needs. Q15-CHECKLIST-PROMPT-TEXT-CONCATENATED-ACROSS-CRITERIA splits the candidate by criterion; the inverse aggregation would re-introduce the same composite-shape dishonesty the doctrine warns against.

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

### Rejected — runtime evidence bridge

A prior plan proposed ingesting vendor runtime results (vendor JSON → normalized shape → ledger) as the path to close runtime-only WCAG criteria. Rejected: vendor-specific ingest adapters duplicate capability agents already have via their own test harnesses, and the tool's job is to point at the source — not at another tool's output. The ingest shape is also fragile to vendor schema drift, and the normalized layer re-buckets findings in ways the reading agent can't re-audit. Agents that run runtime checks bridge their results through the existing `attest` tool — the reason text is the evidence, and the attestation ledger is the durable, vendor-neutral channel.

Items struck: C-RUNTIME-ADR, C-RUNTIME-SCHEMA, C-RUNTIME-INGEST, C-RUNTIME-MAP. C-COVERAGE-MERGE is re-scoped below.

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

### v1.0.0 — release hygiene

- [~] **V1-CHANGELOG-V1** Draft `## [1.0.0]` entry landed (1d784b7). Date placeholder `YYYY-MM-DD` stays until user says ship. Sections populated: Breaking Changes (exit-code freeze), Added (13 sub-groups), Changed (9 items), Deprecated (2 aliases), Fixed (19 items), Deferred (the four ADR 0018 items). New empty `## [Unreleased]` sits at top. Ready for `/release 1.0.0` when the user triggers.

### v1.0.0 — four-repo field test findings — catalog-scale perf / scoping

### Additional items

Response shape / honesty:

Tool-orchestration / bootstrap / suppress / write-gate:


Checklist / review-candidate shape:

Catalog-scale perf / scoping:

Review-finder noise / dedup:


Response shape / cross-surface drift / honesty:

Tool-orchestration / new tool surfaces:

Catalog-scale perf / scoping:

- [ ] **V1-REVIEW-CANDIDATE-CROSS-FILE-REPETITION-COLLAPSE** Website-templates' 528 HTML files trigger the same 2.4.5 candidate with byte-identical reason "Likely root layout has no search/sitemap/breadcrumb" on each `index.html`; `uniquePerCriterion` doesn't help because every candidate anchors to a different file path. V1-CHECKLIST-CRITERION-CANDIDATE-DEDUPE-ACROSS-IDS covers the same-candidate-across-criteria axis; V1-CHECKLIST-VENDOR-IFRAME-OCCURRENCES-COLLAPSE covers the vendor-file same-path axis. This item is the cross-file cross-template pattern-repetition axis. Fix: when the same `(ruleId, reasonHash)` fires on N files with N > threshold (e.g. 20), collapse to one top-level entry with `{pattern, occurrences: N, sampleFiles: [top-5-paths], totalFiles: N}` and elide the rest; the agent gets the signal once + sample coverage + the total without 528 near-identical rows. Doctrine: labeled buckets honest when the label is provable — "same-reason pattern fires on N files" is a deterministic fact.


### v1.0.0 — orchestrator follow-ups

Items surfaced during the /continue orchestrator run that landed the tenth-pass batch. Not user-surfaced drift — engineering follow-ups.


### v1.0.0 — multi-corpus sweep follow-ups

Items surfaced from a four-corpus blind sweep (CSS-framework docs, SSG fixtures, vanilla-JS demo catalog, bulk-template catalog) covering scan_project / checklist / coverage / scan_file / suggest_fix surfaces. Recurring patterns confirmed across ≥2 corpora.

---


- **Implement the remaining manual-only criteria as finders.** The coverage matrix (V1-COVERAGE-MATRIX) will enumerate actual gaps — per finder review the finder list confirms most are already covered. If V1-COVERAGE-MATRIX surfaces genuine gaps, each becomes a Track R `R-<criterion>-<topic>` item, NOT a Track V item. Track V verifies; Track R implements detection.
- **Widen real-world fixtures beyond the five above.** SPA routing, internationalization, dark-mode contrast, reduced-motion — all worth fixtures, none are "find all violations" gates. Log as Track F `F-V1.x` items if the v1.0 bar rises.
- **OSSF Scorecard / npm audit workflows.** Nice-to-have for supply-chain posture; zero-dep invariant already covers most of the surface. Skip unless a real signal arrives.

---

