/**
 * mdx-iframe-in-backticks — guards that MDX prose with backtick-escaped
 * `<iframe>` tokens does not produce review candidates or violations
 * anchored at the prose lines, while the real iframe inside an
 * `<Example code={`…`}/>` template is still surfaced as a regular
 * synthesized JSX element.
 *
 * Field report:
 * An MDX file in a docs site (Astro Starlight content collection)
 * carries prose like:
 *
 *     Skip the `frameborder="0"` attribute on your `<iframe>`s.
 *
 * The MDX adapter strips fenced code blocks and frontmatter, but does
 * not symmetrically strip inline backtick-code spans (`…`) the way
 * the sibling markdown adapter (`src/input/parsers/markdown.ts`) does.
 * The TSX scanner that takes over the residue therefore reads the
 * backtick spans as JS template literals at top level — fine for the
 * common balanced case, but a load-bearing fragility:
 *
 *   1. An unbalanced backtick (single tick at end of a sentence)
 *      flips the scanner into template-literal mode and consumes
 *      everything until the next backtick — which can be the opening
 *      of a downstream `<Example code={`…`}/>` body, swallowing the
 *      docs-component element and its template entirely.
 *
 *   2. Future finders or rules that scan the source-text substrate
 *      directly (rather than walking the JSX AST) would see the
 *      backtick contents as live tokens. The Q7 fixture
 *      (`iframe-prose-vs-element-candidate`) addressed this for raw
 *      HTML `<code>` blocks; this fixture is the MDX-surface analog.
 *
 *   3. Symmetry with the markdown adapter — both `.md` and `.mdx`
 *      pipelines should expose the same residual shape to downstream
 *      consumers, so a regression in one parser is observable as
 *      drift, not silently absorbed by the other.
 *
 * What the fixture locks in:
 *
 *   - Source parses cleanly. Parse errors would mask the violation /
 *     candidate signals downstream.
 *
 *   - The real `<iframe>` inside the `<Example code={`…`}/>` body
 *     surfaces a `document/iframe-title` violation at line 24. Surface,
 *     don't suppress — the synthesized iframe is missing a title and
 *     must still be flagged.
 *
 *   - No 1.2.x review candidates anywhere in the file. The MDX has
 *     zero `<video>` or `<audio>` elements; the only media token is
 *     the synthesized `<iframe>`, and per the Q7 iframe-non-emission
 *     contract iframes are never 1.2.x evidence.
 *
 *   - No `document/iframe-title` violation on the prose backtick
 *     lines (14, 15, 16, 17, 21) or the fenced code block (lines
 *     30-34). A regression that promotes prose-backtick `<iframe>`
 *     tokens to JSX elements would fire iframe-title here, failing the
 *     fixture.
 *
 * Sanitization: source is a minimal MDX docs page that mirrors the
 * Astro Starlight `helpers/ratio.mdx` shape — frontmatter, an import,
 * prose with backticked HTML tag names, an `<Example code={`…`}/>`
 * block, and a fenced code reference snippet. No real brand names,
 * URLs, or video identifiers; the embed src is `/intro.mp4` and the
 * import path is a placeholder.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "MDX prose with backtick-escaped <iframe> tokens must not produce " +
    "violations or 1.2.x review candidates anchored at the prose " +
    "lines — the MDX adapter strips inline-code spans (`…`) before " +
    "the TSX scanner walks the residue, the same way it already strips " +
    "fenced code blocks. The synthesized iframe inside <Example " +
    "code={`…`}/> is surfaced as a real (synthesized) JSX element.",
  origin: {
    notes:
      "Mirrors Q6/Q7 iframe-finder fixes (JS string literals, HTML " +
      "<code> blocks) for the MDX inline-code-span surface. Field " +
      "report cited a docs site MDX file with three 1.2.x candidates " +
      "anchored at prose lines while the real <iframe> inside " +
      "<Example code={`…`}/> went un-flagged. The 1.2.x emission " +
      "path was already closed by the iframe-as-1.2.x drop " +
      "(commit 35ed3179); this " +
      "fixture pins the MDX-side hardening — strip inline-code spans " +
      "in the MDX adapter so prose backticks cannot surface as JSX " +
      "elements via any downstream finder, present or future.",
  },
  expectations: [
    // Source must parse cleanly — parse errors would mask the
    // downstream signals the fixture is asserting on.
    { kind: "zero-parse-errors" },

    // Positive control: the real <iframe> synthesized from
    // <Example code={`…`}/> at line 24 must still surface a
    // document/iframe-title violation. Surface, don't suppress —
    // the synthesized iframe lacks an accessible name.
    {
      kind: "violation-present",
      ruleId: "document/iframe-title",
      inFile: "ratio.mdx",
    },

    // No 1.2.x review candidates anywhere in the file. The MDX has
    // zero <video>/<audio> elements; the only media token is the
    // synthesized <iframe> inside <Example>, and per the Q7
    // iframe-non-emission contract iframes are never 1.2.x evidence.
    // A regression that re-promotes iframes (synthesized or otherwise)
    // to 1.2.x candidates would fail here.
    { kind: "no-candidate", criterionId: "wcag22:1.2.1" },
    { kind: "no-candidate", criterionId: "wcag22:1.2.3" },
    { kind: "no-candidate", criterionId: "wcag22:1.2.5" },
    { kind: "no-candidate", criterionId: "wcag21:1.2.1" },
    { kind: "no-candidate", criterionId: "wcag21:1.2.3" },
    { kind: "no-candidate", criterionId: "wcag21:1.2.5" },
  ],
};
