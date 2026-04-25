/**
 * sensory-callout-prose — guards review/sensory-characteristics (wcag22:1.3.3)
 * callout-container reason-text enrichment.
 *
 * Component-library documentation pages commonly include callout blocks
 * (`<div class="note">`, `<aside class="tip">`, etc.) that describe UI
 * elements to *developers* using sensory phrasing ("click the red button
 * below", "icon on the right side"). These phrases are structurally
 * identical to genuine user-facing 1.3.3 violations — the finder fires
 * on the text regardless.
 *
 * Per AI-first doctrine, suppressing the candidate would silently hide
 * real violations whenever the heuristic is wrong (a note block that
 * IS user-facing, a mis-nested element, etc.). The correct mechanism is
 * reason-text enrichment: the candidate stays in the primary list, and
 * the reason text carries a note that the prose is inside a callout
 * container so the agent can dismiss in one read.
 *
 * This fixture guards two invariants:
 *
 *   1. Surface, don't suppress: the candidate for wcag22:1.3.3 (and
 *      wcag21:1.3.3) must still appear even when the matched text is
 *      inside a <div class="note"> block. A regression that drops the
 *      candidate would be a silent miss.
 *
 *   2. Reason-text enrichment: the candidate's reason must include both
 *      "callout block" (the container note) and "developer-facing
 *      documentation" (the dismissal signal) so the agent's one-read
 *      dismiss is possible without opening the file.
 *
 * The fixture also implicitly guards the ssg-pagination-sensory-line-
 * drift fix: the callout walk uses precisePositionForOffset just like
 * the original flat walk, so the line-mapping fix from commit 81cc8ee2
 * is preserved through the ancestor-stack refactor.
 *
 * Live meta evidence (probed 2026-04-25):
 *   criteria fired: wcag22:1.3.3 at callout-note.html:27,
 *                   wcag21:1.3.3 at callout-note.html:27
 *   reason snippet: 'text references sensory characteristic "click the red"
 *     in: "To try this out in the sandbox, click the red button below
 *     the preview pane." -- verify a non-sensory alternative exists
 *     -- inside a <div class="note"> callout block: likely developer-facing
 *     documentation, not a user-facing UI instruction; verify the rendered
 *     output uses non-sensory alternatives'
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Guards the review/sensory-characteristics finder callout-container enrichment: " +
    'sensory phrases inside <div class="note"> callout blocks must still surface as ' +
    "wcag22:1.3.3 candidates (surface, don't suppress), with a reason-text note that " +
    "identifies the prose as likely developer-facing documentation so the agent can " +
    "dismiss in one read.",
  origin: {
    notes:
      "Sanitized excerpt of a component-library documentation page. The original " +
      'contained a <div class="note"> block describing how to interact with a sandbox ' +
      'UI using sensory phrasing ("click the red button below", "right side of the ' +
      'toolbar"). The 1.3.3 finder fired on the developer-facing prose, which was ' +
      "correct behavior — suppression would risk hiding real violations. The fix was " +
      "reason-text enrichment so the agent can dismiss without file-read overhead.",
  },
  expectations: [
    // Source must parse cleanly — a parse error would mask the callout signal.
    { kind: "zero-parse-errors" },

    // The candidate must surface (surface, don't suppress). A regression that
    // silently drops the finding on callout-wrapped prose is a false negative.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.3.3",
      reasonIncludes: "click the red",
    },

    // Positional honesty: the candidate must anchor on line 27, the exact
    // line where "click the red button below" appears in the source. This
    // guards the line-mapping fix (ssg-pagination-sensory-line-drift) through
    // the ancestor-stack refactor — a regression in precisePositionForOffset
    // would misreport the line.
    {
      kind: "candidate-at-line",
      criterionId: "wcag22:1.3.3",
      path: "callout-note.html",
      line: 27,
      reasonIncludes: "click the red",
    },

    // The reason text must include the callout-container enrichment note.
    // Guards the enrichment pathway specifically: if the callout detection
    // regresses, the reason would not contain "callout block" and this
    // assertion fails — making the regression loud.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.3.3",
      reasonIncludes: "callout block",
    },

    // The reason text must identify the prose as developer-facing — this is
    // the dismissal signal the agent uses to decide "no action needed here."
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.3.3",
      reasonIncludes: "developer-facing documentation",
    },

    // The wcag21 mirror must move in lockstep — both criteria come from the
    // same finder, so a fix that lands one but not the other is a partial
    // regression on standards parity.
    {
      kind: "candidate-present",
      criterionId: "wcag21:1.3.3",
      reasonIncludes: "callout block",
    },

    {
      kind: "candidate-at-line",
      criterionId: "wcag21:1.3.3",
      path: "callout-note.html",
      line: 27,
      reasonIncludes: "click the red",
    },
  ],
};
