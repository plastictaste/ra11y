# ADR 0022 — registry aggregate for rules, standards, and finders

- Status: Accepted
- Date: 2026-04-20
- Accepted: 2026-04-21
- Supersedes: none
- Superseded by: none
- Related: ADR 0002 (three-layer standards/criteria/rules), ADR 0005 (in-house MCP server), ADR 0019 (v1.0 public API stability), `src/engine/registry/{criteria,rules,standards}.ts`, `src/api/plugin.ts`

## Context

CLAUDE.md §3.8 names a hard invariant: "Engine never imports from rules/standards. They consume them through registries. Formatters never import from rules/standards. They consume `ScanResult` and `ReportData`." The engine honors it — `src/engine/registry/{criteria,rules,standards}.ts` exists and the scanner reaches rules/standards through those primitives. The surrounding orchestration layers do not.

Measurement — `grep -rln "BUILTIN_RULES\|BUILTIN_STANDARDS" src/` on 2026-04-20:

| layer                          | files importing `BUILTIN_*` | notes                                              |
|-------------------------------|----------------------------:|----------------------------------------------------|
| `src/mcp/**`                   | 17                          | includes `tools.ts`, `tools-helpers.ts`, every `tool-*.ts` |
| `src/cli/commands/**`          | 11                          | every command that needs rules or standards        |
| `src/rules/index.ts`           | 1                           | the barrel itself (legitimate)                     |
| `src/standards/index.ts`       | 1                           | the barrel itself (legitimate)                     |
| `src/mcp/completions.ts`       | 1                           | completions autocompletes rule IDs                 |
| `src/mcp/wrappers-meta.ts`     | 1                           | wrapper/meta builders                              |
| `src/mcp/scan-project-budget.ts` | 1                         | density-cap helper                                 |
| **Total**                      | **33**                      | of which 31 are non-barrel leaks                   |

The leak is structural, not local: `src/mcp/tools-helpers.ts` already constructs `CriteriaRegistry` + `RulesRegistry` on demand (`rebuildRegistries`, lines 752–754), then *also* imports `BUILTIN_RULES` and `BUILTIN_STANDARDS` at module scope (lines 24–25) and passes them in as values at lines 216, 418, 568, 732, 736. Every MCP tool and CLI command follows the same pattern. The registry abstraction exists but is never the source of truth — the barrels are.

Three concrete consequences:

1. **Layer boundary stated but not enforced.** The AI-facing MCP layer is the formatter-tier sibling the invariant was written for; it imports rule and standard content directly. No lint check today catches the pattern, so new tools inherit it by copy-paste.
2. **Plugin API is inert.** `src/api/plugin.ts` documents itself as "zero-cost at runtime … return their argument verbatim" — `defineRule`, `defineStandard`, `defineFormatter`, `defineCandidateFinder` are identity functions for type inference only. ADR 0019 froze these four as stable public exports for v1.0, but there is no wiring path from a user-authored `defineRule(...)` result to `list_rules`, `suggest_fix`, or any scan. Every consumer reads `BUILTIN_RULES` directly. The v1.0 freeze locks a surface that doesn't function end-to-end.
3. **Adding a rule edits a barrel every consumer reads.** `feat(rules):` commits consistently touch `src/rules/index.ts`; every subsequent consumer closure over `BUILTIN_RULES` picks the new entry up by static graph, which is why the pattern spread to 31 files without friction. The barrel is acting as a shared mutable singleton in a tree that claims to avoid them.

Review finders follow the same static-barrel pattern at `src/review/index.ts` (`BUILTIN_CANDIDATE_FINDERS`), though their consumer count is smaller today. Standards live at `src/standards/index.ts` (`BUILTIN_STANDARDS`) with identical shape.

## Decision

Introduce a `Registry` aggregate that owns the loaded rules, standards, and candidate finders, wrapping the existing `CriteriaRegistry`, `RulesRegistry`, and `StandardsRegistry` primitives under a single constructor seam. Thread it through `McpSession` and the CLI command bootstrap so every downstream consumer reads the registry instead of the barrels. Add a lint gate that forbids `BUILTIN_RULES` / `BUILTIN_STANDARDS` / `BUILTIN_CANDIDATE_FINDERS` imports outside `src/engine/registry/**`, the barrels themselves, and tests.

Shape (new file `src/engine/registry/registry.ts`, co-located with the three existing primitives):

```ts
export interface RegistryInput {
  readonly rules: readonly Rule[];
  readonly standards: readonly Standard[];
  readonly finders: readonly CandidateFinder[];
}

export class Registry {
  readonly rules: readonly Rule[];
  readonly standards: readonly Standard[];
  readonly finders: readonly CandidateFinder[];
  readonly criteria: CriteriaRegistry;   // built from standards
  readonly rulesIndex: RulesRegistry;    // built from rules + criteria closure
  constructor(input: RegistryInput);

  findRule(id: string): Rule | undefined;
  findStandard(id: string): Standard | undefined;
  findCriterion(id: string): Criterion | undefined;
  rulesForCriterion(id: string): readonly Rule[];
}

export function createBuiltinRegistry(): Registry;
```

`createBuiltinRegistry` is the single remaining caller of `BUILTIN_RULES`, `BUILTIN_STANDARDS`, and `BUILTIN_CANDIDATE_FINDERS`.

Migration stages as atomic commits, each under the 400-LOC budget (CLAUDE.md §9) and green on `bun run verify`:

1. **feat(engine): add Registry wrapping existing registry primitives.** New file + unit tests. No call-site change.
2. **feat(mcp): attach Registry to McpSession.** `session.registry` exposed; old imports still work.
3. **refactor(mcp): migrate tools-helpers.ts to session.registry.** Six sites inside one file, plus dropping the two barrel imports. This is the highest-value single commit — it eliminates the leak in the module every other MCP tool depends on.
4. **refactor(mcp): migrate tool-*.ts** — grouped by adjacency (scan-family, fix-family, baseline-family, meta-family), ≈4 commits.
5. **refactor(cli): thread Registry through command bootstrap.** One commit wires `src/cli.ts`; follow-ups migrate `src/cli/commands/*.ts` by file group, ≈2–3 commits.
6. **refactor(engine): add forbidden-import check.** New `scripts/check-builtins-scope.ts` modeled on `scripts/check-network-isolation.ts`; appended to the `scripts/verify.ts` sequence (CLAUDE.md §4). This is the commit that locks the invariant.
7. **feat(api): wire defineRule/defineStandard/defineCandidateFinder through Registry.** `createRegistry(overrides)` for plugin composition. Example under `examples/plugin-rule/`. ADR 0019's frozen surface now functions end-to-end.

Stages 1–6 are pure refactor, behavior-preserving, reversible at every commit. Stage 7 is additive.

## Consequences

- **CLAUDE.md §3.8 becomes enforced, not aspirational.** The forbidden-import check in stage 6 makes violation a CI failure. New MCP tools can't leak by copy-paste.
- **ADR 0019's plugin-API freeze functions end-to-end for v1.0.** `defineRule` / `defineStandard` / `defineCandidateFinder` stop being type-only identity functions. A user-authored rule supplied through a future config hook or plugin loader is visible to every consumer that currently reads `BUILTIN_RULES`. No public-API surface change: the frozen symbols in the ADR 0019 tables keep their signatures; the internal wiring behind them now exists.
- **One bootstrap seam per consumer surface.** The MCP server instantiates `Registry` once in `McpSession`; CLI instantiates it once in `src/cli.ts`. Tests inject their own via `new Registry({...})` instead of mutating a shared barrel — current tests that build partial registries inline (e.g. `tools-helpers.ts:750–755`) collapse to a single constructor call.
- **Rule-authoring workflow is unchanged.** The scaffolder still updates `src/rules/index.ts`; the barrel is still the registration site for built-ins. The change is that no consumer reaches for it directly.
- **Zero runtime-dependency invariant preserved.** Purely in-tree restructuring; no import additions outside `src/engine/registry/**`. No parser, formatter, rule, or scanner contract changes.
- **Performance is within budget noise.** One `new Registry()` per session (MCP) or per CLI invocation; `bench.ts` budgets hold by construction. The `rebuildRegistries` allocation already happens on every scan assembly; the new seam amortizes it to once per session, a net improvement.
- **`src/api/index.ts` stays un-exported.** ADR 0019 notes that barrel is not part of the published surface. Nothing about this ADR changes the public `package.json#exports`.
- **Density-cap helpers and completions stay behavior-identical.** `scan-project-budget.ts`, `completions.ts`, `wrappers-meta.ts` gain a registry parameter; response shapes and the pagination contract established by ADR 0021 are unaffected.
- **The dispatch model is preserved.** Stages 3–5 are file-group sized so `/continue` with worktree isolation can fan them out in parallel across turns. The ordering dependency is stage 1 → 2 → {3, 5}; stage 6 runs only after 3–5 converge.

## Alternatives considered

**Auto-generate the barrels.** A pre-commit hook or `.generated.ts` pattern that enumerates `src/rules/**/*.ts` exports and rewrites the barrel. Solves authoring friction — one-file rule commits instead of two — but leaves all 31 leaky imports untouched. The layer boundary stays violated; the plugin API stays inert. Smaller-bore, wrong target. Compatible with this ADR as a later add-on if authoring friction remains after migration.

**Split `tools-helpers.ts` into focused modules.** Breaks up the 842-line god module but preserves the barrel coupling — the split modules would each import `BUILTIN_*`. Cosmetic refactor; the underlying isolation problem is unchanged.

**Full plugin loader with filesystem discovery at v1.0.** A `ra11y.config.ts` that accepts `rules: [...]` plus a glob-based loader. Over-reach for this change: it combines Registry introduction with a loader design that has open questions (ESM import resolution under the peer-dep TypeScript constraint, security stance for running plugin code from node_modules) that should not gate the layer-boundary fix. Registry unblocks a loader; a loader is a separate ADR when the evidence for one lands.

**Inject rules/standards directly into `McpSession` (no Registry).** Two fields instead of one aggregate. Works for the immediate leak but loses the `rulesForCriterion` / `findRule` / `findStandard` accessor consolidation — every consumer still hand-rolls `.find(r => r.id === id)`. The aggregate is the place where "which rule satisfies this criterion under the loaded standards?" has a single implementation.

**Wait until after v1.0.** Tempting (v1.0 is close, this is refactor scope), but ADR 0019 freezes `defineRule`/`defineStandard` as stable exports for v1.0. Freezing a public surface whose internal wiring is stubs is the wrong order of operations. Doing this pre-v1.0 keeps the freeze honest.
