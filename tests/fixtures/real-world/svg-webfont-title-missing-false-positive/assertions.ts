/**
 * svg-webfont-title-missing-false-positive — guards that
 * `semantics/svg-title-missing` does NOT fire on SVG webfont
 * definition files. These are font-definition resources consumed
 * by `@font-face`, never `<img>`-rendered or inlined as UI graphics
 * — the rule's premise (an SVG asset rendered as a UI image needs
 * an accessible name) does not apply.
 *
 * Bug shape: a vendor-heavy bulk-template corpus contained SVG
 * webfont source files whose root structure is `<svg><defs><font
 * id="…"><missing-glyph/><glyph unicode="…"/>…</font></defs></svg>`
 * — no `<path>`/`<rect>`/`<circle>`/`<g>` drawing primitives at top
 * level, no `<title>`, no UI rendering. `semantics/svg-title-missing`
 * fired at `severity: error, confidence: high` because the file
 * matched the root-`<svg>` predicate without inspecting the children
 * for font-definition shape.
 *
 * Closure path: extend the SVG classifier to detect font-glyph SVGs
 * — when a root `<svg>` contains a `<font id="…">` direct child, OR
 * has only `<font>`/`<missing-glyph>`/`<glyph>` descendants with no
 * `<path>`/`<rect>`/`<circle>`/`<g>` drawing primitives, classify
 * as `font-glyph-svg` and skip `semantics/svg-title-missing` (and
 * any other UI-image rule that presumes the SVG is rendered as a
 * picture). Sibling `.ttf` / `.eot` / `.woff` files in the same
 * directory are an additional confirmation signal.
 *
 * Once the classifier ships, the `no-violation` predicate is the
 * load-bearing assertion: scanning the fixture must produce zero
 * `semantics/svg-title-missing` findings.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "semantics/svg-title-missing must not fire on SVG webfont definition files " +
    "— root <svg><defs><font><glyph/></font></defs></svg> shape is a font-definition " +
    "resource consumed by @font-face, not a UI image. The rule's accessible-name " +
    "premise does not apply.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep on a vendor-heavy bulk-template catalog " +
      "observed semantics/svg-title-missing firing at severity:error, confidence:high " +
      "on SVG webfont source files (root <font> element with 200+ <glyph> children, " +
      "no UI drawing primitives, sibling .ttf/.eot/.woff files in same directory).",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // The rule must NOT fire on font-glyph SVGs. This is the load-bearing
    // assertion the classifier must satisfy.
    {
      kind: "no-violation",
      ruleId: "semantics/svg-title-missing",
    },
  ],
};
