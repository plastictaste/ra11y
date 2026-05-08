/**
 * Routing helpers for `buildSuggestFixPayload` — picks one of the
 * five outcome lanes (vendor-classified file, template-directive,
 * markdown-heading-id collision, rule-fixPaths, prose-only fallback)
 * based on which per-call context fields the handler computed.
 *
 * Lives in its own module so `tool-suggest-fix-internals.ts` stays
 * under the MCP-handler line budget enforced by
 * `scripts/check-limits.ts`. Each lane's outcome builder lives in its
 * own sibling module (`tool-suggest-fix-vendor.ts`,
 * `tool-suggest-fix-template-directive.ts`,
 * `tool-suggest-fix-fixpaths.ts`); this file just dispatches.
 *
 * Pure functions, no I/O.
 */

import { resolveConfidence } from "../output/agent-response/build-finding.ts";
import type { Confidence } from "../output/agent-response/types.ts";
import type { Violation } from "../types/violation.ts";
import {
  buildPerCallEnrichmentAlternatives,
  deriveApproachFromProse,
  type VerifyCommandStructured,
} from "./suggest-fix-guidance-shape.ts";
import {
  buildSuppressRecommendedOutcome,
  isSuppressionFlavoredSuggestion,
} from "./suggest-fix-suppress-recommended.ts";
import type { VendorContext } from "./suggest-fix-vendor-context.ts";
import { buildFixPathsOutcome, kindFromFixClass } from "./tool-suggest-fix-fixpaths.ts";
import type { BuildSuggestFixPayloadArgs } from "./tool-suggest-fix-payload-args.ts";
import {
  buildMarkdownHeadingCollisionOutcome,
  buildTemplateDirectiveOutcome,
} from "./tool-suggest-fix-template-directive.ts";
import { buildVendorOverrideOutcome } from "./tool-suggest-fix-vendor.ts";

/**
 * Per-call shared fields the routing helpers thread onto every
 * outcome branch (verify pair, warnings spread, disambiguation note,
 * vendor-context spread). Bundled into one object so the routing
 * helpers below take a single positional `shared` arg rather than 5
 * — keeping each helper under the cognitive-complexity cap.
 */
export interface PayloadSharedFields {
  readonly verify: {
    readonly verifyCommandStructured: VerifyCommandStructured;
  };
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
  readonly vendorContextField: { readonly vendorContext?: VendorContext };
}

/**
 * Marker for the rule-emitted Tailwind escape-hatch hint that the
 * `focus/outline-visible` rule appends to its `suggestion` text on
 * scoped selectors. Local copy mirrors the constant in the parent
 * module — kept in sync intentionally; a future-proof tightening on
 * either side requires an explicit cross-edit.
 */
const TAILWIND_HINT_PREFIX = " If this element uses Tailwind's";

function stripContextBlindTailwindHint(
  suggestion: string,
  tailwindDetected: boolean | undefined,
): string {
  if (tailwindDetected === true) return suggestion;
  const index = suggestion.indexOf(TAILWIND_HINT_PREFIX);
  if (index === -1) return suggestion;
  return suggestion.slice(0, index).trimEnd();
}

/**
 * Routes a matched-violation payload through the per-rule reroute lanes
 * (vendor-classified file → override-redirect; template-directive on
 * target line → verify-binding; markdown-heading-id collision →
 * resolve-collision; rule's own `fixPaths` → mechanical-edit/guidance;
 * fallback prose-only guidance). Returns the assembled payload record.
 *
 * Extracted into its own module so {@link buildSuggestFixPayload}
 * stays under the cognitive-complexity cap — each branch is
 * independent, but the cumulative `if` count pushes the parent past
 * the budget.
 */
export function routeMatchedPayload(args: {
  readonly args: BuildSuggestFixPayloadArgs;
  readonly match: Violation;
  readonly shared: PayloadSharedFields;
}): Record<string, unknown> {
  const { args: a, match, shared } = args;
  const snippetField = match.snippet ? { snippet: match.snippet } : {};
  if (a.vendorContext !== undefined) {
    return buildVendorOverrideOutcome({
      match,
      filePath: a.filePath,
      vendorContext: a.vendorContext,
      sourceContext: a.sourceContext,
      tailwindDetected: a.tailwindDetected,
      snippetField,
      verify: shared.verify,
      warningsField: shared.warningsField,
      disambiguationNoteField: shared.disambiguationNoteField,
      vendorContextField: shared.vendorContextField,
    });
  }
  if (a.templateDirectiveContext !== undefined) {
    return buildTemplateDirectiveOutcome({
      ruleId: a.ruleId,
      match,
      templateDirectiveContext: a.templateDirectiveContext,
      sourceContext: a.sourceContext,
      snippetField,
      verify: shared.verify,
      warningsField: shared.warningsField,
      disambiguationNoteField: shared.disambiguationNoteField,
    });
  }
  if (a.markdownHeadingCollision !== undefined) {
    return buildMarkdownHeadingCollisionOutcome({
      ruleId: a.ruleId,
      match,
      collision: a.markdownHeadingCollision,
      sourceContext: a.sourceContext,
      snippetField,
      verify: shared.verify,
      warningsField: shared.warningsField,
      disambiguationNoteField: shared.disambiguationNoteField,
    });
  }
  return routeMatchedFallback({ args: a, match, shared, snippetField });
}

/**
 * Tail of {@link routeMatchedPayload} — the rule-fixPaths branch and
 * the prose-only guidance fallback. Extracted so the parent stays
 * under the cognitive-complexity cap.
 */
function routeMatchedFallback(args: {
  readonly args: BuildSuggestFixPayloadArgs;
  readonly match: Violation;
  readonly shared: PayloadSharedFields;
  readonly snippetField: { readonly snippet?: string };
}): Record<string, unknown> {
  const { args: a, match, shared, snippetField } = args;
  // Carry forward the source finding's confidence rather than recompute
  // from severity. The previous local ladder
  // (`match.severity === "error" ? "high" : "medium"`) skipped the
  // `low` rung entirely, so an info-severity finding that scan_project
  // ships with `confidence: low` came back from suggest_fix as
  // `primary.confidence: medium` — the canonical drift the agent
  // budgeting against scan_project's confidence label cannot tell from
  // a real per-call upgrade. `resolveConfidence` is the same helper
  // `buildAgentFinding` uses, so the per-finding and per-call surfaces
  // partition the same finding into the same confidence bucket. Per
  // docs/kb/architecture/ai-first-consumer.md "Per-call shape must
  // agree with per-class plan tally" + "Per-tool review-candidate
  // shape must agree across surfaces."
  const confidence: Confidence = resolveConfidence(match);
  if (match.fixPaths) {
    return buildFixPathsOutcome({
      match,
      source: a.source,
      line: a.line,
      sourceContext: a.sourceContext,
      confidence,
      snippetField,
      verify: shared.verify,
      warningsField: shared.warningsField,
      disambiguationNoteField: shared.disambiguationNoteField,
      ...(a.tailwindDetected === undefined ? {} : { tailwindDetected: a.tailwindDetected }),
    });
  }
  const explanation = match.suggestion
    ? stripContextBlindTailwindHint(match.suggestion, a.tailwindDetected)
    : `Violation found but no fix guidance available for ${a.ruleId}. ${match.message}`;
  const primaryConfidence: Confidence = match.suggestion ? confidence : "low";
  // No rule-supplied paths to demote on this branch — populate
  // `alternatives` with per-call enrichments derived deterministically
  // from filePath + line so the slot the tool description promised is
  // real, not a phantom. See `suggest-fix-guidance-shape.ts`
  // `buildPerCallEnrichmentAlternatives` for the doctrine rationale.
  const enrichments = buildPerCallEnrichmentAlternatives(a.filePath, a.line);
  // When the rule's suggestion text concedes the criterion may not
  // apply on this substrate and points the agent at the source-level
  // disable pragma ("suppress with <!-- ra11y-disable wcag22:1.3.1 -->"),
  // the honest discriminator is `kind: "suppress-recommended"` — not
  // `kind: "guidance"` (which advertises a real fix direction). The
  // detection fires on the literal `ra11y-disable` token; see
  // `suggest-fix-suppress-recommended.ts` for the predicate doctrine.
  if (isSuppressionFlavoredSuggestion(explanation)) {
    return buildSuppressRecommendedOutcome({
      explanation,
      approach: deriveApproachFromProse(explanation),
      sourceContext: a.sourceContext,
      confidence: primaryConfidence,
      criteria: match.criteria,
      filePath: a.filePath,
      snippetField,
      verify: shared.verify,
      warningsField: shared.warningsField,
      disambiguationNoteField: shared.disambiguationNoteField,
      ...(enrichments ? { alternatives: enrichments } : {}),
    });
  }
  // Per-call `kind` mirrors `plan.fixesByClass` lane keys when the rule
  // routes into `runtime-only` or `verify-in-source`. The vendor /
  // template-directive / markdown-collision / suppression-flavored
  // branches above this fallback override the rule's lane with their
  // own substrate-specific concern (override the upstream selector,
  // verify after binding, resolve a markdown collision, suppress with
  // a pragma) so they keep their own discriminators. This honest
  // prose-only fallback is the right place for the rule-lane mirror.
  // See `kindFromFixClass` for the doctrine rationale.
  return {
    kind: kindFromFixClass(match.fixClass),
    primary: {
      approach: deriveApproachFromProse(explanation),
      explanation,
      sourceContext: a.sourceContext,
      confidence: primaryConfidence,
    },
    ...(enrichments ? { alternatives: enrichments } : {}),
    ...snippetField,
    ...shared.verify,
    ...shared.warningsField,
    ...shared.disambiguationNoteField,
  };
}
