/**
 * Builds the `kind: "guidance"` response for `suggest_fix` when the
 * target line carries a template directive (Mustache/Handlebars,
 * Liquid/Jinja, ERB/EJS, JSP, JS template literal) AND the rule's
 * canonical suggestion text is a literal "fill in / rename to a hard-
 * coded value" recommendation. Restricted via
 * {@link TEMPLATE_DIRECTIVE_REROUTE_RULES} to rules where the reroute
 * is honest (`semantics/empty-heading` today).
 *
 * Sibling case: when the rule is `parsing/duplicate-id` and the id on
 * the target line collides with the slugified text of a later ATX
 * heading in the same source, the response reroutes to the
 * markdown-heading-collision lane instead — same restructure shape,
 * different primary prose. Both lanes are mutually exclusive at the
 * caller level.
 *
 * Doctrine bar (`docs/kb/architecture/ai-first-consumer.md`):
 *   - "Reason / priority / fix-description must agree across all three
 *     channels" — when the heading's binding interpolates at render
 *     time, the rule's `fix.description` ("fill with primary section
 *     title") contradicts the static-evidence reality. The reroute
 *     surfaces the actual question (binding can resolve to empty?) on
 *     the primary lane.
 *   - "Surface, don't suppress" — the rule's original suggestion stays
 *     in `alternatives[0]` so the agent can still see the literal text
 *     if forking the binding is the chosen path.
 *
 * Pure function, no I/O. Sibling of `tool-suggest-fix-vendor.ts`
 * (the vendor-classified file reroute); both feed the per-call
 * restructure path in `tool-suggest-fix-internals.ts`.
 */

import type { Violation } from "../types/violation.ts";
import type { VerifyCommandStructured } from "./suggest-fix-guidance-shape.ts";
import {
  buildMarkdownHeadingCollisionExplanation,
  buildVerifyBindingPrimaryExplanation,
  HARDCODE_FALLBACK_ALTERNATIVE_APPROACH,
  type MarkdownHeadingIdCollision,
  RESOLVE_MARKDOWN_COLLISION_PRIMARY_APPROACH,
  type TemplateDirectiveContext,
  VERIFY_BINDING_PRIMARY_APPROACH,
} from "./suggest-fix-template-directive.ts";

export interface BuildTemplateDirectiveOutcomeInputs {
  readonly ruleId: string;
  readonly match: Violation;
  readonly templateDirectiveContext: TemplateDirectiveContext;
  readonly sourceContext: string;
  readonly snippetField: { readonly snippet?: string };
  readonly verify: {
    readonly verifyCommandStructured: VerifyCommandStructured;
  };
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
}

export interface BuildMarkdownHeadingCollisionOutcomeInputs {
  readonly ruleId: string;
  readonly match: Violation;
  readonly collision: MarkdownHeadingIdCollision;
  readonly sourceContext: string;
  readonly snippetField: { readonly snippet?: string };
  readonly verify: {
    readonly verifyCommandStructured: VerifyCommandStructured;
  };
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
}

/**
 * Builds the verify-binding-at-render-time `kind: "guidance"` response.
 * `confidence` on the primary lane is fixed to `"medium"` — directive
 * presence is high-confidence (regex match on token bytes), but the
 * *actual binding behavior* (does it ever resolve to empty?) depends on
 * evidence the suggest_fix surface doesn't have (data fixtures, render
 * pipeline, fallback chain). `"medium"` matches the existing convention
 * the vendor-reroute lane uses for "right approach, exact phrasing-
 * yours-to-confirm" — see `tool-suggest-fix-vendor.ts`.
 *
 * `verifyCommandStructured` rides at top level: the agent can re-scan
 * after adding a fallback / suppression to confirm the underlying
 * violation no longer fires. The reroute does not invalidate the
 * verify surface (Surface-don't-suppress).
 */
export function buildTemplateDirectiveOutcome(
  inputs: BuildTemplateDirectiveOutcomeInputs,
): Record<string, unknown> {
  const {
    ruleId,
    match,
    templateDirectiveContext,
    sourceContext,
    snippetField,
    verify,
    warningsField,
    disambiguationNoteField,
  } = inputs;
  const overrideExplanation = buildVerifyBindingPrimaryExplanation(
    ruleId,
    templateDirectiveContext,
  );
  // Demote the rule's original suggestion as the alternative
  // explanation. Falls back to `match.message` when the rule did not
  // emit a suggestion (defense-in-depth — every emitted finding has a
  // message even when `suggestion` is absent).
  const originalExplanation = match.suggestion ?? match.message;
  const alternatives: ReadonlyArray<{ readonly approach: string; readonly explanation: string }> = [
    {
      approach: HARDCODE_FALLBACK_ALTERNATIVE_APPROACH,
      explanation: originalExplanation,
    },
  ];
  return {
    kind: "guidance",
    primary: {
      approach: VERIFY_BINDING_PRIMARY_APPROACH,
      explanation: overrideExplanation,
      sourceContext,
      confidence: "medium",
    },
    alternatives,
    ...snippetField,
    ...verify,
    ...warningsField,
    ...disambiguationNoteField,
    templateDirectiveContext,
  };
}

/**
 * Builds the markdown-heading-collision `kind: "guidance"` response.
 * Same restructure shape as the template-directive lane; the primary
 * prose names the collision pair and the two resolution paths
 * (remove-explicit-id vs change-heading-text).
 *
 * `confidence` on the primary lane is fixed to `"medium"` — the
 * collision detection is high-confidence (slug match + heading line is
 * deterministic from the source), but *which side the agent should
 * change* depends on inbound-link evidence the suggest_fix surface
 * doesn't have. `"medium"` matches the convention.
 */
export function buildMarkdownHeadingCollisionOutcome(
  inputs: BuildMarkdownHeadingCollisionOutcomeInputs,
): Record<string, unknown> {
  const {
    ruleId,
    match,
    collision,
    sourceContext,
    snippetField,
    verify,
    warningsField,
    disambiguationNoteField,
  } = inputs;
  const overrideExplanation = buildMarkdownHeadingCollisionExplanation(ruleId, collision);
  const originalExplanation = match.suggestion ?? match.message;
  const alternatives: ReadonlyArray<{ readonly approach: string; readonly explanation: string }> = [
    {
      approach: HARDCODE_FALLBACK_ALTERNATIVE_APPROACH,
      explanation: originalExplanation,
    },
  ];
  return {
    kind: "guidance",
    primary: {
      approach: RESOLVE_MARKDOWN_COLLISION_PRIMARY_APPROACH,
      explanation: overrideExplanation,
      sourceContext,
      confidence: "medium",
    },
    alternatives,
    ...snippetField,
    ...verify,
    ...warningsField,
    ...disambiguationNoteField,
    markdownHeadingCollision: collision,
  };
}
