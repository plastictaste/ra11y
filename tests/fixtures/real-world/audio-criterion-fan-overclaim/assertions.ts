/**
 * audio-criterion-fan-overclaim — guards the spec-correct criterion fan
 * for `<audio>` elements in the review/media-alternatives finder.
 *
 * WCAG 1.2.3 (Audio Description or Media Alternative, Prerecorded) and
 * 1.2.5 (Audio Description, Prerecorded) are normatively scoped to
 * *synchronized media* — content that has both a video track and an
 * audio track. Audio-only content (a podcast, an interview recording,
 * a standalone `<audio>` element) is NOT synchronized media; it falls
 * under 1.2.1 (Audio-only and Video-only Prerecorded) only.
 *
 * Before the fix, the finder applied the full 6-criterion fan-out
 * (1.2.1, 1.2.3, 1.2.5 × wcag22 + wcag21 equivalents) to every
 * `<audio>` element, which caused six audio elements to produce 18
 * candidates across three criteria — three of which were spec-incorrect.
 * The fix narrows the audio fan-out to 1.2.1 only.
 *
 * What the fixture locks in:
 *   - wcag22:1.2.1 must surface for a bare `<audio>` element.
 *   - wcag22:1.2.3 must NOT surface — it is scoped to synchronized media.
 *   - wcag22:1.2.5 must NOT surface — same reason.
 *
 * Spec refs:
 *   https://www.w3.org/TR/WCAG22/#audio-only-and-video-only-prerecorded
 *   https://www.w3.org/TR/WCAG22/#audio-description-or-media-alternative-prerecorded
 *   https://www.w3.org/TR/WCAG22/#audio-description-prerecorded
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "review/media-alternatives emits wcag22:1.2.1 for <audio> elements but NOT wcag22:1.2.3 " +
    "or wcag22:1.2.5, which are scoped to synchronized media (video+audio tracks) and do not " +
    "apply to audio-only content.",
  origin: {
    feedbackRound: "Q7-CHECKLIST-AUDIO-VS-VIDEO-CRITERION-FAN",
    notes:
      "Six audio elements in a real-world media player emitted 18 candidates across 3 criteria. " +
      "1.2.3 and 1.2.5 are normatively scoped to synchronized media only. " +
      "Sanitized to a podcast-player HTML page with a single <audio> element.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // 1.2.1 must fire: audio-only prerecorded content requires a transcript.
    {
      kind: "candidate-present",
      criterionId: "wcag22:1.2.1",
      reasonIncludes: "audio element",
    },

    // 1.2.3 must NOT fire on an <audio> element — it applies only to
    // synchronized media (video with audio track). An audio-only
    // element does not have a video track that needs an audio
    // description or text media alternative.
    {
      kind: "no-candidate",
      criterionId: "wcag22:1.2.3",
    },

    // 1.2.5 must NOT fire on an <audio> element — same reasoning as
    // 1.2.3: Audio Description (Prerecorded) is a synchronized-media
    // criterion. There is no video track on a bare <audio> element.
    {
      kind: "no-candidate",
      criterionId: "wcag22:1.2.5",
    },
  ],
};
