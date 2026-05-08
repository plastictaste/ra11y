/**
 * interactive-role-on-document-root — guards that
 * `keyboard/interactive-div-role-missing` does not emit on the
 * `<html>` document-root element when the only cross-file evidence
 * for "interactive" comes from a vendor minified JS file attaching
 * a click listener to `document.documentElement` (or the `html`
 * selector) for delegated outside-click dismissal.
 *
 * Bug shape: a bare authored `index.html` loads a vendor framework
 * bundle whose minified JS attaches a click listener to
 * `document.documentElement` and `document.querySelector("html")`
 * for the close-on-outside-click pattern. The rule's cross-file
 * resolution lands on those two listener sites — both inside a file
 * the scanner has already classified under `scannedBuildArtifacts`
 * (definite-min-infix) — and emits on the user's `<html>` element:
 *
 *   "<html> is wired to a click handler in JS via `html` ...
 *    Best fix: change `<html>` to `<button type="button">`."
 *
 * Two structural problems compound:
 *   1. The `<html>` element cannot be converted to `<button>` —
 *      the suggested fix is structurally invalid for the document
 *      root, which is by-platform-focusable and does not need an
 *      ARIA role.
 *   2. The cross-file evidence anchors entirely on a vendor minified
 *      file. Per "Per-finding confidence must reflect per-rule
 *      coverage limitations," when a rule's resolution lands ONLY
 *      in files classified as `scanKind: buildArtifact`, the
 *      per-finding emission must downgrade — vendor click
 *      delegation is not a user-fixable signal.
 *   3. Per "Heuristic emission is the symmetric twin of heuristic
 *      suppression," the rule's selector-to-element matching on a
 *      structural document-root selector (`html`,
 *      `document.documentElement`) is composition-speculative —
 *      this is a delegated-listener pattern on the platform's
 *      naturally-focusable root, not a missing-role bug.
 *
 * Closure: the JS-side `classifySelector` step in
 * `src/rules/keyboard/interactive-div-role-missing-js-targets.ts`
 * skips emission when the captured tag selector names a document
 * root (`html`, `body`). The selector never enters the host rule's
 * (selector, sites) map, so no finding is emitted on the user's
 * `<html>` element regardless of which lane the JS file sits in.
 * The closure is local and predicate-strength-correct: a tag
 * selector targeting the document root is composition-speculative
 * by construction, and the suggested fix `change <html> to <button>`
 * is structurally invalid for the document root.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "keyboard/interactive-div-role-missing must not emit on the `<html>` " +
    "document-root element when the only cross-file resolution sites are " +
    "delegated click listeners attached to `document.documentElement` / " +
    "the `html` selector inside a vendor minified JS file already " +
    "classified under scannedBuildArtifacts. The `<html>` element cannot " +
    "be converted to `<button>`; document-level click delegation for " +
    "close-on-outside-click is a normal pattern; cross-file evidence " +
    "anchored solely in buildArtifact-lane files is not a user-fixable " +
    "signal.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep on a bulk HTML template catalog " +
      "(admin dashboard with vendor-heavy theme) observed " +
      "keyboard/interactive-div-role-missing emitting on the `<html>` " +
      "element of an authored index.html, with the suggested fix " +
      '`change <html> to <button type="button">`. The cross-file ' +
      "evidence chain anchored entirely in a vendor minified JS file " +
      "tagged scanKind: buildArtifact / definite-min-infix; the rule " +
      "presented it as a user-fixable HTML edit.",
  },
  expectations: [
    // Sanity: the vendor file is correctly classified before the
    // rule branch that consumes its evidence runs.
    { kind: "zero-parse-errors" },

    // The rule must not emit on this fixture's `<html>` — under any
    // of the three closure paths (skip / downgrade / review-candidate),
    // the rule stops appearing in `findings[]`.
    { kind: "no-violation", ruleId: "keyboard/interactive-div-role-missing" },
  ],
};
