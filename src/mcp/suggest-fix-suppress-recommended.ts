/**
 * Detection + payload helper for the `kind: "suppress-recommended"`
 * outcome of `suggest_fix`.
 *
 * Background — doctrine motivation:
 * `suggest_fix` historically returned `kind: "guidance"` for two
 * categorically different shapes:
 *
 *   1. Structural recommendation prose ("widen aria-label to contain
 *      the visible text", "promote <h2> to <h1>") — a real fix
 *      direction the agent can pursue.
 *   2. "I give up — please verify and add a pragma" prose ("if this
 *      page is rendered inside a parent layout that supplies the
 *      title, suppress with <!-- ra11y-disable wcag22:1.3.1 -->") — a
 *      concession that the rule's evidence model can't honestly resolve
 *      this case and the deterministic escape hatch is the source-level
 *      disable.
 *
 * Both shapes shipped under the same discriminator, so the agent's
 * branching had to inspect the prose to tell them apart — the canonical
 * "Ambiguous field shapes are dishonest" failure mode at the response-
 * shape level. Splitting `kind: "suppress-recommended"` from `kind:
 * "guidance"` gives the agent a structural lever it can branch on
 * without parsing English.
 *
 * Detection predicate:
 *   The suggestion prose mentions `ra11y-disable` (the canonical pragma
 *   token) OR includes the cue phrase "suppress with" — both signals
 *   the rule itself emits when its evidence model concedes the
 *   criterion may not apply on this substrate. We deliberately do NOT
 *   match generic phrases like "verify" / "if this is" because those
 *   ride on plenty of legitimate `kind: "guidance"` returns where the
 *   recommended fix is a real edit, just one the agent has to verify
 *   first. The token `ra11y-disable` is provable from rule emission
 *   sites and never fires accidentally.
 *
 * Pure functions, no I/O. Lives in its own file so
 * `tool-suggest-fix-routing.ts` and `tool-suggest-fix-fixpaths.ts` can
 * both import the predicate without crossing through the parent
 * internals module.
 */

import type { Violation } from "../types/violation.ts";
import { isSuppressionFlavoredSuggestion } from "../utils/suppression-flavored-suggestion.ts";
import { pragmaFormForExtension } from "./checklist-suppress-pragma.ts";

// Re-export the underlying string predicate so call sites that
// already reach into this module for the outcome builder can keep a
// single import surface. The pure-string form lives in
// `src/utils/suppression-flavored-suggestion.ts` so plan-tally code
// in `src/output/agent-response/` can consume it without crossing
// into `src/mcp/` (which would create a cycle).
export { isSuppressionFlavoredSuggestion };

/**
 * Predicate over a {@link Violation} — the per-violation form of
 * {@link isSuppressionFlavoredSuggestion}. Used by `countFixesByClass`
 * to route suppression-flavored emissions into the
 * `fixesByClass.suppressRecommended` lane instead of their declared
 * `fixClass` lane (typically `guidance` or `verify-in-source`). The
 * declared `fixClass` stays accurate at the rule level (the rule's
 * remediation lane describes the typical case); the per-violation
 * predicate names the per-emission deviation.
 */
export function isSuppressionFlavoredViolation(violation: Violation): boolean {
  return isSuppressionFlavoredSuggestion(violation.suggestion);
}

/**
 * Build the `kind: "suppress-recommended"` response shape for a
 * suppression-flavored guidance emission. The shape mirrors the
 * `kind: "guidance"` branch — same `primary` / `alternatives` / verify
 * pair — but the discriminator names the actual answer the rule's
 * prose advances ("verify, then add a pragma if intentional"). Per
 * `docs/kb/architecture/ai-first-consumer.md` "Ambiguous field shapes
 * are dishonest," the field is present-when-meaningful: when no
 * criterion is available to scope the pragma, we still emit the
 * discriminator (the prose itself is the load-bearing signal), but
 * `pragma` is omitted.
 *
 * Crucially, the response carries NO `newText` and NO `fixPaths.edit`
 * — there is no edit to apply, just a pragma the agent pastes after
 * verifying. This matches the per-call doctrine "Per-call shape must
 * agree with per-class plan tally": the response advertises a
 * suppress-recommended emission, and `plan.fixesByClass.suppressRecommended`
 * counts the same predicate.
 */
export function buildSuppressRecommendedOutcome(args: {
  readonly explanation: string;
  readonly approach: string;
  readonly sourceContext: string;
  readonly confidence: "high" | "medium" | "low";
  readonly criteria: readonly string[];
  readonly filePath: string;
  readonly snippetField: { readonly snippet?: string };
  readonly verify: Record<string, unknown>;
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
  readonly vendorContextField?: { readonly vendorContext?: unknown };
  readonly alternatives?: ReadonlyArray<{
    readonly approach: string;
    readonly explanation: string;
  }>;
}): Record<string, unknown> {
  const {
    explanation,
    approach,
    sourceContext,
    confidence,
    criteria,
    filePath,
    snippetField,
    verify,
    warningsField,
    disambiguationNoteField,
    vendorContextField,
    alternatives,
  } = args;
  // Pragma is scoped to the first criterion the violation cites. A bare
  // `ra11y-disable` would silence every rule on the surrounding region —
  // dishonest scope. Omitted when the violation has no criteria so the
  // shape stays present-when-meaningful (CLAUDE.md §1).
  const firstCriterion = criteria[0];
  const pragmaField =
    firstCriterion === undefined
      ? {}
      : {
          pragma: pragmaFormForExtension(filePath, firstCriterion),
          criterionId: firstCriterion,
        };
  return {
    kind: "suppress-recommended",
    primary: {
      approach,
      explanation,
      sourceContext,
      confidence,
    },
    ...(alternatives && alternatives.length > 0 ? { alternatives } : {}),
    ...pragmaField,
    ...snippetField,
    ...verify,
    ...warningsField,
    ...disambiguationNoteField,
    ...(vendorContextField ?? {}),
  };
}
