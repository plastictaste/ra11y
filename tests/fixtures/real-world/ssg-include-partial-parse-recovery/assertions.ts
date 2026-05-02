/**
 * ssg-include-partial-parse-recovery — guards the
 * `analysisCoverage.fragmentFiles[]` reclassification of SSG include
 * partials whose own tag balance legitimately depends on a sibling
 * partial.
 *
 * The bug: a Jekyll / Hugo / Eleventy `_includes/header.html` typically
 * opens an outer `<div class="page-content">` whose closer is supplied
 * by `_includes/footer.html`. The HTML parser reads each partial in
 * isolation, sees the unclosed `<div>`, and emits a recoverable
 * "Unclosed `<div>` element" parse error. Without a carve-out, the
 * file landed in `analysisCoverage.parseErrorFiles[]` with that reason
 * — an honestly false signal: the partial's own markup is fine, the
 * missing closer lives in a sibling the scanner cannot splice.
 *
 * Per AI-first consumer doctrine "Routing skips that drop content are
 * the symmetric twin of suppression," the fix surfaces the substrate
 * classification (the file IS a fragment whose envelope is composed
 * elsewhere) rather than the less-informative parse-error narrative.
 * The two-signal AND (recognized SSG include path AND fragment-shape:
 * `hasHtmlOpener: false`) keeps the gate honest — a genuinely-broken
 * `_includes/<name>.html` whose author DID intend a full document
 * (rare; the partial would carry `<html>` then) stays in
 * `parseErrorFiles[]`.
 *
 * What the fixture locks in:
 *   - The `_includes/header.html` partial with its unclosed
 *     `<div class="page-content">` (closer in `_includes/footer.html`)
 *     does NOT appear in `parseErrorFiles[]`.
 *   - It DOES appear in `fragmentFiles[]` with kind
 *     `composition_shell` — the role-driven kind that names "this
 *     partial IS providing a top-level `<header>` landmark the
 *     assembled document depends on." Per AI-first doctrine
 *     "Heuristic-mislabeled meta sub-fields are dishonest," the
 *     AST-evidence-driven `composition_shell` discriminator wins
 *     over the path-driven `layout_include_partial` because the AST
 *     evidence is more specific about role.
 *
 * Companion to other parse-recovery fixtures
 * (`code-block-cdata`, `liquid-root-layout-parse-recovery`,
 * `livereload-mixed-signal-parse-error`): each guards a distinct
 * substrate where the parse-error narrative was honestly wrong, and
 * the fix routes the file through a more informative classification.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Jekyll-style `_includes/<name>.html` partials whose own tag balance " +
    "depends on a sibling partial (the canonical wrapping-div idiom) must " +
    "route to `fragmentFiles[]` with kind `layout_include_partial`, NOT " +
    "to `parseErrorFiles[]` with the honestly-false 'Unclosed <div> " +
    "element' reason.",
  origin: {
    notes:
      "Sanitized from the Jekyll default-theme include-partial idiom: " +
      "`_includes/header.html` opens `<div class='page-content'>` and " +
      "`_includes/footer.html` closes it. The HTML parser reads each " +
      "file in isolation and surfaces a recoverable parse error on the " +
      "unclosed `<div>` — a false signal because the partial's tag " +
      "balance is correct once the parent layout composes the two " +
      "files. Per AI-first doctrine 'Routing skips that drop content " +
      "are the symmetric twin of suppression,' the file routes through " +
      "the substrate classification (fragment, kind " +
      "`layout_include_partial`) rather than the less-informative " +
      "parse-error narrative.",
  },
  expectations: [
    // Path-list arrays carry the agent-actionable classification. The
    // header partial MUST appear in `fragmentFiles[]` so the agent can
    // route around the include with the honest narrative.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "0", "path"],
      predicate: { equals: "_includes/footer.html" },
    },
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "0", "kind"],
      predicate: { equals: "composition_shell" },
    },
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "1", "path"],
      predicate: { equals: "_includes/header.html" },
    },
    {
      kind: "meta-field",
      path: ["analysisCoverage", "fragmentFiles", "1", "kind"],
      predicate: { equals: "composition_shell" },
    },
    // The substrate gate must keep the include partial OUT of
    // `parseErrorFiles[]`. With the Q9 always-populate fix the counter
    // is present-and-zero (not absent) so the agent reads "telemetry
    // collected, value is 0" rather than disambiguating absence.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "parseErrorFileCount"],
      predicate: { equals: 0 },
    },
  ],
};
