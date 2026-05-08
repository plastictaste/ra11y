// ra11y-limits-exempt: four-lane outcome composer (edit / guidance / suppress-recommended / poisoned-drop) sharing one sanitize+widen pipeline; splitting further scatters the outcome shape across tiny files and obscures the discriminator partition.

/**
 * Builds the `kind: "edit"` / `kind: "guidance"` /
 * `kind: "suppress-recommended"` branches of `buildSuggestFixPayload`
 * when the matched violation carries `fixPaths`. Extracted into its own
 * module so the parent file stays under the MCP-handler line budget
 * (`scripts/check-limits.ts`).
 *
 * Four concerns layered into one outcome:
 *   1. Template-directive poison sanitization on primary + alternatives
 *      (see `suggest-fix-sanitize.ts`).
 *   2. `widenToUniqueAnchor` so apply_fix's literal find-and-replace
 *      has exactly one match site (see `unique-anchor.ts`).
 *   3. `kind` split: mechanical-edit lane keeps the flat FixPath shape;
 *      guidance lane nests under `primary: { approach, explanation,
 *      sourceContext, confidence }` with optional `alternatives` per
 *      Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY; suppress-recommended
 *      partition based on suggestion-text predicate (see
 *      `suggest-fix-suppress-recommended.ts`).
 *   4. Caveat re-threading on the suppress-recommended branch so the
 *      template-directive poison drop and widen-anchor non-unique
 *      check still surface alongside the partition.
 *
 * Pure function, no I/O.
 */

import type { Confidence } from "../output/agent-response/types.ts";
import type { FixClass } from "../types/rule.ts";
import type { FixPath, Violation } from "../types/violation.ts";
import { widenToUniqueAnchor } from "../utils/unique-anchor.ts";
import {
  buildGuidanceAlternatives,
  buildPerCallEnrichmentAlternatives,
  type VerifyCommandStructured,
} from "./suggest-fix-guidance-shape.ts";
import { POISONED_NEWTEXT_CAVEAT, sanitizeFixPathAgainstPoison } from "./suggest-fix-sanitize.ts";
import {
  buildSuppressRecommendedOutcome,
  isSuppressionFlavoredSuggestion,
} from "./suggest-fix-suppress-recommended.ts";

export interface BuildFixPathsOutcomeInputs {
  readonly match: Violation;
  readonly source: string;
  readonly line: number;
  readonly sourceContext: string;
  /**
   * Per-call `primary.confidence` carried forward from the source
   * finding via {@link resolveConfidence} (agent-response/build-finding).
   * Widened from the prior `"high" | "medium"` ladder to the full
   * {@link Confidence} union so the per-call surface honours rule-
   * emitted `low` / `inherited` / info-severity emissions instead of
   * rounding them into `medium`. The drift was the canonical Q16-
   * confidence-drift case: scan_project shipped `confidence: low` for
   * an info-severity finding while suggest_fix on the same id shipped
   * `medium`. Per docs/kb/architecture/ai-first-consumer.md "Per-call
   * shape must agree with per-class plan tally."
   */
  readonly confidence: Confidence;
  readonly snippetField: { readonly snippet?: string };
  readonly verify: {
    readonly verifyCommandStructured: VerifyCommandStructured;
  };
  readonly warningsField: { readonly warnings?: readonly string[] };
  /**
   * Conditional-spread for the criterion-input → rule resolution note
   * (suggest_fix criterion-id bridge). When the caller passed a
   * criterion ID and multiple rules satisfy it, the handler resolves to
   * the most-specific rule (smallest `satisfies.length`, alphabetic
   * tiebreak) and threads the explanation here. Singleton resolution
   * and rule-ID input both leave the spread empty. Forwarded onto the
   * mechanical-edit AND guidance lanes so the resolution disclosure is
   * visible regardless of outcome shape.
   */
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
  /**
   * forwarded verbatim from the
   * caller (`buildSuggestFixPayload`). `false` / `undefined` triggers
   * the strip of the rule-emitted Tailwind escape-hatch sentence from
   * `explanation` (`focus/outline-visible` is the current sole emitter
   * of that sentence); `true` keeps the hint intact for a Tailwind
   * project. Local to suggest_fix's guidance-composition path —
   * other formatters consume `match.suggestion` verbatim.
   */
  readonly tailwindDetected?: boolean;
}

/**
 * See {@link tool-suggest-fix-internals.TAILWIND_HINT_PREFIX}. Local
 * copy keeps the strip helper independent of the parent module so the
 * `kind: "edit"` and `kind: "guidance"` lanes both apply the same
 * rule without a circular import.
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

/**
 * Per-call `kind` discriminator for the no-mechanical-edit guidance
 * branches. Mirrors `plan.fixesByClass` lane keys so the per-call shape
 * agrees with the per-class plan tally on the same finding (per
 * `docs/kb/architecture/ai-first-consumer.md` "Per-call shape must
 * agree with per-class plan tally"):
 *
 *   - `runtime-only` → `kind: "runtime-only"` — the rule flagged a
 *     pattern only runtime verification can decide; the agent should
 *     route to a runtime harness rather than the edit queue.
 *   - `verify-in-source` → `kind: "verify-in-source"` — the agent has
 *     to read adjacent code to decide the right fix (cross-file handler
 *     binding, parent-element placement, list re-nesting).
 *   - everything else → `kind: "guidance"` — judgment-required prose
 *     fix (contrast ratios, copy rewrites, restructure decisions).
 *
 * The `mechanical` lane stays out of this helper — the mechanical-edit
 * branch above this routing emits `kind: "edit"` directly. When a
 * mechanical-fixClass rule's `fixPaths.primary.edit` is dropped (e.g.
 * by template-directive poison sanitization), the residual outcome is
 * generic guidance — the lane lost its "edit" status, so falling back
 * to `kind: "guidance"` is honest.
 *
 * Pure function over its input; the `match.fixClass` enum is the only
 * input.
 */
export function kindFromFixClass(
  fixClass: FixClass,
): "runtime-only" | "verify-in-source" | "guidance" {
  if (fixClass === "runtime-only") return "runtime-only";
  if (fixClass === "verify-in-source") return "verify-in-source";
  return "guidance";
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
    disambiguationNoteField,
    tailwindDetected,
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
  // strip the rule-emitted
  // Tailwind escape-hatch sentence from the explanation when no
  // Tailwind signal was detected in the suggest_fix scan. Applies to
  // both the mechanical-edit lane and the guidance lane below since
  // both surface this same `explanation` to the agent.
  const explanation = stripContextBlindTailwindHint(
    match.suggestion ?? match.message,
    tailwindDetected,
  );
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
      ...disambiguationNoteField,
    };
  }
  // Guidance lane (Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY): nest
  // `approach` + `explanation` + `sourceContext` + `confidence` under
  // a ranked `primary` block, matching the tool description's
  // advertised shape. `alternatives` is conditional-spread — omitted
  // when there are no sibling paths (present-when-meaningful per
  // CLAUDE.md §1 "Ambiguous field shapes are dishonest").
  //
  // The previous `meta.mechanicalInPrinciple` annotation was dropped
  // (closure path (a) per docs/kb/architecture/ai-first-consumer.md
  // "Per-call shape must agree with per-class plan tally") — shipping
  // `meta.mechanicalInPrinciple: true` alongside `kind: "guidance"`
  // was itself the contradiction the rule warns against. Cross-surface
  // honesty now flows entirely through `plan.fixesByClass`.
  // Rule-supplied alternatives win when present (richer signal than
  // generic enrichments). When the rule supplied none, fall back to
  // per-call enrichments derived from filePath + criteria so the
  // advertised slot is real rather than a phantom — same closure as
  // the prose-only fallback lane in `tool-suggest-fix-routing.ts`.
  const guidanceAlternatives =
    buildGuidanceAlternatives(alternatives) ??
    buildPerCallEnrichmentAlternatives(match.location.filePath, match.location.line);
  // When the rule's suggestion text concedes via "suppress with …
  // ra11y-disable …" prose, the honest discriminator is
  // `kind: "suppress-recommended"` — same parity as the prose-only
  // fallback lane in `tool-suggest-fix-routing.ts`. The caveat field
  // (template-directive poison drop, widen-anchor non-unique) still
  // rides since both signals are independent of the suppress framing.
  if (isSuppressionFlavoredSuggestion(explanation)) {
    return buildSuppressRecommendedFixPathsOutcome({
      explanation,
      label: primary.label,
      sourceContext,
      confidence,
      match,
      snippetField,
      verify,
      warningsField,
      disambiguationNoteField,
      guidanceAlternatives,
      caveatField,
    });
  }
  // Per-call `kind` mirrors `plan.fixesByClass` lane keys when the rule
  // routes into `runtime-only` or `verify-in-source`. The mechanical-
  // edit lane already returned above; the suppress-recommended branch
  // already returned above; this fallthrough is the
  // guidance-or-lane-mirror partition. See `kindFromFixClass` for the
  // doctrine rationale.
  return {
    kind: kindFromFixClass(match.fixClass),
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
    ...disambiguationNoteField,
  };
}

/**
 * Builds the `kind: "suppress-recommended"` payload for the
 * fixPaths-with-no-mechanical-edit branch. Extracted so
 * {@link buildFixPathsOutcome} stays under the cognitive-complexity
 * cap (`scripts/check-limits.ts`). Re-threads the caveat field after
 * delegating to {@link buildSuppressRecommendedOutcome}: the
 * template-directive poison drop and the widen-anchor non-unique
 * check are independent of the suppress framing, but
 * {@link buildSuppressRecommendedOutcome} doesn't know about either
 * — the parent's caveat already covers them, so we splice it back in
 * after the outcome is composed.
 */
function buildSuppressRecommendedFixPathsOutcome(args: {
  readonly explanation: string;
  readonly label: string;
  readonly sourceContext: string;
  readonly confidence: Confidence;
  readonly match: Violation;
  readonly snippetField: { readonly snippet?: string };
  readonly verify: BuildFixPathsOutcomeInputs["verify"];
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
  readonly guidanceAlternatives:
    | ReadonlyArray<{ readonly approach: string; readonly explanation: string }>
    | undefined;
  readonly caveatField: { readonly caveat?: string };
}): Record<string, unknown> {
  const base = buildSuppressRecommendedOutcome({
    explanation: args.explanation,
    approach: args.label,
    sourceContext: args.sourceContext,
    confidence: args.confidence,
    criteria: args.match.criteria,
    filePath: args.match.location.filePath,
    snippetField: args.snippetField,
    verify: args.verify,
    warningsField: args.warningsField,
    disambiguationNoteField: args.disambiguationNoteField,
    ...(args.guidanceAlternatives ? { alternatives: args.guidanceAlternatives } : {}),
  });
  return Object.keys(args.caveatField).length > 0 ? { ...base, ...args.caveatField } : base;
}
