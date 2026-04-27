/**
 * build-artifact-fp-scss-function — guards `collectBuildArtifacts`
 * against mis-labeling a small hand-authored CSS-family file as
 * `minified` when one rule carries a long `calc()` / multi-`var()`
 * type-signature-style line.
 *
 * Field-report shape: design-system tokens.css / SCSS partials
 * frequently declare a single rule whose value is a long `calc()`
 * expression composing many CSS custom properties — the structural
 * equivalent of an SCSS `@function` with a long parameter / return
 * type signature. The expression fits on one authored line and crosses
 * 500 chars; the rest of the file is 3 short authored lines (`:root`
 * declarations, two short rules). The result: 1 long line out of 4,
 * exactly the 25% ratio threshold.
 *
 * Why this mirrors the SCSS-function false positive: SCSS `@function`
 * bodies with long parameter lists or long `@return` type chains
 * exhibit identical line-length distribution. The harness does not
 * register `.scss` (its `parseForExtension` gates on `.css/.html/.tsx
 * /.ts/.js/.jsx`), so the reproduction uses a `.css` source whose
 * `calc()` chain stretches the same way an authored SCSS function
 * signature would. The classifier reads source content + path, not
 * file-extension semantics, so the same predicate path executes.
 *
 * Why the previous predicate mis-labels: 1 long line of 4 = 25% ratio,
 * which the `MINIFIED_LONG_LINE_RATIO` corroborator accepts at `>=
 * 0.25`. Combined with the single-long-line probe, the file gets
 * labeled `minified`, the agent drops findings, and authored token /
 * function modules silently leave the scan's actionable surface.
 *
 * The fix tightens the corroborator: the long-line ratio is only a
 * second-tier signal when ≥3 long lines exist. A single long calc()
 * / type-signature line in an otherwise-short authored stylesheet is
 * not minification evidence and stops corroborating under the fix.
 *
 * Companion fixtures: `build-artifact-fp-sri-hash` (HTML with one
 * concatenated SRI-link line), `build-artifact-fp-inline-svg` (HTML
 * with one inline-SVG path line). All three reproduce the same root
 * cause — tiny file, one long line, 25% ratio — across distinct
 * authored-source patterns.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A 4-line authored CSS-family file whose single rule carries a long `calc()` / multi-" +
    "`var()` value (>500 chars) must NOT receive a `scannedBuildArtifacts` label. The " +
    "shape mirrors an SCSS `@function` body with a long type signature; the harness " +
    "exercises it via the supported `.css` extension.",
  origin: {
    notes:
      "Sanitized from design-system token modules / SCSS partials where a single rule " +
      "composes many CSS custom properties via calc(). The authored shape uses `.css` " +
      "(harness does not register `.scss`); classifier reads source content + path, not " +
      "extension semantics, so the predicate path is identical. Sister-fixture coverage " +
      "in build-artifact-fp-sri-hash + build-artifact-fp-inline-svg.",
  },
  expectations: [
    // Sanity check — the file must reach the classifier path. Without
    // zero parse errors, the no-label assertion below is a no-op.
    { kind: "zero-parse-errors" },

    // Primary invariant: a small authored token / function-style CSS
    // file with one long calc() line must stay unlabeled. Fix restores
    // this by requiring ≥3 long lines for the ratio corroborator.
    { kind: "no-build-artifact-label", path: "tokens.css" },
  ],
};
