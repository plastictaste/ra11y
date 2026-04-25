/**
 * ssg-pagination-sensory-line-drift — guards review/sensory-characteristics
 * (wcag22:1.3.3) finder against line-drift on Markdown body text whose
 * containing block carries inline Liquid directives.
 *
 * Origin: a Jekyll-style docs site shipped `docs/_docs/pagination.md`
 * with a `<div class="example">` block that wrapped a multi-line
 * `{% include pagination.html ... %}` directive immediately above the
 * sensory phrase "See below for the rendered output." The 1.3.3 finder
 * reported the candidate two lines above the phrase — at the line where
 * the Liquid `%}` closed, not the line where "See below" actually
 * appears. The drift is exactly the count of newlines inside the stripped
 * directive span.
 *
 * Mechanism: the HTML parser's text-node `value` is post-
 * `stripTemplateDirectives`. Multi-line `{% ... %}` spans collapse to
 * zero characters in `value`, taking their newlines with them. The
 * finder's `precisePositionForOffset` walked `node.value` counting
 * `\n` codepoints to map a concat-offset back to (line, column). Since
 * the post-strip `value` was missing the newlines that lived inside the
 * directive, every `\n` after the stripped span undercounted the source
 * line by N (where N = newlines stripped).
 *
 * Same class of bug as the SCSS-selector line-drift fixture (cited the
 * `animation:` declaration line instead of the ruleset opener); this
 * one is the Markdown-body / HTML-residue variant of the same line-
 * mapping anti-pattern. See the `jekyll-docsearch-scss-line-drift`
 * sibling fixture for the CSS variant.
 *
 * Captured as `.html` so the fixture harness's `parseHtml` path
 * exercises the exact post-residue shape an `.md` file produces after
 * `parseMarkdown` strips frontmatter / fences / headings — mirrors the
 * jekyll-docsearch-scss-line-drift fixture (also captured as `.css`,
 * not `.scss`) rather than widening the harness's parser surface.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Guards review/sensory-characteristics (wcag22:1.3.3) finder against " +
    "line-drift when the containing block carries inline Liquid directives: " +
    "the candidate must point at the line of the matched text run, not at " +
    "an upstream line that the post-strip text-node value coincidentally " +
    "lands on after multi-line directive spans collapse.",
  origin: {
    notes:
      "Sanitized excerpt of a Jekyll-style `docs/_docs/pagination.md` page. " +
      "Original report cited `pagination.md:134` for the phrase \"See below\" " +
      "whose actual position was line 136 — finder pointed at the containing " +
      "block-open line rather than the text-node's own line.",
  },
  expectations: [
    // Source must parse cleanly — a parse error would mask the line-drift signal.
    { kind: "zero-parse-errors" },

    // The candidate must surface (surface, don't suppress) — no regression
    // that silently drops the 1.3.3 finding on this prose shape.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.3.3",
      reasonIncludes: "See below",
    },

    // Positional honesty: the candidate must anchor on line 32, the line
    // where "See below for the rendered output." literally appears in the
    // source. The pre-fix finder cited line 30 — the line where the
    // multi-line `{% include … %}` directive closes its `%}` token. The
    // two-line drift equals the number of newlines inside the directive
    // span that were collapsed away when the parser stripped the
    // directive from the text-node `value`. A regression that walks the
    // post-strip `value` to count newlines re-introduces the same drift.
    {
      kind: "candidate-at-line",
      criterionId: "wcag22:1.3.3",
      path: "pagination.html",
      line: 32,
      reasonIncludes: "See below",
    },

    // The 2.1 mirror must move in lockstep — both criteria are emitted
    // from the same finder, so a fix that lands one but not the other
    // would be a partial regression on standards parity.
    {
      kind: "candidate-at-line",
      criterionId: "wcag21:1.3.3",
      path: "pagination.html",
      line: 32,
      reasonIncludes: "See below",
    },
  ],
};
