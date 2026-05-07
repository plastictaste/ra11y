/**
 * Manual-only-criterion guidance shape for `suggest_fix`.
 *
 * Doctrine bridge: when a `checklist` review-candidate's `criteria[]`
 * contains a criterion no automated rule satisfies (e.g.
 * `wcag22:1.3.6`, `wcag22:2.4.5`, every other `automatable: "manual"`
 * row), the agent walking that candidate calls
 * `suggest_fix({ ruleId: "wcag22:1.3.6", file, line })`. Pre-fix the
 * handler returned `{ error: "No rule satisfies criterion '…'.",
 * code: "rule-not-found" }` — but `checklist` had just shipped that
 * criterion as an addressable item the agent was supposed to walk.
 *
 * The per-call surface MUST address every candidate the manual-review
 * surface emits ("Per-tool review-candidate shape must agree across
 * surfaces" + "One tool call should answer 'what next?'"). Instead of
 * a rule-not-found failure, the handler ships a `kind: "guidance"`
 * payload whose `primary.explanation` quotes the criterion's normative
 * description and points the agent at the spec URL — manual review
 * IS the answer for these criteria, and the response shape names that
 * answer rather than denying the call.
 *
 * Distinct from `kind: "suppress-recommended"`: that discriminator
 * fires when a rule's evidence model conceded the criterion may not
 * apply on this substrate; here, the criterion has no rule to begin
 * with, so the conceded-evidence framing doesn't fit. The manual-only
 * guidance is honest "no automation; verify against the spec" — closer
 * to the prose-only guidance fallback than the suppression lane.
 *
 * Pure function over the criterion record, no I/O. Lives in its own
 * file so `tool-suggest-fix.ts` stays under the 150-effective-line cap
 * and the criterion-bridge module stays focused on rule resolution.
 *
 * See `docs/kb/architecture/ai-first-consumer.md`: "One tool call
 * should answer 'what next?'", "Per-tool review-candidate shape must
 * agree across surfaces," "Surface, don't suppress."
 */

import type { Criterion } from "../types/standard.ts";
import type { VendorContext } from "./suggest-fix-vendor-context.ts";

/**
 * Shared per-call fields the handler threads into every guidance lane:
 * verify pair, response-level warnings, vendor-context spread. The
 * manual-only branch carries them through the same way the matched-
 * payload routing does so the response shape stays consistent across
 * lanes (an agent reading the result doesn't need to know which branch
 * fired).
 */
export interface ManualOnlyGuidanceFields {
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly vendorContextField: { readonly vendorContext?: VendorContext };
  readonly verify: {
    readonly verifyCommandStructured: {
      readonly tool: "scan_file";
      readonly args: { readonly path: string };
      readonly verifyRuleId: string;
    };
  };
}

/**
 * Build the `kind: "guidance"` payload for a criterion ID that no
 * automated rule satisfies. The criterion record is required so the
 * `primary.explanation` can quote the normative text and point at the
 * spec URL — without that, the response would be a generic "manual
 * review" string indistinguishable from a no-op.
 *
 * `confidence` is `"medium"` because the response is structurally an
 * investigation prompt, not a deterministic fix recipe — same framing
 * the candidate-match guidance lane uses (review candidates are always
 * softer signals than rule violations). `verifyRuleId` on the verify
 * pair echoes the criterion ID the caller passed, so `scan_file` re-
 * checks against the same surface even though the criterion has no
 * automated rule to verify against — the verify hint is honest about
 * what the agent will look for.
 *
 * `alternatives` carries one entry: a "verify by reading the spec"
 * pointer at the criterion's URL. The suppression-pragma alternative
 * the prose-only fallback offers is omitted here — pasting a pragma
 * for a criterion the scanner cannot detect would silence nothing
 * meaningful, only litter source.
 */
export function buildManualOnlyCriterionGuidance(args: {
  readonly criterion: Criterion;
  readonly inputCriterionId: string;
  readonly filePath: string;
  readonly line: number;
  readonly fields: ManualOnlyGuidanceFields;
}): Record<string, unknown> {
  const { criterion, inputCriterionId, filePath, line, fields } = args;
  const explanation =
    `Manual-review only — criterion '${inputCriterionId}' (${criterion.title}) has no automated rule. ` +
    `Verify against the normative requirement: "${criterion.description}" ` +
    `See ${criterion.url} for the full spec text.`;
  const approach = `Verify ${inputCriterionId} (${criterion.title}) against the spec`;
  return {
    kind: "guidance",
    primary: {
      approach,
      explanation,
      sourceContext: `Manual-review criterion at ${filePath}:${line} — no automated rule satisfies '${inputCriterionId}'.`,
      confidence: "medium",
    },
    alternatives: [
      {
        approach: "Read the normative spec text",
        explanation: `Open ${criterion.url} and read the criterion's full requirements; the cited file:line is the location to inspect against the spec.`,
      },
    ],
    ...fields.verify,
    ...fields.warningsField,
    ...fields.vendorContextField,
  };
}
