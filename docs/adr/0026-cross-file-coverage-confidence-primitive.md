# ADR 0026 — Cross-file coverage confidence primitive

- Status: Accepted
- Date: 2026-04-23
- Supersedes: none
- Superseded by: none
- Related: `src/types/rule.ts`, `src/types/violation.ts`, `src/engine/per-rule-coverage.ts`, `src/mcp/rule-coverage-derivative.ts`, `docs/kb/architecture/ai-first-consumer.md`

## Context

`PerRuleCoverage.coverageConfidence` is scan-confidence telemetry. Today it is the string-literal union `"high" | "low"` and carries two concrete signals:

- `"low"` — the rule either had no eligible files (canonical Tailwind-pre-build shape: `contrast/minimum` targets `.css`, scan has zero `.css` inputs) or ran against fewer than `MIN_FILES_FOR_HIGH_CONFIDENCE` files. Paired with a `reason` + `remediation` string.
- `"high"` — the rule ran on at least one eligible file.

Field-test finding Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-FILE-BLINDSPOT surfaced a third case that neither value names honestly. `keyboard/handler-missing` reports `coverageConfidence: "high"` on single-HTML-file scans even though the rule's target spec — "element has a click handler with no paired keyboard handler" — can require cross-file evidence to evaluate (the click handler may be attached from an external `.js` file via `addEventListener`). The evaluation was bounded by the substrate this call looked at; the rule cannot see the sibling file where the listener is wired. Reporting `"high"` on a clean tally here is the same silent-miss shape as reporting `"high"` on a rule that never found its target extension.

Adding a new confidence level requires a typed vocabulary that can express:

1. **Which rules are architecturally capable of cross-file evidence.** A rule whose evaluation inherently sees only one file (today: every `check` / `afterFile` rule) is not "bounded"; it is operating at its spec'd scope. A rule whose target spec *could* be evaluated with cross-file evidence but whose implementation is single-file today IS bounded when invoked on a single-file substrate. The primitive the rule authors reach for should state this cleanly.
2. **A third confidence level between "ran with eligible inputs" and "ran with zero eligible inputs."** The canonical reading of today's `"low"` is "rule had nothing to look at." The new case is "rule had eligible inputs and ran but its evidence horizon is narrower than the spec demands on this call." Collapsing the two into `"low"` loses the signal: an agent reading `lowConfidenceClean` assumes "no matching files found," not "ran-but-might-have-missed-cross-file-wiring." Per the AI-first doctrine entry "Ambiguous field shapes are dishonest," the union must name both cases distinctly.

Two shapes were on the table.

**(1) Discriminated object union.** `coverageConfidence: { kind: "high" } | { kind: "medium"; reason: string } | { kind: "low"; reason: string; remediation: string }`. Would fold `reason` / `remediation` into the discriminant and make exhaustiveness-checkable at the type level. But: existing `reason` / `remediation` are already conditional-spread at the response-assembly site, so the honesty-by-construction gain is marginal; every downstream consumer (including the MCP `rulesEvaluated` helper, the rule-coverage derivative, every test literal constructing a `PerRuleCoverage`, every response-assembler snapshot) would need `row.coverageConfidence.kind` rewrites. The scope of the cascade would exceed the ~20-file ceiling for a single type-change ADR.

**(2) Widened string-literal union + additive rule-level flag.** `coverageConfidence: "high" | "medium" | "low"` plus `Rule.crossFileCapable?: boolean`. Strictly additive at the type level: existing producers continue to emit `"high"` / `"low"`; the `"medium"` value is reserved for the follow-up (Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-FILE-BLINDSPOT) that wires the downgrade for rules declaring `crossFileCapable: false` when invoked on a single-file substrate. The only call site that branches on the value — `buildRuleCoverageDerivative` — routes `"medium"` into the existing `lowConfidenceClean` bucket until the follow-up decides whether to add a dedicated `mediumConfidenceClean` bucket on the derivative.

## Decision

Widen `PerRuleCoverage.coverageConfidence` from `"high" | "low"` to `"high" | "medium" | "low"`. Add the optional `Rule.crossFileCapable?: boolean` property.

- `crossFileCapable: true` — the rule can resolve evidence across files (e.g. a project-scoped rule that walks every file's AST). Present-when-meaningful: rules that operate on a single file per invocation omit the field.
- `crossFileCapable: false` — the rule's *spec* encompasses cross-file evidence but its *implementation* is bounded to the current file. These rules should downgrade to `"medium"` when invoked on a substrate that likely truncates their evidence horizon.
- Absent — the rule's spec is single-file; no downgrade applies.

The `"medium"` value is introduced but not yet emitted by any producer. The downstream audit item (Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-FILE-BLINDSPOT) will:

1. Tag the five candidate rules (`keyboard/handler-missing`, `aria/labelledby-target-exists`, `navigation/skip-link-target-valid`, `forms/error-message-not-associated`, `pointer/drag-alternative`) with `crossFileCapable: false`.
2. Add a downgrade branch in `buildExtensionGatedEntry` / `buildProjectScopedEntry` (or a post-processing step) that emits `"medium"` with a structured `reason: "cross_file_listener_resolution_limited_on_this_input"` when a `crossFileCapable: false` rule ran on a substrate below the cross-file evidence threshold.
3. Decide whether `buildRuleCoverageDerivative` grows a `mediumConfidenceClean` sibling bucket.

The primitive ADR (this one) only establishes the typed vocabulary. No finding-emission logic changes here — producers continue to emit `"high"` / `"low"` and the response shape stays backward-compatible.

### Consumer updates

- `src/mcp/rule-coverage-derivative.ts` — explicit branch on `"high"` vs other; `"medium"` and `"low"` both route to `lowConfidenceClean` until the follow-up. Documented in TSDoc so the transient conflation is visible.
- Fixture literals in tests continue to use `"high"` / `"low"` — the widened union is a superset, so no test-literal rewrites are required.

## Consequences

Positive:
- Agents reading `perRuleCoverage[*].coverageConfidence === "medium"` (once producers emit it in the follow-up) get an honest read on "the rule ran but its evidence was bounded" without collapsing into the zero-eligible-files `"low"` case.
- `Rule.crossFileCapable` is a declarative point the rule author owns; the downgrade logic keys off metadata the rule knows about itself, not a runtime heuristic in the scanner.
- Strictly additive at the type level: no existing producer or test literal needs changes.

Negative:
- Transient conflation: until the follow-up, `"medium"` and `"low"` both route into `lowConfidenceClean` on the MCP response derivative. The TSDoc names this as intentional so the follow-up's scope is clear.
- The new union member is reserved until the follow-up emits it — a producer that forgets to honor `crossFileCapable: false` continues to report `"high"` dishonestly. The follow-up's test coverage closes this gap.

## Alternatives considered

- **Discriminated object union on `coverageConfidence`** — rejected above on call-site cascade cost.
- **Encode the signal in `reason` text only** — rejected. The agent's primary triage surface is the top-level `ruleCoverage` derivative on scan responses (`confidentlyClean` / `lowConfidenceClean` lists). A signal that only appears in per-row `reason` strings is invisible at the derivative layer, and the derivative's split is load-bearing for "trust the clean tally?" budgeting.
- **A boolean `coverageBounded` sibling field** — rejected. Two fields (`coverageConfidence` + `coverageBounded`) that both describe "how much to trust the clean tally" disagree silently when they drift; the three-valued enum names the continuum in one place.

## Migration

- `src/types/violation.ts`: widen the union. TSDoc updated to describe all three values and the semantics of `"medium"`.
- `src/types/rule.ts`: add `crossFileCapable?: boolean` with doc naming the downstream downgrade mechanism.
- `src/mcp/rule-coverage-derivative.ts`: update the branch to `=== "high"` / else, documented with the transient-conflation note.
- Follow-up (Q5-COVERAGE-CONFIDENCE-HONESTY-CROSS-FILE-BLINDSPOT): tag the five audit-list rules + wire the downgrade.
