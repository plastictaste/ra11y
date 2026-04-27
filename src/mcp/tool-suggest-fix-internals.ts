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
 * fix carry it. See +
 *     CLAUDE.md §1 "Ambiguous field shapes are dishonest." When the
 *     per-file finding list carries one or more same-rule findings
 *     within ±NEAREST_FINDING_WINDOW lines of the requested line, the
 *     response gets a `nearestFinding: { ruleId, line }` (single match)
 *     or `didYouMean[]` (multi match) breadcrumb so paginated scans /
 *     line-drift / rule renames don't produce a dead-end response. See
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

import type { VerifyCommandStructured } from "./suggest-fix-guidance-shape.ts";
import { buildInheritedHintExplanation } from "./suggest-fix-inherited-hint.ts";
import { nearestFindingSpread } from "./suggest-fix-nearest-finding.ts";
import type { VendorContext } from "./suggest-fix-vendor-context.ts";
import type { BuildSuggestFixPayloadArgs } from "./tool-suggest-fix-payload-args.ts";
import { type PayloadSharedFields, routeMatchedPayload } from "./tool-suggest-fix-routing.ts";

// Re-export the shared shape so external consumers (tests, the tool
// handler) continue to import it from this file verbatim — the type
// was extracted to `suggest-fix-guidance-shape.ts` to break a circular
// import between internals and the fixPaths branch.
// Re-export the args type from its single-source-of-truth module so
// existing callers (`tool-suggest-fix.ts`, every test importing from
// this file) keep working without reaching into the new module
// directly. The split exists only to break the routing-helper cycle.
export type { BuildSuggestFixPayloadArgs, VerifyCommandStructured };

// `nearestFindingSpread` lives in
// its own module so this handler stays under the MCP-handler line
// budget. See `suggest-fix-nearest-finding.ts` for the full doc block.

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
  const {
    ruleId,
    line,
    match,
    filePath,
    warnings,
    disambiguationNote,
    sameFileFindings,
    vendorContext,
    inheritedFromWrapper,
  } = args;
  const verify = buildVerifyCommand(filePath, ruleId);
  // Response-level `warnings` for the zero-output-success doctrine
  // (CLAUDE.md §1). The handler pre-computes scan-confidence codes
  // and passes them here; `warningsSpreadField` handles the
  // conditional-spread so the field is absent when empty.
  const warningsField = warningsSpreadField(warnings);
  // Criterion-input → rule resolution note (suggest_fix criterion-id
  // bridge). Present-when-meaningful: omitted on rule-ID input AND on
  // singleton criterion resolution where there's no ambiguity to
  // disclose. Conditional-spread per CLAUDE.md §1 "Ambiguous field
  // shapes are dishonest."
  const disambiguationNoteField: { readonly disambiguationNote?: string } =
    disambiguationNote === undefined ? {} : { disambiguationNote };
  // present-when-meaningful spread for
  // the vendor-context payload. When the handler's classifier didn't
  // fire on this file, the field is absent — behavior identical to
  // pre-Q7 calls. When it did fire, the same `vendorContext` block
  // rides every outcome branch (kind: "none" / "edit" / "guidance")
  // so the agent always sees the override-redirect signal alongside
  // whatever else the response carried.
  const vendorContextField: { readonly vendorContext?: VendorContext } =
    vendorContext === undefined ? {} : { vendorContext };
  const shared: PayloadSharedFields = {
    verify,
    warningsField,
    disambiguationNoteField,
    vendorContextField,
  };
  if (!match) {
    // omit the verify pair on
    // `kind: "none"`. A populated `verifyCommand` next to "no
    // violation found at this line" reads as "you already fixed it
    // and verified," which is indistinguishable from "the finding
    // never existed." Present-when-meaningful (CLAUDE.md §1
    // "Ambiguous field shapes are dishonest") — the verify pair only
    // belongs on the lanes that actually applied a fix.
    //
    // walk the per-file findings
    // for same-rule matches within ±NEAREST_FINDING_WINDOW lines of the
    // requested line. Single match → `nearestFinding: { ruleId, line }`;
    // multi match → `didYouMean[]`. Without these breadcrumbs the
    // response is a dead end forcing the agent to re-scan when paginated
    // scans drifted the line, the agent lost the original line, or a
    // rule rename swapped the ID. Conditional-spread so the field is
    // absent when no nearby same-rule finding exists (CLAUDE.md §1
    // "Ambiguous field shapes are dishonest").
    const nearestSpread = nearestFindingSpread(ruleId, line, sameFileFindings);
    // when the requested
    // (filePath, line) resolves to a registered native-element wrapper
    // call site, the multi-file scan synthesized the finding via the
    // inherited-findings post-pass — the rule never fired at this line
    // single-file. The inherited-hint payload tells the agent the rule
    // lives at the wrapper component definition so the next call can
    // re-target there rather than re-running the same dead-end lookup.
    // See `src/mcp/suggest-fix-inherited-hint.ts` and the doctrine
    // "Cross-surface count invariant" applied to the per-finding lookup
    // channel.
    const inheritedSpread = inheritedFromWrapper
      ? { inheritedFromWrapper: { wrapperName: inheritedFromWrapper.wrapperName } }
      : {};
    const explanation = inheritedFromWrapper
      ? buildInheritedHintExplanation(ruleId, line, inheritedFromWrapper.wrapperName)
      : `No violation for ${ruleId} at line ${line}.`;
    return {
      kind: "none",
      explanation,
      confidence: "low",
      ...inheritedSpread,
      ...nearestSpread,
      ...warningsField,
      ...disambiguationNoteField,
      ...vendorContextField,
    };
  }
  return routeMatchedPayload({ args, match, shared });
}
