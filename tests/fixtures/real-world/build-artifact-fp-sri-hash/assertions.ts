/**
 * build-artifact-fp-sri-hash — guards `collectBuildArtifacts` against
 * mis-labeling a small hand-authored vanilla-JS HTML page as `minified`
 * when one line concatenates a few CDN preload `<link>` tags whose
 * `integrity="sha512-..."` attributes push the line over 500 chars.
 *
 * Field-report shape: vanilla-JS scaffolds (no bundler, just a single
 * `index.html` pointing at hand-authored CDN assets) typically pretty-
 * print fine, but a minimizer or a single-line `<head>` writer
 * concatenates several `<link rel="preload" integrity="sha512-...">`
 * tags onto one line. Each integrity hash is 88 base64 chars, three
 * preloads + boilerplate cross 500 chars in one authored line, and the
 * surrounding file is 4 short lines (doctype/head, body, /body/html).
 *
 * Why the previous predicate mis-labels: the `MINIFIED_LONG_LINE_RATIO`
 * corroborator fires at `>= 0.25`, and 1 long line out of 4 total = 25%
 * exactly — the ratio threshold catches the file even though a single
 * long SRI-tag concatenation is not minification evidence. Combined
 * with the single-long-line probe, the file gets labeled `minified`,
 * the agent's triage lane drops findings, and authored vanilla-JS
 * pages silently disappear from the scan's actionable surface.
 *
 * The fix tightens the corroborator: the long-line ratio is only a
 * second-tier signal when there are *several* long lines (≥3) — a
 * single very-long line in a 4-line file is the canonical false-
 * positive shape and must not corroborate. Real minified bundles run
 * many long lines (canonical CSS minifier output emits one rule per
 * line with every line long) or one enormous unwrapped line (canonical
 * JS bundler output), and the median-line-length corroborator covers
 * the latter; the ratio corroborator is meaningful only on the former.
 *
 * Companion fixtures: `build-artifact-fp-inline-svg` (HTML with one
 * long inline SVG path), `build-artifact-fp-scss-function` (CSS-family
 * file with one long type-signature-like line). All three reproduce
 * the same root cause — tiny file, one long line, ratio exactly 25% —
 * but each pins a distinct authored-source pattern so a regression in
 * any one path-shape fails loudly.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A 4-line vanilla-JS HTML page whose single `<link>` line concatenates three SRI-hashed " +
    "CDN preload tags (>500 chars) must NOT receive a `scannedBuildArtifacts` label. " +
    "Under the previous predicate, 1 long line out of 4 hit the 25% ratio threshold and " +
    "labeled the file `minified`; under the fix the ratio corroborator requires ≥3 long " +
    "lines so a single SRI-concatenation line in an otherwise-short authored page stays " +
    "unlabeled.",
  origin: {
    notes:
      "Sanitized from vanilla-JS / static-HTML scaffolds where one `<head>` line carries " +
      "three CDN preloads with sha512 integrity hashes. Synthetic SRI hashes preserve " +
      "the line-length shape without referencing a real package. Sister-fixture coverage " +
      "in build-artifact-fp-inline-svg + build-artifact-fp-scss-function.",
  },
  expectations: [
    // Sanity check — the file must reach the classifier path. If this
    // ever goes red, the fixture parser fault is the real failure and
    // the no-build-artifact-label assertion below is not meaningfully
    // tested.
    { kind: "zero-parse-errors" },

    // Primary invariant: the small-file FP shape (4 lines, 1 long line
    // concatenating SRI links) must not be labeled. Under the fix, the
    // ratio corroborator requires ≥3 long lines so this file's
    // 1-long-of-4 shape no longer corroborates and the file stays out
    // of the build-artifact bucket.
    { kind: "no-build-artifact-label", path: "index.html" },
  ],
};
