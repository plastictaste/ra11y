/**
 * Structured response-level limitation code for cross-file click /
 * change handler resolution. Surfaced on `plan.limitations[]` when the
 * scan observed any rule whose evidence horizon is bounded to local-
 * file analysis for click/change handler bindings — i.e. a rule with
 * `crossFileCapable: false` whose per-rule coverage row was downgraded
 * with the listener-resolution reason (see
 * `CROSS_FILE_BOUND_REASONS["keyboard/handler-missing"]` in
 * `src/engine/per-rule-coverage.ts`).
 *
 * The code surfaces when a finder needs cross-file evidence to confidently
 * resolve a click/change handler binding (separate `.js` modules attaching
 * listeners via `addEventListener`, JSX importing handler identifiers from
 * sibling files). It is the response-level pointer that lets the agent
 * decide when to follow up with Read+Grep — paired with (not duplicating)
 * the per-rule `coverageConfidence: "medium"` + reason
 * `cross_file_listener_resolution_not_attempted_by_rule` rows already
 * shipped on `meta.perRuleCoverage[]`. Doctrine: docs/kb/gotchas/
 * cross-file-handler-resolution.md ("Surface the limitation structurally").
 *
 * Suffix framing — the trailing `_unavailable` names the response-level
 * fact ("this scan cannot resolve external handler bindings") rather
 * than the rule-design fact ("this rule does not attempt resolution")
 * the per-rule reason already names. The two layers carry the same
 * underlying limitation; the names differ by axis.
 *
 * Extracted into its own file so the host `scan-assembly.ts` orchestrator
 * stays under the file-line budget. The detector is content-free over
 * the orchestrator and could later serve other tools that need the
 * same response-level surfacing.
 */

import type { PerRuleCoverage } from "../types/violation.ts";

/**
 * The structured code value itself. Imported by the assembler and the
 * integration test that pins the contract.
 */
export const EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE = "external_handler_resolution_unavailable";

/**
 * Per-rule reason code names that, when observed on a scan's
 * `perRuleCoverage[]`, surface the response-level
 * {@link EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE} limitation.
 *
 * Currently a single-element set — `keyboard/handler-missing` is the
 * only rule whose cross-file bound is *external handler resolution*
 * specifically (other `_not_attempted_by_rule` codes — id-ref
 * resolution for `aria/labelledby-target-exists` /
 * `navigation/skip-link`, custom-property resolution for
 * `contrast/minimum` — name different cross-file resolutions and would
 * earn their own response-level code if/when the doctrine extends).
 */
const HANDLER_RESOLUTION_REASON_CODES: ReadonlySet<string> = new Set([
  "cross_file_listener_resolution_not_attempted_by_rule",
]);

/**
 * Decides whether the scan's per-rule coverage rows carry evidence
 * that the response should surface
 * {@link EXTERNAL_HANDLER_RESOLUTION_UNAVAILABLE}. Returns `true` when
 * any row is at `coverageConfidence: "medium"` with a `reason` matching
 * {@link HANDLER_RESOLUTION_REASON_CODES}. The downgrade is gated upstream
 * on `crossFileCandidates > 0` (see `per-rule-coverage.ts`), so a row
 * carrying this reason already encodes "the rule observed a candidate
 * binding that may resolve cross-file" — which is exactly the predicate
 * the response-level code names. No additional gate needed here.
 */
export function shouldSurfaceExternalHandlerLimitation(
  perRuleCoverage: readonly PerRuleCoverage[] | undefined,
): boolean {
  if (perRuleCoverage === undefined) return false;
  for (const row of perRuleCoverage) {
    if (
      row.coverageConfidence === "medium" &&
      row.reason !== undefined &&
      HANDLER_RESOLUTION_REASON_CODES.has(row.reason)
    ) {
      return true;
    }
  }
  return false;
}
