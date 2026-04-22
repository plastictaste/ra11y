/**
 * review-1-4-5-sr-only-sibling — guards that the 1.4.5 images-of-text
 * finder surfaces a "visually-hidden text sibling" dismissal signal
 * when the flagged `<img>` shares a parent with an element carrying
 * `.sr-only` / `.visually-hidden`, or when the parent anchor carries
 * `aria-label`.
 *
 * Motivation: the Jekyll-repo field test reported that a logo `<img>`
 * in `header.html` flagged for `wcag22:1.4.5` (images of text) did not
 * mention the `<span class="sr-only">Jekyll</span>` sibling already
 * carrying the textual equivalent — a strong dismissal signal the
 * agent had to re-derive by reading the file. Per the AI-first
 * consumer model ("surface-not-suppress", "enrich reason with the
 * dismissal signal"), the candidate still surfaces but the reason
 * text names the sibling.
 *
 * The candidate MUST stay visible. Reason-text enrichment ONLY —
 * doctrine violation if the finder suppresses, down-ranks, or moves
 * the candidate to a separate bucket.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A logo <img> sharing a parent <a> with a .sr-only / .visually-hidden " +
    "sibling (or where the parent carries aria-label) produces a " +
    "wcag22:1.4.5 candidate whose reason names the visually-hidden text " +
    "sibling as a dismissal signal. The candidate remains visible — no " +
    "suppression, no priority downgrade. Reason-text enrichment only.",
  origin: {
    notes:
      "Second-pass Jekyll field-test finding (2026-04-21). header.html " +
      "in a Jekyll site has `<a><img alt=\"Jekyll\"><span class=\"sr-only\">Jekyll</span></a>` — " +
      "the image is the visual rendering of the text and the sr-only span " +
      "is the SR-accessible equivalent. The finder must enrich `reason` " +
      "with that signal so the agent dismisses without reading the file.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // header.html — .sr-only sibling
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.4.5",
      reasonIncludes: "visually-hidden text sibling",
    },

    // Candidate MUST remain visible. Any absence of the candidate is a
    // doctrine violation.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.4.5",
      reasonIncludes: ".sr-only",
    },

    // visually-hidden.html — .visually-hidden sibling
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.4.5",
      reasonIncludes: ".visually-hidden",
    },

    // aria-label-parent.html — aria-label on the parent anchor
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.4.5",
      reasonIncludes: "aria-label",
    },
  ],
};
