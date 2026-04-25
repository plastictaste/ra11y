/**
 * livereload-mixed-signal-parse-error — captures the dishonest
 * `parseErrorFiles` classification when a parse-error file ALSO emits
 * review candidates from a source-text finder.
 *
 * The bug (from V1-PARSE-ERROR-LIVERELOAD-MIXED-SIGNAL): a livereload-
 * shaped distribution produces a TSX parser error (originally
 * `Unclosed JSX element <r.length>` from `r.length<b.length` shape on a
 * bare `.js` file; the underlying TSX-parser entry has since been
 * tightened — see `jekyll-livereload-minified-js` — so this fixture
 * keeps the SAME structural bug alive on a `.tsx` file with a single
 * unclosed JSX element). On the same file the `review/timing` finder
 * emits `wcag22:2.2.1` review candidates by scanning `ctx.source`
 * directly via regex rather than via the (failed) AST walk.
 *
 * The classifier in
 * `src/mcp/analysis-coverage.ts:assembleParseErrorBlocks` splits
 * `parseErrorFiles` (zero output) from `partialParseFiles` (rules fired
 * on the recovered slice) using `findingFilePaths` — but every
 * callsite that builds that set looks only at `violations`, never at
 * review candidates. So a file that emits ONLY review candidates lands
 * in `parseErrorFiles` (read by agents as "invisible") even though
 * grounded `wcag22:2.2.1` candidates with live line numbers reach the
 * caller.
 *
 * Doctrine: "Ambiguous field shapes are dishonest" (CLAUDE.md §1).
 * `parseErrorFiles` MUST mean "no findings emerged"; mixing in files
 * that did emit candidates makes downstream triage silently wrong.
 *
 * Fix: include review-candidate file paths in the `findingFilePaths`
 * set passed to `buildAnalysisCoverage` (and `applyParseErrorAdjustment`,
 * via the same wiring).
 *
 * Companion fixture: `jekyll-livereload-minified-js` captures the
 * underlying TSX-parser false-JSX entry on bare .js files. That fix
 * eliminates the parse error entirely; this fixture guards the honest
 * classification path WHILE the parse error exists, so the bucket
 * stays correct regardless of whether the parser fix lands first.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A .tsx file whose TSX parser errors AND whose source-text review " +
    "finder still emits wcag22:2.2.1 setTimeout candidates must land in " +
    "`partialParseFiles` (not `parseErrorFiles`). The latter bucket is " +
    "agent-doctrine for `invisible-to-rules`; mixed-signal files mislead it.",
  origin: {
    feedbackRound: "V1-PARSE-ERROR-LIVERELOAD-MIXED-SIGNAL",
    notes:
      "Sanitized from a real livereload.js distribution. The combination of " +
      "a parser-error trigger (originally minified `<` length comparisons; here " +
      "an unclosed JSX element to keep the structural bug alive after the TSX " +
      "parser tightened bare-.js entry) AND setTimeout/setInterval call sites " +
      "is the canonical mixed-signal shape — vendor scripts the TSX parser " +
      "chokes on but whose timing primitives the regex-based finder still " +
      "grounds at file:line. Annotation, not suppression: the fix promotes " +
      "the file to `partialParseFiles` so the agent sees both the recall " +
      "warning and the surfaced candidates honestly.",
  },
  expectations: [
    // Sanity: the parser must still error on this shape (precondition for
    // the bug; without a parse error the file never enters either bucket).
    { kind: "parse-errors-at-path", path: "livereload.tsx" },
    // The setTimeout candidate must surface for wcag22:2.2.1 — proves the
    // source-text finder bypassed the failed AST and emitted output.
    { kind: "candidate-present", criterionId: "wcag22:2.2.1" },
    // The honest classification: the file emitted candidates, so it
    // belongs in `partialParseFiles`. Currently RED — the file lands in
    // `parseErrorFiles` because `findingFilePaths` only sees violations.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "partialParseFileCount"],
      predicate: { equals: 1 },
    },
    // Symmetric: `parseErrorFileCount` must NOT count this file. Once the
    // file moves to `partialParseFiles`, the count is omitted entirely
    // (present-when-meaningful per the coverage block doctrine).
    {
      kind: "meta-field",
      path: ["analysisCoverage", "parseErrorFileCount"],
      predicate: "absent",
    },
  ],
};
