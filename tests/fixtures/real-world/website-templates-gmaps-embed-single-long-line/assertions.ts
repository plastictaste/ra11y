/**
 * website-templates-gmaps-embed-single-long-line — guards the
 * `scannedBuildArtifacts` classifier against labeling authored contact-
 * page HTML as `minified` when a single embedded Google Maps iframe
 * URL crosses 500 characters on one authored line.
 *
 * Field report origin: the website-templates field scan mis-labeled
 * 101 authored HTML files under the same shape — each page embeds a
 * `<iframe src="https://www.google.com/maps/embed/v1/place?…">` whose
 * src URL carries a map key, query parameters, feature flags, and UI
 * preferences on ONE authored line, and that line crosses the 500-char
 * threshold. The surrounding page markup (head, nav, main content,
 * contact-details, footer) is normal multi-line authored HTML. Under
 * the previous `MINIFIED_LINE_THRESHOLD = 500` single-probe predicate,
 * every such page got pulled into the `scannedBuildArtifacts` bucket
 * and the agent's triage lane silently drops findings on authored
 * templates.
 *
 * The fix (tracked as Q3-BUILD-ARTIFACT-SINGLE-LONG-LINE-SECOND-PROBE)
 * requires a second-tier corroborating predicate alongside the single-
 * long-line probe — any of: ≥25% of lines exceed the threshold, median
 * line length exceeds the threshold, `.min.` infix in filename, build-
 * path ancestry, or a sibling `.map`. On this fixture the 686-char
 * iframe line sits among ~56 short authored lines (1/57 ≈ 2% ratio,
 * median ~40 chars, no filename/path/sibling signals), so no second-
 * tier predicate fires and the file stays unlabeled.
 *
 * Pair fixture: `bootstrap-astro-template-single-long-line` covers the
 * Astro/TSX form of the same false-positive shape (template-literal
 * prop value on one line amid authored component code). Both share one
 * fix scope but reproduce independently; separate fixtures so a
 * regression in either path fails loudly and names its own repro.
 *
 * Companion closed item: `Q-SHARED-BUILD-ARTIFACT-SASS-PARTIAL` hardened
 * the `_` filename-prefix assumption; this fixture tightens the
 * complementary single-long-line predicate on the same doctrine —
 * `scannedBuildArtifacts` labels must be provable from file shape, not
 * a heuristic on weak evidence (ai-first-consumer.md §labeled-buckets).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "An authored contact-page HTML with a single Google Maps iframe whose src URL is " +
    "over 500 chars on one line — surrounded by ~56 short authored lines — must NOT " +
    "receive a `scannedBuildArtifacts` label. The single-long-line probe requires " +
    "second-tier corroboration; without it, the authored page stays unlabeled.",
  origin: {
    notes:
      "Sanitized from the website-templates field scan pattern: contact / location " +
      'pages each embed a Google Maps iframe (`src="https://www.google.com/maps/embed/v1/' +
      'place?key=…&q=…&feature_flags=…"`) whose URL is authored on one file-line and ' +
      "crosses 500 characters. This reproduction preserves the single-long-line shape " +
      "with a synthetic URL (no real coordinates or API key), and surrounds it with 56 " +
      "short authored lines of ordinary HTML, so only the single-long-line probe can fire.",
  },
  expectations: [
    // The file must parse cleanly — sanity check that the fixture
    // itself reaches the classifier path and isn't dropped earlier by
    // a parser fault. If this ever fails, the fixture source has
    // drifted and the classifier assertion below is not meaningfully
    // tested.
    { kind: "zero-parse-errors" },

    // Primary invariant: the classifier must not label this authored
    // file as a build artifact on the single-long-line signal alone.
    // Under the fix, the second-tier corroboration predicates all
    // evaluate false, so `collectBuildArtifacts` returns no entry
    // for this path.
    { kind: "no-build-artifact-label", path: "contact.html" },
  ],
};
