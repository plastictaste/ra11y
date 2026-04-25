/**
 * iframe-prose-vs-element-candidate — guards that the
 * review/media-alternatives finder distinguishes real `<iframe>` DOM
 * elements from prose mentions of the string "<iframe>" in developer
 * documentation text (code examples, prose paragraphs).
 *
 * Bug (Q7-CHECKLIST-IFRAME-FINDER-ELEMENT-VS-PROSE):
 * A documentation page that explains how to use `<iframe>` for video
 * embedding contains code-block examples whose text content includes
 * the literal string "<iframe>". A regex-based implementation would
 * match these string occurrences and emit 1.2.x review candidates
 * pointing at text nodes — not actual embedded media elements.
 *
 * The correct behavior:
 *   - Traverse the parsed DOM for element nodes.
 *   - Iframes are excluded from 1.2.x evidence entirely (per the
 *     likelyIrrelevant-bucket consistency contract in the finder header).
 *   - Only `<video>` and `<audio>` element nodes produce 1.2.x candidates.
 *
 * The fixture source is a documentation page that has:
 *   1. Multiple `<code>` blocks and prose paragraphs containing
 *      "&lt;iframe&gt;" as text content (five occurrences in total).
 *   2. Exactly ONE real `<video>` element (a live example at line 65).
 *
 * Live meta evidence (probed 2026-04-24):
 *   parse errors: 0
 *   candidates for wcag22:1.2.1: 1, reason "video element -- verify
 *     transcript or audio description is provided", line 65
 *   candidates for wcag22:1.2.3: 1, reason "video element -- verify
 *     transcript or audio description is provided", line 65
 *   candidates for wcag22:1.2.5: 1, reason "video element -- verify
 *     transcript or audio description is provided", line 65
 *   no candidate whose reason contains "iframe"
 *
 * What the fixture locks in:
 *   - No candidate for 1.2.1/1.2.3/1.2.5 has a reason containing "iframe".
 *     Guards against a regression that adds regex-based iframe detection
 *     and fires on the text-node occurrences of "<iframe>" in code blocks.
 *   - The real <video> still surfaces for 1.2.1 (surface, don't suppress).
 *   - The video candidate is anchored at line 65 (positional honesty).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "review/media-alternatives must not emit 1.2.x candidates for prose " +
    "mentions of '<iframe>' in developer documentation — only actual " +
    "<video> element nodes produce candidates; text-node '<iframe>' " +
    "occurrences in <code> blocks are not evidence for 1.2.x criteria.",
  origin: {
    feedbackRound: "Q7-CHECKLIST-IFRAME-FINDER-ELEMENT-VS-PROSE",
    notes:
      "Documentation pages that explain iframe embedding contain multiple " +
      "code-block occurrences of the '<iframe>' string. A naive regex " +
      "implementation would emit false 1.2.x candidates for these text " +
      "nodes. The fix (AST-based DOM traversal) fires only on real " +
      "element nodes. Iframes are additionally excluded from 1.2.x scope " +
      "entirely; this fixture captures the prose-mention vs element " +
      "distinction as a durable regression guard.",
  },
  expectations: [
    // Source must parse cleanly — parse errors would mask the finder signal.
    { kind: "zero-parse-errors" },

    // Positive control: the real <video> at line 65 must still surface for
    // 1.2.1. Surface, don't suppress — a regression that drops the video
    // candidate would be a silent miss.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.2.1",
      reasonIncludes: "video element",
    },

    // Positional honesty: the 1.2.1 candidate must anchor at line 65, the
    // opening tag of the real <video> element. A regex-based regression
    // that matches the text-node occurrences of "<iframe>" would cite a
    // different line (the <code> block or prose paragraph), failing here.
    {
      kind: "candidate-at-line",
      criterionId: "wcag22:1.2.1",
      path: "embed-guide.html",
      line: 65,
      reasonIncludes: "video element",
    },

    // 1.2.3 (synchronized media) must also anchor at the video element —
    // not at any prose mention.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.2.3",
      reasonIncludes: "video element",
    },

    {
      kind: "candidate-at-line",
      criterionId: "wcag22:1.2.3",
      path: "embed-guide.html",
      line: 65,
      reasonIncludes: "video element",
    },

    // 1.2.5 (audio description) must also anchor at the video element.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.2.5",
      reasonIncludes: "video element",
    },

    {
      kind: "candidate-at-line",
      criterionId: "wcag22:1.2.5",
      path: "embed-guide.html",
      line: 65,
      reasonIncludes: "video element",
    },

    // Core guard: no candidate for 1.2.1 must have a reason containing
    // "iframe". The source has five prose/code-block occurrences of the
    // string "<iframe>" as text content. If the finder ever switches to
    // substring matching, it would emit candidates with "iframe" in the
    // reason, failing this assertion.
    {
      kind: "candidate-present-without",
      criterionId: "wcag22:1.2.1",
      reasonExcludes: "iframe",
    },

    // Same guard for 1.2.3 — no iframe-reason candidate.
    {
      kind: "candidate-present-without",
      criterionId: "wcag22:1.2.3",
      reasonExcludes: "iframe",
    },

    // Same guard for 1.2.5 — no iframe-reason candidate.
    {
      kind: "candidate-present-without",
      criterionId: "wcag22:1.2.5",
      reasonExcludes: "iframe",
    },
  ],
};
