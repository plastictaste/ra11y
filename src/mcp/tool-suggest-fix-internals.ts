/**
 * Shape the `suggest_fix` response from a resolved violation match.
 *
 * Three outcomes:
 *   - `kind: "none"` — no violation at that line (or unmatched rule).
 *     OMITS `verifyCommand` + `verifyCommandStructured`: a "no finding
 *     here" response with a populated verify hint reads as "you already
 *     fixed it and verified," which is indistinguishable from "the
 *     finding never existed at this location." The verify pair is
 *     present-when-meaningful — only the lanes that actually applied a
 *     fix carry it. See V1-SUGGEST-FIX-VERIFYCOMMAND-ON-NONE +
 *     CLAUDE.md §1 "Ambiguous field shapes are dishonest."
 *   - `kind: "edit"` — the rule emitted fixPaths with a mechanical
 *     `primary.edit`; the agent can apply it via Edit directly. The
 *     edit is widened to a unique anchor window via `widenToUniqueAnchor`
 *     before serialization so apply_fix's literal find-and-replace
 *     matches exactly once. When no unique anchor fits in the cap, the
 *     payload carries a `caveat` string so the agent can disambiguate
 *     before applying.
 *   - `kind: "guidance"` — fixPaths without mechanical edits, or
 *     prose-only suggestion. The response shape mirrors the tool's
 *     advertised contract: a ranked `primary` approach carrying the
 *     `approach` label + `explanation` prose + `sourceContext` +
 *     `confidence`, plus an optional `alternatives` array (omitted when
 *     only one approach is reasonable — CLAUDE.md §1 "Ambiguous field
 *     shapes are dishonest"). `verifyCommand` +
 *     `verifyCommandStructured` stay at top level. See Q-SHARED-SUGGEST-
 *     FIX-GUIDANCE-PRIMARY.
 *
 * The `kind: "edit"` and `kind: "guidance"` outcomes carry a
 * `verifyCommand` (prose) + `verifyCommandStructured` (`{ tool:
 * "scan_file", args: { path }, verifyRuleId }`) pair naming the
 * canonical re-check the agent should run after applying the fix. The
 * `kind: "none"` outcome OMITS the pair (see above) — there is nothing
 * to re-verify when no finding existed.
 *
 * Pure function, no I/O. Lives in its own file so `tools.ts` stays
 * under the file-size budget; the suggest_fix handler imports this
 * directly.
 */

import type { FixClass } from "../types/rule.ts";
import type { Violation } from "../types/violation.ts";
import {
  deriveApproachFromProse,
  type VerifyCommandStructured,
} from "./suggest-fix-guidance-shape.ts";
import { buildFixPathsOutcome } from "./tool-suggest-fix-fixpaths.ts";

/**
 * Set of rule `fixClass` lanes that promise a source-edit path in
 * principle — the two lanes whose edits, when present, land in the
 * source file. Mirrors the editable-lane subset
 * (`fixesByClass.mechanical + fixesByClass.verifyInSource`) that the
 * scan plan surfaces; the `countFixes` helper in
 * `src/output/agent-response/build-plan.ts` counts violations in these
 * lanes that also ship a `fixPaths.primary.edit`, but the result is
 * internal to effort math rather than a headline counter (the former
 * composite `safeEditsAvailable` was dropped per
 * Q-SHARED-SAFE-EDITS-VS-MECHANICAL-DISAGREEMENT).
 *
 * Used by `mechanicalInPrincipleField` to annotate `kind: "guidance"`
 * responses whose rule family supports a mechanical path even though
 * this specific call couldn't produce a concrete `newText`. Closes the
 * cross-surface contradiction where `plan.fixesByClass` advertises a
 * mechanical/verify-in-source lane but `suggest_fix` returns only
 * prose (Q6-SUGGEST-FIX-MECHANICAL-VS-GUIDANCE-DRIFT).
 */
const MECHANICAL_IN_PRINCIPLE_LANES: ReadonlySet<FixClass> = new Set<FixClass>([
  "mechanical",
  "verify-in-source",
]);

/**
 * Conditional-spread wrapper for the `meta.mechanicalInPrinciple`
 * signal. Returns `{ meta: { mechanicalInPrinciple: true } }` when the
 * matched violation's `fixClass` is in {@link MECHANICAL_IN_PRINCIPLE_LANES};
 * returns `{}` otherwise so the field is absent rather than
 * `mechanicalInPrinciple: false` (CLAUDE.md §1 "Ambiguous field shapes
 * are dishonest" — a boolean that silently flips to false looks like
 * data when it's actually "not applicable"). Only meaningful on
 * `kind: "guidance"` responses — the `kind: "edit"` lane has already
 * shipped a concrete edit and doesn't need the in-principle hint.
 */
function mechanicalInPrincipleField(match: Violation): {
  readonly meta?: { readonly mechanicalInPrinciple: true };
} {
  return MECHANICAL_IN_PRINCIPLE_LANES.has(match.fixClass)
    ? { meta: { mechanicalInPrinciple: true } }
    : {};
}

// Re-export the shared shape so external consumers (tests, the tool
// handler) continue to import it from this file verbatim — the type
// was extracted to `suggest-fix-guidance-shape.ts` to break a circular
// import between internals and the fixPaths branch.
export type { VerifyCommandStructured };

export interface BuildSuggestFixPayloadArgs {
  readonly ruleId: string;
  readonly line: number;
  readonly match: Violation | undefined;
  readonly sourceContext: string;
  readonly source: string;
  /**
   * Canonical file path from the suggest_fix request. Passed through
   * to `verifyCommandStructured.args.file` so the verify hint names the
   * exact same path the fix was computed against — never re-derived
   * here to avoid shape-drift between the request and the verify
   * pointer.
   */
  readonly filePath: string;
  /**
   * Caller-computed response-level warnings, forwarded verbatim onto
   * every outcome shape. Closes the zero-output-success ambiguity
   * documented in CLAUDE.md §1 — the handler knows the scan-confidence
   * signals (`filesScanned`, deprecated-param alias, future codes) and
   * passes them here pre-assembled. Omit or pass an empty array to
   * skip the field entirely (conditional-spread at the assembly site).
   */
  readonly warnings?: readonly string[];
  /**
   * Whether the suggest_fix scan parsed any JSX/HTML evidence of
   * Tailwind utility usage. Computed by the handler via
   * `hasTailwindSignal` over the parsed-file set
   * (V1-SUGGEST-FIX-TAILWIND-HINT-SCOPED). When `false`, rule-emitted
   * suggestions that append a Tailwind escape-hatch sentence
   * (`focus/outline-visible` is the current sole emitter) read as
   * context-blind advice on a vanilla CSS repo — the prose builder
   * strips that trailing sentence before composing the explanation.
   * Omitted (or `false`) leaves the strip active; `true` keeps the
   * hint intact for a Tailwind project. See CLAUDE.md §1 "Ambiguous
   * field shapes are dishonest" + ai-first-consumer.md
   * "context-blind advice."
   */
  readonly tailwindDetected?: boolean;
}

/**
 * Builds the `verifyCommand` prose + `verifyCommandStructured`
 * machine form naming `scan_file` on the fix target. Both are always
 * emitted on every `suggest_fix` response — there is always a way to
 * re-check after applying the fix, so the fields are never ambiguous
 * (no conditional-spread).
 */
export function buildVerifyCommand(
  filePath: string,
  ruleId: string,
): {
  readonly verifyCommand: string;
  readonly verifyCommandStructured: VerifyCommandStructured;
} {
  return {
    verifyCommand: `mcp: scan_file({ path: ${JSON.stringify(filePath)} }) and confirm \`${ruleId}\` no longer fires at this location`,
    verifyCommandStructured: {
      tool: "scan_file",
      args: { path: filePath },
      verifyRuleId: ruleId,
    },
  };
}

/**
 * Conditional-spread wrapper for response-level `warnings` — omitted
 * when the caller-supplied array is undefined or empty so the field is
 * never `warnings: []` (CLAUDE.md §1 "Ambiguous field shapes are
 * dishonest"). Shared by every outcome branch of
 * `buildSuggestFixPayload`.
 */
function warningsSpreadField(warnings: readonly string[] | undefined): {
  readonly warnings?: readonly string[];
} {
  return warnings !== undefined && warnings.length > 0 ? { warnings } : {};
}

/**
 * Marker for the rule-emitted Tailwind escape-hatch hint that the
 * `focus/outline-visible` rule appends to its `suggestion` text on
 * scoped selectors. The exact prefix is stable — it begins with a
 * leading space so the strip never lands on word boundaries inside the
 * preceding sentence — and the rule emits everything from this prefix
 * to end-of-string as a single trailing block.
 *
 * V1-SUGGEST-FIX-TAILWIND-HINT-SCOPED: when the suggest_fix scan
 * detected no Tailwind signal, that block reads as context-blind advice
 * on a vanilla CSS repo. We strip it from the explanation before the
 * agent reads it. The rule-level emit is unchanged (other consumers
 * like the CLI terminal formatter make their own context decisions);
 * the strip is local to suggest_fix's guidance-composition path.
 */
const TAILWIND_HINT_PREFIX = " If this element uses Tailwind's";

/**
 * Removes the rule-emitted Tailwind escape-hatch sentence from a
 * `match.suggestion` string when the suggest_fix scan reported no
 * Tailwind signal. No-op when the marker is absent (other rules don't
 * emit it) or when Tailwind WAS detected (the hint is real context for
 * a Tailwind project). See {@link TAILWIND_HINT_PREFIX}.
 */
function stripContextBlindTailwindHint(
  suggestion: string,
  tailwindDetected: boolean | undefined,
): string {
  if (tailwindDetected === true) return suggestion;
  const index = suggestion.indexOf(TAILWIND_HINT_PREFIX);
  if (index === -1) return suggestion;
  return suggestion.slice(0, index).trimEnd();
}

export function buildSuggestFixPayload(args: BuildSuggestFixPayloadArgs): Record<string, unknown> {
  const { ruleId, line, match, sourceContext, source, filePath, warnings, tailwindDetected } = args;
  const verify = buildVerifyCommand(filePath, ruleId);
  // Response-level `warnings` for the zero-output-success doctrine
  // (CLAUDE.md §1). The handler pre-computes scan-confidence codes
  // and passes them here; `warningsSpreadField` handles the
  // conditional-spread so the field is absent when empty.
  const warningsField = warningsSpreadField(warnings);
  if (!match) {
    // V1-SUGGEST-FIX-VERIFYCOMMAND-ON-NONE: omit the verify pair on
    // `kind: "none"`. A populated `verifyCommand` next to "no
    // violation found at this line" reads as "you already fixed it
    // and verified," which is indistinguishable from "the finding
    // never existed." Present-when-meaningful (CLAUDE.md §1
    // "Ambiguous field shapes are dishonest") — the verify pair only
    // belongs on the lanes that actually applied a fix.
    return {
      kind: "none",
      explanation: `No violation for ${ruleId} at line ${line}.`,
      confidence: "low",
      ...warningsField,
    };
  }
  const confidence = match.severity === "error" ? "high" : "medium";
  // Omit empty `snippet` rather than emitting `snippet: ""` — a
  // sentinel-empty field forces the agent to re-read and disambiguate
  // whether the value is unavailable or genuinely empty. Present-only-
  // when-populated is the honest shape.
  const snippetField = match.snippet ? { snippet: match.snippet } : {};
  if (match.fixPaths) {
    return buildFixPathsOutcome({
      match,
      source,
      line,
      sourceContext,
      confidence,
      snippetField,
      verify,
      warningsField,
      mechanicalInPrincipleField: mechanicalInPrincipleField(match),
      // exactOptionalPropertyTypes: conditional-spread the optional
      // boolean so `undefined` doesn't satisfy `boolean | undefined`
      // when the property is required-with-undefined-disallowed.
      ...(tailwindDetected === undefined ? {} : { tailwindDetected }),
    });
  }
  // V1-SUGGEST-FIX-TAILWIND-HINT-SCOPED: strip the rule-emitted
  // Tailwind escape-hatch sentence when no Tailwind signal was
  // detected in the suggest_fix scan. The strip is local to this
  // tool — other surfaces (CLI, JSON formatter) keep the rule's
  // suggestion verbatim and make their own context decisions.
  const explanation = match.suggestion
    ? stripContextBlindTailwindHint(match.suggestion, tailwindDetected)
    : `Violation found but no fix guidance available for ${ruleId}. ${match.message}`;
  const primaryConfidence = match.suggestion ? confidence : "low";
  // Q-SHARED-SUGGEST-FIX-GUIDANCE-PRIMARY: guidance responses nest the
  // explanation + sourceContext + confidence under a ranked `primary`
  // block so the shape matches the tool description's promise. No
  // `alternatives` here — the rule never supplied structured paths.
  //
  // Q6-SUGGEST-FIX-MECHANICAL-VS-GUIDANCE-DRIFT: when the matched
  // violation's rule lives in a source-edit lane (`mechanical` or
  // `verify-in-source`) but this specific call couldn't produce a
  // concrete `newText`, annotate with `meta.mechanicalInPrinciple:
  // true` so the agent knows the rule family supports a mechanical
  // path. Closes the cross-surface drift between this tool's `kind:
  // "guidance"` and scan's `plan.fixesByClass` editable lanes.
  return {
    kind: "guidance",
    primary: {
      approach: deriveApproachFromProse(explanation),
      explanation,
      sourceContext,
      confidence: primaryConfidence,
    },
    ...snippetField,
    ...verify,
    ...warningsField,
    ...mechanicalInPrincipleField(match),
  };
}
