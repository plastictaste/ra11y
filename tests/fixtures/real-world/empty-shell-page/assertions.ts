/**
 * empty-shell-page — guards the fix for the silent-pass on
 * empty-structural-shell HTML pages in semantics/landmark-main and
 * semantics/heading-hierarchy.
 *
 * Source: sanitized from a field-test pass over hand-authored vanilla
 * HTML demo projects (theme-clock, kinetic-loader, random-image-
 * generator, hoverboard). Each project's `index.html` is a full DOCTYPE
 * + `<html>` + `<head>` + `<body>` document whose body contains only
 * decorative `<div>` containers (no `<h1>`-`<h6>`, no `<main>`/
 * `<header>`/`<nav>`/`<footer>`/`<aside>`). Static analysis emits zero
 * findings on these files even though the empty structural shell is a
 * *stronger* WCAG 1.3.1 signal than a page with the wrong heading
 * level — the document literally has no programmatically determinable
 * structure at all.
 *
 * Three sanitized files cover the shapes observed in the wild:
 *
 *   clock.html    — DOCTYPE+html+head+body, button + nested clock divs +
 *                   widget script. No heading, no landmark. Pre-fix:
 *                   0 findings; post-fix: landmark-main + heading-
 *                   hierarchy both fire at the <body> tag.
 *
 *   loader.html   — DOCTYPE+html+head+body, just five `<div class="square">`
 *                   children inside a `<div class="loader">` wrapper. No
 *                   script, no heading, no landmark. Same expected outcome.
 *
 *   gallery.html  — DOCTYPE+html+head+body, an image grid of four `<img>`
 *                   tiles inside a single `<div id="gallery">`. No script,
 *                   no heading, no landmark. Same expected outcome.
 *
 * The pre-fix `looksLikeFullPage` predicate (src/engine/layout-partial.ts)
 * has four branches (A: explicit landmark; B: h1 + body content; C:
 * heading + list + interactive; D: heading + body-script). All four
 * require *either* a landmark element *or* a heading element to be
 * present somewhere; a page composed entirely of decorative `<div>` and
 * `<img>` clears none of them. The fix adds a content-only branch:
 * when the body has ≥3 visible (non-script, non-style) descendants AND
 * zero headings AND zero landmarks, the page reads as a structural
 * shell that should carry both a `<main>` and an `<h1>` — every
 * authoring guideline for HTML5 calls for one of each on a real page.
 *
 * Edge case (not covered here): a body with ONLY a `<script>` (vanilla
 * JS demo whose DOM is generated at runtime) is a different shape and
 * is tracked by. The visible-
 * descendant threshold (≥3 non-script, non-style) keeps this fixture's
 * fix conservative: a body holding only `<script>` does not cross the
 * bar.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Three full-page vanilla HTML demos (DOCTYPE+html+head+body, body composed " +
    "entirely of decorative <div>/<img> children with no headings and no landmarks) " +
    "— guards that semantics/landmark-main and semantics/heading-hierarchy both " +
    "fire on the empty-structural-shell shape rather than silently passing.",
  origin: {
    notes:
      "Sanitized from hand-authored vanilla HTML demo projects (theme-clock, " +
      "kinetic-loader, random-image-generator, hoverboard). Field-test pass " +
      "produced 0 findings per file pre-fix despite full-page DOCTYPE shape " +
      "and zero structural elements. Root cause: looksLikeFullPage() in " +
      "src/engine/layout-partial.ts requires either a landmark or a heading " +
      "to be present in one of its four branches; a body of only " +
      "decorative <div>/<img> children clears none of them. The fix adds a " +
      "content-only branch (≥3 visible non-script non-style descendants, " +
      "no headings, no landmarks).",
  },
  expectations: [
    // All three files must parse cleanly — any parse error would mean
    // the HTML parser broke on minimal but valid HTML5 page structure.
    { kind: "zero-parse-errors" },

    // ── semantics/landmark-main ─────────────────────────────────────────────
    //
    // Post-fix, every file emits one landmark-main finding anchored at
    // the <body> tag with the standard "no <main> landmark" message.
    // Pre-fix this assertion is RED (0 findings).
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      reasonIncludes: "no <main> landmark",
    },

    // ── semantics/heading-hierarchy ─────────────────────────────────────────
    //
    // Post-fix, every file emits the missing-h1-on-full-page variant
    // anchored at the <body> tag with the page-level "no <h1> heading"
    // message. The variant's "no headings at all" branch fires because
    // none of the three files contains any <h1>-<h6>. Pre-fix this
    // assertion is RED (0 findings).
    {
      kind: "violation-present",
      ruleId: "semantics/heading-hierarchy",
      reasonIncludes: "no <h1> heading",
    },
  ],
};
