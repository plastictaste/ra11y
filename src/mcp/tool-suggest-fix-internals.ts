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
 *     prose-only suggestion. The labels + snippet + sourceContext are
 *     enough for the agent to compose the edit.
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

import type { FixPath, Violation } from "../types/violation.ts";
import { POISONED_NEWTEXT_CAVEAT, sanitizeFixPathAgainstPoison } from "./suggest-fix-sanitize.ts";
import { widenToUniqueAnchor } from "./unique-anchor.ts";

/**
 * Machine-parseable verify hint. `tool` is always `"scan_file"` — the
 * narrowest, most deterministic verify surface (one file, one pass).
 * `scan_project` is deliberately NOT used here: broader scans dilute
 * the honest signal ("did this specific fix land?") with unrelated
 * findings and cost the agent a slower round-trip.
 *
 * `args.file` mirrors the `file` that was passed into `suggest_fix`
 * (canonical `file` parameter per P2-R, never re-derived). `args.ruleId`
 * is optional — included when the rule is known so the agent can
 * post-filter the verify scan's findings to the rule it just fixed.
 * `scan_file` itself doesn't filter by `ruleId`, so the field is
 * advisory: it documents "what you were trying to fix" for the
 * consumer, not a server-side filter.
 */
export interface VerifyCommandStructured {
  readonly tool: "scan_file";
  readonly args: {
    readonly path: string;
  };
  /**
   * Advisory metadata: the rule ID the caller just fixed. Sits as a
   * sibling of `args` (not inside it) because `scan_file` has no
   * `ruleId` parameter — encoding it in `args` would emit an
   * undeclared key against the tool's inputSchema. Agents that want
   * to post-filter the verify scan to only this rule can read it here.
   */
  readonly verifyRuleId: string;
}

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
    });
  }
  const explanation = match.suggestion
    ? match.suggestion
    : `Violation found but no fix guidance available for ${ruleId}. ${match.message}`;
  return {
    kind: "guidance",
    explanation,
    ...snippetField,
    sourceContext,
    confidence: match.suggestion ? confidence : "low",
    ...verify,
    ...warningsField,
  };
}

/**
 * Builds the `kind: "edit"` or `kind: "guidance"` outcome when the
 * violation carries `fixPaths`. Extracted from `buildSuggestFixPayload`
 * to keep that function's cognitive complexity under the lint cap —
 * the widen-to-unique-anchor plumbing adds branching this function
 * absorbs.
 */
function buildFixPathsOutcome(inputs: {
  readonly match: Violation;
  readonly source: string;
  readonly line: number;
  readonly sourceContext: string;
  readonly confidence: "high" | "medium";
  readonly snippetField: { readonly snippet?: string };
  readonly verify: ReturnType<typeof buildVerifyCommand>;
  readonly warningsField: { readonly warnings?: readonly string[] };
}): Record<string, unknown> {
  const { match, source, line, sourceContext, confidence, snippetField, verify, warningsField } =
    inputs;
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
  return {
    kind: mechanical ? "edit" : "guidance",
    primary,
    alternatives,
    explanation: match.suggestion ?? match.message,
    ...snippetField,
    ...caveatField,
    sourceContext,
    confidence,
    ...verify,
    ...warningsField,
  };
}
