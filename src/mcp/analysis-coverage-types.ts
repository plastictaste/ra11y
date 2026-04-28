/**
 * Shared types co-owned by `analysis-coverage.ts` and its sibling
 * sub-assemblers (currently `analysis-coverage-parse-errors.ts`). Kept
 * in a thin types-only module so neither consumer creates an
 * import-back-edge to the parent — the parent file owns the
 * orchestration and the sub-assemblers own the per-section logic, and
 * the shared shape they both touch lives here.
 */

/**
 * A file whose parser emitted errors. The `reason` is the first parse
 * error's message — surfaced as-is so an agent can branch on the root
 * cause ("Unexpected token `<`" vs "Unterminated string literal")
 * rather than guessing from the file extension.
 *
 * `parserAttempted` names which in-house parser owned the failure
 * (`html`, `css`, `tsx`, `jsx`, `ts`, `js`) — i.e. the routing
 * decision the dispatcher in `src/mcp/session.ts` `parseSourceForFile`
 * actually took. This is *not* a content classification: a `.js` file
 * routed through the TSX parser ships `parserAttempted: "tsx"`, which
 * an agent reading naively could mistake as "this codebase uses TSX"
 * and re-route fix suggestions accordingly. The companion
 * `naturalParser` field disambiguates (per AI-first consumer model
 * "Ambiguous field shapes are dishonest").
 *
 * `naturalParser` is present-when-meaningful: the per-extension
 * default the agent would expect from looking at the file extension
 * alone (`.js` → `js`, `.svg` → `svg`, `.scss` → `scss`). Surfaced
 * only when it differs from `parserAttempted` — for matching
 * extension/parser pairs (`.tsx` → `tsx`, `.html` → `html`,
 * `.css` → `css`) the field is omitted because there is no routing
 * mismatch to disclose. The two-field shape lets the agent see in one
 * read whether the parse failure was on a file routed through a
 * non-natural parser (e.g. `.js` → tsx) versus a file whose natural
 * parser failed on its own input.
 *
 * Classification into either `parseErrorFiles` (total-parse-failure,
 * file invisible to rules) or `partialParseFiles` (rules fired on the
 * recovered slice) is decided at emission time by checking whether
 * the file produced any findings.
 *
 * `triggerToken` is present-when-meaningful: parsers populate it when
 * the structured `reason` token (e.g. `tsx_parser_on_non_jsx_input`)
 * names a routing or interpretation failure rather than an authored-
 * source error, and the offending source fragment (e.g. the literal
 * `<r.length>` read from a minified `.js` `r.length<b.length`
 * comparison) is the additive evidence the agent needs to verify the
 * read without the parser echoing the fragment as if it were
 * authored ground truth. Absent on conventional prose-reason entries.
 *
 * `parsedThroughLine` is present-when-meaningful: the 1-based source
 * line of the first parse error — the natural "parser stopped here"
 * signal so an agent can bound trust in per-rule findings on the file
 * (rules may have visited the first 5 lines or the first 500). Without
 * it, an agent triaging a `partialParseFiles` entry has no way to
 * scope the verification read short of the whole file, defeating the
 * static-scanner premise. Sourced from the head error's
 * {@link ../types/ast.SourcePosition.line | `position.line`}; absent
 * when the parser couldn't record an exact line (`position.line` is 0
 * or otherwise non-meaningful) — never `0` or `null` as a sentinel,
 * per the AI-first consumer model's rule against ambiguous field
 * shapes.
 */
export interface ParseErrorEntry {
  readonly path: string;
  readonly parserAttempted: string;
  readonly naturalParser?: string;
  readonly reason: string;
  readonly triggerToken?: string;
  readonly parsedThroughLine?: number;
}
