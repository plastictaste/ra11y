/**
 * js-routing-member-access-comparisons — captures the parser route for bare
 * `.js` files containing `<Identifier`-shaped comparison operators. Upstream
 * field report: a single project produced a 538-entry `parseErrorFiles[]`
 * with reasons like "Unclosed JSX element <h>" and "<g.top>" — every plain-JS
 * file with a `<member.access` length comparison was being misclassified as
 * broken JSX, flooding the response and dominating token-budget overrun
 *
 * The fix surface is two-layered:
 *   1. `parseTsx`'s `inferJsxMode` already gates JSX-mode entry on
 *      file extension — bare `.js`/`.ts` without a JSX-import signal
 *      stay in non-JSX mode (added under
 *      Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS).
 *   2. The Q8 work plumbs `filePath` through every remaining
 *      `parseTsx` caller that already had it in scope (the MCP
 *      session, apply-fix re-parse path) so the gate fires uniformly.
 *
 * Companion fixture: `jekyll-livereload-minified-js` covers the minified
 * single-line shape; this fixture covers the multi-line authored shape with
 * member-access comparisons that more closely matches the field report's
 * reason snippets.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A bare .js file with `if (a < b && b > c)` plus `a < b.length` and `e < g.top` " +
    "member-access comparisons must parse without errors. Without the JSX-mode gate " +
    "the parser promotes `<b.length>` and `<g.top>` to JSX open-tags, hunts for their " +
    "closing tags, and emits fake `Unclosed JSX element <…>` errors at EOF — flooding " +
    "`parseErrorFiles[]` with as many false errors as the project has plain-JS files.",
  origin: {
    notes:
      "Sanitized from a field report citing 538-entry parseErrorFiles[] with reasons " +
      "like `Unclosed JSX element <h>` and `<g.top>`. The reproduction preserves the " +
      "shape (member-access length comparisons in plain JS) without shipping any " +
      "upstream semantics.",
  },
  expectations: [{ kind: "zero-parse-errors" }],
};
