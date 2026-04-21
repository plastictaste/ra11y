/**
 * bootstrap-nested-interactive-role-only — guards the
 * semantics/nested-interactive rule against firing on role-only
 * wrappers.
 *
 * Canonical real-world FP: twbs/bootstrap `js/tests/visual/collapse/`
 * and `js/tests/visual/modal/` visual-test HTML. The outer wrapper
 * carries an ARIA role (role="tab", role="button") to convey AT
 * semantics, but is NOT materially interactive — no click/key handler
 * attribute, no tabindex, not a native interactive tag. The sole
 * focus + activation surface is the inner `<a href>` / `<button>`.
 *
 * Previous behaviour: role-on-wrapper alone qualified the outer
 * element as "interactive" for the nested-interactive ancestry walk,
 * producing false positives on this idiomatic accordion/collapse/tab
 * markup (7 FPs across Bootstrap's visual-test HTML).
 *
 * Required behaviour (surface-don't-suppress applied correctly):
 *   - A wrapper whose ONLY interactive signal is an ARIA role does
 *     NOT qualify as an interactive outer element. The rule must not
 *     fire. This is not suppression — it is tightening an over-broad
 *     predicate: the outer element is genuinely not a focus stop or
 *     activator, so there is no two-focusables-one-control problem to
 *     surface.
 *   - True nested-interactive patterns (native interactive tag,
 *     tabindex>=0, real click/key handler on the outer) must continue
 *     to fire — this fixture does not regress those; the rule's unit
 *     tests cover them.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Role-only wrappers (div role=tab / role=button with no handler, " +
    "no tabindex, not a native interactive tag) around an <a href> or " +
    "<button> must NOT trigger semantics/nested-interactive. The outer " +
    "element is not materially interactive, so there is no nested-" +
    "controls pattern to surface.",
  origin: {
    notes:
      "Sanitized from Bootstrap's js/tests/visual/collapse/ and " +
      "js/tests/visual/modal/ visual-test HTML. Seven FPs across those " +
      "files before the fix; zero after.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    // Role-only wrappers must not trigger the rule at all.
    { kind: "no-violation", ruleId: "semantics/nested-interactive" },
  ],
};
