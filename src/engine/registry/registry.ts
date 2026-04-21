/**
 * Registry aggregate.
 *
 * Single-seam wrapper around the three existing registry primitives
 * ({@link StandardsRegistry}, {@link CriteriaRegistry}, {@link RulesRegistry})
 * plus the candidate-finder list. Owns no new logic — it composes the
 * primitives into the shape downstream consumers (MCP session, CLI
 * command bootstrap, future plugin loader) read from, so the hard
 * invariant in CLAUDE.md §3.8 ("engine never imports from rules/standards
 * — they consume them through registries") can be enforced at the
 * layer boundary instead of relying on convention.
 *
 * The intentional *only* reach into `BUILTIN_RULES`, `BUILTIN_STANDARDS`,
 * and `BUILTIN_CANDIDATE_FINDERS` is {@link createBuiltinRegistry} below
 * — stage 6 of ADR 0022's migration adds a lint gate forbidding those
 * imports anywhere else under `src/`.
 *
 * See docs/adr/0022-registry-aggregate.md.
 */

import { BUILTIN_CANDIDATE_FINDERS } from "../../review/index.ts";
import { BUILTIN_RULES } from "../../rules/index.ts";
import { BUILTIN_STANDARDS } from "../../standards/index.ts";
import type { CandidateFinder } from "../../types/review.ts";
import type { Rule } from "../../types/rule.ts";
import type { Criterion, Standard } from "../../types/standard.ts";
import { CriteriaRegistry } from "./criteria.ts";
import { RulesRegistry } from "./rules.ts";
import { StandardsRegistry } from "./standards.ts";

/**
 * Input to the {@link Registry} constructor. Mirrors the three loaded
 * collections the aggregate composes. Every field is required so the
 * wrapper has one well-defined shape; callers that want only built-ins
 * use {@link createBuiltinRegistry}.
 */
export interface RegistryInput {
  readonly rules: readonly Rule[];
  readonly standards: readonly Standard[];
  readonly finders: readonly CandidateFinder[];
}

/**
 * Aggregate wrapper over rules, standards, and candidate finders.
 *
 * The constructor is the single place `CriteriaRegistry.rebuild()` and
 * `RulesRegistry.rebuild()` are ordered — standards first (so the
 * criteria registry is populated), then rules (so the `rulesBySatisfied`
 * index closes over the criteria's equivalence reciprocal). Callers
 * construct a Registry once per session or CLI invocation and thread
 * it through; downstream code reads the accessors instead of reaching
 * for the built-in barrels directly.
 *
 * Accessor semantics mirror the underlying primitives: lookup-by-id
 * returns `undefined` for unknown IDs (no throw), and
 * {@link rulesForCriterion} returns `[]` when the criterion is not loaded
 * or no rule satisfies it. `rulesForCriterion` closes over the
 * criteria registry's `equivalenceClosure`, so a rule satisfying
 * `wcag22:1.4.3` is also returned for `section508:1194.22.c` when the
 * standards declare them equivalent — the same behavior the standard
 * filter already relies on.
 */
export class Registry {
  readonly rules: readonly Rule[];
  readonly standards: readonly Standard[];
  readonly finders: readonly CandidateFinder[];
  readonly criteria: CriteriaRegistry;
  readonly rulesIndex: RulesRegistry;
  readonly #standardsIndex: StandardsRegistry;
  readonly #ruleOrder: Map<string, number>;

  constructor(input: RegistryInput) {
    this.rules = input.rules;
    this.standards = input.standards;
    this.finders = input.finders;

    const standardsIndex = new StandardsRegistry();
    for (const standard of input.standards) standardsIndex.register(standard);
    this.#standardsIndex = standardsIndex;

    const criteria = new CriteriaRegistry();
    criteria.rebuild(input.standards);
    this.criteria = criteria;

    const rulesIndex = new RulesRegistry();
    for (const rule of input.rules) rulesIndex.register(rule);
    rulesIndex.rebuild(criteria);
    this.rulesIndex = rulesIndex;

    // Registration-order map used by rulesForCriterion to keep results
    // deterministic across call sites regardless of the order the
    // equivalence closure happened to visit rule IDs.
    const ruleOrder = new Map<string, number>();
    for (let i = 0; i < input.rules.length; i += 1) {
      const rule = input.rules[i];
      if (rule !== undefined) ruleOrder.set(rule.id, i);
    }
    this.#ruleOrder = ruleOrder;
  }

  /** Returns a rule by ID, or undefined. */
  findRule(id: string): Rule | undefined {
    return this.rulesIndex.get(id);
  }

  /** Returns a standard by ID, or undefined. */
  findStandard(id: string): Standard | undefined {
    return this.#standardsIndex.get(id);
  }

  /** Returns a criterion by ID, or undefined. */
  findCriterion(id: string): Criterion | undefined {
    return this.criteria.get(id);
  }

  /**
   * Every rule that satisfies the given criterion, directly or via the
   * criteria registry's equivalence closure. Returns `[]` when the
   * criterion is unknown or no rule covers it. Ordered by the rules'
   * position in the input `rules` array for stable output.
   */
  rulesForCriterion(id: string): readonly Rule[] {
    const ruleIds = this.rulesIndex.rulesFor(id);
    const resolved: Rule[] = [];
    for (const ruleId of ruleIds) {
      const rule = this.rulesIndex.get(ruleId);
      if (rule !== undefined) resolved.push(rule);
    }
    resolved.sort((a, b) => {
      const ai = this.#ruleOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = this.#ruleOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
    return resolved;
  }
}

/**
 * Constructs a Registry populated with the shipped built-ins. This is
 * the only legitimate module-scope reach into `BUILTIN_RULES`,
 * `BUILTIN_STANDARDS`, and `BUILTIN_CANDIDATE_FINDERS` anywhere under
 * `src/` — downstream callers (MCP session, CLI bootstrap) use this
 * helper and thread the resulting Registry through.
 */
export function createBuiltinRegistry(): Registry {
  return new Registry({
    rules: BUILTIN_RULES,
    standards: BUILTIN_STANDARDS,
    finders: BUILTIN_CANDIDATE_FINDERS,
  });
}

/**
 * Additions a caller (plugin loader, test harness, future
 * `ra11y.config.ts` hook, CLI `--plugin` flag) can contribute to
 * the built-in registry. Every field is optional and additive —
 * omitted fields fall through to the shipped built-ins unchanged.
 *
 * See `examples/plugin-rule/` for a worked example.
 */
export interface RegistryOverrides {
  readonly rules?: readonly Rule[];
  readonly standards?: readonly Standard[];
  readonly finders?: readonly CandidateFinder[];
}

/**
 * Constructs a Registry composed of the shipped built-ins plus any
 * user-authored additions. The seam ADR 0022 reserved for the
 * plugin path: `defineRule` / `defineStandard` / `defineCandidateFinder`
 * stay identity functions on the public API surface (ADR 0019
 * freeze), and this factory is the internal wiring that makes those
 * authored records visible to every consumer of `session.registry` —
 * `list_rules`, `scan_project`, `checklist`, and every other
 * registry-reading tool.
 *
 * Additions append to the built-in collection and keep source order
 * stable. ID collisions between a user rule and a built-in rule are
 * not silently resolved here: the Registry constructor's
 * `RulesRegistry.register` path throws on duplicate IDs, which is
 * the correct failure mode — plugin authors must choose a distinct
 * ID (convention: `<scope>/<rule>`, e.g. `example/no-title-attribute`)
 * rather than accidentally shadow a built-in.
 *
 * @param overrides - Optional user-authored rules, standards, and
 *   finders to fold in alongside the built-ins. Omitting the argument
 *   is equivalent to {@link createBuiltinRegistry}.
 * @returns A Registry with the union of built-in + user records,
 *   ordered built-ins first.
 *
 * @example
 * ```ts
 * import { createRegistry } from "ra11y/engine/registry/registry";
 * import myRule from "./my-rule.ts";
 *
 * const registry = createRegistry({ rules: [myRule] });
 * // registry.rules includes every shipped rule AND myRule.
 * ```
 */
export function createRegistry(overrides: RegistryOverrides = {}): Registry {
  const rules = overrides.rules?.length ? [...BUILTIN_RULES, ...overrides.rules] : BUILTIN_RULES;
  const standards = overrides.standards?.length
    ? [...BUILTIN_STANDARDS, ...overrides.standards]
    : BUILTIN_STANDARDS;
  const finders = overrides.finders?.length
    ? [...BUILTIN_CANDIDATE_FINDERS, ...overrides.finders]
    : BUILTIN_CANDIDATE_FINDERS;
  return new Registry({ rules, standards, finders });
}
