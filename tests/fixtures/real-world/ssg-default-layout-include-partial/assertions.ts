/**
 * jekyll-default-layout — guards `semantics/landmark-main` against
 * silently missing the `<main>` gap on Jekyll layout wrappers that
 * inject content via `{{ content }}` / `{% include %}`.
 *
 * Jekyll composes a rendered page as `_includes/top.html` (head +
 * opening body) + the selected `_layouts/*.html` wrapping
 * `{{ content }}` (the page's own body) + `_includes/footer.html`.
 * Each file parses in isolation — the scanner can't follow the
 * include graph. Two concrete failure modes before the fix:
 *
 *   1. `default.html` — has `<html>` + `<body>` but no `<main>` of its
 *      own (the `<main>` lives in the child page's body rendered into
 *      `{{ content }}`). The rule used to fire at full confidence with
 *      NO indication that the <main> might be composed elsewhere, so
 *      an agent acting on the finding would patch the layout file when
 *      the right fix is to audit the content pages.
 *   2. `top.html` — has `<html>` opening but no `<body>` close (the
 *      closing `</body></html>` lives in `footer.html`). The rule used
 *      to silently skip (body-less = fragment = out of scope), hiding
 *      the composition-level gap entirely.
 *
 * After the fix, both files surface a `semantics/landmark-main`
 * finding enriched with `couldBeWrongBecause:
 * ["partial_or_layout_file_requires_composed_check"]` and a message
 * naming the layout-wrapper / template-partial shape — per
 * docs/kb/architecture/ai-first-consumer.md §"Surface, don't suppress"
 * and §"No heuristic suppression." The agent reading the file sees
 * the `{% include %}` / `{{ content }}` / missing `<body>` close in
 * one read and routes the fix correctly (or adds the deterministic
 * source-level disable pragma).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "semantics/landmark-main fires on Jekyll layout wrappers (default.html with " +
    "{{ content }}, top.html with no <body> close) and attaches " +
    "`partial_or_layout_file_requires_composed_check` so the agent can tell " +
    "the composition-level gap apart from a confident missing-<main> finding.",
  origin: {
    notes:
      "Jekyll layouts compose at render time — `_layouts/default.html` wraps " +
      "`{{ content }}` while `_includes/top.html` + `_includes/footer.html` " +
      "split the <html>/<body> open/close across files. Scanner parses each " +
      "file in isolation, so without composition-aware enrichment the agent " +
      "sees a confident finding that points at the wrong fix site.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // Surface-don't-suppress: the finding must fire so the agent sees
    // the gap on both canonical Jekyll layout shapes. Under the old
    // behavior `top.html` would have been silently skipped (body-less).
    { kind: "violation-present", ruleId: "semantics/landmark-main" },

    // Message must name the layout/partial shape so an agent reading
    // the finding routes to the include/composition chain in one read.
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      reasonIncludes: "layout wrapper or template partial",
    },
  ],
};
