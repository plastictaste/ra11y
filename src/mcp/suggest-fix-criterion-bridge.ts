/**
 * Criterion-input → rule resolution for `suggest_fix`. Manual-review
 * candidates carry criterion IDs (`wcag22:N.N.N`, `section508:…`,
 * `en301549:…`); without this bridge the handoff
 * `review_candidates → suggest_fix` hard-errors with `Rule not found.
 * Call list_rules.` — wasting a round trip to learn that "the criterion
 * ID isn't a rule ID."
 *
 * Doctrine: "fetch fix guidance for any rule satisfying this criterion."
 * When multiple rules satisfy, pick the most-specific by deterministic
 * tiebreak (smallest `satisfies.length`, alphabetic on ties) and report
 * the choice via `disambiguationNote` so the agent can re-call against
 * a sibling rule when the chosen one isn't the right fit. Singleton
 * resolution leaves the note absent — there's no ambiguity to disclose.
 *
 * Pure function over the rule registry; no I/O. Pairs with
 * `tool-suggest-fix.ts`'s handler at the input-validation layer.
 *
 * See `docs/kb/architecture/ai-first-consumer.md`: "One tool call should
 * answer 'what next?'" + "Surface, don't suppress."
 */

import type { Rule } from "../types/rule.ts";
import type { Criterion } from "../types/standard.ts";
import type { McpSession } from "./session.ts";
import { manualOnlyCriterionResult } from "./suggest-fix-manual-only-criterion.ts";
import type { VendorContext } from "./suggest-fix-vendor-context.ts";
import type { McpToolResult } from "./tools-helpers.ts";
import { errorResult, findRule } from "./tools-helpers.ts";

/**
 * Criterion IDs are namespaced `<standard>:<number>` (e.g.
 * `wcag22:1.4.3`, `section508:1194.22.c`, `en301549:9.1.4.3`). Rule IDs
 * use `/` as the separator (e.g. `keyboard/handler-missing`) and never
 * contain `:`. The same classifier shape is used in
 * `tool-list-suppressions.ts` for the suppression-pragma surface — a
 * `:` in the token is a reliable distinguisher because rule IDs cannot
 * carry one.
 */
export function isCriterionId(token: string): boolean {
  return token.includes(":");
}

/**
 * Discriminated union returned from {@link resolveCriterionInput}. See
 * that function's comment for the resolution rules.
 */
export type CriterionResolution =
  | null
  | { readonly kind: "unknown" }
  | { readonly kind: "resolved"; readonly ruleId: string; readonly note?: string };

/**
 * Resolves a `suggest_fix` `ruleId` input to the rule the handler
 * should pretend was named in the request:
 *
 *   - `null` → input was not a criterion ID; caller stays on the
 *     existing rule-lookup path verbatim.
 *   - `{ kind: "unknown" }` → input was a criterion ID but no rule
 *     satisfies it; caller emits a rule-not-found envelope naming the
 *     criterion.
 *   - `{ kind: "resolved", ruleId, note? }` → 1+ rules satisfy.
 *     Singleton resolution leaves `note` absent (no ambiguity); 2+
 *     rules attach a note naming the chosen rule and the others.
 *
 * Tie-break: smallest `satisfies.length` (a rule that satisfies fewer
 * criteria is, by construction, more specific to any single one of
 * them), then alphabetical by rule ID for stability. Both legs are
 * deterministic from the rule registry — no heuristics — so the agent
 * can re-derive the choice from the response.
 */
export function resolveCriterionInput(input: string, session: McpSession): CriterionResolution {
  if (!isCriterionId(input)) return null;
  const candidates = session.registry.rulesForCriterion(input);
  if (candidates.length === 0) return { kind: "unknown" };
  const sorted = [...candidates].sort(compareRuleSpecificity);
  const chosen = sorted[0] as Rule;
  if (sorted.length === 1) return { kind: "resolved", ruleId: chosen.id };
  const otherIds = sorted
    .slice(1)
    .map((r) => r.id)
    .join(", ");
  const note = `Criterion '${input}' is satisfied by ${sorted.length} rules. Selected '${chosen.id}' as the most-specific rule (smallest satisfies-list, alphabetic tiebreak). Other satisfying rules: ${otherIds}.`;
  return { kind: "resolved", ruleId: chosen.id, note };
}

/**
 * Tie-break for {@link resolveCriterionInput}. Pure comparator —
 * exported for direct unit testing of the ordering invariant without
 * spinning up a session.
 */
export function compareRuleSpecificity(a: Rule, b: Rule): number {
  if (a.satisfies.length !== b.satisfies.length) {
    return a.satisfies.length - b.satisfies.length;
  }
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Four-way resolution of the `suggest_fix` `ruleId` param:
 *
 *   - `{ ruleId, … }` — input was a rule ID OR a criterion ID with at
 *     least one satisfying rule; the rest of the handler proceeds
 *     against `ruleId`.
 *   - `{ manualOnlyCriterion: Criterion, inputCriterionId }` — input
 *     was a criterion ID known to the registry but with NO automated
 *     rule satisfying it (every `automatable: "manual"` criterion).
 *     The handler builds a `kind: "guidance"` payload framed as
 *     "manual-review only — verify against the normative spec text"
 *     instead of returning a `rule-not-found` error envelope. Per
 *     `docs/kb/architecture/ai-first-consumer.md`: "Per-tool review-
 *     candidate shape must agree across surfaces" — `checklist` ships
 *     these criteria as addressable items the agent walks via
 *     `suggest_fix`; the per-call surface MUST address them honestly.
 *   - `{ error: McpToolResult }` — input was a criterion ID NOT known
 *     to the registry (typo, unsupported standard prefix). The
 *     rule-not-found envelope still fires here because the criterion
 *     itself doesn't exist; this is distinct from the manual-only
 *     case where the criterion is real but un-automated.
 *
 * `inputCriterionId` is set ONLY when the caller passed a criterion ID
 * — not on a rule-ID input. The candidate-bridge in
 * `suggest-fix-candidate-bridge.ts` reads it to scope finder lookup to
 * the criterion the agent actually asked about; rule-ID inputs fall
 * back to the rule's full `satisfies[]` list.
 */
export function applyCriterionBridge(
  inputRuleId: string,
  session: McpSession,
):
  | { readonly error: McpToolResult }
  | {
      readonly manualOnlyCriterion: Criterion;
      readonly inputCriterionId: string;
    }
  | {
      readonly ruleId: string;
      readonly disambiguationNote?: string;
      readonly inputCriterionId?: string;
    } {
  const resolution = resolveCriterionInput(inputRuleId, session);
  if (resolution === null) return { ruleId: inputRuleId };
  if (resolution.kind === "unknown") {
    // Distinguish "criterion exists in registry but no rule satisfies"
    // from "criterion ID not recognized at all." The first case routes
    // to manual-review guidance; the second is a real error envelope.
    // Per CLAUDE.md §1 "Per-tool review-candidate shape must agree
    // across surfaces" — `checklist` candidates carrying this
    // criterion ID must address from `suggest_fix`.
    const criterion = session.registry.findCriterion(inputRuleId);
    if (criterion !== undefined) {
      return { manualOnlyCriterion: criterion, inputCriterionId: inputRuleId };
    }
    return {
      error: errorResult({
        code: "rule-not-found",
        message: `No rule satisfies criterion '${inputRuleId}'.`,
        details: { requested: inputRuleId },
        remediation:
          "Call `list_rules` to discover valid rule IDs, or `explain_standard` to see this criterion's coverage.",
      }),
    };
  }
  const base = { ruleId: resolution.ruleId, inputCriterionId: inputRuleId } as const;
  return resolution.note === undefined ? base : { ...base, disambiguationNote: resolution.note };
}

/**
 * Combines {@link applyCriterionBridge} with the rule-existence check
 * the handler ran inline pre-Q14, returning the bridge's three honest
 * outcomes (error / manual-only-criterion / resolved-rule) plus the
 * `Rule` record the rule path resolves to. Extracted so the
 * suggest_fix handler stays under the 150-effective-line cap enforced
 * by `scripts/check-limits.ts`.
 *
 * The `manualOnlyCriterion` branch passes through unchanged — there is
 * no `Rule` to look up because no rule satisfies the criterion. The
 * caller routes this branch to a `kind: "guidance"` payload framed as
 * "manual-review only" rather than a rule-not-found envelope.
 */
export function resolveSuggestFixRule(
  inputRuleId: string,
  session: McpSession,
):
  | { readonly error: McpToolResult }
  | {
      readonly manualOnlyCriterion: Criterion;
      readonly inputCriterionId: string;
    }
  | {
      readonly rule: Rule;
      readonly ruleId: string;
      readonly disambiguationNote?: string;
      readonly inputCriterionId?: string;
    } {
  const bridge = applyCriterionBridge(inputRuleId, session);
  if ("error" in bridge) return bridge;
  if ("manualOnlyCriterion" in bridge) return bridge;
  const rule = findRule(bridge.ruleId, session);
  if (!rule) {
    return {
      error: errorResult({
        code: "rule-not-found",
        message: `Rule '${bridge.ruleId}' not found.`,
        details: { requested: bridge.ruleId },
        remediation: "Call `list_rules` to discover valid rule IDs.",
      }),
    };
  }
  return { rule, ...bridge };
}

/**
 * Bridge resolution + early-exit routing for the suggest_fix handler:
 * resolves the input through {@link resolveSuggestFixRule} and routes
 * the three terminal branches (error envelope, manual-only-criterion
 * guidance, rule-not-found) into a single `earlyExit` discriminator
 * the handler returns directly. The resolved-rule path returns the
 * `{ ruleId, disambiguationNote }` pair the rest of the handler
 * proceeds with.
 *
 * Lives in this module (alongside the bridge primitives) so the
 * MCP handler in `tool-suggest-fix.ts` stays under the
 * 150-effective-line cap enforced by `scripts/check-limits.ts`.
 */
export function resolveCriterionBridgeOrEarlyExit(
  inputRuleId: string,
  filePath: string,
  line: number,
  session: McpSession,
):
  | { readonly earlyExit: McpToolResult }
  | { readonly ruleId: string; readonly disambiguationNote: string | undefined } {
  const resolved = resolveSuggestFixRule(inputRuleId, session);
  if ("error" in resolved) return { earlyExit: resolved.error };
  if ("manualOnlyCriterion" in resolved) {
    return {
      earlyExit: manualOnlyCriterionResult(
        { criterion: resolved.manualOnlyCriterion, inputCriterionId: resolved.inputCriterionId },
        filePath,
        line,
      ),
    };
  }
  return { ruleId: resolved.ruleId, disambiguationNote: resolved.disambiguationNote };
}

/**
 * Conditional-spread of the optional `BuildSuggestFixPayloadArgs`
 * fields the `suggest_fix` handler computes inline (`warnings` from
 * the scan-confidence helper, `vendorContext` from
 * `detectVendorContext`, `disambiguationNote` from the criterion-id
 * bridge). Centralized here so the handler stays under the
 * 150-effective-line cap and the present-when-meaningful spread shape
 * stays in one place — every new optional field added here keeps the
 * call site flat.
 */
export function optionalSuggestFixFields(
  scanWarnings: readonly string[],
  vendorContext: VendorContext | null,
  disambiguationNote: string | undefined,
): {
  readonly warnings?: readonly string[];
  readonly vendorContext?: VendorContext;
  readonly disambiguationNote?: string;
} {
  return {
    ...(scanWarnings.length > 0 ? { warnings: scanWarnings } : {}),
    ...(vendorContext === null ? {} : { vendorContext }),
    ...(disambiguationNote === undefined ? {} : { disambiguationNote }),
  };
}
