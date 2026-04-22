/**
 * jekyll-livereload-minified-js — captures the TSX parser misidentifying a
 * bare `.js` file containing `<` comparison operators as JSX. Upstream source:
 * `jekyll/lib/jekyll/commands/serve/livereload_assets/livereload.js`, a
 * single-line minified distribution that includes `r.length<b.length`-shape
 * length comparisons. The parser reports `Unclosed JSX element <r.length>`
 * and drops the file to partial-parse, taking all downstream rule coverage
 * with it.
 *
 * Current state (RED by design per CLAUDE.md §7): the `zero-parse-errors`
 * assertion is COMMENTED OUT pending the fix tracked under
 * `Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS`. Fix direction: gate JSX-mode
 * entry on file extension (`.jsx`/`.tsx`/`.mdx`/`.astro` — not bare `.js`
 * or `.ts`) unless the file has a leading JSX-import signal. Bare JS should
 * never enter JSX mode regardless of `<identifier` tokens.
 *
 * Companion fixture: `astro-template-literal-jsx-attr` captures the other
 * JSX-context leak (template literal inside JSX attribute). Both share one
 * fix scope but reproduce independently; separate fixtures so a regression
 * in either path fails loudly and names its own repro.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A bare .js file containing `<` comparison operators (minified length compares) " +
    "must parse without errors. Currently fails because the TSX parser promotes " +
    "`<identifier` to a JSX open-tag even in non-JSX file contexts; the assertion " +
    "is commented out pending the fix tracked in Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS.",
  origin: {
    feedbackRound: "Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS",
    notes:
      "Sanitized from jekyll/lib/jekyll/commands/serve/livereload_assets/livereload.js. " +
      "Upstream is a single-line minified build artifact; this reproduction preserves the " +
      "shape (single-line IIFE, `<`/`>` length comparisons, short identifiers) without " +
      "shipping any upstream semantics. The bug is in TSX's JSX-mode entry predicate, " +
      "not in the minification — the same false-JSX leak would occur on any authored .js " +
      "file that happened to contain `a<b` comparisons.",
  },
  expectations: [{ kind: "zero-parse-errors" }],
};
