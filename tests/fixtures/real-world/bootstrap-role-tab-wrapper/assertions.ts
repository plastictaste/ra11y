/**
 * bootstrap-role-tab-wrapper — regression guard for
 * semantics/nested-interactive on role-only tab wrappers containing
 * a native <button>.
 *
 * The failing shape from Bootstrap's js/tests/visual/ HTML:
 *   <div role="tab">
 *     <button type="button">...</button>
 *   </div>
 *
 * The outer div carries role="tab" for ARIA composite-widget
 * semantics but is NOT materially interactive — no click/key handler,
 * no tabindex, not a native interactive tag. The inner <button> is
 * the sole focus and activation surface.
 *
 * Required behaviour: semantics/nested-interactive must NOT fire.
 * The outer element is not a focus stop or activator, so there is no
 * two-focusables-one-control problem to flag. Firing on it is an
 * over-broad false positive on the isMateriallyInteractiveHtml
 * predicate.
 *
 * Live meta evidence (probed on main, 2026-04-21):
 *   violations: [] — zero semantics/nested-interactive findings on
 *   three role="tab" + <button> pairs. Parse errors: 0.
 *
 * Note on divergence from dispatch: the backlog described this as a
 * regression that "still fires" at specific Bootstrap visual-test
 * line numbers. Live probe against current main shows zero findings —
 * the fix in isMateriallyInteractiveHtml (role-alone does not qualify
 * as the outer element) already covers the <button> case, not only
 * the <a href> case captured by bootstrap-nested-interactive-role-only.
 * This fixture is therefore a forward regression guard (green on
 * current main) rather than a bug-capture (red). The README documents
 * the divergence.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'A <div role="tab"> with no handler, tabindex, or native interactive tag, ' +
    "wrapping a <button>, must NOT trigger semantics/nested-interactive. The outer " +
    "role-only wrapper is not materially interactive — there is no two-focusables-" +
    "one-control violation to surface.",
  origin: {
    notes:
      "Sanitized from Bootstrap js/tests/visual/modal.html (lines 63, 78, 92) " +
      "and js/tests/visual/collapse.html (lines 17, 32, 46, 60). Seven false " +
      "positives reported in the backlog (Q3-RULE-NESTED-INTERACTIVE-ROLE-REGRESSION). " +
      "Live probe on main shows zero findings — isMateriallyInteractiveHtml already " +
      "excludes role-only wrappers for the <button>-inner case as well as <a href>. " +
      "Fixture guards this correct behavior against future regressions in the " +
      "materially-interactive predicate.",
  },
  expectations: [
    // Source must parse without errors — malformed HTML would invalidate
    // the repro and produce misleading results on the rule walk.
    { kind: "zero-parse-errors" },

    // The core invariant: semantics/nested-interactive must NOT fire on
    // a role="tab" wrapper around a <button> when the wrapper has no
    // click/key handler, no tabindex, and is not a native interactive tag.
    // If this assertion fails, the isMateriallyInteractiveHtml predicate
    // has regressed and role-alone is again qualifying as an outer element.
    { kind: "no-violation", ruleId: "semantics/nested-interactive" },
  ],
};
