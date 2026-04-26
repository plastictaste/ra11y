/**
 * Builds the `kind: "guidance"` response for `suggest_fix` when the
 * target file carries a {@link VendorContext} (build-artifact or
 * vendor-library banner match). Extracted into its own module to keep
 * `tool-suggest-fix-internals.ts` under the MCP-handler line budget
 * (`scripts/check-limits.ts` enforces ≤150 effective lines).
 *
 * The primary fix lane is the consumer-override recommendation
 * (composed by {@link buildOverridePrimaryExplanation}); the rule's
 * original mechanical edit / guidance is demoted to `alternatives[0]`
 * with the {@link IN_VENDOR_EDIT_ALTERNATIVE_APPROACH} label so the
 * agent still sees what the rule would have proposed against the vendor
 * source. `vendorContext` rides at top level so the agent reads the
 * deterministic evidence (signal kind, classification or library name)
 * that drove the restructure.
 *
 * Pure function, no I/O. Sibling of `tool-suggest-fix-fixpaths.ts`
 * (the non-vendor mechanical-edit + guidance lane); both are called
 * from `buildSuggestFixPayload` in mutually exclusive branches.
 */

import type { Violation } from "../types/violation.ts";
import type { VerifyCommandStructured } from "./suggest-fix-guidance-shape.ts";
import {
  buildOverridePrimaryExplanation,
  IN_VENDOR_EDIT_ALTERNATIVE_APPROACH,
  OVERRIDE_PRIMARY_APPROACH,
  type VendorContext,
} from "./suggest-fix-vendor-context.ts";

/**
 * See {@link tool-suggest-fix-internals.TAILWIND_HINT_PREFIX}. Local
 * copy keeps this module independent of the parent so the in-vendor
 * alternative's demoted explanation can apply the same
 * V1-SUGGEST-FIX-TAILWIND-HINT-SCOPED strip without a circular import.
 */
const TAILWIND_HINT_PREFIX = " If this element uses Tailwind's";

function stripContextBlindTailwindHint(
  text: string,
  tailwindDetected: boolean | undefined,
): string {
  if (tailwindDetected === true) return text;
  const index = text.indexOf(TAILWIND_HINT_PREFIX);
  if (index === -1) return text;
  return text.slice(0, index).trimEnd();
}

export interface BuildVendorOverrideOutcomeInputs {
  readonly match: Violation;
  readonly filePath: string;
  readonly vendorContext: VendorContext;
  readonly sourceContext: string;
  readonly tailwindDetected: boolean | undefined;
  readonly snippetField: { readonly snippet?: string };
  readonly verify: {
    readonly verifyCommand: string;
    readonly verifyCommandStructured: VerifyCommandStructured;
  };
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
  readonly vendorContextField: { readonly vendorContext?: VendorContext };
}

/**
 * Builds the override-shaped `kind: "guidance"` response. See the
 * file-level comment for design rationale.
 *
 * `confidence` on the primary lane is fixed to `"medium"` — the
 * override recommendation is the right action with high confidence
 * (the file IS vendor-classified by deterministic predicates), but
 * the *concrete selector* the agent should override depends on
 * evidence the suggest_fix surface doesn't fully see (which file in
 * the consumer codebase loads this artifact, what specificity the
 * consumer's existing overrides use). `"medium"` matches the
 * "right approach, exact phrasing-yours-to-confirm" semantics the
 * rest of the guidance lane uses for `severity: "warning"` findings.
 *
 * `verifyCommand` + `verifyCommandStructured` ride at top level — the
 * agent can re-scan the same vendor file to confirm the underlying
 * violation after the override lands, even though the edit happens
 * elsewhere. Surface-don't-suppress: a populated verify hint lets the
 * agent route a confirmation pass; the override path does not
 * invalidate the verify surface.
 */
export function buildVendorOverrideOutcome(
  inputs: BuildVendorOverrideOutcomeInputs,
): Record<string, unknown> {
  const {
    match,
    filePath,
    vendorContext,
    sourceContext,
    tailwindDetected,
    snippetField,
    verify,
    warningsField,
    disambiguationNoteField,
    vendorContextField,
  } = inputs;
  // Snippet (when the rule emitted one) is the most reliable hint at
  // *which* selector the override should target — it's the literal
  // source slice the rule flagged. When absent, the prose falls back
  // to "the failing selector flagged above" and relies on the
  // violation's `location.line` for the agent to read the file.
  const failingSelector = match.snippet === undefined ? undefined : match.snippet.trim();
  const overrideExplanation = buildOverridePrimaryExplanation(
    filePath,
    vendorContext,
    failingSelector,
  );
  // Demote the rule's original suggestion as the alternative
  // explanation. Strip the Tailwind escape-hatch sentence on the same
  // tailwindDetected predicate the sibling lanes use — the alternative
  // text is still subject to V1-SUGGEST-FIX-TAILWIND-HINT-SCOPED
  // because it's the same `match.suggestion` text the non-vendor lane
  // would have surfaced.
  const originalExplanation = match.suggestion
    ? stripContextBlindTailwindHint(match.suggestion, tailwindDetected)
    : match.message;
  const alternatives: ReadonlyArray<{ readonly approach: string; readonly explanation: string }> = [
    {
      approach: IN_VENDOR_EDIT_ALTERNATIVE_APPROACH,
      explanation: originalExplanation,
    },
  ];
  return {
    kind: "guidance",
    primary: {
      approach: OVERRIDE_PRIMARY_APPROACH,
      explanation: overrideExplanation,
      sourceContext,
      confidence: "medium",
    },
    alternatives,
    ...snippetField,
    ...verify,
    ...warningsField,
    ...disambiguationNoteField,
    ...vendorContextField,
  };
}
