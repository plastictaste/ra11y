# ADR 0024 — scan-family MCP response assembler

- Status: Proposed
- Date: 2026-04-20
- Supersedes: none
- Superseded by: none
- Related: ADR 0019 (v1.0 public API stability), ADR 0021 (scan response size budget), ADR 0022 (registry aggregate), ADR 0023 (warning structured details), `src/mcp/scan-assembly.ts`, `src/mcp/tools-helpers.ts`, `src/mcp/tools.ts`, `src/output/agent-response/build-finding.ts`, `docs/kb/architecture/ai-first-consumer.md`, `.claude/rules/mcp-response-shapes.md`

## Context

The AI-first consumer model in `docs/kb/architecture/ai-first-consumer.md` (CLAUDE.md §1 doctrine) encodes invariants that every scan-family MCP response must honor: conditional-spread on zero counts so optional fields are present-when-meaningful, structured `warnings[]` on zero-output success so "tool never ran" never reads as "clean scan," honest-counter splits (`actionableManualItems` + `untargetedCriteria`, `fixesByClass` rather than a summed `guidanceFixesAvailable`), verbose `meta` kept intact as scan-confidence telemetry, and cross-tool drift prevention (the `scan says 21, checklist says 4` failure mode). The path-scoped rule `.claude/rules/mcp-response-shapes.md` loads the doctrine automatically when editing MCP handlers, but the enforcement is reviewer-side — there is no single code path that guarantees the rules hold.

Measurement on 2026-04-20:

| surface                                                                  | count              | notes                                                                                      |
|--------------------------------------------------------------------------|-------------------:|--------------------------------------------------------------------------------------------|
| `src/mcp/tool-*.ts` files                                                | **24**             | aggregate 8,485 LOC; top five: `tool-checklist.ts` 771, `tool-scan-project.ts` 728, `tool-scan-diff.ts` 618, `tool-bootstrap.ts` 587, `tool-attest.ts` 504 |
| tool files routing through `runScanAndFormat` (existing near-assembler)  | **2**              | `tool-scan-project.ts`, `tool-scan-diff.ts` only                                           |
| tool files hand-rolling `meta: {` blocks directly                        | **10**             | `tool-apply-fix`, `tool-baseline`, `tool-bootstrap`, `tool-propose-baseline`, `tool-propose-config`, `tool-scan-diff`, `tool-scan-process`, `tool-scan-project`, `tool-suppress`, `tool-wrapper-introspect` |
| tool files importing `buildAgentFinding` directly                        | **5**              | `tool-apply-fix-internals`, `tool-apply-fix`, `tool-baseline`, `tool-scan-diff`; plus the shared helper `tools-helpers.ts`                                                    |
| `scan` + `scan_file` tool definitions                                    | **inline** in `src/mcp/tools.ts` | 625 LOC file mixing schemas + inline handlers; `scan_process` is already extracted to its own file |
| `src/mcp/tools-helpers.ts` size (hosts `runScanAndFormat`)               | **856 LOC**        | god module; combined with `tools.ts` the two files are 1,481 LOC                           |
| `src/mcp/scan-assembly.ts` exports                                       | **2 functions**    | `buildScanPlan`, `buildScanMeta` — the right shape, but consumed by only 2 of 24 handlers  |
| `scripts/check-response-nullability.ts` allowlist entries                | **1**              | static guard catches sentinel `null`/`""`; does not catch field-presence drift across tools |

The partial assembler is already the right design: `src/mcp/scan-assembly.ts` owns plan + meta, `src/output/agent-response/build-finding.ts` owns the Violation → AgentFinding transform, `src/mcp/reference-guide.ts` owns reference-guide hoisting, `src/mcp/analysis-coverage.ts` owns analysis-coverage meta, `src/mcp/suppression-audit.ts` owns suppressions meta, `src/mcp/wrappers-meta.ts` owns wrappers meta, `src/mcp/token-budget.ts` owns clamping. These helpers exist and are correct. The gap is that no single entry point orchestrates them — `runScanAndFormat` in `tools-helpers.ts:520` does part of the work but is called by only 2 sites, and the other 22 tool handlers re-compose the helpers inline with subtly different contracts.

Three concrete consequences:

1. **AI-first doctrine is enforced by convention, not by construction.** Conditional-spread rules (`...(x ? { field: x } : {})`), the honest-counter splits, the `warnings` code emission on zero-output success, the "present-when-meaningful" invariant — every one of these lives in 10-24 places. `ai-first-consumer.md` plus the path-scoped rule mean a reviewer (human or agent) sees the doctrine when touching MCP files, but silent cross-surface drift is the waiting failure mode. The `scan says 21, checklist says 4` invariant is an example: nothing today prevents `scan_project` and `checklist` from disagreeing on `totalFindings` for the same input, because they compute the counter independently.
2. **v1.0 freezes a shape whose single-path invariant is missing.** ADR 0019 commits the public MCP surface for v1.0. `docs/migrations/0.1-to-0.2.md` already lists four hard breaks in response-output shapes between 0.1 and 0.2 — the cost of reshaping after a freeze is real. Third-party tooling pattern-matches on hand-rolled handler examples; changing the pattern later is a semver-breaking event. The analogous situation motivated ADR 0022: freezing `defineRule` as stable while its wiring path was inert. Same ordering mistake avoided here, different seam.
3. **Every new response field multiplies by 24.** Future sampling outputs (`src/mcp/sampling.ts`), new fix-class lanes from `FixesByClass`, new `warnings` codes (ADR 0023), new honest-counter splits — each addition currently requires touching ≤24 sites without a CI gate forcing synchrony. The backlog already records past drift instances patched tool-by-tool (checklist nextStep, scan_file remediation listing, bootstrap nextStep self-loop, detect_native_wrappers structured emptyReason) — the shape is one where drift ships before it's caught.

`runScanAndFormat` exists today and is the right shape in miniature. The ADR ratifies its role as the authoritative entry point, renames it for clarity, and locks the invariant with a lint check — analogous to how ADR 0022 took the existing `CriteriaRegistry` / `RulesRegistry` / `StandardsRegistry` primitives and wrapped them in a single `Registry` aggregate that every consumer must read through.

## Decision

Introduce `assembleScanFamilyResponse` as the single code path every scan-family MCP response flows through, extracted from the existing `runScanAndFormat` in `src/mcp/tools-helpers.ts` into a dedicated module. Migrate every tool handler that currently emits `plan` / `meta` / `files` / `warnings` / `fixesByClass` / `referenceGuide` / `reviewCandidates` / `nextStep` to route through it. Add a lint gate that forbids hand-rolled scan-family shapes outside the assembler and its underlying helpers. Enforce a per-handler LOC budget after migration so future drift cannot land by copy-paste.

Shape (new file `src/mcp/response-assembler.ts`, co-located with the existing `scan-assembly.ts` helpers):

```ts
export interface ScanFamilyResponseInput {
  readonly violations: readonly Violation[];
  readonly perRuleCoverage: readonly PerRuleCoverage[];
  readonly reviewCandidates: readonly ReviewCandidate[];
  readonly discovery: DiscoveryDiagnostics;
  readonly wrappers: ResolvedWrapperSources;
  readonly config: { readonly source: ConfigSource; readonly searchedFrom: string; readonly preset: ConfigPreset };
  readonly durationMs: number;
  readonly toolName: string;          // attribution for warnings + nextStep hints
  readonly scopeHint: "file" | "project" | "diff" | "changed" | "process";
}

export interface ScanFamilyResponseOptions {
  readonly hoistReferenceGuide?: boolean;   // scan-core: true; fix-family: false
  readonly includeReviewCandidates?: boolean;
  readonly tokenBudget?: number;            // ADR 0021 clamping
}

export interface ScanFamilyResponse {
  readonly plan: ScanPlan;
  readonly meta: ScanMeta;
  readonly files: readonly AgentFile[];
  readonly warnings?: readonly string[];              // structured codes; omitted when absent
  readonly warnings_details?: readonly WarningDetail[]; // ADR 0023 parallel channel
  readonly referenceGuide?: ReferenceGuide;           // conditional-spread: omitted when hoistReferenceGuide=false
  readonly reviewCandidates?: readonly ReviewCandidate[];
  readonly nextStep?: NextStep;
}

export function assembleScanFamilyResponse(
  input: ScanFamilyResponseInput,
  options?: ScanFamilyResponseOptions,
): ScanFamilyResponse;
```

`assembleScanFamilyResponse` is the only function that composes `buildScanPlan` + `buildScanMeta` + `buildAnalysisCoverage` + `suppressionsMetaBlock` + `wrappersMetaBlock` + `buildAgentFinding` + `buildReferenceGuide` + `dedupReviewCandidates` + `tokenBudget` clamping + structured `warnings[]` emission. Tool handlers marshal arguments into `ScanFamilyResponseInput` and consume `ScanFamilyResponse`; they never hand-roll intermediate shapes.

Migration stages as atomic commits, each under the 400-LOC budget (CLAUDE.md §9) and green on `bun run verify`:

1. **feat(mcp): extract assembleScanFamilyResponse from runScanAndFormat.** New `src/mcp/response-assembler.ts` + unit tests mirroring the existing helpers (honest-counter-split cases, conditional-spread `fixesByClass`, empty-scan `warnings` emission, reference-guide dedup, per-scope variants, ADR 0021 token-budget clamping, ADR 0023 `warnings_details` parallel channel). `runScanAndFormat` becomes a thin adapter delegating to the new function; `tool-scan-project.ts` and `tool-scan-diff.ts` stay byte-identical. Pure addition — zero call-site change; stages 3-5 migrate consumers.
2. **refactor(mcp): extract scan + scan_file handlers from tools.ts.** Inline handlers at `tools.ts:70` and `tools.ts:249` move to `src/mcp/tool-scan.ts` + `src/mcp/tool-scan-file.ts`, matching the pattern of every other tool-*.ts file. `tools.ts` drops from 625 LOC to ≤ 350 LOC (schemas only). No handler logic changes.
3. **refactor(mcp): migrate scan-core through assembleScanFamilyResponse.** `tool-scan.ts` + `tool-scan-file.ts` + `tool-scan-process.ts` route findings emission through the assembler. `tests/snapshots/mcp/scan*.json` stay byte-identical.
4. **refactor(mcp): migrate scan-derivative tools.** `tool-checklist.ts` + `tool-coverage.ts` + `tool-conformance-statement.ts` route their scan portion through the assembler so `plan` / `meta` / `warnings` match the primary scan tools. Cross-tool invariant test added: `scan.totalFindings === checklist.automatedFindings + checklist.manualReviewRequired` for a canonical fixture.
5. **refactor(mcp): migrate fix-family finding emission.** `tool-baseline.ts` + `tool-apply-fix.ts` + `tool-suggest-fix.ts` route their findings sub-tree through the assembler. Tool-specific outer fields (`baselineStatus`, `appliedEdits`, `primary` / `alternative` fix paths) stay bespoke — partial migration of the findings sub-block only.
6. **refactor(mcp): add response-assembly lint gate.** New `scripts/check-response-assembly.ts` modeled on `scripts/check-network-isolation.ts` + `scripts/check-response-nullability.ts`. Statically forbids object literals with a `plan:` key or a `meta: {` block in `src/mcp/tool-*.ts` unless routed through `assembleScanFamilyResponse`. Allowlist: `response-assembler.ts`, `scan-assembly.ts` (underlying helpers), non-scan-family tools (`attest`, `suppress`, `list_*`, `explain_*`, `bootstrap`, `detect_native_wrappers`, `wrapper_introspect`, `sessionConfigure`), and `tests/**`. Appended to the `scripts/verify.ts` sequence (CLAUDE.md §4). This is the commit that locks the invariant.
7. **refactor(mcp): enforce per-handler LOC budget.** Extension to `scripts/check-limits.ts`: scan-family `tool-*.ts` files must be ≤ 150 LOC after migration (matches the density of a handler that marshals arguments + calls the assembler). Handlers exceeding the budget are doing work that belongs in the assembler — keep extracting until they fit, or carry an inline `// ra11y-limits-exempt: <reason>` pragma (matches existing escape). Aggregate `src/mcp/tool-*.ts` LOC drops from 8,485 to ≤ 3,600.

Stages 3, 4, and 5 touch disjoint file sets and are parallelizable across agents on separate worktrees. The ordering dependency is stage 1 → 2 → {3, 4, 5} → 6 → 7. Stages 1-7 are behavior-preserving; every commit holds `tests/snapshots/mcp/**` byte-identical. Any intentional shape change splits into a separate `feat(mcp):` commit with rationale per the AI-first consumer rules.

## Consequences

- **AI-first consumer doctrine becomes mechanically enforced.** Conditional-spread, honest-counter splits, `warnings` code emission on zero-output success, reference-guide hoisting, per-field present-when-meaningful — every invariant in `ai-first-consumer.md` lives in one file. `check-response-assembly.ts` makes violation a CI failure. The path-scoped rule in `.claude/rules/mcp-response-shapes.md` remains (reviewer signal + doctrine discovery for agents touching MCP code), but the authoritative enforcement moves from convention to structure.
- **v1.0 freezes a shape whose single-path invariant is already in place.** ADR 0019's public MCP surface commits with the assembler behind it; post-v1.0 response-shape changes land in one file. Third-party tooling pattern-matches on the one authoritative example rather than 24 divergent ones.
- **New scan-family response fields land in one file.** Future sampling outputs, new `FixesByClass` lanes, new `warnings` codes (ADR 0023), honest-counter splits — every addition edits `response-assembler.ts`; all consumers pick it up automatically. The drift class ("a field added to one tool and forgotten in another") becomes uninventable.
- **Handler files collapse to argument-marshalling + one call.** Top-five handlers — `tool-checklist.ts` 771, `tool-scan-project.ts` 728, `tool-scan-diff.ts` 618, `tool-bootstrap.ts` 587, `tool-attest.ts` 504 — drop to the 150-LOC budget for scan-family handlers (`attest` is not scan-family and stays as-is). Reviewing a new MCP tool becomes "what did you pass into the assembler and what did you do with its result," not "did you re-implement the 12 invariants correctly."
- **`tools.ts` becomes schemas-only.** Dropping the two inline handlers at lines 70 + 249 lets `tools.ts` settle at ≤ 350 LOC describing JSON-RPC tool schemas; `tools-helpers.ts` sheds `runScanAndFormat` and shrinks below the file-size limit in `scripts/check-limits.ts`.
- **Zero runtime-dependency invariant preserved.** Purely in-tree restructuring; no import additions, no parser/formatter/rule/scanner contract changes, no `dependencies` churn.
- **Performance is within budget noise.** The assembler composes the same helpers `runScanAndFormat` composes today; `bench.ts` budgets hold by construction. A single allocation site per call replaces per-tool allocations that already happen; net improvement is expected but not targeted.
- **Public API types stay stable.** `ScanResult`, `Violation`, `ReportData`, `Severity` (ADR 0019) are unchanged. `AgentFinding` (internal MCP shape) gains a stable producer but keeps its existing schema. `src/api/index.ts` remains un-exported; `package.json#exports` is untouched.
- **The dispatch model is preserved.** Stages 3, 4, 5 are file-group sized so `/continue` with worktree isolation can fan them out in parallel across turns. Matches the ADR 0022 migration cadence. Stage 6 runs only after 3-5 converge; stage 7 runs after 6.
- **ADR 0022 and ADR 0024 are independent.** Registry aggregate threads registry access through `McpSession`; response assembler threads shape production through a single function. Neither blocks the other; both must land before v1.0 freezes the surfaces they back.

## Alternatives considered

**Keep convention + path-scoped rule.** Status quo: `ai-first-consumer.md` + `.claude/rules/mcp-response-shapes.md` + reviewer judgment. Works today — the doctrine is discoverable, the rule auto-loads, drift gets caught in review. But the drift surface grows with every tool added (24 today, 30+ plausible by v0.3). Convention-only invariants decay when the population of people editing the code grows beyond those who learned the doctrine by osmosis; the code-level seam is what scales. Rejected for v1.0 timing — freezing the shape without the single-path invariant ships the wrong ordering.

**Extend `runScanAndFormat` in place.** Rename it, document it as authoritative, migrate tools to call it without the new file. Smaller diff. Rejected because `tools-helpers.ts` is already 856 LOC and the combined `tools.ts` + `tools-helpers.ts` is 1,481 LOC — the function's authoritative role needs a dedicated module to carry its documentation, tests, and future extensions, and the existing god module is the wrong home. Cosmetic nit, real consequence: a dedicated module makes the seam visible to `check-response-assembly.ts` without pattern-matching an export name.

**One-shape-fits-all across all MCP tools.** Route every tool through the assembler, including `attest` / `suppress` / `list_*` / `explain_*` / `bootstrap`. Over-reach: non-scan-family tools have categorically different response shapes (prompts, resources, attestations, suppression ledgers). Forcing them through a scan-family assembler would either bloat the assembler interface or misrepresent what those tools do. The ADR limits the scope to scan-family deliberately; non-scan-family tools keep their bespoke shapes with independent testing.

**Wait until after v1.0.** Tempting — v1.0 is close, this is refactor scope. Rejected for the same reason ADR 0022 is not deferred: v1.0 freezes the public shape (`docs/migrations/0.1-to-0.2.md` already records four hard breaks in response-output shapes between 0.1 and 0.2). Freezing a shape whose single-path invariant is missing is the wrong order. Doing this pre-v1.0 keeps the freeze honest and lets the AI-first doctrine rules in `ai-first-consumer.md` become structural rather than conventional.

**Split into finer-grained assemblers (one per scope).** `assembleScan`, `assembleScanDiff`, `assembleChecklist`, `assembleCoverage`, each with its own signature. Rejected because the differences between scan-family tools are better modeled as `options` on a single assembler than as separate functions — the invariants (`plan` structure, `meta` blocks, `warnings` codes, `files` shape) are 95% shared. Independent assemblers would re-introduce the drift surface this ADR eliminates. The `scopeHint` field on `ScanFamilyResponseInput` carries the per-tool variance.

**Code-generate handlers from a schema.** A `tool-spec.ts` per handler that a generator turns into the current hand-rolled TypeScript. Solves drift by producing code from one source. Over-reach: adds a generator to the build pipeline, adds another file per tool, and the fundamental problem is the composition logic, not the boilerplate. The assembler solves composition directly; a generator would layer tooling over a problem that has a smaller solution.
