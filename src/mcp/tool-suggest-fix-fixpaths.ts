/**
 * Builds the `kind: "edit"` or `kind: "guidance"` branch of
 * `buildSuggestFixPayload` when the matched violation carries
 * `fixPaths`. Extracted into its own module so the parent file stays
 * under the MCP-handler line budget (`scripts/check-limits.ts`).
 *
 * Three concerns layered into one outcome:
 *   1. Template-directive poison sanitization on primary + alternatives
 *      (see `suggest-fix-sanitize.ts`).
 *   2. `widenToUniqueAnchor` so apply_fix's literal find-and-replace
 *      has exactly one match site (see `unique-anchor.ts`).
 *   3. `kind` split: mechanical-edit lane keeps the flat FixPath shape,
 *      guidance lane nests under `primary: { approach, explanation,
 *      sourceContext, confidence }` with optional `alternatives` per
 *      Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY.
 *
 * Pure function, no I/O.
 */

import type { FixPath, Violation } from "../types/violation.ts";
import {
  buildGuidanceAlternatives,
  type VerifyCommandStructured,
} from "./suggest-fix-guidance-shape.ts";
import { POISONED_NEWTEXT_CAVEAT, sanitizeFixPathAgainstPoison } from "./suggest-fix-sanitize.ts";
import { widenToUniqueAnchor } from "./unique-anchor.ts";

export interface BuildFixPathsOutcomeInputs {
  readonly match: Violation;
  readonly source: string;
  readonly line: number;
  readonly sourceContext: string;
  readonly confidence: "high" | "medium";
  readonly snippetField: { readonly snippet?: string };
  readonly verify: {
    readonly verifyCommand: string;
    readonly verifyCommandStructured: VerifyCommandStructured;
  };
  readonly warningsField: { readonly warnings?: readonly string[] };
  /**
   * Pre-built `{ meta: { mechanicalInPrinciple: true } }` spread (or
   * `{}` when not applicable) computed by the caller from the matched
   * violation's `fixClass`. Forwarded verbatim onto the guidance lane
   * so agents reading a `kind: "guidance"` response learn that the rule
   * family supports a mechanical path in principle — even though the
   * specific context made the replacement ambiguous. See Q6-SUGGEST-
   * FIX-MECHANICAL-VS-GUIDANCE-DRIFT. Not emitted on the `kind: "edit"`
   * lane (the edit is concrete; the in-principle hint would be noise).
   */
  readonly mechanicalInPrincipleField: {
    readonly meta?: { readonly mechanicalInPrinciple: true };
  };
}

export function buildFixPathsOutcome(inputs: BuildFixPathsOutcomeInputs): Record<string, unknown> {
  const {
    match,
    source,
    line,
    sourceContext,
    confidence,
    snippetField,
    verify,
    warningsField,
    mechanicalInPrincipleField,
  } = inputs;
  const fixPaths = match.fixPaths;
  if (fixPaths === undefined) {
    throw new Error(
      "ra11y internal invariant: buildFixPathsOutcome called without match.fixPaths. This helper is only invoked from the `if (match.fixPaths)` branch of buildSuggestFixPayload; reaching it indicates a refactor missed a caller. Please file an issue with the ruleId of the offending match.",
    );
  }
  // Sanitize both primary and alternatives against template-directive
  // poisoning of `newText` BEFORE any widen step. A poisoned primary
  // drops out of the mechanical-edit lane entirely — we don't want to
  // widen or emit it — and alternatives are rebuilt with their
  // poisoned structured edits stripped. See CLAUDE.md §1 "Ambiguous
  // field shapes are dishonest" and docs/kb/architecture/ai-first-
  // consumer.md "Surface, don't suppress": an honest drop + caveat
  // beats a confident-wrong newText an agent might paste verbatim.
  const sanitizedPrimary = sanitizeFixPathAgainstPoison(fixPaths.primary);
  const sanitizedAlternatives = fixPaths.alternatives.map((alt) =>
    sanitizeFixPathAgainstPoison(alt),
  );
  const anyPoisonDropped =
    sanitizedPrimary.editDropped ||
    sanitizedPrimary.candidateDropped ||
    sanitizedAlternatives.some((a) => a.editDropped || a.candidateDropped);
  const mechanical = sanitizedPrimary.path.edit;
  const widened = mechanical
    ? widenToUniqueAnchor({
        source,
        oldText: mechanical.oldText,
        newText: mechanical.newText,
        line,
      })
    : null;
  const primary: FixPath = widened
    ? {
        ...sanitizedPrimary.path,
        edit: { oldText: widened.oldText, newText: widened.newText },
      }
    : sanitizedPrimary.path;
  const alternatives = sanitizedAlternatives.map((a) => a.path);
  // Caveat precedence: the template-directive drop and the widen's
  // "non-unique anchor" caveat are independent signals — concat when
  // both fire so the agent sees both reasons. Unchanged otherwise.
  const caveatParts: string[] = [];
  if (anyPoisonDropped) caveatParts.push(POISONED_NEWTEXT_CAVEAT);
  if (widened?.caveat) caveatParts.push(widened.caveat);
  const caveatField = caveatParts.length > 0 ? { caveat: caveatParts.join(" ") } : {};
  const explanation = match.suggestion ?? match.message;
  if (mechanical) {
    // Mechanical-edit lane: `primary` stays the structured `FixPath`
    // (carrying `edit` / optional `editCandidate`) so agents can apply
    // the find-and-replace directly. `alternatives` is always present
    // — it is the rule's ranked list of other paths and remains a
    // schema-required field on the edit shape.
    return {
      kind: "edit",
      primary,
      alternatives,
      explanation,
      ...snippetField,
      ...caveatField,
      sourceContext,
      confidence,
      ...verify,
      ...warningsField,
    };
  }
  // Guidance lane (Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY): nest
  // `approach` + `explanation` + `sourceContext` + `confidence` under
  // a ranked `primary` block, matching the tool description's
  // advertised shape. `alternatives` is conditional-spread — omitted
  // when there are no sibling paths (present-when-meaningful per
  // CLAUDE.md §1 "Ambiguous field shapes are dishonest").
  const guidanceAlternatives = buildGuidanceAlternatives(alternatives);
  return {
    kind: "guidance",
    primary: {
      approach: primary.label,
      explanation,
      sourceContext,
      confidence,
    },
    ...(guidanceAlternatives ? { alternatives: guidanceAlternatives } : {}),
    ...snippetField,
    ...caveatField,
    ...verify,
    ...warningsField,
    ...mechanicalInPrincipleField,
  };
}
