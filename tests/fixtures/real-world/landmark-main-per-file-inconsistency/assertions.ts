/**
 * 50p-landmark-main-per-file-inconsistency — guards the fix for
 * semantics/landmark-main firing inconsistently across two
 * structurally-equivalent pages in the same scan.
 *
 * Source: sanitized from a vanilla-JS mini-projects corpus. A field-test
 * pass produced one `semantics/landmark-main` finding on
 * `drink-water/index.html` (no <main>, branch B via h1 + body content)
 * but zero on `expanding-cards/index.html` (also no <main>, same
 * DOCTYPE+html+body+<script> shape, but headings are h3-only). Both
 * files are unambiguously full pages — DOCTYPE, `<title>`, linked
 * stylesheet, body-level `<script>`, multi-panel content. Yet the
 * eligibility predicate (`looksLikeFullPage()` in
 * `src/rules/semantics/landmark-main.ts`) classified one as a page
 * and the other as a fragment.
 *
 * Root cause:
 *   Branch B requires `<h1>` + ≥5 body descendants.
 *   Branch C requires heading + `<ul>/<ol>/<dl>` + interactive.
 *   expanding-cards has only `<h3>` (card titles), no list, no
 *   `<button>/<a>/<input>` — it hits none of the three existing branches
 *   and is silently dropped as a fragment. drink-water has `<h1>` so
 *   branch B fires for it.
 *
 * The inconsistency is asymmetric: the rule misses a real missing-main
 * finding on expanding-cards while correctly surfacing on drink-water.
 * Per docs/kb/architecture/ai-first-consumer.md §"Surface, don't suppress":
 * the fix widens the predicate so both fire, rather than narrowing so
 * neither does.
 *
 * Fix: add Branch D — presence of a `<script>` descendant of `<body>`
 * plus any heading. Script-in-body is a strong full-page signal — not
 * a single good-path HTML fixture in the repo contains `<script>` in
 * body (only `<head>` in one bad fixture), so the branch has zero
 * spillover to existing fixtures. Combined with any heading (the author
 * wrote page content), this catches expanding-cards without the h1
 * requirement of branch B.
 *
 * What the fixture locks in:
 *   - Zero parse errors across both files.
 *   - `semantics/landmark-main` fires on BOTH files (not just
 *     drink-water). Consistency invariant: structurally-equivalent
 *     full-page documents produce the same rule outcome.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Two vanilla HTML pages with DOCTYPE+html+body+<script> shape and no <main> landmark — " +
    "drink-water (h1) and expanding-cards (h3-only) — must both trigger semantics/landmark-main. " +
    "The predicate was previously inconsistent: drink-water fired via branch B (h1 + content) " +
    "but expanding-cards silently passed because branch B requires h1 and branch C requires " +
    "ul/ol/dl which this page lacks. Widening to include a script-in-body branch closes the gap.",
  origin: {
    notes:
      "Sanitized from two representative files in a vanilla-JS mini-projects corpus " +
      "(a drink-water and an expanding-cards demo). Structure preserved verbatim: " +
      "DOCTYPE, lang='en', standard meta tags, external stylesheet, body content " +
      "matching the demo, body-level <script src='script.js'>. No <main> landmark " +
      "in either file — the field-test shape.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    // Consistency invariant: both files emit landmark-main. The
    // `inFile` pin is the instrument that makes this failing-first —
    // without it, the bare "violation-present" expectation would pass
    // as long as ANY file fired, which hides the per-file asymmetry
    // (drink-water fires, expanding-cards silent) that is the bug.
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      reasonIncludes: "no <main> landmark",
      inFile: "drink-water.html",
    },
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      reasonIncludes: "no <main> landmark",
      inFile: "expanding-cards.html",
    },
  ],
};
