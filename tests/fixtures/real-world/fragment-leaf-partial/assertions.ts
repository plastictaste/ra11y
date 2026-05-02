/**
 * fragment-leaf-partial — guards the
 * `analysisCoverage.fragmentFiles[].kind: "leaf_partial"`
 * discriminator on a Jekyll-style `_includes/icon-*.html` partial
 * whose AST contains zero landmark elements and whose top-level
 * content is exclusively inline tags (an SVG icon host).
 *
 * Doctrine: prior to this fixture, leaf partials (icon hosts, badge
 * wrappers, code-demo snippets, utility includes) silently rolled up
 * under the catch-all `layout_include_partial` kind because the path
 * pattern matched a recognized SSG include convention. Document-shape
 * rules (`landmark-main`, `heading-hierarchy`, `page-titled`,
 * `lang-attribute`) then either over-emitted at high confidence
 * against a leaf partial that is NOT a document AND has no useful
 * answer for those rules, OR forced an agent to dismiss the emission
 * by hand. Per AI-first consumer doctrine "Heuristic-mislabeled meta
 * sub-fields are dishonest," the `leaf_partial` discriminator names
 * the role-driven classification with AST evidence (zero landmark
 * elements anywhere AND every element is an inline tag from the
 * curated set) — the path-token evidence
 * (`pathSuggestsLeafPartial: true` for `icon-arrow.html`) rides
 * along as additive context but is never load-bearing on its own.
 *
 * What the fixture locks in:
 *   - The `_includes/icon-arrow.html` SVG icon partial appears in
 *     `fragmentFiles[]` with kind `leaf_partial` (NOT
 *     `layout_include_partial` — the role-driven kind wins because
 *     the AST evidence is more specific about role).
 *   - The companion `fragmentRoleSignals.hasOnlyInlineContent`
 *     surfaces `true` so an agent auditing the classification can
 *     read the AST evidence the predicate consumed.
 *
 * Companion to `fragment-composition-shell` (the symmetric shell
 * case) and `ssg-include-partial-parse-recovery` (the path-driven
 * `layout_include_partial` fallback when AST evidence is mixed /
 * absent).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "An `_includes/icon-arrow.html` SVG icon partial whose AST contains " +
    "zero landmark elements and whose top-level content is exclusively " +
    "inline tags must classify in `fragmentFiles[]` with kind " +
    "`leaf_partial` — NOT `layout_include_partial` — because the AST " +
    "evidence is more specific about role. The companion " +
    "`fragmentRoleSignals.hasOnlyInlineContent` surfaces `true` as the " +
    "structural evidence the predicate consumed.",
  origin: {
    notes:
      "Sanitized from the canonical Jekyll / Hugo / Eleventy " +
      "`_includes/icon-<name>.html` shape: a presentational include " +
      "whose role in the assembled document is to provide an inline " +
      "SVG glyph composed into surrounding markup. The AST evidence " +
      "(zero landmark elements, exclusively inline tags including " +
      "`<svg>` / `<path>`) is the load-bearing predicate; the path- " +
      "basename token (`icon`) rides along as additive context. Per " +
      "AI-first consumer doctrine `Heuristic-mislabeled meta sub-" +
      "fields are dishonest`, the discriminator must be provable from " +
      "AST alone — the path evidence is never sufficient on its own.",
  },
  expectations: [
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "0", "path"],
      predicate: { equals: "_includes/icon-arrow.html" },
    },
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "0", "kind"],
      predicate: { equals: "leaf_partial" },
    },
    // The role-signals sub-field surfaces the AST evidence the
    // predicate consumed. `hasOnlyInlineContent` is the load-bearing
    // AST signal — every element in the tree is an inline tag from
    // the curated set.
    {
      kind: "meta-field",
      path: [
        "analysisCoverage",
        "fragmentFiles",
        "0",
        "fragmentRoleSignals",
        "hasOnlyInlineContent",
      ],
      predicate: { equals: true },
    },
    // Path-basename token check fires for `icon` — additive
    // context, not load-bearing.
    {
      kind: "meta-field",
      path: [
        "analysisCoverage",
        "fragmentFiles",
        "0",
        "fragmentRoleSignals",
        "pathSuggestsLeafPartial",
      ],
      predicate: { equals: true },
    },
  ],
};
