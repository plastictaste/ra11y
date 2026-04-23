/**
 * Shape the `suggest_fix` response from a resolved violation match.
 *
 * Three outcomes:
 *   - `kind: "none"` — no violation at that line (or unmatched rule).
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
 * Every outcome also carries a `verifyCommand` (prose) +
 * `verifyCommandStructured` (`{ tool: "scan_file", args: { file,
 * ruleId } }`) pair naming the canonical re-check the agent should run
 * after applying the fix. Both fields are always populated — a
 * `suggest_fix` response without a re-verify is never meaningful, so
 * this is one of the few places that does NOT conditional-spread (the
 * CLAUDE.md §1 "present-when-meaningful" rule doesn't apply when the
 * field is always meaningful). See Track Q2 item Q2-VERIFYCMD.
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
 * source file. Mirrors the `safeEditsAvailable` accounting in
 * `src/output/agent-response/build-plan.ts`: that counter is positive
 * when a rule's `fixClass` is one of these AND the finding shipped a
 * `fixPaths.primary.edit`.
 *
 * Used by `mechanicalInPrincipleField` to annotate `kind: "guidance"`
 * responses whose rule family supports a mechanical path even though
 * this specific call couldn't produce a concrete `newText`. Closes the
 * cross-surface contradiction where `plan.fixesByClass`/
 * `safeEditsAvailable` advertise a mechanical/verify-in-source lane
 * but `suggest_fix` returns only prose (Q6-SUGGEST-FIX-MECHANICAL-VS-
 * GUIDANCE-DRIFT).
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

export function buildSuggestFixPayload(args: BuildSuggestFixPayloadArgs): Record<string, unknown> {
  const { ruleId, line, match, sourceContext, source, filePath, warnings } = args;
  const verify = buildVerifyCommand(filePath, ruleId);
  // Response-level `warnings` for the zero-output-success doctrine
  // (CLAUDE.md §1). The handler pre-computes scan-confidence codes
  // and passes them here; `warningsSpreadField` handles the
  // conditional-spread so the field is absent when empty.
  const warningsField = warningsSpreadField(warnings);
  if (!match) {
    return {
      kind: "none",
      explanation: `No violation for ${ruleId} at line ${line}.`,
      confidence: "low",
      ...verify,
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
    });
  }
  const explanation = match.suggestion
    ? match.suggestion
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
  // "guidance"` and scan's `plan.fixesByClass` / `safeEditsAvailable`.
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
