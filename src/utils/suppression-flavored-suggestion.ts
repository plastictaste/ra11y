/**
 * Predicate naming the per-emission "suppression-flavored guidance"
 * shape that drives the `kind: "suppress-recommended"` suggest_fix
 * discriminator and the `plan.fixesByClass.suppressRecommended` lane.
 *
 * Why a util module: both `src/output/agent-response/build-plan.ts`
 * (which assembles the plan tally) and `src/mcp/...` (which assembles
 * the per-call suggest_fix payload) need the predicate. The MCP layer
 * already imports from `output/agent-response`, so co-locating the
 * predicate under `src/mcp/` would create a cycle. `src/utils/` is the
 * neutral home for pure string predicates with no parser or engine
 * dependency.
 *
 * Detection rationale lives at the call site — see
 * `src/mcp/suggest-fix-suppress-recommended.ts` for the doctrine.
 * Kept conservative: only emission sites that explicitly name the
 * pragma token count.
 */

/**
 * Tokens that, when present in a suggestion's prose, indicate the
 * rule has conceded the criterion may not apply on this substrate
 * and the deterministic dismissal path is the source-level disable
 * pragma. Any addition here must clear the bar "the token never
 * appears in legitimate `kind: "guidance"` prose where the agent
 * should pursue a real fix" — same correctness bar as
 * `docs/kb/architecture/ai-first-consumer.md` "Heuristic-mislabeled
 * meta sub-fields are dishonest" applies.
 */
const SUPPRESSION_TOKENS: readonly string[] = ["ra11y-disable", "suppress with"];

/**
 * Test whether a suggestion's prose is suppression-flavored — i.e. the
 * primary remediation it advances is "investigate, then add a pragma if
 * intentional," not "apply this fix." Returns `false` when `suggestion`
 * is undefined or empty — absence of prose can't be suppression-flavored.
 *
 * @param suggestion - The violation's prose suggestion text, or
 *   undefined when the rule emitted no suggestion.
 * @returns `true` when the prose contains a literal suppression token.
 *
 * @example
 * isSuppressionFlavoredSuggestion('Insert an <h1> at the top of <body>… If this page is rendered inside a parent layout that supplies the title, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.')
 * // => true
 *
 * @example
 * isSuppressionFlavoredSuggestion('Add alt="" to the decorative <img>.')
 * // => false
 *
 * @example
 * isSuppressionFlavoredSuggestion(undefined)
 * // => false
 */
export function isSuppressionFlavoredSuggestion(suggestion: string | undefined): boolean {
  if (suggestion === undefined || suggestion.length === 0) return false;
  for (const token of SUPPRESSION_TOKENS) {
    if (suggestion.includes(token)) return true;
  }
  return false;
}
