/**
 * Shape the `suggest_fix` response from a resolved violation match.
 *
 * Three outcomes:
 *   - `kind: "none"` — no violation at that line (or unmatched rule).
 *     OMITS `verifyCommandStructured`: a "no finding here" response
 *     with a populated verify hint reads as "you already fixed it and
 *     verified," which is indistinguishable from "the finding never
 *     existed at this location." The verify hint is present-when-
 *     meaningful — only the lanes that actually applied a fix carry it.
 *     ALSO OMITS `confidence`: the field grades how confident a fix
 *     recommendation is, which is structurally undefined on the
 *     negative answer. "Low confidence we have no fix" is a category
 *     error — confidence belongs with positive answers (`kind:
 *     "edit"` / `"guidance"` / `"suppress-recommended"`), not with
 *     `kind: "none"`. See CLAUDE.md §1 "Ambiguous field shapes are
 *     dishonest" + "Sibling fields naming the same concept must use
 *     one shape." When the per-file finding list carries one or more
 *     same-rule findings within ±NEAREST_FINDING_WINDOW lines of the
 *     requested line, the response gets a `nearestFinding: { ruleId,
 *     line }` (single match) or `didYouMean[]` (multi match)
 *     breadcrumb so paginated scans / line-drift / rule renames don't
 *     produce a dead-end response.
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
 *     shapes are dishonest"). `verifyCommandStructured` stays at top
 *     level.
 *
 * The `kind: "edit"` and `kind: "guidance"` outcomes carry a
 * `verifyCommandStructured` (`{ tool: "scan_file", args: { path },
 * verifyRuleId }`) field naming the canonical re-check the agent
 * should run after applying the fix. The `kind: "none"` outcome OMITS
 * the field (see above) — there is nothing to re-verify when no
 * finding existed.
 *
 * The prose `verifyCommand` sibling has been dropped — shipping a
 * prose string alongside its structured object form was the canonical
 * "Ambiguous field shapes are dishonest" failure mode at the response
 * level: drift between the two channels was silent and the agent
 * could not tell which was canonical. Only the structured form
 * remains; agents synthesize re-check prose from `tool` + `args` +
 * `verifyRuleId` directly.
 *
 * Pure function, no I/O. Lives in its own file so `tools.ts` stays
 * under the file-size budget; the suggest_fix handler imports this
 * directly.
 */

import type { CandidateMatch } from "./suggest-fix-candidate-match.ts";
import {
  deriveApproachFromProse,
  type VerifyCommandStructured,
} from "./suggest-fix-guidance-shape.ts";
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
 * Builds the `verifyCommandStructured` machine form naming `scan_file`
 * on the fix target. Always emitted on every `suggest_fix` `kind:
 * "edit"` / `kind: "guidance"` response — there is always a way to
 * re-check after applying the fix, so the field is never ambiguous on
 * those lanes. The `kind: "none"` lane omits it entirely (see file
 * doc).
 *
 * The prose `verifyCommand` sibling that previously rode alongside
 * was dropped — shipping two channels with the same content was the
 * canonical "Ambiguous field shapes are dishonest" / triple-readout
 * failure mode (`docs/kb/architecture/ai-first-consumer.md`). Agents
 * that want a prose form synthesize it from `tool` + `args` +
 * `verifyRuleId`.
 */
export function buildVerifyCommand(
  filePath: string,
  ruleId: string,
): {
  readonly verifyCommandStructured: VerifyCommandStructured;
} {
  return {
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
    candidateMatch,
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
    // Review-candidate match path: when the rule did not fire at the
    // queried line BUT a manual-review candidate at the same
    // coordinate carries a criterion the rule satisfies, return
    // `kind: "guidance"` derived from the candidate's prose so the
    // agent gets the same actionable framing the manual-review
    // surface promised. Closes the checklist→suggest_fix lane parity
    // gap per AI-first doctrine "Per-call shape must agree with
    // per-class plan tally" extended one hop. The verify pair rides
    // along — once the agent edits source after reading the
    // candidate's reason, `scan_file` is the canonical re-check.
    if (candidateMatch !== undefined) {
      return buildCandidateGuidancePayload({
        ruleId,
        line,
        filePath,
        candidateMatch,
        shared,
      });
    }
    return buildNoMatchPayload({
      ruleId,
      line,
      sameFileFindings,
      inheritedFromWrapper,
      warningsField,
      disambiguationNoteField,
      vendorContextField,
    });
  }
  return routeMatchedPayload({ args, match, shared });
}

/**
 * `kind: "none"` payload assembler — the dead-end path when neither a
 * rule violation nor a review candidate matches the queried line.
 * Walks `sameFileFindings` for nearby same-rule emissions and builds
 * the `nearestFinding` / `didYouMean` breadcrumbs so the response is
 * never a true dead end (paginated scans drift the line, agents lose
 * the original line, rule renames swap the ID — the breadcrumb
 * recovers from all three). When the queried line resolves to a
 * registered wrapper-call site, `inheritedFromWrapper` re-routes the
 * agent to the wrapper definition. Extracted from the parent so the
 * candidate-match branch above stays readable; the field set returned
 * here is unchanged from the prior inline shape.
 */
function buildNoMatchPayload(args: {
  readonly ruleId: string;
  readonly line: number;
  readonly sameFileFindings: BuildSuggestFixPayloadArgs["sameFileFindings"];
  readonly inheritedFromWrapper: BuildSuggestFixPayloadArgs["inheritedFromWrapper"];
  readonly warningsField: { readonly warnings?: readonly string[] };
  readonly disambiguationNoteField: { readonly disambiguationNote?: string };
  readonly vendorContextField: { readonly vendorContext?: VendorContext };
}): Record<string, unknown> {
  const {
    ruleId,
    line,
    sameFileFindings,
    inheritedFromWrapper,
    warningsField,
    disambiguationNoteField,
    vendorContextField,
  } = args;
  const nearestSpread = nearestFindingSpread(ruleId, line, sameFileFindings);
  const inheritedSpread = inheritedFromWrapper
    ? { inheritedFromWrapper: { wrapperName: inheritedFromWrapper.wrapperName } }
    : {};
  const explanation = inheritedFromWrapper
    ? buildInheritedHintExplanation(ruleId, line, inheritedFromWrapper.wrapperName)
    : `No violation for ${ruleId} at line ${line}.`;
  return {
    kind: "none",
    explanation,
    // `confidence` is OMITTED on `kind: "none"`. The field is
    // semantically meaningful only on the positive answers
    // (`kind: "edit"` / `"guidance"` / `"suppress-recommended"`)
    // where it grades how confident the fix recommendation is.
    // "Low confidence we have no fix" is a category error — the
    // negative answer is "no violation matches at the queried
    // location," and confidence on that statement is structurally
    // undefined. Per CLAUDE.md §1 "Ambiguous field shapes are
    // dishonest" + "Sibling fields naming the same concept must
    // use one shape": a field that's sometimes meaningful and
    // sometimes a category error forces the agent to disambiguate
    // and the silent-miss failure mode is identical to the
    // `newText: ""` / `snippet: ""` mistakes.
    ...inheritedSpread,
    ...nearestSpread,
    ...warningsField,
    ...disambiguationNoteField,
    ...vendorContextField,
  };
}

/**
 * Build the `kind: "guidance"` payload for the review-candidate match
 * path. Mirrors the shape the prose-only fallback produces in
 * `routeMatchedPayload`'s tail — the agent reads the same `primary`
 * block (`approach` + `explanation` + `confidence` + optional
 * `sourceContext`) regardless of whether the guidance came from a
 * rule's `match.suggestion` or from a finder's review prose. The
 * candidate's `reason` becomes the explanation; the `approach` label
 * is derived from the same {@link deriveApproachFromProse} helper so
 * the terse-summary surface stays consistent across guidance lanes.
 *
 * Confidence is sourced from the candidate's framing: review
 * candidates are always investigation prompts ("verify X"), never
 * deterministic fix recipes — `medium` matches that framing across
 * the existing guidance shapes (the prose-only fallback uses
 * `confidence === "high"` only for severity-`error` rule matches; a
 * candidate is structurally a softer signal than a rule violation).
 *
 * The verify pair rides along — once the agent edits source after
 * reading the candidate's reason, `scan_file` is the canonical
 * re-check. The same `warningsField` / `disambiguationNoteField` /
 * `vendorContextField` spreads ride here as on every guidance lane so
 * scan-confidence telemetry stays consistent across branches.
 */
function buildCandidateGuidancePayload(args: {
  readonly ruleId: string;
  readonly line: number;
  readonly filePath: string;
  readonly candidateMatch: CandidateMatch;
  readonly shared: PayloadSharedFields;
}): Record<string, unknown> {
  const { line, filePath, candidateMatch, shared } = args;
  const explanation = candidateMatch.reviewPrompt
    ? `${candidateMatch.reason}\n\n${candidateMatch.reviewPrompt}`
    : candidateMatch.reason;
  return {
    kind: "guidance",
    primary: {
      approach: deriveApproachFromProse(candidateMatch.reason),
      explanation,
      sourceContext: `Manual-review candidate at ${filePath}:${line} (criterion ${candidateMatch.criterionId}).`,
      confidence: "medium",
    },
    ...shared.verify,
    ...shared.warningsField,
    ...shared.disambiguationNoteField,
    ...shared.vendorContextField,
  };
}
