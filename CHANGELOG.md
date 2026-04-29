# Changelog

All notable changes to ra11y are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see `CLAUDE.md` section 14 for the ra11y-specific semver policy.

## [1.0.0-beta.1] - 2026-04-29

Public API stability freeze: [ADR 0019](./docs/adr/0019-v1-api-stability.md)

Deferred decisions: [ADR 0018](./docs/adr/0018-v1-deferred-decisions.md)

### Breaking Changes

#### Exit-code table frozen as semver-major surface

The `ExitCode` enum in `src/cli/exit-codes.ts` is now the canonical source of truth for all CLI exit codes. Changes to these values are a semver-major change.

| Code | Constant | Meaning |
|------|----------|---------|
| `0` | `ExitCode.OK` | Success; no action required |
| `1` | `ExitCode.VIOLATIONS` | Violations found, or command-specific failures |
| `2` | `ExitCode.USER_ERROR` | Invalid arguments, unknown rule/profile, malformed input |
| `3` | `ExitCode.NEW_VIOLATIONS` | `--diff` / `scan_diff` mode only: new violations absent from baseline |

The observable behavior is unchanged from v0.2.0; the freeze makes the table a semver guarantee going forward. CI scripts that branch on `$?` should verify against the table, in particular that exit code 3 is only reachable via `--diff` (CLI) or `scan_diff` (MCP baseline mode).

#### MCP response shape changes

- **MCP `coverage` tool: `criteriaTotal` renamed to `criteriaTotalForProfile`; new sibling `criteriaByLevel: Record<string, number>`** (`src/mcp/tool-coverage.ts`, `src/reports/coverage.ts` `PerStandardCoverage.criteriaByLevel`). The bare `criteriaTotal: 55` headline was unanchored from the active conformance-level qualifier — an agent calling `coverage({ level: "AA" })` couldn't tell from the response alone whether the count reflected the AA-scoped shape, the full AAA row count, or some other narrowing. Per [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md) "Ambiguous field shapes are dishonest" the rename makes the conformance-profile scoping explicit; the new sibling `criteriaByLevel` (e.g. `{ A: 30, AA: 25 }` for WCAG at level AA, `{ base: N }` for level-less standards like Section 508 / EN 301 549) carries the per-level breakdown so the total is verifiable against its parts. The values sum to `criteriaTotalForProfile` exactly by construction; an integration test pins the equality at the tool boundary. Per-level keys are present-when-meaningful — narrowing to `level: "A"` drops the `AA` / `AAA` keys entirely (no zero-sentinel buckets). Pre-1.0 in-place rename — no transition alias, same precedent as the `id` → `criterionId` rename on these entries (per ADR 0028 doctrine for pre-release shape changes). Consumers reading `response.criteriaTotal` switch to `response.criteriaTotalForProfile`; consumers that need the total without the per-level shape continue to read it from there. Internal `PerStandardCoverage.total` field name is unchanged for in-process consumers (CLI `coverage` command, VPAT, certification, HTML formatter).
- **MCP `suggest_fix` drops the prose `verifyCommand` sibling; only `verifyCommandStructured` remains** (`src/mcp/tool-suggest-fix-internals.ts` `buildVerifyCommand`, the verify-pair plumbing across `tool-suggest-fix-routing.ts` / `tool-suggest-fix-fixpaths.ts` / `tool-suggest-fix-template-directive.ts` / `tool-suggest-fix-vendor.ts`). Every `kind: "edit"` and `kind: "guidance"` response previously shipped both `verifyCommand: string` (a prose instruction naming `scan_file` as the re-check step) and `verifyCommandStructured: { tool, args, verifyRuleId }` (the same content in machine-readable form). The two channels carried the same content under different shapes — exactly the canonical "Ambiguous field shapes are dishonest" / triple-readout failure mode in [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md). Drift between the two was silent and the agent could not tell which was canonical: a future format change to the prose template (or a missed update to one channel during a refactor) would leave consumers reading two disagreeing answers to the same question. Per the doctrine "Verbose meta is signal — but de-duplicate triple readouts," the prose channel is dropped entirely; only the structured form rides on `kind: "edit"` / `kind: "guidance"` responses, and `kind: "none"` continues to omit both. Consumers that read `response.verifyCommand` synthesize prose from the structured form (e.g. ``mcp: scan_file({ path: "${args.path}" }) and confirm `${verifyRuleId}` no longer fires``); the field-name change is mechanical.
- **MCP warning code `extensions_skipped_no_parser` split into `text_source_skipped` + `binary_assets_skipped`** (`src/mcp/warnings.ts`, `ScanWarningCode` union, `ScanWarningDetails` interface, paired `warningsDetails` payload slots). The pre-split code surfaced a single composite payload mixing routable text-source extensions (`.php`, `.coffee`, `.htc`, `.xhtml`, `.mkdn`, `.rmd`, `.erb`, `.hbs`) with binary asset extensions (`.png`, `.jpg`, `.eot`, `.ttf`, `.woff`, `.mp3`, `.psd`, `.ico`). On bulk catalog scans the binary tail buried the actionable subset — a `topExtension: ".jpg"` (1835) at the head of `extensions_skipped_no_parser.extensions` hid 30 `.php` files among `totalSkipped: 5341`, and the agent reading the top extension concluded "binary noise" while real text-bearing source went silently unscanned. Per [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md) "Routing skips that drop content are the symmetric twin of suppression," the two predicates are now independent: `text_source_skipped` fires when at least one text-source extension is in the skipped map (the actionable subset an agent might re-route via `additionalPaths` or new parser support); `binary_assets_skipped` fires when at least one binary-asset extension is in the map (the corpus-shape signal — surfaced honestly rather than silently filtered). Both warnings can fire simultaneously on heterogeneous corpora; each carries its own payload (`extensions`, `topExtension`, `topCount`, `totalSkipped`) describing only its subset, so the wire shape is disjoint. Consumers branching on `warnings[i] === "extensions_skipped_no_parser"` must switch to `warnings.includes("text_source_skipped") || warnings.includes("binary_assets_skipped")`; consumers reading `warningsDetails.extensions_skipped_no_parser.totalSkipped` for "how bad is the skip" must read both `warningsDetails.text_source_skipped?.totalSkipped` and `warningsDetails.binary_assets_skipped?.totalSkipped` (sum if the legacy combined value is needed; branch on each independently if the actionable subset is the question). Cross-surface invariant tests (`scan_project` ↔ `coverage` ↔ `checklist`) extend to assert the same code set on identical cwd; `scan_file` continues to omit both codes (single-file surface has no discovery phase).
- **MCP `scan_project.plan.summary` removed; `meta.countsBySurface` removed; `warningsDetails.response_meta_truncated` becomes payload-bearing** (`src/mcp/scan-assembly.ts`, `src/mcp/response-assembler.ts`, `src/mcp/tools-helpers.ts`, `src/mcp/warnings.ts`, `src/mcp/meta-array-cap.ts`). Three breaking shape changes bundled — they all touch `scan_project` response assembly. (1) `plan.summary` was a prose blurb embedding 5+ counts (per-lane fixClass tally, notes, actionable manual review, untargeted criteria) into a single composite sentence the agent read first — duplicating the structured siblings (`fixesByClass`, `notes`, `actionableManualItems`, `untargetedCriteria`) and rotting independently of them. Per [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md) "Composite headline counts are dishonest" the prose is dropped (not renamed); consumers stitch a human-readable headline from the structured siblings if needed. Same precedent as `plan.totalFindings` / `plan.safeEditsAvailable` / `plan.violations`. (2) `meta.countsBySurface` framed as cross-surface reconciliation but shipped a 4-way internal spread of disagreeing finding totals (`plan: 316`, `perRuleCoverage: 328`, `filesSurface: 316`, plus `plan.violations: 310`) — the worst-case dishonest shape doctrine warns against, where a field whose name implies cross-surface reconciliation actually multiplies the disagreement instead of reconciling it. Removed (not annotated); consumers that want cross-surface reconciliation read the structured siblings directly (`plan.fixesByClass`, `meta.perRuleCoverage`, the per-file `findings.length` rollup). (3) `warningsDetails.response_meta_truncated` graduates from a binary-presence marker to a payload-bearing entry: `{ fields: readonly string[] }` names the dotted paths of every meta sub-array elided when one or more linear-with-input meta path-arrays exceeded `META_ARRAY_CAP`. The membership table (`META_ARRAY_TRUNCATION_ENTRIES` in `src/mcp/meta-array-cap.ts`) is the single source of truth; `getTruncatedMetaArrayFields(meta)` produces the field-paths list for the warning input slot (`metaArrayTruncatedFields: readonly string[]`, replacing the former boolean `metaArrayTruncated`). An agent reading the bare warning code now knows which array to re-fetch under `verboseMeta: true` instead of probing each possible array blind.
- **`plan.safeEditsAvailable` removed** (MCP `scan` / `scan_file` / `scan_project` / `scan_diff` / `bootstrap` response `plan` block; MCP `bootstrap` response `scan` subset; CLI `--format agent` response `plan` block; the `FixCounts.safeEditsAvailable` property on the exported `countFixes` helper under `src/output/agent-response/build-plan.ts`). The counter shipped one release ago as the rename of the older `plan.mechanicalEditsAvailable`, but field reports surfaced a second mismatch the rename didn't resolve: `plan.safeEditsAvailable: 14` sat next to `plan.fixesByClass.mechanical: 266` on the same `bootstrap` response — two sibling counters both framed as "how many fixes an agent can apply" disagreeing 18× because they measured different slices (payload-availability vs. rule-demanded lane) under names that both sound like "safe mechanical work." Per [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md) "Composite headline counts are dishonest," a top-level counter must count one kind of thing; when two kinds exist the structured per-kind sibling is the honest shape, not a composite sitting next to it. The structured `plan.fixesByClass: { mechanical, guidance, runtimeOnly, verifyInSource }` already carries the honest per-lane signal — each key counts one kind of thing (rule-level `fixClass`). Consumers that read `plan.safeEditsAvailable` switch to `plan.fixesByClass.mechanical + plan.fixesByClass.verifyInSource` — the two remediation lanes whose edit lands in source. Consumers that need only the mechanical-lane subset read `plan.fixesByClass.mechanical` directly.
- **MCP `bootstrap` response `scan` subset drops `totalFindings`; adds `violationsCount` + `notesCount` + `fixesByClass`** (`src/mcp/tool-bootstrap.ts` `ScanSubset`). Upstream `scan_project` intentionally splits its plan block into `violations` / `notes` / `fixesByClass` (one counter per remediation lane); the bootstrap composer used to re-sum them back into a single `scan.totalFindings` headline, which re-introduced the composite-headline anti-pattern CLAUDE.md §1 warns against — agents budgeting against the sum treated info-severity notes as identical work to violations, and could not tell editable-lane violations apart from guidance/runtime-only lanes without a second tool call. The subset now forwards the upstream split verbatim: `violationsCount` (severity `error` / `warning`), `notesCount` (severity `info`), and `fixesByClass: { mechanical, guidance, runtimeOnly, verifyInSource }` (present when violations > 0, mirroring the upstream `emitFixesByClass` gate). The `nextStep` prose reads "N violations" (and optionally "+ M notes") instead of "N findings"; `nextStepStructured` routes off `violationsCount` rather than the composite. Consumers that read `response.scan.totalFindings` read `response.scan.violationsCount + response.scan.notesCount` for the former sum, or branch on `violationsCount` alone for the work-budget question `nextStepStructured` answers.
- **VPAT conformance cells for runtime-evidence-required criteria now read `"Not Evaluated"` on clean scans** (MCP `vpat` tool response `standards[].entries[].conformance`; CLI `--vpat` rendered table). The criteria listed in `src/reports/runtime-evidence-criteria.ts` (`RUNTIME_EVIDENCE_REQUIRED_CRITERIA` — 2.1.1 Keyboard, 2.4.3 Focus Order, 2.4.7 Focus Visible, 1.4.3 / 1.4.11 Contrast, 2.4.6 Headings and Labels, 1.4.10 Reflow, 1.4.12 Text Spacing, 1.4.13 Content on Hover or Focus, 2.5.7 Dragging Movements, 2.5.8 Target Size, 3.3.7–3.3.9 Authentication, plus WCAG 2.1 aliases) used to surface as `"Partially Supports"` or `"Supports"` on clean bootstrap scans via their `automatable: "partial" | "full"` metadata — but a procurement reader seeing `"Partially Supports"` reads "some aspects evaluated, some pass," when the honest framing on runtime-dependent criteria is "the static layer cannot answer this question." The builder now routes these criteria to `"Not Evaluated"` when there are zero static violations AND no fresh attestation (verdict `pass` / `fail` / `n/a`) covers the criterion; a remarks string cites the runtime dependency and points at the `attest` tool. A proven static failure still routes to `"Does Not Support"` — honest negative evidence is preserved. Attestations supplied via `.ra11y/attestations.jsonl` or pragma are threaded through the `attestations` option on `buildVpatReport`; the MCP `vpat` tool forwards them automatically. Consumers pattern-matching against `conformance === "Partially Supports"` on these criteria must add a `"Not Evaluated"` branch (the honest and VPAT 2.5 Rev-accepted verdict) or re-examine whether the criterion needed a bridge to a runtime harness.
- **`checklist.summary.manualReviewRequired` removed** (MCP `checklist` tool response `summary`): the composite counter summed grounded file:line candidates (`actionable`) with bare-criterion WCAG prompts (`untargetedCriteria`) into one headline number, which was the canonical dishonest-composite example called out in [`docs/kb/architecture/ai-first-consumer.md`](./docs/kb/architecture/ai-first-consumer.md) ("Composite headline counts are dishonest"). Agents budgeting against the summed value over-counted the work by ~5× on typical media-light scans. The `summary.headline` string (`"N actionable · M untargeted · K likely irrelevant"`) is unchanged — it already presents the split correctly. Consumers that actually want the sum can compute `summary.actionable + summary.untargetedCriteria` themselves, but per doctrine the two are categorically different work kinds and should not be summed into one agent-facing headline.
- **`ConformanceBlocker.status` widened with `"undetermined"`** (`src/reports/conformance.ts` exported type `ConformanceCriterionStatus = EvidenceStatus | "undetermined"`; `conformance_statement` MCP response `blockers[].status`). Runtime-evidence-required criteria (keyboard, focus-visible, rendered contrast, heading adequacy, pointer interaction, authentication flow — full list in `RUNTIME_EVIDENCE_REQUIRED_CRITERIA`) that reach the builder with zero fail-evidence AND no attested/sampled source now emit `status: "undetermined"` and `reason: "runtime-evidence-required"`, instead of the former `status: "pass", reason: "no-evidence"` collapse. A shape-agnostic consumer that read `status === "pass"` unconditionally will miss these results — they are honestly undetermined, not provably passing. Callers that pattern-match on `status` must add the `"undetermined"` case or fall back to reading `reason`. The blocker `status` field is otherwise unchanged (`pass` / `fail` / `partial` / `unknown` / `n/a` stay in the enum). The ledger's `EvidenceStatus` is NOT widened — the undetermined verdict lives only on claim-level blockers, where the claim reader's stricter threshold applies.
- **`AgentFix.description` may be hoisted off findings into `referenceGuide.fixDescriptions`** (MCP `scan` / `scan_file` / `scan_project` / `scan_diff` response `files[].findings[].fix.description`): when the same `(ruleId, description)` pair appears on ≥2 findings in a single response, the prose is deduped into a new top-level `referenceGuide.fixDescriptions: { [ruleId]: { [hash]: description } }` map and the affected findings drop inline `fix.description` in favour of `fixDescriptionRef: { hash }`. Findings whose description is unique-in-response keep the inline text. Keyed by a 12-hex-char truncated SHA-256 of the description — matching the `findingId` recipe — so rules that legitimately emit two distinct descriptions (e.g. `semantics/label-in-name`'s two verdicts) keep both entries in the map without one silently replacing the other. Never emit both the pointer and the inline description on the same finding. Consumers that read `finding.fix.description` unconditionally must now fall back to `referenceGuide.fixDescriptions[finding.ruleId][finding.fixDescriptionRef.hash]` when the inline field is absent. Tools that don't hoist (`apply_fix`, `baseline`, CLI `--format agent`) emit descriptions inline as before.
- **`AgentFinding.snippet` shape change** (CLI `--format agent`, MCP `scan_project` / `scan` / `scan_file` / `scan_diff` response `files[].findings[].snippet`): the field is now `string | undefined` and omitted entirely when the violation has no snippet. Previously it was always a `{ before: [], highlighted: string, after: [] }` record where `before` and `after` had zero writers anywhere in the codebase — the empty-array sentinel was indistinguishable from "snippet builder failed" per CLAUDE.md §1 "Ambiguous field shapes are dishonest." Consumers that accessed `finding.snippet.highlighted` must now read `finding.snippet` directly; consumers that inspected `.before` / `.after` were reading dead fields and can drop the code. The `AgentSnippet` type is removed.
- **Canonical `scanned` envelope across MCP scan-family tools**: `scan_project`, `scan`, `scan_file`, `scan_diff`, `detect_native_wrappers`, `propose_config`, `propose_baseline`, `bootstrap`, and `wrapper_introspect` now emit a single `scanned: { mode: "project" | "dir" | "file", root?, paths?, file? }` envelope in place of the three previous keys (`scannedRoot`, `scannedPaths`, `scannedFile`). Only the field matching `mode` is populated — the others are absent per CLAUDE.md §1 "present-when-meaningful." Consumers that branched on which key was present now read `scanned.mode` and pick the matching field; responses are otherwise unchanged.

### Added

#### MCP server — new tools

- **`scan_diff` tool** — per-scan baseline delta. Returns only violations new since a baseline snapshot; supports `hunksOnly` mode for PR-review agents. (Commit: 2690406, ff21fa5.)
- **`baseline` tool** — create/check/update baseline within an MCP session, mirroring the CLI `--baseline` modes. Uses SHA-1 fingerprinting (line-number-independent). (Commit: aef0e0d.)
- **`apply_fix` tool** — write-gated fix-verify loop. Accepts a structured fix instruction, applies it to the source file, and re-scans to confirm the violation is resolved. Disabled by default; requires `allowWrite: true` in session config. (Commit: 65f349e.)
- **`audit` meta-tool** — one-call shorthand that runs `scan`, `coverage`, and `checklist` and merges results into a single response for cold-start onboarding. Partial failures surface as warning codes via `Promise.allSettled`. (Commit: c41832b.)
- **`bootstrap` meta-tool** — single-call onboarding composing `detect_native_wrappers`, `propose_config`, `scan_project`, and opt-in `baseline create`, plus a copy-pasteable GitHub Actions snippet. `writeBaseline: true` grandfathers current violations into `.ra11y-baseline.json`. Partial-failure tolerant. (Commit: 9337cc4.)
- **`scan_process` tool** — multi-page process scope; threads process-scoped page sets through `runScan` and per-page finders. (Commit: 9f23018.)
- **`conformance_statement` tool** — gates a WCAG conformance claim against the evidence ledger; emits a signed conformance bundle with a SHA-256 digest. Refuses or emits per ledger state. (Commit: 4c7ea4d.)
- **`list_attestations` tool** — lists file-backed attestations with staleness detection. (Commit: 2ad0108.)
- **`list_suppressions` tool** — pragma audit; lists all inline `ra11y-disable` suppressions across the scanned tree. (Commit: d0a017c.)
- **`attest` tool** — writes durable attestations to the evidence ledger; accepts `ruleIds` for partial attestations and surfaces missing rules on the conformance report. (Commit: 6e0f9e5.)
- **`suppress` tool** — adds an inline pragma at a specified location. (Commit: b72eb90.)
- **`propose_config` tool** — proposes a `ra11y.config.ts` starter based on detected wrappers, framework, and scan findings. (Commit: f043fa5.)
- **`propose_baseline` tool** — classifies current violations and proposes a baseline snapshot with reason codes. (Commit: 5fb68bd.)
- **`wrapper_introspect` tool** — AST-based wrapper classification and introspection cache. (Commit: 5bf4c00.)
- **`autoDetectWrappers` and `additionalPaths`** parameters on `scan` and `scan_project` — `autoDetectWrappers: true` runs the wrapper detector inline; `additionalPaths` includes built CSS/HTML files alongside the source tree. Wrapper provenance annotated per-entry as `source: "config" | "autoDetect" | "session"`. (Commits: 941c54a, 8af966a.)
- **`skipCriterion` parameter** on `checklist` and `scan_project`. (Commit: ef8062f.)
- **`includeRuleDetails` parameter** on `scan` and `scan_project`. (Commit: fd045b9.)

#### MCP server — prompt templates

- **`ra11y/triage`** — prioritized triage agenda from a scan result.
- **`ra11y/fix`** — fix-path guidance and verification checklist for a single violation.
- **`ra11y/audit`** — project-level WCAG readiness narrative for a technical lead.
- **`ra11y/vpat-narrative`** — per-criterion VPAT remarks from checklist output.

All four prompts are served via `prompts/list` and `prompts/get`. Prompt templates are referenced in `nextStep` guidance on scan responses. `nextStep` guidance on applicable tools now references the canonical prompt template. See [`docs/mcp/prompts.md`](./docs/mcp/prompts.md). (Commits: a332475, 52f97aa.)

#### MCP server — prompt checksum registry

`src/mcp/prompts/checksums.ts` computes a stable 16-hex SHA over each prompt template's canonical serialization. The checksum surfaces as `_meta.checksum` on `prompts/list` and `prompts/get` responses so agents can pin to a specific prompt version and detect drift without re-reading the full content. (Commits: 9cfc547.)

#### MCP server — capabilities and resources

- **`logging` capability** — server declares `logging` in the initialize response; hosts receive structured scan telemetry via `notifications/message`. Level controlled via `logging/setLevel`. (Commit: 4195a11.)
- **`completions` capability** — `completion/complete` dispatch for prompt names and resource URIs. (Commit: c1b4ca8.)
- **`roots` capability** — server reads `params.roots` from `initialize` and `notifications/roots/list_changed` to set the default scan root. (Commit: b11d7ba.)
- **`resources/list` and `resources/read`** — `docs/kb/**` exposed as MCP resources via `ra11y-kb://` URIs; agents retrieve architecture docs, rule entries, and gotchas directly. (Commit: 707dace.)

#### MCP server — structured errors

All error responses across `scan`, `scan_diff`, `scan_file`, `apply_fix`, and `audit` now carry a `structuredContent` envelope with machine-consumable fields (`code`, `message`, optional `details` and `remediation`). Agents can branch on `code` without parsing prose. See [`docs/errors.md`](./docs/errors.md). (Commit: 19333a1.)

#### MCP server — bidirectional outbound rail and sampling

- `src/mcp/outbound.ts` — JSON-RPC rail for server-to-host requests.
- `src/mcp/session.ts` — `hostCapabilities` slot and `sendRequest` for outbound calls.
- `src/mcp/sampling.ts` — `sample()` helper calling `sampling/createMessage`. Raises `SamplingNotSupportedError` / `SamplingTransportUnavailableError`; default timeout 60 s. (Commits: c141440.)

#### MCP server — metaMode and sessionRef delta cache

- `metaMode` parameter on `scan`, `scan_file`, `scan_diff`, `checklist`, `coverage`, and `list_suppressions` — controls verbosity of the `meta` block. (Commits: 608cda7, 4ac1cba.)
- `sessionRef` + meta-delta cache — allows agents to reference a prior scan result to compute a meta diff without retransmitting the full result. (Commit: 14c35a4.)

#### MCP server — additional surface improvements

- Scan responses carry `warnings: string[]` for silent-failure modes (`scanned_zero_files`, `root_source_defaulted`, `no_config_found`, `storybook_preset_active`, `bootstrap_<leg>_failed`, and others).
- `scan_project` returns a ranked `top-N opaque components` list in `verboseMeta`, ordered by interactive call-site count.
- `scan_project` includes Tailwind-aware CSS coverage hints when Tailwind utilities are detected.
- `scan_project` surfaces `wrapper provenance` per active native wrapper (`source: "config" | "autoDetect" | "session"`; `confirmed` flag for `autoDetect` entries set by one-hop AST probe).
- `checklist` summary leads with a plain-English headline before the structured counts; items carry WCAG principle name (Perceivable / Operable / Understandable / Robust).
- Per-finding suppression placement guidance: each violation includes a `suppressionHint` with the exact pragma and placement.
- `coverage`: `manualUntargeted` list gated behind `showUntargeted: true`; the count is always present. Gated list emitted as `untargetedCriteriaList`.
- `scan dir-mode` nextStep parity — directory-mode scans return the same `nextStep` structure as file-mode scans. (Commit: fbe6c56.)
- Brace-balance snippet walker — `scan` response snippets widen to the enclosing block boundary. (Commit: b0e26cc.)
- `detect_native_wrappers` now includes `suggestedConfigSnippet` and `definitionFile` on candidates. (Commits: e2d4a2f, 6930fce.)
- `suggest_fix` returns `verifyCommand` + `verifyCommandStructured` alongside `fixPaths`. (Commit: 100a0fa.)
- `suggest_fix` suppresses the prose nudge when inline fixes are mechanical. (Commit: 14e3d9a.)
- `scan_diff` surfaces resolved findings in baseline mode. (Commit: 9d85885.)
- `scan_project` paginates files with findings via `limit`/`offset`. (Commit: ab23bd5.)
- `checklist` is paginated with `limit`/`offset`/`perCriterion` caps. (Commit: df8946c.)
- **MCP scan responses surface `linked_stylesheet_not_resolved_for_contrast` warning** (`src/mcp/scan-assembly.ts` `detectLinkedStylesheetsNotResolvedForContrast`, `src/mcp/warnings.ts`). Scanning HTML files that declare `<link rel="stylesheet" href="…">` references does not pull the linked stylesheets into contrast-rule resolution — the rule operates on parsed CSS / SCSS files in isolation and never follows link references from HTML into linked sheets. Without this code, a multi-page site whose pages link a single bundled stylesheet (canonical case: 14 `.html` files referencing `bootstrap.min.css`) reads as `findings: []` with `coverageConfidence: "high"` despite the entire color substrate sitting outside the rule's evidence horizon. The detector does not attempt to resolve the linked sheet inline (full resolution is out of scope for this surface) — it just names the unresolved hrefs so the agent can scope a follow-up via `additionalPaths`, `propose_config`, or a separate `scan` against the linked CSS. Paired payload: `warningsDetails.linked_stylesheet_not_resolved_for_contrast: { count, htmlFiles, topUnresolvedHrefs }` (topUnresolvedHrefs capped at 10 entries, deterministic-sorted). Cross-surface invariant: emitted identically across `scan_project` / `scan` / `scan_file` / `coverage` / `checklist` on the same cwd. Fragments (no `<html>`/`<body>` envelope) are intentionally excluded — partials don't establish a page-level link-resolution context. `rel="alternate stylesheet"` and `rel="preload" as="style"` shapes are excluded too because they don't activate the canonical parse-and-resolve path the warning is about.
- **MCP scan responses surface `sourcemap_files_excluded` warning** (`src/input/discover.ts`, `src/mcp/warnings.ts`, `src/mcp/analysis-coverage.ts`). The discovery walker previously routed `.map` sourcemap files through `skippedByExtension` alongside parser-routable extensions like `.vue` / `.scss`, so 48 sourcemaps in a CSS-framework corpus surfaced under `text_source_skipped` as if they were a coverage gap an agent could close by adding a parser. Sourcemap exclusion is conventionally correct (the `.map` payload is generator output, not authored a11y source) but a silent skip is indistinguishable from "tool never saw the file" from the agent's seat. The walker now routes `.map` paths into a dedicated `analysisCoverage.sourcemapFiles` list (sorted ascending, deterministic across runs) and the warnings module emits a top-level `sourcemap_files_excluded` code paired with `warningsDetails.sourcemap_files_excluded: { count, topPaths }` (topPaths capped at 10 entries; the full list lives under meta). Cross-surface invariant: emitted identically across `scan_project` / `coverage` / `checklist` on the same cwd.
- **MCP `scan_project` plan splits violations by scan-kind** (`src/mcp/scan-assembly.ts` `withViolationsByScanKind` / `splitViolationsByScanKind`, wired in `src/mcp/tool-scan-project.ts`). When the scan included files the build-artifact classifier labelled — compiled CSS, minified bundles, hashed webpack chunks, etc. — the `plan` block now ships a structured sibling `violationsByScanKind: { source, buildArtifact }` so an agent reading "187 violations" against a vendor-heavy template catalog can tell at a glance that 41 of those sit in `css/bootstrap.min.css` (often un-editable; the productive triage is `propose_config` exclude or source-level disable, not a fix attempt). The flat `plan.violations` counter is unchanged. Severity-axis-honest: info-severity findings (counted in `plan.notes`) are excluded from both lanes so the per-lane sum mirrors `plan.violations`. Present-when-meaningful: omitted when no build artifacts were classified for the scan (the absence of `meta.scannedBuildArtifacts` already conveys that signal).
- **MCP `checklist` candidates carry source-level suppression pragmas** (`src/mcp/tool-checklist.ts`). Every candidate now ships `suppressWith: { html, jsx, liquid, hugo }` — ready-to-paste `ra11y-disable <criterionId>` pragmas for the four comment dialects the inline-disable parser accepts today (HTML, JSX, Liquid `{% comment %}`, Hugo `{{/*...*/}}`). The MCP workflow tells agents to dismiss manual-review candidates at source via `<!-- ra11y-disable wcag22:1.2.1 -->` / `{/* ra11y-disable wcag22:1.2.1 */}`; carrying the pre-built pragma inline saves a per-file lookup on every dismissal. Schema-required (not optional). Scoped to the owning criterion ID, same granularity the disable parser matches.
- **MCP `checklist` annotates candidates that span multiple criteria with `criteriaIds`** (`src/mcp/tool-checklist.ts`). A single file:line + reason shared across multiple items (the canonical case: a `<video>` surfacing under `wcag22:1.2.1`, `1.2.3`, and `1.2.5`) now carries `criteriaIds: string[]` listing every criterion the location covers, so an agent walking a shared candidate reads one entry per location and knows which criteria it satisfies. Items stay per-criterion (the cross-tool invariant `checklist.items[].criterionId ≡ coverage.manualWithCandidates[].id` is load-bearing per ADR 0010) — the annotation is the dedup signal the agent consumes. Present-when-meaningful: omitted on single-criterion candidates; populated with ≥2 IDs when the location is shared.
- **MCP `checklist` gains a per-criterion resume cursor** (`src/mcp/tool-checklist.ts`). Previously when `maxCandidatesPerCriterion` clipped a noisy criterion's candidate list, the response carried `perCriterionClipped: true` but offered no path to the elided tail — a caller seeing `perCriterionClipped: true` + 10 candidates on a criterion with 34 available had no way to fetch the remaining 24. The response now also emits `nextCursor: { afterCriterion, afterCandidateIndex }` (opaque) when per-criterion elision happens; passing it back via the new `cursor` input resumes inside the named criterion at `afterCandidateIndex + 1`, yielding up to `maxCandidatesPerCriterion` more candidates and a fresh `nextCursor` if the tail still overflows. Paired with a structured response-level `warnings: ["results_truncated_use_nextcursor"]` code so the agent's warnings read-path disambiguates success-with-more-to-fetch from success-complete. The flat-stream `offset` / `nextOffset` lane is unaffected; the cursor is the orthogonal resume for the per-criterion axis. Honest-shape throughout: no cursor emitted when nothing was clipped; malformed cursors drop silently; cursor-resume yields an empty page with no `nextCursor` when the named criterion is no longer in the inventory.
- **MCP scan meta splits parse-error reporting into `parseErrorFiles` and `partialParseFiles`** (`src/mcp/analysis-coverage.ts` `buildAnalysisCoverage`). Previously a single `parseErrorFiles` list lumped together "file wholly failed to parse, rules saw nothing" with "parser recovered, rules fired on the partial tree." Agents reading the combined shape treated every listed path as invisible and silently discarded the live-line-numbered findings emitted on the recovered slice — the canonical example was a `.mdx` file producing 14 findings that also appeared in `parseErrorFiles`. The split routes errored files by whether the scan produced at least one finding on their path: zero findings → `parseErrorFiles` (invisible-to-rules; count always present, path list gated on `verboseMeta`); any finding → `partialParseFiles: Array<{ path, reason }>` (always present when non-empty, reason carries the first parser error message truncated to 200 chars). `parseErrorFileCount` and `partialParseFileCount` are split siblings. Response-level `warnings: ["parse_errors_present"]` now fires on either bucket being non-zero, so the signal is preserved.
- **MCP `bootstrap` response** now forwards `plan.limitations` prose from the composed `scan_project` leg onto `scan.limitations` in the bootstrap subset — the static-analysis caveat ("can prove failure but not conformance; runtime-only checks — live-region announcements, focus traps, ARIA state transitions, post-render contrast — are out of scope") that upstream `scan_project` has always emitted. Previously the subset extractor stripped this prose, so the bootstrap composer's `ciSnippet` advised running `baseline check` in CI with zero caveat about what the scan can't verify.
- **MCP `list_rules` echoes filter result shape**: responses now include `matchedOf: { total, matched }` (always present) and `filter: { standard }` (present-when-meaningful, conditional-spread). Previously the handler returned the same `rules: [...]` array whether a filter narrowed the list or was silently a no-op. Additive — the `rules` array shape is unchanged.
- **MCP scan meta** surfaces `analysisCoverage.skippedByExtension` — a map of `ext ↦ count` for files the discovery walker cleared past dir-ignore and user-excludes but then rejected purely because their extension isn't in `PARSEABLE_EXTENSIONS` (`.astro`, `.scss`, `.vue`, etc.). Paired with the top-level `warnings: ["extensions_skipped_no_parser"]` code, this closes the silent-miss case where a mixed-language repo scanned only 125 of 351 source files and `filesScanned: 125` read as "tool covered everything." Present-when-meaningful: omitted when the map is empty or when the caller's tool doesn't run discovery. Wired into `scan_project`.
- **MCP scan responses gain a parallel `warningsDetails` channel** alongside the bare-string `warnings: string[]` ([ADR 0023](./docs/adr/0023-warning-structured-details.md)). Conditional-spread, keyed by `ScanWarningCode`, populated only for codes that carry a structured payload. An agent branching on the warning code can now read `warningsDetails.<code>.{...}` without cross-referencing `meta` slots. The two channels agree on set membership: a code in `warnings[]` without a matching entry is a presence-only signal; these stay presence-only and leave `warningsDetails` unpopulated. Purely additive — the bare-string channel shape is unchanged.
- **`response_token_budget_truncated` warning echoes requested vs. effective file counts** via `warningsDetails.response_token_budget_truncated: { requestedLimit, effectiveLimit }`. Emitted only when the density cap trims trailing file entries on `scan`, `scan_project`, or `scan_diff`. `requestedLimit` is the file count the density guard saw entering (post-pagination, pre-density on `scan_project`; full files-with-findings on `scan` and `scan_diff`); `effectiveLimit` is what survived the char-budget trim. Conditional-spread per "present-when-meaningful." Purely additive.
- **`conformance_statement` surfaces `limitations[]`** — a top-level prose list, one entry per in-scope criterion whose only signal was absence-of-findings against a runtime-dependent WCAG requirement (keyboard, focus-visible, rendered contrast, heading adequacy, pointer interaction, authentication flow, and the rest of the spec-derived enumeration in `RUNTIME_EVIDENCE_REQUIRED_CRITERIA`). Each entry reads `"<criterionId>: <title> — runtime evidence required; no static finding in scope, no attestation supplied."`. The same criteria also surface in `blockers[]` with `reason: "runtime-evidence-required"` and `status: "undetermined"` so agents can route by structured type or by prose. Present-when-non-empty per CLAUDE.md §1 "present-when-meaningful." Markdown renderer emits a `## Limitations` section in the same cases.

#### Engine

- **Evidence primitive and ledger** — `src/engine/evidence.ts` and `src/engine/ledger.ts` establish per-criterion evidence records that aggregate static scan results, file-backed attestations, and pragma-resolved attestations. Coverage and conformance reports consume the ledger. (Commits: e87347f, 6b2778c.)
- **Rule-scoped attestations** — `attest` accepts `ruleIds` for partial criterion coverage; `conformance_statement` surfaces missing rules. (Commit: f9e2f33.)
- **`afterProject` hook for finders** — `Finder` objects may implement `afterProject({ files, enabledStandards })` to emit cross-file review candidates after all per-file passes. (Commit: 1c20455.)
- **Inherited findings** — `Violation.confidence: "inherited"` + `Violation.sourceOfFinding` propagate wrapper-definition findings to call sites. Post-scan synthesizer in `src/engine/inherited-findings.ts`; SARIF maps `sourceOfFinding` to `relatedLocations[0]` with role `"origin"`. (Commit: 2eae9ea.)
- **Criterion IDs in inline disable pragmas** — `ra11y-disable wcag22:2.4.5` works alongside rule IDs. (Commit: 9b9a2f9.)
- **Bare pragma attestations** — `@ra11y-intentional` pragma-reason → attestation resolver wires pragma evidence into the ledger. (Commits: 93619b4, 701f452.)
- **Conformance level gate** — rules and finders skipped end-to-end when their criterion level exceeds the active scan level. (Commit: 347e59e.)
- **`wrapperTreatsAsElement` opt-in** — rules may declare element-mapping semantics to skip false positives on wrapper components. (Commits: 3f7a07f, 7c7e43b.)
- **Polymorphic `as`/`asChild` resolution** — rules may opt in to resolving the rendered element from `as` or `asChild` props. (Commits: 0b130dd, b07455b.)
- **`Violation.groupKey`** — stable SHA derived from rule + AST shape for grouping duplicate findings in PR comments. (Commit: 9184f6d.)
- **`Violation.findingId`** — stable per-finding ID, line-number-independent. (Commit: 49f9227.)
- **`Violation.fixClass`** — inline discriminator (`"mechanical"` | `"guidance"` | `"none"`) on every violation. (Commit: bbbecf1.)
- **`Violation.couldBeWrongBecause`** — additive context for findings that may have lower confidence due to framework-specific patterns (e.g. Tailwind class on consumer). (Commits: 2df787a.)
- **Per-rule coverage confidence** — scanner tracks per-rule file evaluation counts to derive coverage confidence ratios. (Commit: 93dfb72.)

#### Configuration

- **`profiles` primitive** — eight built-in scan profiles (`wcag21-a`, `wcag21-aa`, `wcag22-a`, `wcag22-aa`, `section508`, `en301549`, `strict`, `lenient`). `--profile` CLI flag and `scan_project` parameter. (Commits: 4d217e3, bd73f3d.)
- **`processes` primitive** — multi-page process scope for page-set finders and conformance claims; enables consistent-navigation and consistent-identification finders to operate cross-page. (Commit: 1893410.)
- **`preset: "storybook"` option** — opt-in framework preset: story files reach the scanner, Storybook primitives (`Meta`, `StoryObj`, `StoryFn`, `Story`) render transparent in opaque-component telemetry. `storybook_preset_active` warning code emitted on scan responses. (Commit: 6dfa231.)
- **`@ra11y-intentional` JSDoc tag** — scoped disable recognized as pragma evidence. (Commit: 5b1d54f.)
- **Inline disable reason annotation** — `ra11y-disable wcag22:1.4.5 -- confirmed logotype` or `: reviewed` suffix; reason captured in `meta.suppressions`. (Commit: d820186.)
- **Glob patterns on `nativeWrappers`** — wrapper names may include glob patterns. (Commit: 560d015.)
- **Object-form `nativeWrappers`** — compound component support with per-member element mapping. (Commits: 4e40f10, e1ca368.)
- **`pruneAttestations` / `rewriteAttestations` config primitives**. (Commit: 45b754a.)
- **`attestations prune` CLI subcommand**. (Commit: 0489ba5.)
- **`baseline prune` CLI subcommand**. (Commit: ebbe753.)

#### Rules

- **`aria/conflicting-role`** (wcag22:4.1.2) — flags elements where an explicit ARIA role contradicts the host element's implicit role. Requires the implicit-roles table added to the engine. (Commits: 6937cf3, bddbd40.)
- **`wrapper/drift`** (wcag22:4.1.2) — flags wrapper components that re-implement interactive behavior already present in the wrapped element, creating two parallel interaction models. (Commit: b645b81.)
- **`forms/required-indicator-missing`** (wcag22:3.3.2) — flags form controls marked required without a visible required indicator. (Commit: 2b48123.)

#### Review finders (new since v0.1.0)

Finders produce grounded manual-review candidates (file + line + reason); they do not emit automated violations. All finders respect the active standard, level, and `processes` config.

- `use-of-color` — wcag22:1.4.1
- `images-of-text` — wcag22:1.4.5, 1.4.9 (1.4.9 candidates annotated separately)
- `media-variants` — wcag22:1.2.1 through 1.2.6
- `timing` — wcag22:2.2.1, 2.2.2, 2.2.3, 2.2.4, 2.2.6; literal duration in reason text
- `pointer-input` — wcag22:2.5.1, 2.5.6
- `motion-actuation` — wcag22:2.5.4
- `identify-purpose` — wcag22:1.3.6
- `section-headings` — wcag22:2.4.10
- `multiple-ways` — wcag22:2.4.5; SPA index-shell route annotation
- `error-suggestion` — wcag22:3.3.3
- `error-prevention` — wcag22:3.3.4
- `redundant-entry` — wcag22:3.3.7
- `error-identification` — wcag22:3.3.1
- `server-error-untied` — wcag22:3.3.1; server-side error messages not tied to form fields
- `captcha` — wcag22:3.3.8, 3.3.9
- `on-input-change` — wcag22:3.2.1, 3.2.2; confidence tiers based on detectable handler body shape
- `headings-and-labels` — wcag22:2.4.6
- `consistent-navigation` — wcag22:3.2.3; cross-file `afterProject` finder
- `consistent-identification` — wcag22:3.2.4; cross-file `afterProject` finder
- `flashing-content` — wcag22:2.3.1
- `suppression/no-reason` — surfaces bare `@ra11y-disable` pragmas without a reason annotation
- `validation-timing` — wcag22:3.3.3, 3.3.4; validation event timing relative to submission
- `sensory-characteristics`, `meaningful-sequence`, `no-keyboard-trap`, `media-alternatives` — additional finders covering remaining WCAG A criteria

**Tailwind focus-ring cross-reference for `focus/outline-visible`**: when a CSS rule suppresses the outline and the same element carries a `focus-visible:ring-*`, `focus-visible:outline-*`, or `focus-visible:shadow-*` Tailwind utility class, the finding resolves to info-level. Deterministic literal class-token prefix match only. (Commit: ddaada4.)

#### Parser

- TSX parser correctly disambiguates TypeScript generic syntax (`<T>`, `<T extends U>`) from JSX open tags. A generic in expression position previously corrupted subsequent parse state. (Commit: 2968d87.)
- `JsxElement` AST node preserves `hasSpreadProps` flag; rules use this to suppress false positives on spread-prop primitives. (Commit: e480644.)
- StoryObj `args` synthesis pass — TSX parser synthesizes JSX elements from `StoryObj` story argument bindings for Storybook story files when the `storybook` preset is active. (Commits: 55ba1f7, 0fa523d.)

#### Reports

- **Conformance statement report** — `src/reports/conformance-statement.ts` gates a WCAG conformance claim by evidence level; emits a signed bundle with SHA-256 digest. (Commits: 6dd297e, 68f5b6d.)
- **Profile-scoped coverage report** — coverage report accepts a `profile` argument and filters criteria accordingly. (Commit: 96275bb.)
- **Per-criterion attestation on checklist items** — checklist items carry their evidence status from the ledger. (Commit: 70a5e4e.)
- **VPAT location injection** — `scan`-level candidate locations injected into VPAT manual remarks. (Commit: e612435.)

#### CLI

- **`--profile` flag** — profile-scoped scans against one of the eight built-in profiles. (Commit: bd73f3d.)
- **`attestations prune` subcommand** — removes stale attestation records. (Commit: 0489ba5.)
- **`baseline prune` subcommand** — removes stale baseline entries. (Commit: ebbe753.)
- Per-command reference section in [`docs/cli.md`](./docs/cli.md). (Commit: 192cf0d.)

#### Scripts and developer tooling

- **`scripts/scaffold-rule.ts`** — generates a complete rule skeleton: source file, unit test, fixture directories, and alphabetically-inserted registry entry. Run: `bun scripts/scaffold-rule.ts <domain>/<slug> --satisfies wcag22:X.Y.Z`. (Commit: f1226ed.)
- **400-LOC reviewable-size cap** in `scripts/check-commit.ts` — staged diffs exceeding 400 net lines (excluding generated KB, fixtures, lockfiles) fail `bun run verify:precommit`. `chore(kb):` prefix is exempt. (Commit: c9016c4.)
- **Scope-filtered precommit mode** — `verify:precommit` filters checks to staged files only. (Commit: a2c5816.)
- **Tests typecheck gated in `verify`** — `tests/` directory is typechecked as part of the full verify sequence. (Commit: 20631f6.)

#### CI

- Windows (`windows-latest`) added to the verify matrix. (Commit: b0b07cc.)
- Self-scan SARIF uploaded to GitHub Security tab on every push. (Commit: 6315a06.)
- Dependency-review soft gate on PRs. (Commit: 914d4f1.)
- Performance baseline locked for v1.0; bench budget enforced in CI. (Commit: 8e8a564.)

#### Real-world fixture corpus

- `tests/integration/real-world-fixtures.test.ts` — harness that discovers every subdirectory under `tests/fixtures/real-world/`, loads its `assertions.ts`, and verifies scanner output against declared invariants. Fixtures survive internal API refactors.
- Sanitized fixtures added since v0.1.0: `tsx-generics`, `spa-shell-vite`, `tailwind-coverage`, `logotype-annotation`, `timing-role-hints`, `template-directives`, `opaque-components-top`, `suppression-reason-slot`, `autodetect-attribution`, `storybook-args-binding`, `dialog-modal`, `data-tables`, `nav-landmarks`, `forms-validation`.

ADR: [`docs/adr/0006-real-world-fixture-harness.md`](./docs/adr/0006-real-world-fixture-harness.md).

#### Prompt evaluations

- `tests/evals/` — scripted-host harness replaying prompt templates against a deterministic host stub and asserting on rendered output. See `tests/evals/README.md`.

#### VS Code extension scaffold

- `integrations/vscode/` — extension skeleton wrapping the ra11y MCP server as a subprocess; registered with the VS Code language server client. No runtime dependency on `@ra11y/core` in the extension host process.

#### Docs and knowledge base

- [`docs/mcp/prompts.md`](./docs/mcp/prompts.md) — prompt library user guide.
- [`docs/errors.md`](./docs/errors.md) — canonical error + exit-code index.
- [`docs/conformance.md`](./docs/conformance.md) — end-to-end conformance guide.
- [`docs/kb/architecture/mcp-sampling.md`](./docs/kb/architecture/mcp-sampling.md) — bidirectional outbound rail and sampling client.
- [`docs/kb/standards/coverage.md`](./docs/kb/standards/coverage.md) — authoritative per-criterion automatability coverage matrix.
- [`docs/kb/patterns/suggest-fix-ranking.md`](./docs/kb/patterns/suggest-fix-ranking.md) — `suggest_fix` ranking and `fixClass` semantics.
- ADR 0006 (real-world fixture harness), ADR 0008 (groupKey), ADR 0010 (coverage vs checklist boundary), ADR 0011 (Evidence primitive), ADR 0012 (wrapper introspection), ADR 0013 (rule-scoped attestations), ADR 0014 (inherited findings), ADR 0016 (process-level scope), ADR 0017 (conformance-statement output), ADR 0018 (v1.0 deferred decisions), ADR 0019 (v1.0 public API stability).

### Changed

- **MCP response shape:** `checklist.summary.automatedCoverage` trimmed to a one-field gloss `{ standardId, automatedCriteriaPassRate }` per ADR 0010. The previous per-standard block (`criteriaAutomatable`, `criteriaAutomatablePassing`) is canonical on `coverage` only. `coverage` and `checklist` cross-point via `nextStep` + `nextStepStructured` pairs.
- **MCP response shape:** `activeNativeWrappers` unified into a tagged list `Array<{ name: string; source: "config" | "autoDetect" | "session"; confirmed?: boolean }>`. The former `sessionNativeWrappers` string list is removed; filter by `source === "session"`. Affects `scan`, `scan_project`, `scan_file`, `scan_diff`, `list_suppressions`, and other tools emitting wrapper meta.
- **MCP response shape:** Canonical untargeted-criteria count renamed to `untargetedCriteria` across all tools. Previous names `untargeted` and `manualUntargetedCount` removed.
- `suggest_fix` response shape changed from `{ suggestion: string }` to `{ fixPaths: { primary: FixPath, alternatives: FixPath[] } }`. The `suggestion` prose field was removed in v0.2.0.
- `checklist`: `reviewNeeded` field replaced by a structured array with `priority` and `wcagPrinciple` per item.
- Pre-commit hook scoped to staged files only; the previous behavior ran on the full working tree.
- `list-structure` rule: bare `<li>` outside a list container is now `info` severity (down from `warning`). The element is still surfaced.
- `scan_process` and process-aware finders thread the `processes` config through the project-scoped finder context.
- `scan_project` response includes `baselineStatus` and opaque-component auto-detect disclosure.
- `scan_project` response includes `plan.limitations` on every response for runtime-only checks the static scanner cannot perform.
- `coverage` now includes per-criterion attestation evidence status when the evidence ledger has entries.
- **MCP `checklist` inverts the default shape of `untargetedCriteriaList`** (`src/mcp/tool-checklist.ts`). Previously the full list was gated behind `showUntargeted: true` while the summary reported only a count. The default now ships `untargetedCriteriaList` as a bare criterion-ID array so the enumeration is cheap. `showUntargeted: true` still opts into the full-item shape (`title` + `level` + `principle` + empty `candidates`) for workflows that need the metadata; `showUntargeted: false` is preserved as a size-pressure escape hatch that omits the list entirely while the summary counter remains visible.
- **MCP `propose_baseline` hoists per-entry rationale prose into a response-level `rationales` map** (`src/mcp/propose-baseline-classify.ts`, `src/mcp/tool-propose-baseline.ts`). Entries previously carried `rationale: string` inline; on a 242-finding scan the same 128-char `unclassified` rationale shipped 242 times, inflating the response past 70 KB on one line. Each entry now carries `rationaleKey: string` — a 12-hex SHA-256 truncation that points into a top-level `rationales: { [rationaleKey]: string }` map. Identical rationales across entries collapse to one key; specific-evidence rationales (`legacy-route` / `design-system-internal` / `third-party-html` / `wrapper-undetected`, which embed matched paths or wrapper names) dedup when two entries happen to produce the same text. Shape mirrors the existing `referenceGuide.fixDescriptions[ruleId][hash]` hoist so agents recognize the short-hex-token format across the MCP surface. Consumers that read `entry.rationale` now read `response.rationales[entry.rationaleKey]`; the mapping is a one-line resolve. Counts and `proposed.length` are unchanged — the hoist is pure prose dedup, no finding is dropped or downgraded.
- **MCP scan `meta.rulesEvaluated` and `meta.perRuleCoverage` now agree by construction**. Previously the counter and the per-rule array could drift — project-scoped rules (`focus/outline-visible`, `wrapper/drift`, whose lifecycle is `afterProject` only) never flowed through the per-file tracker and were silently omitted from `perRuleCoverage`, while `rulesEvaluated` counted them. Every evaluated rule now gets exactly one entry: project-scoped rules surface as `filesEvaluated: filesScanned, coverageConfidence: "high"`; extension-gated rules with zero eligible files keep the existing `filesEvaluated: 0, coverageConfidence: "low"` shape with a `reason` naming the gap. `rulesEvaluated` is now derived from `perRuleCoverage.length` so the two cannot drift again.
- **MCP `plan.summary` violations parenthetical** now breaks down by the rule-level `fixClass` lane (`mechanical` / `guidance` / `runtime-only` / `verify-in-source`) instead of summing `runtime-only` and `verify-in-source` findings under a single "guidance fixes" label. Zero-count lanes are omitted.
- **CLI `--format agent` `plan.summary` violations parenthetical** now matches the MCP path: breaks down by rule-level `fixClass` lane (`mechanical` / `guidance` / `runtime-only` / `verify-in-source`) instead of the former composite `"N mechanical edits, M guidance fixes"` label. The old label counted violations by `fixPaths.edit` / `suggestion` presence (a data-path fix-availability axis) rather than the rule-demanded fix nature. Zero-count lanes are omitted; lane order is stable: `mechanical → guidance → runtime-only → verify-in-source`. The shared helper (`buildFixClassBreakdown`) is extracted to `src/output/agent-response/fix-class-breakdown.ts` — one source of truth for both surfaces.
- **MCP `scan_project` default `limit` lowered from 200 to 25** ([ADR 0021](./docs/adr/0021-scan-response-size-budget.md)). The previous default shipped responses up to ~1.2 MB on medium repos and tripped typical MCP host token ceilings on the first call even at `limit: 50`. Bytes-per-file is stable within a given repo profile (~2.9 KB/file amortized on a Bootstrap-class scan), so a tighter file-count cap is the cheapest honest fix; the token-aware-budget alternative was considered and deferred. Pagination semantics (`truncated`, `nextOffset`, `totalFilesWithFindings`) are unchanged — callers that want the old window set `limit: 200` explicitly; the 2000-file maximum is also unchanged.
- **MCP scan responses gain a token-density secondary budget** ([ADR 0021 amendment](./docs/adr/0021-scan-response-size-budget.md#amendment-2026-04-20-token-density-secondary-budget)). After the `fix.description` hoist runs, `scan` / `scan_project` / `scan_diff` measure the serialized response; if density pushes it past the 88000-char default (≈ 22000 tokens via a 4-chars-per-token proxy, leaving headroom under the ~25k-token MCP host ceiling), trailing file entries drop until the body fits. Truncated responses flip `truncated: true`, surface `nextOffset = offset + keptFileCount` (where paging applies), and emit a new `response_token_budget_truncated` warning code so callers can distinguish density truncation from the existing file-count cap. Progress guarantee: at least one file entry is always kept so the caller has resumable state. `scan_file` is unaffected (single-file shape; no trailing file entries to drop).

### Deprecated

- **MCP `bootstrap` response now emits `suggestedConfig` as canonical; `proposedConfig` remains for one release as a transition alias** (identical value; both emitted together when a suggestion is available, both omitted when the `propose_config` leg degrades). Matches `propose_config.suggestedConfig` and `detect_native_wrappers.suggestedConfigSnippet` — cross-surface drift resolved. The `proposedConfig` alias will be removed in the next minor release. A new structured `warnings: ["proposed_config_deprecated_use_suggested_config"]` code now fires whenever the alias is emitted so agents reading the warnings channel can drop their `proposedConfig` reads on the next call without paying the double-payload cost.
- **Rule `navigation/href-placeholder` split into `navigation/href-javascript-scheme` and `navigation/href-empty-fragment`** (`src/rules/navigation/href-javascript-scheme.ts`, `src/rules/navigation/href-empty-fragment.ts`). The umbrella `href-placeholder` rule (itself the hop from `href-javascript-void`) covered three distinct placeholder shapes — `javascript:` schemes, bare `href="#"`, and empty `href=""` — under one ID. A pragma or config entry suppressing the umbrella ID silenced ALL three shapes; an agent triaging by ID could not distinguish "we know this jQuery toggle uses `javascript:void`" from "we know this Forgot-password? link is intentionally a placeholder we'll wire up later." The split moves each shape to its own rule ID with its own message and suggestion, so suppression and triage are granular per-shape. Both legacy IDs (`navigation/href-javascript-void` and `navigation/href-placeholder`) keep resolving through the rule-ID alias table (`src/engine/rule-aliases.ts`) — both point at `navigation/href-javascript-scheme` because the original `href-javascript-void` literal name unambiguously names that shape and pointing the umbrella legacy ID at the empty-fragment heir would silently flip suppression intent for the most common legacy callers. Every alias resolution emits the structured `deprecated_rule_id:<from>:navigation/href-javascript-scheme` warning so agents can offer to rewrite. Deprecated since 0.2.0; aliases dropped in 0.3.0. Ships as minor, not breaking, per CLAUDE.md §12.
- **Rule `navigation/href-javascript-void` renamed to `navigation/href-placeholder`** (`src/rules/navigation/href-placeholder.ts`). The old name promised detection of `href="javascript:void(0)"` only, but the check always also fired on bare `href="#"`, whitespace-only, and `href=""` — every shape of placeholder href. The new name matches the actual surface. The old ID keeps resolving through the rule-ID alias table (`src/engine/rule-aliases.ts`) in suppression pragmas, `ra11y.config.ts` `rules` keys, CLI `--rules` flags, and MCP lookups — every resolution emits the structured `deprecated_rule_id:navigation/href-javascript-void:navigation/href-placeholder` warning so agents can offer to rewrite. `list_rules` surfaces the old ID with `deprecated: true` + `replacedBy: "navigation/href-placeholder"`. Deprecated since 0.2.0; alias dropped in 0.3.0 — once the alias is removed the old ID stops being accepted, which is when the rename becomes a hard break. Ships as minor, not breaking, per CLAUDE.md §12.

### Removed

- **`configure` MCP tool alias** — the v0.2.0 `configure` name is removed; use `sessionConfigure`.
- **`filePath` parameter alias on `suggest_fix` and `apply_fix`** — the v0.2.0 alias is removed; use `file`.

### Fixed

- `scan_project`: manual-review count was inconsistent between `scan`, `checklist`, and `coverage` when the active level filter excluded some finders. All three surfaces now use the same filtered count. (Commit: df26f17.)
- `scan_project`: empty `snippet` field was emitted alongside a populated `sourceContext` on some `suggest_fix` paths. The field is now conditionally spread and omitted when empty. (Commit: 406a28f.)
- `scan_file`: `reviewCandidates` was not populated. (Commit: 9d8a274.)
- `audit`: sub-handler rejections now caught via `allSettled`; a failing sub-leg surfaces as a warning code without sinking the response. (Commit: 048dfcc.)
- `checklist`: empty-candidate items (criteria with no grounded candidates) were mixed into the primary list; they are now separated and only included when explicitly requested.
- Engine: conformance level filter was not applied to finders, allowing AA-only finders to fire during A-only scans. (Commit: 347e59e.)
- Engine: `.js` and `.ts` files were excluded from the JSX rule filter even when they contained JSX syntax. (Commit: 2558bea.)
- Engine: inline `ra11y-disable` was not applied to review candidates, only to automated violations. (Commit: 1beda8a.)
- Review: `3.2.1`/`3.2.2` finders emitted candidates for all focus/input handlers regardless of detectable context-change signals; they now gate on those signals. (Commit: 9cac116.)
- Review: `use-of-color` finder treated `aria-hidden` colored elements as active color signals; they are now excluded. (Commit: 54d9552.)
- Review: `1.3.3` finder matched polysemous words ("view", "press") in noun phrases without directional instruction. Instructional context is now required. (Commit: 983d3f2.)
- Review: page-set finders (`multiple-ways`, `skip-link`) emitted duplicate candidates across root layouts in Next.js / Remix app directories; deduplication applied after `afterProject`. (Commit: e59af58.)
- Review: timing finder emitted filename-based role hints in user-facing reason text; removed. (Commit: adb3976.)
- Rules: `nested-interactive` flagged the native `<details>`/`<summary>` nesting pattern, which is spec-correct; both elements are now allowlisted. (Commits: 0e7a2ce, 99e2616.)
- Rules: `button-name`, `fieldset-legend`, `labels-required`, `non-empty-label`, `empty-heading` emitted false positives when the element carried a JSX spread (`{...props}`); `hasSpreadProps` detection suppresses the finding with an info-level note. (Commits: 864a590, c864710.)
- Parser: TSX generic disambiguation — a bare `<T>` in expression position was parsed as a JSX open tag, corrupting parse state. (Commit: 2968d87.)
- MCP wrapper detection: usage scan for `autoDetectWrappers` was not reaching default-excluded paths; wrappers used only in test or stories directories were missed. Detection now widens to include those paths. (Commit: 18ec904.)
- MCP `as-unknown-as` casts in the dispatcher replaced with guards, eliminating a category of unsafe casts. (Commit: 1ac89a1.)
- Errors: actionable messages on sampling/attestation/fix-internal error paths; previously returned generic "internal error" prose. (Commit: 7979ef8.)
- Input: root `.gitignore` was not honored on subpath scans. (Commit: 389ba58.)
- MCP `changedOnly`: previously returned a silent full-scan when nothing was staged; now returns an explicit warning. (Commit: 7824f81.)
- Standards: hardcoded criterion count in WCAG 2.2 source comment removed to prevent rot. (Commit: 456158d.)
- **MCP `scan_file` now classifies build artifacts and emits the same scan-time warnings as `scan_project`** (`src/mcp/tool-scan-file.ts`). Previously `scan_file` on a `.min.css` (or any other minified / build-artifact-shaped input) returned findings without surfacing `meta.scannedBuildArtifacts`, `scanned_build_artifacts_present`, or `scanned_minified_file` — while `scan_project` on the identical file flagged it as a build artifact and emitted both warning codes. The handler now overlays the canonical [`buildScanTimeWarnings`](./src/mcp/scan-time-warnings.ts) helper output on top of the assembler-internal warning channel — same helper `coverage` and `checklist` already route through — so the warning code set and `meta.scannedBuildArtifacts` payload agree across every project-rooted scan tool on identical input. Discovery-only codes (`text_source_skipped`, `binary_assets_skipped`, `sourcemap_files_excluded`) intentionally stay omitted on `scan_file`: their predicate reads off `analysisCoverage.skippedByExtension`, which a single-file scan never populates.
- **MCP `coverage` splits the `failingAutomatedCriteria` lump by emission severity** (`src/mcp/tool-coverage.ts`). The field historically listed every criterion with at least one non-info emission against it, conflating an `error`-severity blocker with a `warning`-severity nudge under one label whose name reads as test-runner fail/pass. The single `failingAutomatedCriteria` field now ships only criteria with ≥1 `error`-severity emission; criteria whose emissions were all `warning`-severity ride alongside under the new `warningAutomatedCriteria` field. The two arrays partition the legacy lump (no overlap, no orphans) so a caller summing `failingAutomatedCriteria.length + warningAutomatedCriteria.length` recovers the old count exactly. The internal `PerStandardCoverage.failingCriteria` shape is unchanged — `certification.ts` and the CLI `coverage` command consume it as a union-of-blockers count by design (a warning-severity finding still surfaces as a blocking item there).
- **MCP `checklist.summary.automatedCoverage` drops the composite `automatedCriteriaPassRate` for two non-overlapping counters** (`src/mcp/tool-checklist.ts`). The lone scalar bundled "rule fired clean" (`clean`) with "rule never had eligible inputs" (`untestable`) with "rule found violations" (`withFindings`) into one ratio. An agent budgeting against `automatedCriteriaPassRate: 45` couldn't tell which sub-bucket sank the number; on a Tailwind-pre-build / vendor-bundle scan the rate read as failure when the truth was "most rules never had anything to look at." The field is replaced with two non-overlapping counters: `criteriaWithRulesAllClean` (rules ran on eligible input and emitted zero findings — maps to coverage's `clean`) and `criteriaWithoutEligibleInputs` (rules declared extension eligibility but the scan saw no applicable input — maps to coverage's `untestable`). The full per-standard block (`criteriaTotal`, `criteriaAutomatable`, `criteriaEvaluated`, `automatedCriteriaPassRate`) stays canonical on the `coverage` tool. Regression-guard pattern `automated-coverage-pass-rate-composite` added to `scripts/check-response-assembly.ts` so any future re-introduction of `automatedCriteriaPassRate` inside an `automatedCoverage:` literal flowing through `textResult` / `errorResult` fails CI.
- **MCP `checklist` drops the degenerate `summary.byPriority` counter and narrates `maxCandidatesPerCriterion` clamps** (`src/mcp/tool-checklist.ts`). `summary.byPriority: { high, medium, low }` shipped `{ high: N, medium: 0, low: 0 }` on every corpus — `priorityFor()` returned `"high"` for every A/AA criterion, so the field was a composite that could not disagree. The per-item `confidence` axis already carries the honest signal (highest-candidate confidence, or `"low"` for bare-criterion items); the dropped summary counter was pure noise. Separately, caller-supplied `maxCandidatesPerCriterion` values outside `[1, 100]` were silently clamped with no response signal — an agent asking for `500` got `100` back indistinguishable from one that asked for `100`. The handler now emits `warnings: ["max_candidates_per_criterion_clamped"]` + paired `warningsDetails.max_candidates_per_criterion_clamped: { requested, applied }` whenever the clamp fires.
- **MCP `sessionConfigure` rejects non-boolean `allowWrite` instead of silently dropping it** (`src/mcp/tools-helpers.ts` `buildConfigureOpts`, `src/mcp/tools.ts`). Previously a caller that sent `allowWrite: "true"` (string) or `allowWrite: 1` (number) slipped past the handler's `typeof … === "boolean"` guard; the field was silently discarded, the session's write gate stayed at its prior value, and the response echoed `active.allowWrite: false` — indistinguishable from "I never asked to flip the gate" on the response side. `buildConfigureOpts` now returns a discriminated `{ ok, opts } | { ok: false, error }` result; the handler surfaces a structured `invalid-param` error with `details.param: "allowWrite"` and remediation prose when the field is present with a non-boolean JSON type. Boolean-typed calls (with or without `cwd`) persist cleanly; omitting the field leaves the existing session setting untouched; `active.allowWrite` in the success response always matches the session's post-call state.
- **TSX parser rejects two false JSX contexts that silently dropped downstream rule coverage** (`src/input/parsers/tsx.ts`). (a) JSX attribute expressions whose body contained a template-literal — or string-literal, or comment — with an embedded `}` used to close the expression early via a naive depth-only `#skipBraceBlock`; the parser then re-entered JSX-child mode mid-template-content, found orphan HTML-shaped tags, and emitted `Unclosed JSX element <Example>`. `#skipBraceBlock` now skips over those spans exactly like the top-level scanner, so their inner `{`/`}` never contribute to depth. (b) Bare `.js`/`.ts`/`.mjs`/`.cjs`/`.mts`/`.cts` files previously promoted any `<Identifier` token to a JSX element opener, so a minified IIFE with `r.length<b.length` comparison operators emitted `Unclosed JSX element <b.length>` and dropped the whole file to partial-parse. JSX-mode entry is now gated on file extension: `.jsx`/`.tsx`/`.mdx`/`.astro` stay on; bare JS/TS stays on only when the source carries a leading JSX-import signal (`from "react"` / `require("react")` / `@jsx` pragma in the first 4 KB). Callers that omit `filePath` keep the prior default (JSX on) so existing tests, rule helpers, and MCP handlers that parse source strings without path context are unchanged.
- **MCP `bootstrap` `ciSnippet` now gates on actual baseline-existence** (`src/mcp/tool-bootstrap.ts` `buildCiSnippet`). Previously the snippet emitted `npx @ra11y/core --baseline check` verbatim on every call — including dry-run responses where `baseline: null` was returned and `.ra11y-baseline.json` did not exist on disk. A caller pasting the snippet into CI before committing the baseline file hit a first-run failure because `baseline check` has nothing to check against. The snippet now branches on disk state plus the `writeBaseline` param: (1) baseline already on disk — emit the plain `--baseline check` incantation; (2) baseline absent but this call wrote it — add a comment reminding the caller to commit `.ra11y-baseline.json` before pushing; (3) pure dry-run (no baseline, `writeBaseline: false`) — prepend a `npx @ra11y/core --baseline create` step and a `# create ... first` comment so the copy-paste-into-CI path is honest about first-run ordering.

### Deferred (not in v1.0)

These four items were evaluated for v1.0 and explicitly deferred. They are listed here so readers know what is NOT changing at this release. See [ADR 0018](./docs/adr/0018-v1-deferred-decisions.md) for the revisit signals that would revive each.

- **Rule-catalog renames** — the overlap between `parsing/` and `document/` families, and between `semantics/label-in-name` and `forms/labels-required`, is acknowledged but not resolved. No rule IDs change at v1.0.
- **Coverage + checklist merge** — ADR 0010 boundary is preserved. `coverage` and `checklist` remain separate tools.
- **`@ra11y/parser-typescript` subpackage** — TSX parsing stays in `@ra11y/core`; the optional `typescript` peer is unchanged.
- **Sampling-backed speculative tools** (`resolve-component`, `verdict-candidate`, `draft-vpat-narrative`) — blocked on first-user sampling-host evidence.

## [0.1.0] — 2026-04-13

This is the first public release of ra11y: a zero-dependency, multi-standard accessibility scanner for JSX/TSX, HTML, and CSS. It covers WCAG 2.2 A+AA and WCAG 2.1 A+AA with 49 automated rules, ships four conformance standards, and publishes with npm provenance.

### Added

#### Architecture
- Three-layer architecture: standards → criteria → rules, glued by a reciprocal `equivalentTo` closure so one rule can cite every conformance framework simultaneously.
- Engine: scanner, rule-runner, context-builder, AST helpers, standard-filter, and three registries (standards, criteria, rules). ~500 lines end-to-end.
- Zero-runtime-dependency invariant enforced by `scripts/check-zero-deps.ts` — `dependencies: {}` in `package.json`.
- Network-isolation invariant enforced by `scripts/check-network-isolation.ts` — `src/` cannot reference `fetch`, `node:http`, `node:https`, `node:net`, or `node:dns`.
- File/function/nesting-depth guard enforced by `scripts/check-limits.ts` (500/120/5).
- Import-cycle guard enforced by `scripts/check-cycles.ts` (Tarjan SCC).
- Build pipeline via `scripts/build.ts` (Bun.build for ESM JS + tsc for .d.ts).
- Benchmark suite enforcing CLAUDE.md §13 budgets. Current headroom: 1000 files in ~170ms (budget: 3000ms), cold start ~33ms (budget: 200ms).

#### Standards (4 built-in)
- **WCAG 2.2** — all 87 success criteria with automatability classification.
- **WCAG 2.1** — 78 criteria with `equivalentTo` links back to WCAG 2.2.
- **Section 508 (2017 refresh)** — 38 criteria equivalent to WCAG 2.0 A+AA.
- **EN 301 549 v3.2.1** — 50 criteria equivalent to WCAG 2.1 A+AA.

#### Rules (49 built-in)

**ARIA**
- `aria/hidden-focus` (wcag22:4.1.2) — flags `aria-hidden` on focusable elements
- `aria/invalid-role` (wcag22:4.1.2) — flags roles outside the WAI-ARIA 1.2 dictionary, suggests the nearest valid role via edit-distance
- `aria/live-region-valid` (wcag22:4.1.3) — flags invalid `aria-live` values and conflicting politeness attributes
- `aria/required-attrs` (wcag22:4.1.2) — flags ARIA roles missing required state attributes
- `aria/valid-attr` (wcag22:4.1.2) — flags `aria-*` attributes not in the WAI-ARIA 1.2 dictionary

**Contrast**
- `contrast/enhanced` (wcag22:1.4.6) — WCAG AAA enhanced contrast check
- `contrast/minimum` (wcag22:1.4.3) — WCAG AA contrast ratio check with large-text heuristic
- `contrast/non-text` (wcag22:1.4.11) — non-text contrast check for UI components and graphical objects

**Document**
- `document/iframe-title` (wcag22:4.1.2, 2.4.1) — flags iframes without a title or aria-label
- `document/lang-attribute` (wcag22:3.1.1) — flags HTML root without a lang attribute
- `document/lang-on-parts` (wcag22:3.1.2) — flags content in a different language without a lang override
- `document/meta-refresh` (wcag22:2.2.1, 2.2.4, 3.2.5) — flags `<meta http-equiv=refresh>` auto-redirects
- `document/page-titled` (wcag22:2.4.2) — flags documents without a meaningful `<title>`
- `document/viewport-zoom` (wcag22:1.4.4, 1.4.10) — flags `<meta viewport>` that disables pinch-to-zoom

**Focus**
- `focus/not-obscured` (wcag22:2.4.11) — flags focused components fully hidden by sticky headers or overlays
- `focus/outline-visible` (wcag22:2.4.7, 2.4.11) — flags elements where focus outline is suppressed without a replacement
- `focus/tabindex-positive` (wcag22:2.4.3) — flags positive tabindex values

**Forms**
- `forms/autocomplete-missing` (wcag22:1.3.5) — flags personal-info inputs without an autocomplete token
- `forms/fieldset-legend` (wcag22:1.3.1, 3.3.2) — flags fieldset without a legend
- `forms/label-for-id-mismatch` (wcag22:1.3.1) — flags `label[for=X]` where no element has `id=X`
- `forms/labels-required` (wcag22:1.3.1, 3.3.2, 4.1.2) — flags form controls without an accessible label
- `forms/non-empty-label` (wcag22:1.3.1, 3.3.2) — flags label elements with no visible text content

**Keyboard**
- `keyboard/accesskey-duplicate` (wcag22:2.1.1) — flags multiple elements sharing an accesskey value
- `keyboard/character-shortcuts` (wcag22:2.1.4) — flags single-character keyboard shortcuts without a remapping mechanism
- `keyboard/handler-missing` (wcag22:2.1.1) — flags clickable elements without a keyboard handler

**Layout**
- `layout/orientation-lock` (wcag22:1.3.4) — flags CSS that locks display to a single orientation
- `layout/reflow-hardcoded-width` (wcag22:1.4.10) — flags hardcoded pixel widths that break reflow at 320px
- `layout/text-spacing` (wcag22:1.4.12) — flags CSS declarations that would override text-spacing overrides

**Media**
- `media/alt-text-missing` (wcag22:1.1.1) — flags images without a text alternative
- `media/autoplay-sound` (wcag22:1.4.2) — flags audio/video autoplay without muted or controls
- `media/video-captions-missing` (wcag22:1.2.2) — flags `<video>` without a `<track kind="captions">`

**Motion**
- `motion/pause-stop-hide` (wcag22:2.2.2) — flags animated content without a mechanism to pause, stop, or hide

**Navigation**
- `navigation/link-descriptive-text` (wcag22:2.4.4) — flags link text like "click here" or "read more"
- `navigation/link-no-href` (wcag22:2.1.1, 4.1.2) — flags `<a onClick>` without an href
- `navigation/skip-link` (wcag22:2.4.1) — flags pages without a skip-navigation link

**Parsing**
- `parsing/duplicate-id` (wcag22:4.1.1) — flags duplicate `id` attributes in a document
- `parsing/html-has-lang` (wcag22:3.1.2) — flags syntactically invalid BCP 47 lang values

**Pointer**
- `pointer/cancellation` (wcag22:2.5.3) — flags pointer event handlers that fire on down-event without an up-event abort path
- `pointer/drag-alternative` (wcag22:2.5.7) — flags drag-only interactions without a single-pointer alternative
- `pointer/target-size` (wcag22:2.5.8) — flags interactive targets below the minimum 24×24px target size

**Semantics**
- `semantics/button-name` (wcag22:4.1.2) — flags buttons without an accessible name
- `semantics/empty-heading` (wcag22:1.3.1, 2.4.6) — flags heading elements with no text content
- `semantics/heading-hierarchy` (wcag22:1.3.1) — flags skipped heading levels and missing `<h1>`
- `semantics/label-in-name` (wcag22:2.5.3) — flags components where the accessible name does not contain the visible label text
- `semantics/landmark-main` (wcag22:1.3.6, 2.4.1) — flags pages without a `<main>` landmark
- `semantics/list-structure` (wcag22:1.3.1) — flags `<li>` outside a list container and lists with non-`<li>` children
- `semantics/nested-interactive` (wcag22:4.1.2) — flags interactive elements nested inside other interactive elements
- `semantics/table-headers` (wcag22:1.3.1) — flags data tables without `<th>` header cells

**Tooltip**
- `tooltip/dismissable` (wcag22:1.4.13) — flags tooltips that cannot be dismissed without moving focus or pointer

#### Parsers (zero-dep, in-house)
- TSX/JSX parser — character-driven, preserves PascalCase components, recognizes HTML5 void elements; fuzz-tested.
- HTML parser — HTML5-quirks-aware, explicit progress guarantees to prevent hangs on malformed input; fuzz-tested.
- CSS parser — rules, at-rules, nested `@media`/`@supports`/`@keyframes`, `!important`, comments, function calls.
- Tailwind class extractor — extracts utility class strings and resolves Tailwind tokens to CSS declarations for contrast checking.

#### Output formatters (7)
- `terminal` — colored output, snippet rendering, coverage scorecard.
- `plain` — color-free terminal output for piping.
- `json` — machine-readable ScanResult + ReportData.
- `sarif` — SARIF 2.1.0 for GitHub code scanning integration.
- `junit` — JUnit XML for CI test-result UIs.
- `markdown` — PR-comment-friendly markdown report.
- `agent` — compact format optimized for AI coding agent consumption.

#### MCP server
- In-house Model Context Protocol server for AI agent integration (`ra11y mcp`).
- Tools: `scan_file`, `scan_project`, `get_checklist` — each returning structured violation data, coverage ratios, and next-step hints.
- Git-aware scanning, per-rule severity overrides, `nativeWrappers` allowlist, `.gitignore` respect.

#### CLI
- `scan` command with `--standard`, `--level`, `--exclude`, `--fail-on`, `--format`, `--no-color`, `--verbose`, `--quiet`, `--debug`.
- `--changed` — scan only git-staged files (precommit-friendly).
- `--since <ref>` — scan only files changed since a git ref.
- `--baseline=create|check|update` — baseline mode with sha1 fingerprinting (line-number-independent).
- `--baseline-file=<path>` — override the default `.ra11y-baseline.json` path.
- `--list-rules`, `--list-standards`, `--explain <ruleId>` — introspection commands.
- `--coverage`, `--checklist`, `--vpat`, `--certification` — structured report commands.
- `init` and `doctor` commands for project setup and diagnostics.
- Exit codes: 0 clean, 1 violations, 2 errors, 3 new baseline violations.

#### Configuration
- `ra11y.config.ts`, `.js`, `.mjs`, `.json` — config loader walks up from cwd, stops at `.git`.
- `--config <path>` / `RA11Y_CONFIG` environment variable to override auto-discovery.
- Per-rule severity overrides (`"error" | "warning" | "info" | "off"`).
- Per-directory `overrides` array with last-match-wins precedence.
- `nativeWrappers` allowlist to suppress `keyboard/handler-missing` on custom components.
- Inline disable pragmas: `ra11y-disable-next-line`, `ra11y-disable`/`ra11y-enable`.
- Supported comment styles: `//`, `/* */`, `<!-- -->`, `{/* */}`.

#### Plugin API
- `defineRule()`, `defineStandard()`, `defineFormatter()`, `defineConfig()` — typed identity helpers exported from `@ra11y/core/plugin`.
- Plugin rule example: [`examples/plugin-rule/`](./examples/plugin-rule/).
- Plugin standard example: [`examples/plugin-standard/`](./examples/plugin-standard/).

#### Developer experience
- Precommit git hook: `.githooks/pre-commit` + `.githooks/commit-msg` (installed via `bun run setup`).
- Conventional-commit enforcement via `scripts/check-commit.ts`.
- Claude Code autonomous infrastructure: hooks, 15 subagents, 12 skills, persistent backlog.
- In-house utilities: ANSI coloring, contrast math, args parser, logger, gitignore-style glob matcher, string width.

#### Documentation
- [`docs/getting-started.md`](./docs/getting-started.md) — install, first scan, interpreting output, fixing a violation.
- [`docs/cli.md`](./docs/cli.md) — full flag reference and exit-code table.
- [`docs/configuration.md`](./docs/configuration.md) — config file spec, rule settings, per-directory overrides, precedence.
- [`docs/architecture.md`](./docs/architecture.md) — three-layer model, equivalence closure, rule execution lifecycle, plugin boundaries.
- 5 ADRs covering zero-dep invariant, three-layer model, TypeScript peer, Bun test runner, and in-house MCP server.
- `docs/kb/` agent-retrieval knowledge base: rules, standards, architecture concepts, gotchas, patterns.
