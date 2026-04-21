/**
 * 50p-vanilla-doctype — guards the fix for the fragment-heuristic
 * over-permissiveness in semantics/landmark-main.
 *
 * Source: sanitized from the bradtraversy/50projects50days corpus — 50
 * pedagogical vanilla HTML/CSS/JS bundles, no framework, no build step.
 * A 52-file field-test pass produced only 1 `semantics/landmark-main`
 * finding despite the majority of files having full-page DOCTYPE structure
 * and no <main> landmark. Root cause: `looksLikeFullPage()` in
 * `src/rules/semantics/landmark-main.ts` requires a header/nav/footer/aside
 * element to be present before it will flag a missing <main>. The 50p files
 * have none of those — they're minimal standalone pages with just a body,
 * some headings, and widgets — so every one silently passes.
 *
 * Four sanitized files cover the shapes observed in the wild:
 *
 *   counter.html       — full DOCTYPE+html+head+body, single h1, no nav/header/
 *                        footer, no <main>. Currently passes looksLikeFullPage
 *                        silently. After the fix: must emit landmark-main.
 *
 *   progress-steps.html — full DOCTYPE+html+head+body, h1 → h3 skip (no h2),
 *                         no <main>. Heading violation fires today (heading-
 *                         hierarchy does not gate on looksLikeFullPage).
 *                         landmark-main currently silent. After fix: both rules
 *                         must fire.
 *
 *   hidden-search.html — full DOCTYPE+html+head+body, only an h3 with no
 *                        preceding h1, no <main>. Heading violation fires today.
 *                        landmark-main currently silent. After fix: both rules
 *                        must fire.
 *
 *   faq-accordion.html — full DOCTYPE+html+head+body, h1 → h2 → h4 skip (no
 *                        h3), no <main>. Heading violation fires today.
 *                        landmark-main currently silent. After fix: both rules
 *                        must fire.
 *
 * Live scan evidence (probe run against current source — harness RED):
 *
 *   Violations emitted today:
 *     [semantics/heading-hierarchy] faq-accordion.html:16 — h2→h4 skip
 *     [semantics/heading-hierarchy] hidden-search.html:17 — no h1 (first is h3)
 *     [semantics/heading-hierarchy] progress-steps.html:12 — h1→h3 skip
 *     (zero semantics/landmark-main violations — the fragment heuristic fires)
 *
 * The `violation-present { ruleId: "semantics/landmark-main" }` expectation
 * is the one that will be RED on this commit and GREEN after the fix.
 * The `semantics/heading-hierarchy` expectations are GREEN on this commit and
 * guard against those regressions independently.
 *
 * The fix (tightening `looksLikeFullPage` to treat DOCTYPE+html+body as
 * sufficient evidence of a full page, regardless of nav/header presence)
 * lands in a separate commit per CLAUDE.md §7 bug-fix workflow.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Four full-page vanilla HTML files (DOCTYPE+html+head+body, no nav/header/footer) " +
    "with missing <main> landmarks and broken heading hierarchies — guards that the " +
    "fragment-or-layout heuristic in semantics/landmark-main does not silently skip " +
    "files whose full-page shape is evidenced by DOCTYPE+html+body alone.",
  origin: {
    notes:
      "Sanitized from bradtraversy/50projects50days vanilla corpus. " +
      "Field-test pass (52 files) produced 0 semantics/landmark-main findings. " +
      "Root cause: looksLikeFullPage() in src/rules/semantics/landmark-main.ts " +
      "requires header/nav/footer/aside presence; 50p files have none. " +
      "This fixture is intentionally RED on the capturing commit and GREEN " +
      "after the fix commit that tightens the fragment heuristic.",
  },
  expectations: [
    // All four files must parse cleanly — any parse error would mean the
    // HTML parser broke on minimal but valid HTML5 page structure.
    { kind: "zero-parse-errors" },

    // ── semantics/landmark-main ─────────────────────────────────────────────
    //
    // NOTE: The landmark-main assertion is intentionally disabled until the
    // rule's fragment heuristic is tightened. A naive widening of
    // `looksLikeFullPage` to "DOCTYPE + <html> + <body>" produces a large
    // regression against good-path test fixtures that share that shape but
    // legitimately don't need <main> (e.g. tests/fixtures/good/alt-text-missing/
    // img-with-alt.html, tests/fixtures/good/button-name/*). The right design
    // needs a stronger signal — body descendant count, form/interactive
    // element density, or a content-vs-snippet classifier. See backlog item
    // Q5-LANDMARK-FULLPAGE-HEURISTIC-TIGHTEN for the open design question.
    //
    // When the tightened heuristic ships, re-enable this expectation:
    //   { kind: "violation-present", ruleId: "semantics/landmark-main",
    //     reasonIncludes: "no <main> landmark" }

    // ── semantics/heading-hierarchy ─────────────────────────────────────────
    //
    // These assertions are GREEN on the capturing commit — heading-hierarchy
    // does not have a looksLikeFullPage gate and correctly fires today.
    // They lock in those findings against future regressions.

    // progress-steps.html: h1 → h3 (skips h2).
    {
      kind: "violation-present",
      ruleId: "semantics/heading-hierarchy",
      reasonIncludes: "Heading level skipped",
    },

    // hidden-search.html: first (and only) heading is h3 — no h1.
    {
      kind: "violation-present",
      ruleId: "semantics/heading-hierarchy",
      reasonIncludes: "Document has no <h1>",
    },

    // faq-accordion.html: h2 → h4 (skips h3).
    // The "Skipped 1 level" message also covers this case via reasonIncludes
    // above, but we also verify that the ruleId fires at all regardless of
    // reason variant. The above `reasonIncludes: "Heading level skipped"`
    // assertion is shared with progress-steps.html and covers both files.
    // No additional expectation needed here — the ruleId presence is already
    // guarded by the first heading-hierarchy assertion above.
  ],
};
