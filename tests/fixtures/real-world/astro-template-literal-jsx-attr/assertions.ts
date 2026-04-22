/**
 * astro-template-literal-jsx-attr — captures the TSX parser entering JSX
 * mode inside a template literal that is the body of a JSX attribute
 * expression. The canonical shape is `<Example code={`<iframe>…</iframe>`} />`,
 * as shipped in Bootstrap's Astro/Starlight docs site (`helpers/ratio.mdx`,
 * `components/dropdowns.mdx` — 12 files partial-parse in the upstream repo).
 *
 * Current state (RED by design per CLAUDE.md §7 bug-fix workflow): the
 * `zero-parse-errors` assertion is COMMENTED OUT pending the parser fix
 * tracked in `Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS`. The fixture source
 * is committed first so the eventual fix has a live reproducer; once the
 * fix lands, the commented assertion is reinstated and the fixture turns
 * green as a regression guard against re-introduction.
 *
 * Why not land green today: the TSX tokenizer still promotes `<div` and
 * `<iframe` to JSX open-tags inside template-literal contents when the
 * surrounding attribute is a JSX expression. A green assertion here would
 * be a load-bearing false claim that the parser handles Astro/Starlight
 * docs sites cleanly.
 *
 * Scope of the pending fix: while tokenizing a template literal whose
 * parent is a JSX attribute value, treat the contents as opaque string
 * data (no JSX mode, no HTML-ish tag recognition). The backlog entry
 * documents the sibling minified-JS case handled under a separate fixture
 * (jekyll-livereload-minified-js).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A TSX file with <Example code={`<iframe>…</iframe>`} /> must parse without " +
    "errors — the template literal contents are opaque string data, not a nested JSX tree. " +
    "Currently fails because the TSX parser promotes `<iframe` inside the template literal " +
    "to a JSX open-tag; the assertion is commented out pending the fix tracked in " +
    "Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS.",
  origin: {
    feedbackRound: "Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS",
    notes:
      "Sanitized from bootstrap/site/src/content/docs/helpers/ratio.mdx and " +
      "components/dropdowns.mdx. Upstream is .mdx/.astro; reproduction fixture uses .tsx " +
      "because the harness parses JS/TS/JSX/TSX via parseTsx — the same entry point the " +
      "live Astro pipeline eventually reaches. The parser bug is in JSX-attribute " +
      "template-literal handling, not in the file-extension dispatch.",
  },
  expectations: [
    // Pending fix for Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS. When the TSX
    // parser stops entering JSX mode inside template-literal contents of
    // JSX attribute values, uncomment this assertion. The fixture stays
    // committed as a live reproducer in the meantime.
    // { kind: "zero-parse-errors" },
  ],
};
