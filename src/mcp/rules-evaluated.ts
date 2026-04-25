/**
 * Canonical builder for the `meta.rulesEvaluated` shape surfaced by
 * every scan-family / scan-derivative MCP tool.
 *
 * Before Q4-RULES-EVALUATED-COMPOSITE this field was a single number
 * that read as "rules that ran" but actually counted every loaded /
 * post-standard-filter rule regardless of whether it had any eligible
 * inputs in the scan. On a pure-HTML/SSG project, dozens of React-
 * specific rules reported `filesEligible: 0` under `perRuleCoverage` —
 * the composite "52 evaluated" headline inflated the work the agent
 * budgeted against because the summary number didn't split categorically
 * different sub-buckets. Per the AI-first doctrine in
 * `docs/kb/architecture/ai-first-consumer.md`, "Composite headline
 * counts are dishonest": if a top-level counter names one concept, it
 * must count one kind of thing.
 *
 * The shape splits into three honest sub-counters:
 *
 *   - `loaded`: total rules the scanner had available after the config
 *     on/off filter (i.e. `activeRules.length`). This is the ceiling —
 *     everything else is a subset.
 *   - `withEligibleInputs` (optional): rules whose input-filter matched
 *     at least one scanned file — `perRuleCoverage.filter(r =>
 *     r.filesEligible > 0).length`. Omitted when the caller has no
 *     `perRuleCoverage` to derive from (e.g. `propose_config` — tools
 *     that do scans the tool doesn't retain coverage for). Tools that
 *     run no rules at all (e.g. `list_suppressions`) omit the entire
 *     `rulesEvaluated` field rather than emit `{ loaded: N }` alone —
 *     a counter named "evaluated" must describe work the tool did, not
 *     the size of the rule registry; see
 *     V1-LIST-SUPPRESSIONS-RULES-EVALUATED-DRIFT.
 *   - `fired` (optional): rules that emitted at least one finding —
 *     `perRuleCoverage.filter(r => r.findingsEmitted > 0).length`.
 *     Same conditional-spread rule as `withEligibleInputs`.
 *
 * Monotone invariant when all three are present:
 *   `fired <= withEligibleInputs <= loaded`.
 *
 * Conditional-spread on the optional fields follows CLAUDE.md §1
 * "Ambiguous field shapes are dishonest" — a tool that can't honestly
 * compute `withEligibleInputs` / `fired` omits them entirely rather
 * than emitting `0` or `null` that an agent would silently treat as
 * real data.
 */

import { type RuleAlias, resolveRuleId } from "../engine/rule-aliases.ts";
import type { LoadedConfig } from "../types/config.ts";
import type { Rule } from "../types/rule.ts";
import type { PerRuleCoverage } from "../types/violation.ts";
import type { McpSession } from "./session.ts";

/**
 * Structured `rulesEvaluated` meta field. `loaded` is always populated;
 * the other two ride under conditional spread per this module's contract.
 */
export interface RulesEvaluated {
  readonly loaded: number;
  readonly withEligibleInputs?: number;
  readonly fired?: number;
}

/**
 * Builds the canonical `rulesEvaluated` object.
 *
 * Tools that ran the scanner and carry the per-rule coverage array pass
 * it in so the helper can derive the `withEligibleInputs` / `fired`
 * sub-counters; tools that don't (e.g. `propose_config` top-level meta,
 * `apply_fix` when threading is out of scope) omit it and get back a
 * single-field `{ loaded }` object. Tools that don't run any rules
 * (e.g. `list_suppressions`) skip this helper entirely and omit
 * `rulesEvaluated` from their meta — see V1-LIST-SUPPRESSIONS-RULES-
 * EVALUATED-DRIFT.
 *
 * `withEligibleInputs` counts per-rule coverage rows where
 * `filesEligible > 0` — the "this rule had something to look at" signal.
 * Project-scoped rules whose only lifecycle is `afterProject` always
 * synthesize `filesEligible = filesScanned`, so a scan with zero
 * parseable files would surface `withEligibleInputs: 0` honestly
 * instead of inflating by the project-scoped-rule count.
 *
 * `fired` counts per-rule coverage rows where `findingsEmitted > 0`
 * — the set of rules that actually produced a violation on this scan.
 * Zero is a meaningful signal ("rule ran, saw eligible inputs, didn't
 * flag anything") paired with `coverageConfidence` in the underlying
 * `perRuleCoverage` rows.
 */
export function buildRulesEvaluated(args: {
  readonly loadedCount: number;
  readonly perRuleCoverage?: readonly PerRuleCoverage[];
}): RulesEvaluated {
  const { loadedCount, perRuleCoverage } = args;
  if (perRuleCoverage === undefined) {
    return { loaded: loadedCount };
  }
  let withEligibleInputs = 0;
  let fired = 0;
  for (const row of perRuleCoverage) {
    if (row.filesEligible > 0) withEligibleInputs += 1;
    if (row.findingsEmitted > 0) fired += 1;
  }
  return {
    loaded: loadedCount,
    withEligibleInputs,
    fired,
  };
}

/**
 * Single-source-of-truth resolver for the rule set a scan-family or
 * scan-derivative MCP tool should evaluate against the current session.
 *
 * Before this helper landed, every tool independently derived its
 * `activeRules` list by open-coding one of two variants:
 *
 *   1. `applyRuleSettings(session.registry.rules, session.config.rules)`
 *      — session-only, ignoring any `ra11y.config.ts` the user dropped at
 *      the project root.
 *   2. `applyRuleSettings(session.registry.rules,
 *      session.effectiveRules(projectConfig))` — session merged with
 *      project config, the correct shape.
 *
 * Tools divided across the two variants, silently producing different
 * `meta.rulesEvaluated.loaded` counts for the same `cwd`
 * (Q-SHARED-RULES-EVALUATED-SSOT: `scan_project: 53`, `propose_config:
 * 54`, `list_rules: 54` on the same input). Routing every caller through
 * this helper collapses the two variants into one deterministic recipe:
 *
 *   registry rules → merge session + project rule settings →
 *   drop rules set to `"off"` → apply severity overrides → return.
 *
 * Callers pass `projectConfig` when they have one loaded; the `undefined`
 * case falls back to the session-only rule settings (the old variant 1
 * behavior) so tools like `scan` (which never takes a `cwd`) stay honest
 * rather than silently loading a config they have no anchor for. Once
 * every caller loads `projectConfig` upstream, the `undefined` branch
 * becomes dead and can be tightened in a later refactor — keeping it
 * here for now so the refactor stays additive and landable in one pass.
 *
 * Doctrine: "Verbose meta is signal, not clutter" + cross-surface
 * consistency — two MCP surfaces reporting different `rulesEvaluated`
 * counts for the same scan root forces wasted round trips as the agent
 * tries to reconcile them. See `docs/kb/architecture/ai-first-consumer.md`.
 */
export function resolveActiveRules(
  session: McpSession,
  projectConfig?: LoadedConfig,
): readonly Rule[] {
  const effective =
    projectConfig === undefined ? session.config.rules : session.effectiveRules(projectConfig);
  return applyRuleSettings(session.registry.rules, effective);
}

/**
 * Applies per-session rule settings: drops rules set to "off" and
 * overrides severity for rules set to "error", "warning", or "info".
 * Mirrors the config-file behavior in runScanCommand.
 *
 * Lives here (alongside {@link resolveActiveRules}) rather than in
 * `tools-helpers.ts` so the canonical rule-resolution pipeline
 * (registry → settings merge → on/off filter → severity override) stays
 * in one file. `tools-helpers.ts` re-exports this symbol so existing
 * call sites keep working without an import churn pass —
 * {@link resolveActiveRules} is the preferred SSOT for new callers.
 */
export function applyRuleSettings(
  rules: readonly Rule[],
  settings: Readonly<Record<string, string>>,
): readonly Rule[] {
  const effective = normalizeRuleSettings(settings).settings;
  return rules
    .filter((r) => effective[r.id] !== "off")
    .map((r) => {
      const override = effective[r.id];
      if (override === "error" || override === "warning" || override === "info") {
        return { ...r, severity: override };
      }
      return r;
    });
}

/**
 * Rewrites a rule-settings map's keys through the rule-ID alias table
 * (V1-INFRA-RULE-ID-ALIAS-TABLE), returning the canonical-keyed map
 * plus a list of every alias that fired. Used at the apply-settings
 * seam so `ra11y.config.ts` `rules: { "<old>": "off" }` and session
 * `configure({ rules: { ... } })` honor both the old and new ID while
 * the rename is under alias coverage.
 *
 * Precedence when BOTH the old and new keys are set: the new ID's
 * setting wins (deterministic: the canonical ID is authoritative). The
 * old-key entry is still translated but folded under the canonical
 * key, so an agent doing a wholesale rewrite to the new ID doesn't
 * accidentally flip behavior — the final effective setting tracks
 * whichever the author intended to land on the canonical surface.
 *
 * Exposed so MCP tools that assemble a response after applying
 * settings can surface `deprecated_rule_id:<old>:<new>` warnings
 * based on `aliasHits`. `applyRuleSettings` itself discards the list
 * (its callers don't always have a warnings channel); the rewrite is
 * still applied unconditionally so the runtime stays honest.
 */
export function normalizeRuleSettings(settings: Readonly<Record<string, string>>): {
  readonly settings: Readonly<Record<string, string>>;
  readonly aliasHits: readonly RuleAlias[];
} {
  const out: Record<string, string> = {};
  const aliasHits: RuleAlias[] = [];
  // Two-pass: translate deprecated keys into the canonical form first;
  // canonical keys override so the "both set" case is deterministic.
  for (const [key, value] of Object.entries(settings)) {
    const resolution = resolveRuleId(key);
    if (resolution.deprecated === undefined) continue;
    aliasHits.push(resolution.deprecated);
    out[resolution.resolved] = value;
  }
  for (const [key, value] of Object.entries(settings)) {
    const resolution = resolveRuleId(key);
    if (resolution.deprecated !== undefined) continue;
    out[key] = value;
  }
  return { settings: out, aliasHits };
}
