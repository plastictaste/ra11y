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
 * rather than guessing from the file extension. The `parser` names
 * which in-house parser owned the failure (`html`, `css`, `tsx`,
 * `jsx`, `ts`, `js`) — distinguishable from the file extension because
 * e.g. `.mdx` routes through the MDX → TSX bridge and emits
 * `tsx`-class diagnostics. Classification into either `parseErrorFiles`
 * (total-parse-failure, file invisible to rules) or `partialParseFiles`
 * (rules fired on the recovered slice) is decided at emission time by
 * checking whether the file produced any findings.
 *
 * `triggerToken` is present-when-meaningful: parsers populate it when
 * the structured `reason` token (e.g. `tsx_parser_on_non_jsx_input`)
 * names a routing or interpretation failure rather than an authored-
 * source error, and the offending source fragment (e.g. the literal
 * `<r.length>` read from a minified `.js` `r.length<b.length`
 * comparison) is the additive evidence the agent needs to verify the
 * read without the parser echoing the fragment as if it were
 * authored ground truth. Absent on conventional prose-reason entries.
 */
export interface ParseErrorEntry {
  readonly path: string;
  readonly parser: string;
  readonly reason: string;
  readonly triggerToken?: string;
}
