/**
 * bootstrap-modal-aria-hidden — guards the overlay-class runtime-toggle
 * framing on aria/hidden-focus findings.
 *
 * Canonical real-world FP: twbs/bootstrap `js/tests/integration/index.html:41`.
 * A `<div class="modal fade" … aria-hidden="true">` containing a focusable
 * `<button class="btn-close">` fires aria/hidden-focus because Bootstrap
 * toggles `aria-hidden` at runtime when the widget opens — static analysis
 * cannot observe that toggle. The `limitations` block already names this
 * class of gap, but every individual finding previously shipped at
 * `severity: error` with no framing, forcing the consuming agent to
 * re-derive "is this a runtime-toggled overlay?" per call site.
 *
 * Surface-don't-suppress (CLAUDE.md §1, docs/kb/architecture/ai-first-consumer.md):
 *   - Severity stays "error" (no downgrade).
 *   - Finding is not hidden, bucketed, or filtered (no suppression).
 *   - The reason text is enriched with a runtime-toggle clause when the
 *     element's `class` attribute contains any of the 8 overlay-marker
 *     substrings declared by the AI-first consumer doctrine:
 *       modal, dialog, drawer, offcanvas, popover, toast, overlay, backdrop
 *   - A `couldBeWrongBecause: ["runtime_aria_hidden_toggle"]` structured
 *     code is emitted alongside the reason enrichment so agents can also
 *     route on the code without parsing prose.
 *
 * Source files:
 *   index.html — three overlay variants covering three markers
 *     (modal, offcanvas, toast). Each contains a focusable
 *     <button class="btn-close"> descendant so the rule fires in the
 *     descendant-focusable path (the production shape).
 *
 * Key invariants this fixture guards:
 *   1. aria/hidden-focus STILL fires on every overlay wrapper — surfacing
 *      is not suppression, the runtime-toggle note is additive framing.
 *   2. The finding's severity stays `error` — no priority downgrade for
 *      human-attention triage, per ai-first-consumer doctrine.
 *   3. The message text contains a stable marker substring
 *      ("runtime-toggled overlay") that an agent or subsequent rule can
 *      grep for to identify the framing without brittle whole-message
 *      matching.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Bootstrap-style overlay wrappers (modal / offcanvas / toast) with " +
    'aria-hidden="true" wrapping a focusable descendant still fire ' +
    "aria/hidden-focus at severity: error, but carry an additive " +
    '"runtime-toggled overlay" note framing the runtime aria-hidden ' +
    "toggle the scanner cannot observe. Surface-don't-suppress.",
  origin: {
    notes:
      "Canonical source: a popular Bootstrap-style integration fixture " +
      '(`<div class="modal fade" aria-hidden="true">` containing a ' +
      'focusable `<button class="btn-close">`). Per CLAUDE.md §1 the ' +
      "finding keeps severity error; only the reason text is enriched " +
      "so the agent can dismiss in one read.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // The rule MUST still fire — surfacing is not suppression.
    // The message must include the runtime-toggle framing so the agent
    // can identify this class of FP without re-deriving it per call site.
    {
      kind: "violation-present",
      ruleId: "aria/hidden-focus",
      reasonIncludes: "runtime-toggled overlay",
    },
  ],
};
