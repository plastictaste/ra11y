/**
 * Candidate finder: review/media-alternatives
 * Criteria: wcag22:1.2.1, wcag21:1.2.1 — audio-only OR video-only prerecorded
 *           wcag22:1.2.3, wcag21:1.2.3 — synchronized media (video-only)
 *           wcag22:1.2.5, wcag21:1.2.5 — synchronized media (video-only)
 * Spec: https://www.w3.org/TR/WCAG22/#audio-only-and-video-only-prerecorded
 *       https://www.w3.org/TR/WCAG22/#audio-description-or-media-alternative-prerecorded
 *       https://www.w3.org/TR/WCAG22/#audio-description-prerecorded
 *
 * Finds `<video>` and `<audio>` elements that need human review to
 * verify transcripts, captions, and audio descriptions are provided.
 *
 * Criterion fan-out by element type:
 *
 *   <audio> — audio-only content. Fan-out is 1.2.1 only (wcag22 + wcag21).
 *     1.2.3 (Audio Description or Media Alternative) and 1.2.5 (Audio
 *     Description) are normatively scoped to *synchronized media* — content
 *     that has both a video track and an audio track. A bare `<audio>`
 *     element has no video track; applying 1.2.3 or 1.2.5 to it is a
 *     spec-incorrect overclaim. Spec: WCAG 2.2 defines synchronized media as
 *     "audio or video synchronized with another format for presenting
 *     information and/or with time-based interactive components, unless the
 *     media is a media alternative for text that is clearly labeled as such."
 *     Audio-only content is explicitly distinguished from synchronized media
 *     throughout the 1.2.x SCs.
 *
 *   <video> — may be synchronized media (video+audio) OR video-only.
 *     Both 1.2.1 (for video-only) and 1.2.3 / 1.2.5 (for synchronized media)
 *     are potentially applicable. The reviewer determines which SC applies
 *     based on whether the video has an audio track. Full 6-criterion fan-out
 *     is correct for `<video>`.
 *
 * Iframes are intentionally NOT evidence for these criteria. The
 * `likelyIrrelevant` bucket on the manual-review surface is a labeled
 * bucket — per the AI-first doctrine
 * (`docs/kb/architecture/ai-first-consumer.md` "Labeled buckets are
 * suppression too"), the label must be provable from the code: "no
 * `<video>` or `<audio>` elements in the scanned files." A
 * `<iframe src="https://www.youtube.com/embed/…">` could embed a
 * playable video, a YouTube channel page, a non-video tutorial, or a
 * decorative thumbnail — the URL alone is not enough to assert
 * prerecorded A/V is present in the scanned project. Emitting 1.2.x
 * candidates for an iframe contradicts the bucket's contract: the same
 * scan ends up with `likelyIrrelevant: true` (because the bucket
 * predicate, `manual-applicability.ts`, sees no `<video>`/`<audio>`)
 * AND with iframe-grounded candidates for the very criteria the bucket
 * marks irrelevant. That dual signal is the inconsistency callers
 * reported as `V1-LIKELY-IRRELEVANT-INCONSISTENT`.
 *
 * 1.2.2 (captions prerecorded) IS automatable for iframe-embedded
 * media — the rule `media/video-captions-missing` fires a warning on
 * `<iframe src="https://www.youtube.com/embed/…">` so the agent can
 * verify host-side captions are enabled. That rule lives at the
 * violations layer (deterministic warning, not a review candidate)
 * and is unaffected by this finder's scope.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { findHtmlElementsByTag, findJsxElementsByTag } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import { findProseContainerAncestor, proseContainerReasonSuffix } from "../mdx-prose-container.ts";

// Full criterion set — all six IDs registered on this finder so the
// engine knows which criteria it covers for manual-applicability and
// likelyIrrelevant bucket decisions.
const ALL_CRITERION_IDS = [
  "wcag22:1.2.1",
  "wcag21:1.2.1",
  "wcag22:1.2.3",
  "wcag21:1.2.3",
  "wcag22:1.2.5",
  "wcag21:1.2.5",
] as const;

// <audio> is audio-only content. 1.2.3 and 1.2.5 are scoped to
// synchronized media (video+audio) per the WCAG 2.2 normative text.
// https://www.w3.org/TR/WCAG22/#audio-description-or-media-alternative-prerecorded
// https://www.w3.org/TR/WCAG22/#audio-description-prerecorded
const AUDIO_CRITERION_IDS = ["wcag22:1.2.1", "wcag21:1.2.1"] as const;

// <video> may be video-only (1.2.1) or synchronized media (1.2.3, 1.2.5).
// The reviewer determines which SC applies; emit all three pairs.
const VIDEO_CRITERION_IDS = ALL_CRITERION_IDS;

type MediaTag = "video" | "audio";

// DOM-origin file extensions. JSX-family finders see `.js`/`.ts` too
// via the `.js → .jsx` / `.ts → .tsx` alias in `extensionMatches`,
// which is correct for finders where a component file can legitimately
// live under any of the four extensions. It is wrong here: library
// code inside `.js` / `.ts` often contains string-literal HTML
// (`$(html).append('<video ...>')`) that builds DOM at runtime.
// Restricting to DOM-origin extensions kills the entire class at the
// source. The agent reads the JS library directly when investigating;
// per AI-first doctrine (docs/kb/architecture/ai-first-consumer.md),
// the tool's job is to point at real DOM elements, not at string
// payloads inside JS.
const DOM_ORIGIN_EXTENSIONS = [".html", ".htm", ".tsx", ".jsx"] as const;

function isDomOriginFile(filePath: string): boolean {
  return DOM_ORIGIN_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

function reasonForTag(tag: MediaTag): string {
  switch (tag) {
    case "video":
      return "video element -- verify transcript or audio description is provided";
    case "audio":
      return "audio element -- verify transcript is provided";
  }
}

function criterionIdsForTag(tag: MediaTag): readonly string[] {
  return tag === "audio" ? AUDIO_CRITERION_IDS : VIDEO_CRITERION_IDS;
}

export const finder = defineCandidateFinder({
  id: "review/media-alternatives",
  criterionIds: [...ALL_CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <video> and <audio> elements that need human review for transcripts, captions, and audio descriptions. " +
      "<audio> elements fan out to wcag22:1.2.1 only — 1.2.3 and 1.2.5 are scoped to synchronized media (video+audio) and do not apply to audio-only content. " +
      "<video> elements fan out to all three criterion pairs (1.2.1, 1.2.3, 1.2.5) because video may be video-only or synchronized media. " +
      "Iframes are intentionally not surfaced — the iframe `src` is not deterministic evidence of prerecorded A/V, and `likelyIrrelevant` for 1.2.1/1.2.3/1.2.5 must stay provable from the presence of <video>/<audio>.",
    reviewPrompt:
      "Verify that prerecorded audio has a transcript and prerecorded video has captions and an audio description or full text alternative.",
    references: [
      "https://www.w3.org/TR/WCAG22/#audio-only-and-video-only-prerecorded",
      "https://www.w3.org/TR/WCAG22/#audio-description-or-media-alternative-prerecorded",
      "https://www.w3.org/TR/WCAG22/#audio-description-prerecorded",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    // Extension gate: the `.js`/`.ts` alias into `.jsx`/`.tsx` feeds
    // plain JS/TS into JSX-scoped finders via engine/candidate-runner.ts
    // `extensionMatches`. For media-alternatives that's wrong — string-
    // literal `<video>` / `<audio>` in runtime DOM-builder libraries are
    // not rendered elements. See the DOM_ORIGIN_EXTENSIONS comment above.
    if (!isDomOriginFile(ctx.filePath)) return candidates;
    if (ctx.language === "html")
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, ctx.source, candidates);
    else if (ctx.language === "tsx" || ctx.language === "jsx")
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, ctx.source, candidates);
    return candidates;
  },
});

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of findHtmlElementsByTag(root, "video"))
    emitHtml(el, "video", filePath, source, candidates);
  for (const el of findHtmlElementsByTag(root, "audio"))
    emitHtml(el, "audio", filePath, source, candidates);
}

function findJsxCandidates(
  root: TsxModule,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of findJsxElementsByTag(root, "video"))
    emitJsx(el, "video", filePath, source, root, candidates);
  for (const el of findJsxElementsByTag(root, "audio"))
    emitJsx(el, "audio", filePath, source, root, candidates);
}

function emitHtml(
  el: HtmlElement,
  tag: MediaTag,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  const reason = reasonForTag(tag);
  const snippet = source.slice(el.range.start, Math.min(el.range.start + 120, el.range.end));
  const location = { filePath, line: el.loc.start.line, column: el.loc.start.column };
  for (const criterionId of criterionIdsForTag(tag)) {
    // Confidence "high": deterministic tag match on <video> or <audio>.
    // The reviewer question is about transcripts/captions/alternatives —
    // the element's media nature is unambiguous.
    candidates.push({ criterionId, location, reason, snippet, confidence: "high" });
  }
}

function emitJsx(
  el: JsxElement,
  tag: MediaTag,
  filePath: string,
  source: string,
  root: TsxModule,
  candidates: ReviewCandidate[],
): void {
  const baseReason = reasonForTag(tag);
  const snippet = source.slice(el.range.start, Math.min(el.range.start + 120, el.range.end));
  const location = { filePath, line: el.loc.start.line, column: el.loc.start.column };
  // MDX prose-container framing — see media-variants.ts emitJsx
  // for the doctrine reference. The candidate stays in the primary
  // list; the reason names the prose-container ancestor and the
  // confidence drops from "high" to "medium" because the static
  // evidence (a JSX-shape match inside an inline-prose component)
  // weakens.
  const containerName = findProseContainerAncestor(el, root);
  const reason =
    containerName === null
      ? baseReason
      : `${baseReason}${proseContainerReasonSuffix(containerName)}`;
  const confidence: "high" | "medium" = containerName === null ? "high" : "medium";
  for (const criterionId of criterionIdsForTag(tag)) {
    candidates.push({ criterionId, location, reason, snippet, confidence });
  }
}
