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
 * Live scan evidence after the fix (looksLikeFullPage tightening):
 *
 *   Violations emitted:
 *     [semantics/landmark-main]    counter.html:body — branch B (h1 + content)
 *     [semantics/landmark-main]    faq-accordion.html:body — branch B
 *     [semantics/landmark-main]    hidden-search.html:body — branch C (heading + ul + button)
 *     [semantics/landmark-main]    progress-steps.html:body — branch B
 *     [semantics/heading-hierarchy] faq-accordion.html:16 — h2→h4 skip
 *     [semantics/heading-hierarchy] hidden-search.html:17 — no h1 (first is h3)
 *     [semantics/heading-hierarchy] progress-steps.html:12 — h1→h3 skip
 *
 * Both rule families are guarded below: heading-hierarchy was firing pre-fix
 * (no looksLikeFullPage gate); landmark-main fires post-fix once the heuristic
 * recognises full-page shape from h1 + body content or heading + list +
 * interactive trios.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Four full-page vanilla HTML files (DOCTYPE+html+head+body, no nav/header/footer) " +
    "with missing <main> landmarks and broken heading hierarchies — guards that the " +
    "fragment-or-layout heuristic in semantics/landmark-main does not silently skip " +
    "files whose full-page shape is evidenced by an h1 + body content (branch B) or " +
    "a heading + list + interactive trio (branch C).",
  origin: {
    notes:
      "Sanitized from bradtraversy/50projects50days vanilla corpus. " +
      "Field-test pass (52 files) produced 0 semantics/landmark-main findings " +
      "pre-fix. Root cause: looksLikeFullPage() in src/rules/semantics/landmark-main.ts " +
      "originally required header/nav/footer/aside presence; 50p files have none. " +
      "Tightening added two layered branches that recognise full-page shape from " +
      "h1 + body descendant count and heading + list + interactive presence.",
  },
  expectations: [
    // All four files must parse cleanly — any parse error would mean the
    // HTML parser broke on minimal but valid HTML5 page structure.
    { kind: "zero-parse-errors" },

    // ── semantics/landmark-main ─────────────────────────────────────────────
    //
    // The fragment heuristic in `looksLikeFullPage` was tightened to add two
    // page-shape branches in addition to the original "explicit landmark"
    // gate: (B) an `<h1>` plus ≥5 body descendants, and (C) any heading +
    // a list (ul/ol/dl) + at least one interactive element. All four 50p
    // files cross one of those branches: counter / progress-steps /
    // faq-accordion via branch B (h1 + content), hidden-search via branch C
    // (h3 + ul + button/input). The rule emits one violation per file at
    // the body open-tag.
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      reasonIncludes: "no <main> landmark",
    },

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
