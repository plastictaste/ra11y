/**
 * fragment-composition-shell — guards the
 * `analysisCoverage.fragmentFiles[].kind: "composition_shell"`
 * discriminator on a Jekyll-style `_includes/header.html` whose AST
 * surfaces a top-level `<header>` landmark element.
 *
 * Doctrine: prior to this fixture, every HTML fragment in
 * `fragmentFiles[]` shipped under one of the catch-all kinds
 * (`html_partial`, `layout_include_partial`) regardless of the
 * partial's structural role. Document-shape rules (`landmark-main`,
 * `heading-hierarchy`, `page-titled`, `lang-attribute`) then either
 * over-emitted at high confidence on leaves OR silently downgraded on
 * composition shells where the partial's contribution to the
 * assembled document IS load-bearing. Per AI-first consumer doctrine
 * "Heuristic-mislabeled meta sub-fields are dishonest," the
 * `composition_shell` discriminator names the role-driven
 * classification with AST evidence (a top-level landmark element
 * present in the parsed file) — the path-token evidence
 * (`pathSuggestsCompositionShell: true` for `header.html`) rides
 * along as additive context but is never load-bearing on its own.
 *
 * What the fixture locks in:
 *   - The `_includes/header.html` partial appears in
 *     `fragmentFiles[]` with kind `composition_shell` (NOT
 *     `layout_include_partial` — the role-driven kind wins because
 *     the AST evidence is more specific about role).
 *   - The companion `fragmentRoleSignals.topLevelLandmarkTags`
 *     surfaces `["header"]` so an agent auditing the classification
 *     can read the AST evidence the predicate consumed without
 *     re-deriving it.
 *
 * Companion to `fragment-leaf-partial` (the symmetric leaf case)
 * and `ssg-include-partial-parse-recovery` (the path-driven
 * `layout_include_partial` fallback when AST evidence is absent /
 * empty).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "An `_includes/header.html` partial whose AST surfaces a top-level " +
    "`<header>` landmark element must classify in `fragmentFiles[]` with " +
    "kind `composition_shell` — NOT `layout_include_partial` — because the " +
    "AST evidence is more specific about role. The companion " +
    '`fragmentRoleSignals.topLevelLandmarkTags` surfaces `["header"]` as ' +
    "the structural evidence the predicate consumed.",
  origin: {
    notes:
      "Sanitized from the canonical Jekyll / Hugo / Eleventy " +
      "`_includes/header.html` shape: a partial whose role in the " +
      "assembled document is to provide the page banner. The AST " +
      "evidence (top-level `<header>` landmark element) is the load- " +
      "bearing predicate; the path-basename token (`header`) rides " +
      "along as additive context. Per AI-first consumer doctrine " +
      "`Heuristic-mislabeled meta sub-fields are dishonest`, the " +
      "discriminator must be provable from AST alone — the path " +
      "evidence is never sufficient on its own.",
  },
  expectations: [
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "0", "path"],
      predicate: { equals: "_includes/header.html" },
    },
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "0", "kind"],
      predicate: { equals: "composition_shell" },
    },
    // The role-signals sub-field surfaces the AST evidence the
    // predicate consumed. `topLevelLandmarkTags` carries the
    // landmark tag(s) present at the document root — the load-
    // bearing AST signal.
    {
      kind: "meta-field",
      path: [
        "analysisCoverage",
        "fragmentFiles",
        "0",
        "fragmentRoleSignals",
        "topLevelLandmarkTags",
        "0",
      ],
      predicate: { equals: "header" },
    },
    // Path-basename token check fires for `header` — additive
    // context, not load-bearing.
    {
      kind: "meta-field",
      path: [
        "analysisCoverage",
        "fragmentFiles",
        "0",
        "fragmentRoleSignals",
        "pathSuggestsCompositionShell",
      ],
      predicate: { equals: true },
    },
  ],
};
