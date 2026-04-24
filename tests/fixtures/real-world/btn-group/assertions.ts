/**
 * btn-group — locks in the V1-FP-KEYBOARD-HANDLER-DATA-BS-CONTAINER fix
 * for Bootstrap 5's `<div class="btn-group" data-bs-toggle="buttons">`
 * pattern.
 *
 * Symptom: scanning a Bootstrap-derived page surfaced
 * `keyboard/handler-missing` (wcag22:2.1.1) on every `btn-group`
 * container that hosted `data-bs-toggle="buttons"`. The container is
 * not a trigger — Bootstrap's JS wires toggle behavior on the *child*
 * <input type="checkbox"|"radio"> controls; the <div> never receives
 * focus, has no click handler, and Enter/Space on it does nothing.
 *
 * Worse: `suggest_fix` recommended wrapping the container in
 * `<button type="button">`, which would nest the <input> children
 * inside a button — interactive descendants inside an interactive
 * element. That fix would break the Bootstrap layout AND introduce a
 * new accessibility violation (nested-interactive). False-positive
 * fixes that teach anti-patterns are worse than silent misses.
 *
 * Root cause: the `data-bs-toggle` attribute had a single grammar — any
 * value on a non-native element fired the rule. But Bootstrap uses
 * `data-bs-toggle` for two distinct purposes:
 *   - disclosure values (`modal`, `tooltip`, `popover`, `collapse`,
 *     `offcanvas`, `dropdown`, `tab`) — the host IS the trigger; if
 *     the host is a bare <div>/<span> with no keyboard wiring, it's a
 *     real keyboard violation.
 *   - container values (`buttons`) — the host is a *group container*;
 *     interactive children are wired separately. The container never
 *     becomes interactive.
 *
 * Fix: build an explicit allowlist of disclosure values for
 * `data-bs-toggle`. Container values like `buttons` exempt the host.
 * Doctrine: heuristic-suppression is the wrong move (false-positive on
 * a misnamed value), but explicit value-based grammar is correct —
 * `buttons` is a proven container-only Bootstrap idiom with no trigger
 * semantics on the host.
 *
 * Invariant guarded: scanning the sanitized two-`btn-group` snippet
 * emits ZERO `keyboard/handler-missing` violations. The companion
 * positive case (`<div data-bs-toggle="modal">`) stays covered by the
 * unit tests in tests/unit/rules/keyboard/handler-missing.test.ts.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Bootstrap 5 `<div class=\"btn-group\" data-bs-toggle=\"buttons\">` containers must NOT fire " +
    "keyboard/handler-missing — `buttons` is a group-container value, not a trigger value, and the " +
    "container is never interactive (interactive behavior is wired on the child <input> controls).",
  origin: {
    notes:
      "Sanitized from twelfth-pass field-test observations on Bootstrap-derived pages. The " +
      "container `data-bs-toggle=\"buttons\"` value tells Bootstrap's JS to wire toggle behavior on " +
      "the child <input type=\"checkbox\"|\"radio\"> controls — the <div> itself is not focusable and " +
      "has no click handler. Before the fix the rule treated all `data-bs-toggle` values uniformly " +
      "and `suggest_fix` recommended wrapping the container in <button>, which would nest <input> " +
      "interactive descendants inside a <button> — invalid HTML and a broken keyboard model.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    { kind: "no-violation", ruleId: "keyboard/handler-missing" },
  ],
};
