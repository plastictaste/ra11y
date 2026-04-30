/**
 * bootstrap-data-bs-toggle-tooltip — guards the JS-tooltip-enhancer
 * reason-text enrichment for `tooltip/dismissable` (wcag22:1.4.13).
 *
 * On `twbs/bootstrap` at `js/tests/integration/index.html:18`, the
 * finding
 *
 *   <button data-bs-toggle="tooltip" title="Tooltip on top">
 *
 * fired 18 times across the scan. Bootstrap's tooltip JS replaces
 * the native `title` attribute with an ARIA-aware runtime widget
 * (`aria-describedby` + `role="tooltip"` + keyboard dismiss), so the
 * `title` is a source string for the widget — not the rendered
 * native browser tooltip the rule normatively targets.
 *
 * Surface-don't-suppress doctrine (docs/kb/architecture/ai-first-
 * consumer.md §"Surface, don't suppress", §"No heuristic suppression"):
 * the attribute-level evidence is weaker than the agent's file-level
 * evidence. The scanner keeps the finding live and enriches the
 * message with a JS-enhancer signal so the agent reading the file can
 * dismiss fast when the runtime behavior is in fact compliant. Never
 * suppressed, never bucketed.
 *
 * Severity-must-agree-with-reason doctrine (same KB doc, §"Reason
 * text and severity must agree across all three channels"): the
 * enrichment clause concedes the predicate may not hold ("the native
 * title may be an input to a runtime ARIA-aware widget. Verify the
 * runtime behavior at the call site before fixing"). A `warning`
 * finding paired with that conceded-uncertainty reason text is the
 * dishonest shape the doctrine warns against — the agent budgets
 * against severity and discovers the budget was wasted. Severity
 * downgrades to `info` on the enhancer branch; native-only tooltip
 * cases keep `warning`. The downgrade is paired with a
 * `couldBeWrongBecause: ["tooltip_js_enhancer_present"]` so the agent
 * has the structured signal alongside the message.
 *
 * The trigger sibling attributes (all case-sensitive names):
 *   - data-bs-toggle="tooltip"           (Bootstrap 5)
 *   - data-bs-toggle="popover"           (Bootstrap 5)
 *   - data-toggle="tooltip"              (Bootstrap 4 legacy)
 *   - data-toggle="popover"              (Bootstrap 4 legacy)
 *   - data-tippy-content (any value)     (Tippy.js)
 *
 * Invariants guarded here:
 *
 *   1. The rule still fires on enhancer-attributed elements (no
 *      silent suppression).
 *   2. The emitted message contains the enrichment token
 *      `"JS tooltip library"` so the agent sees the signal.
 *   3. The HTML parses without errors.
 *
 * Full five-attribute matrix + negative control (plain <button title>
 * without any enhancer attribute keeps the original phrasing) lives
 * in tests/unit/rules/tooltip/dismissable.test.ts — the fixture is
 * scoped to the real-world repro; the unit tests cover the axes.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Bootstrap/Tippy buttons with data-bs-toggle / data-toggle / data-tippy-content sibling attributes " +
    "still fire tooltip/dismissable (surface-don't-suppress), but the emitted message is enriched with " +
    "a JS-tooltip-library signal so the agent can read the file and dismiss when the runtime widget is " +
    "in fact WCAG 1.4.13-compliant.",
  origin: {
    notes:
      "Sanitized from js/tests/integration/index.html:18 (sixth-pass twbs/bootstrap scan). The " +
      "native title attribute is a source string for a runtime ARIA-aware tooltip widget " +
      "(aria-describedby + role=tooltip + keyboard dismiss); static analysis cannot prove the " +
      "widget is actually wired up, so the finding stays live and the agent reads the file to " +
      "confirm. Severity downgrades from `warning` to `info` because the enrichment clause " +
      "concedes uncertainty about the widget's runtime ARIA wiring (per the reason-text-must- " +
      "agree-with-severity doctrine); never bucketed, never suppressed.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "tooltip/dismissable",
      reasonIncludes: "JS tooltip library",
    },
  ],
};
