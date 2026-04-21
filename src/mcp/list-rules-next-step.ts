/**
 * Next-step builder for the `list_rules` MCP tool.
 *
 * Extracted from `tools.ts` so the handler stays within the file-line
 * budget enforced by `scripts/check-limits.ts`. The logic is trivially
 * testable on its own and has no cross-tool coupling — it only reads
 * the standard-filter argument and the matched count, and emits the
 * prose + structured pair that routes the agent onward.
 *
 * Two branches, both concrete (structured hint is always emitted so
 * `nextStepStructured` is never an ambiguous empty):
 *
 *   - No filter applied: route to `scan_project` with empty args, so
 *     the next call evaluates every loaded rule against the caller's
 *     code. Prose also names `explain_rule` as the lookup surface for
 *     any single ID the agent wants to read deeper on.
 *   - Filter applied: route to `scan_project` with `standard` pre-
 *     filled, so the agent's next scan narrows to the same framework
 *     the enumeration narrowed to. Prose repeats the filter name
 *     inside backticks so an agent reading the string (not the
 *     `filter` echo field) still sees which standard the count refers
 *     to.
 *
 * Shape is the same `{ prose, structured }` pair every other tool's
 * next-step helper returns, so a future refactor can fold this into a
 * shared interface without changing callers.
 */

export interface ListRulesNextStep {
  readonly prose: string;
  readonly structured: {
    readonly tool: string;
    readonly args: Record<string, unknown>;
  };
}

/**
 * Builds the next-step hint for `list_rules`. See the module-level
 * docstring for branch semantics.
 *
 * @param standardFilter - The resolved `standard` parameter (already
 *   validated against `BUILTIN_STANDARDS` by the caller) or
 *   `undefined` when the caller passed no filter.
 * @param matched - The count of rules in the response after the
 *   filter was applied; equals `rules.length` of the envelope.
 * @returns `prose` (English recommendation) + `structured`
 *   (machine-parseable `{ tool, args }`). Both branches emit both
 *   fields — the destination is always concrete for this tool.
 */
export function buildListRulesNextStep(
  standardFilter: string | undefined,
  matched: number,
): ListRulesNextStep {
  const plural = matched === 1 ? "" : "s";
  if (standardFilter !== undefined) {
    return {
      prose: `${matched} rule${plural} satisfy criteria in \`${standardFilter}\`. Call \`scan_project\` with \`standard: "${standardFilter}"\` to evaluate them against your code, or \`explain_rule\` on any ID for full rule metadata.`,
      structured: { tool: "scan_project", args: { standard: standardFilter } },
    };
  }
  return {
    prose: `${matched} rule${plural} loaded across every built-in standard. Call \`scan_project\` to evaluate them against your code, or \`explain_rule\` on any ID for full rule metadata. Pass \`standard\` to narrow this list to a single framework.`,
    structured: { tool: "scan_project", args: {} },
  };
}
