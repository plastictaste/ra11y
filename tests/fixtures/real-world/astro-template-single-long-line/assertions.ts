/**
 * bootstrap-astro-template-single-long-line — guards the
 * `scannedBuildArtifacts` classifier against labeling an authored
 * Astro/Starlight template-preview file as `minified` on the strength
 * of a single long line alone.
 *
 * Field report origin: the Bootstrap docs site (`site/src/assets/examples/
 * blog-rtl/index.astro`, 255 lines, plus ~53 other authored files in the
 * same scan) embeds a `<Example code={`…`}/>` pattern where the `code`
 * prop value carries a multi-tag preview HTML on a single authored line.
 * The prop line crosses 500 characters while the surrounding file is
 * normal multi-line authored code. The previous
 * `MINIFIED_LINE_THRESHOLD = 500` probe at `src/mcp/build-artifacts.ts:176`
 * fired on that one line and labeled the whole file `minified`, pulling
 * authored source into the `scannedBuildArtifacts` bucket — the agent's
 * triage lane drops findings on those files.
 *
 * The fix (tracked as)
 * requires a second-tier corroborating predicate alongside the single-
 * long-line probe — any of: ≥25% of lines exceed the threshold, median
 * line length exceeds the threshold, `.min.` infix in filename, build-
 * path ancestry (`dist/` / `build/` / `_site/` / `public/` / …), or a
 * sibling `.map` file. On this fixture the 808-char prop line sits
 * among ~47 short authored lines (1/48 ≈ 2% long-line ratio, median
 * ~50 chars, no path or sibling signals), so no second-tier predicate
 * fires and the file stays unlabeled.
 *
 * Pair fixture: `website-templates-gmaps-embed-single-long-line` covers
 * the HTML form of the same false-positive shape (Google Maps iframe
 * URL on one line amid authored page markup). Both share one fix scope
 * but reproduce independently; separate fixtures so a regression in
 * either path fails loudly and names its own repro.
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
    "An authored Astro file modeled on the Bootstrap docs `<Example code={`…`}/>` " +
    "template-prop shape — one line over 500 chars, surrounded by short authored lines " +
    "— must NOT receive a `scannedBuildArtifacts` label. The single-long-line probe " +
    "requires second-tier corroboration; without it, the authored file stays unlabeled.",
  origin: {
    notes:
      "Sanitized from the Bootstrap docs site's Astro/Starlight example-preview pattern " +
      "(`site/src/assets/examples/blog-rtl/index.astro` and ~53 siblings). Upstream " +
      "embeds a preview HTML inside a `<Example code={`…`}/>` prop whose value crosses " +
      "500 characters on one authored line. This reproduction preserves the line-length " +
      "shape: one ~808-char prop line, ~30 short lines around it, no `.min.` / dist-path " +
      "/ hashed / sibling-sourcemap signals, so only the single-long-line probe can fire.",
  },
  expectations: [
    // The file must parse cleanly — sanity check that the fixture
    // itself exercises the classifier path and isn't dropped earlier
    // by a parser fault. If this assertion ever fails, the fixture
    // source has drifted and the classifier assertion below is not
    // meaningfully tested.
    { kind: "zero-parse-errors" },

    // Primary invariant: the classifier must not label this authored
    // file as a build artifact on the single-long-line signal alone.
    // Under the fix, the second-tier corroboration predicates (long-
    // line ratio, median line length, filename markers, path ancestry,
    // sibling sourcemap) all evaluate false, so `collectBuildArtifacts`
    // returns no entry for this path.
    { kind: "no-build-artifact-label", path: "blog-rtl.astro" },
  ],
};
