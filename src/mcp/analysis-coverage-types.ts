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
 */
export interface ParseErrorEntry {
  readonly path: string;
  readonly parser: string;
  readonly reason: string;
}
