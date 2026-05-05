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
import type { McpSession } from "./session.ts";
import type { VendorContext } from "./suggest-fix-vendor-context.ts";
import type { McpToolResult } from "./tools-helpers.ts";
import { errorResult } from "./tools-helpers.ts";

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
 * Three-way resolution of the `suggest_fix` `ruleId` param: either an
 * immediate error envelope (criterion ID with no satisfying rule), or
 * a `{ ruleId, disambiguationNote?, inputCriterionId? }` triple the
 * rest of the handler proceeds with. Centralizes the criterion-id
 * bridge so the `tool-suggest-fix.ts` handler body stays under the
 * 150-effective-line cap. See {@link resolveCriterionInput} for the
 * underlying resolution rules.
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
      readonly ruleId: string;
      readonly disambiguationNote?: string;
      readonly inputCriterionId?: string;
    } {
  const resolution = resolveCriterionInput(inputRuleId, session);
  if (resolution === null) return { ruleId: inputRuleId };
  if (resolution.kind === "unknown") {
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
