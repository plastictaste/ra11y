/**
 * carousel-ride — locks in the V1-FP-KEYBOARD-HANDLER-DATA-BS-CONTAINER
 * fix for Bootstrap 5's `data-bs-ride` auto-init attribute.
 *
 * Symptom: scanning a Bootstrap-derived carousel surfaced
 * `keyboard/handler-missing` (wcag22:2.1.1) on every <div> hosting
 * `data-bs-ride="carousel"` (or `data-bs-ride="true"`). The
 * `data-bs-ride` attribute is an *initialization signal* to Bootstrap's
 * JS — it tells BS to instantiate the Carousel component on the host
 * and (for "carousel") start auto-rotation. It is not a click trigger
 * grammar like `data-bs-toggle="modal"`.
 *
 * The container <div class="carousel"> never receives focus, has no
 * click handler, and Enter/Space on it does nothing. The keyboard
 * triggers for the carousel are the child
 * <button class="carousel-control-prev"> /
 * <button class="carousel-control-next"> elements.
 *
 * Worse: `suggest_fix` recommended wrapping the carousel container in
 * <button>, which would nest the <button class="carousel-control-prev">
 * children inside a <button> — nested-interactive. The proposed fix
 * teaches an anti-pattern.
 *
 * Fix: exempt every `data-bs-ride` value (and the BS4 `data-ride`
 * predecessor) from the attribute-interaction grammar entirely. There
 * is no value of `data-bs-ride` that makes the host element a trigger.
 * The legacy `data-ride` grammar follows the same auto-init shape.
 *
 * Invariant guarded: scanning the sanitized carousel snippet (with
 * `data-bs-ride="carousel"` and `data-bs-ride="true"`) emits ZERO
 * `keyboard/handler-missing` violations. The child <button> control
 * pattern stays covered by the existing positive cases in
 * tests/unit/rules/keyboard/handler-missing.test.ts.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    'Bootstrap 5 `<div data-bs-ride="carousel">` (and `data-bs-ride="true"`) auto-init ' +
    "containers must NOT fire keyboard/handler-missing — `data-bs-ride` is an initialization " +
    "signal to Bootstrap's JS, not a click trigger; the host is never interactive (the carousel's " +
    'keyboard controls are child <button class="carousel-control-prev"|"carousel-control-next"> ' +
    "elements).",
  origin: {
    notes:
      "Sanitized from twelfth-pass field-test observations on Bootstrap-derived pages. The " +
      "`data-bs-ride` attribute initializes the Carousel component; the host <div> is never a " +
      "trigger and never becomes focusable. Before the fix the rule treated `data-bs-ride` " +
      "uniformly with disclosure-value `data-bs-toggle` attributes, and `suggest_fix` recommended " +
      "converting the container to <button>, which would nest the .carousel-control-prev/next " +
      "<button> children inside a <button> — nested-interactive, an actively harmful suggestion.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    { kind: "no-violation", ruleId: "keyboard/handler-missing" },
  ],
};
