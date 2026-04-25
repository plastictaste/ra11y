/**
 * build-artifact-fp-inline-svg — guards `collectBuildArtifacts` against
 * mis-labeling a small hand-authored landing-page HTML as `minified`
 * when one line carries an inline `<svg>` whose `<path d="...">`
 * commands push the line over 500 chars.
 *
 * Field-report shape: design-system trees and SSG output frequently
 * inline a brand mark or hero illustration as raw SVG. The `<svg>`
 * element + opening + `<path d="M... L... Z"/>` + closing tag fits on
 * a single authored line, and a moderately complex path crosses 500
 * chars. The surrounding HTML is 3 short authored lines (doctype/head,
 * body open, /body/html), so the long-line ratio is exactly 1/4 = 25%.
 *
 * Why the previous predicate mis-labels: the
 * `MINIFIED_LONG_LINE_RATIO` corroborator fires at `>= 0.25` and the
 * single-long-line probe at the same time, so 1 long inline-SVG line
 * out of 4 total satisfies both conjuncts and the file gets labeled
 * `minified`. The agent's triage lane drops findings on labeled files,
 * so authored brand pages silently disappear from the scan.
 *
 * The fix tightens the corroborator: the long-line ratio only counts
 * when ≥3 long lines exist. A single inlined SVG path in an otherwise-
 * short authored page is the canonical false-positive shape and stops
 * corroborating under the fix.
 *
 * Companion fixtures: `build-artifact-fp-sri-hash` (HTML with one long
 * SRI-hash line), `build-artifact-fp-scss-function` (CSS-family file
 * with one long type-signature-like line). All three reproduce the
 * same root cause — tiny file, one long line, 25% ratio — but pin
 * distinct authored-source patterns.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A 4-line hand-authored landing page whose single inline-SVG line carries a >500-char " +
    '`<path d="...">` command set must NOT receive a `scannedBuildArtifacts` label. ' +
    "Under the previous predicate the 1-of-4 long-line ratio hit 25% and labeled the file " +
    "`minified`; under the fix the ratio corroborator requires ≥3 long lines so a single " +
    "inline-SVG line in an otherwise-short authored page stays unlabeled.",
  origin: {
    feedbackRound: "V1-BUILD-ARTIFACT-REGRESSION-AUDIT-MINIFIED",
    notes:
      "Sanitized from design-system / SSG output that inlines a brand-mark SVG into the " +
      "page body. The synthetic path command sequence preserves the line-length shape " +
      "without copying any real brand asset. Sister-fixture coverage in " +
      "build-artifact-fp-sri-hash + build-artifact-fp-scss-function.",
  },
  expectations: [
    // Sanity check — without zero parse errors, the no-label assertion
    // below is a no-op against a file the harness never reached.
    { kind: "zero-parse-errors" },

    // Primary invariant: a small authored page with one long inline-
    // SVG line must stay unlabeled. The fix restores this by requiring
    // ≥3 long lines for the ratio corroborator to fire.
    { kind: "no-build-artifact-label", path: "index.html" },
  ],
};
