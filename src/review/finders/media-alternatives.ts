/**
 * Candidate finder: review/media-alternatives
 * Criteria: wcag22:1.2.1, wcag21:1.2.1, wcag22:1.2.3, wcag21:1.2.3,
 *           wcag22:1.2.5, wcag21:1.2.5
 * Spec: https://www.w3.org/TR/WCAG22/#audio-only-and-video-only-prerecorded
 *       https://www.w3.org/TR/WCAG22/#audio-description-or-media-alternative-prerecorded
 *       https://www.w3.org/TR/WCAG22/#audio-description-prerecorded
 *
 * Finds <video>, <audio>, and <iframe> elements that need human review
 * to verify transcripts, captions, and audio descriptions are provided.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { findHtmlElementsByTag, findJsxElementsByTag } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = [
  "wcag22:1.2.1",
  "wcag21:1.2.1",
  "wcag22:1.2.3",
  "wcag21:1.2.3",
  "wcag22:1.2.5",
  "wcag21:1.2.5",
] as const;

const MEDIA_TAGS = ["video", "audio", "iframe"] as const;

// DOM-origin file extensions. JSX-family finders see `.js`/`.ts` too
// via the `.js → .jsx` / `.ts → .tsx` alias in `extensionMatches`,
// which is correct for finders where a component file can legitimately
// live under any of the four extensions. It is wrong here: library
// code inside `.js` / `.ts` often contains string-literal HTML
// (`$(html).append('<iframe ...>')`) that builds DOM at runtime. Field
// reports have surfaced review candidates at `jquery.fancybox.pack.js`
// whose snippet is the packed library's iframe-builder string literal,
// not a rendered element. Restricting to DOM-origin extensions kills
// the entire class at the source. The agent reads the JS library
// directly when investigating; per AI-first doctrine
// (docs/kb/architecture/ai-first-consumer.md), the tool's job is to
// point at real DOM iframes, not at string payloads inside JS.
const DOM_ORIGIN_EXTENSIONS = [".html", ".htm", ".tsx", ".jsx"] as const;

function isDomOriginFile(filePath: string): boolean {
  return DOM_ORIGIN_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

function reasonForTag(tag: (typeof MEDIA_TAGS)[number]): string {
  switch (tag) {
    case "video":
      return "video element -- verify transcript or audio description is provided";
    case "audio":
      return "audio element -- verify transcript is provided";
    case "iframe":
      return "iframe element -- verify embedded media has accessible alternatives";
  }
}

export const finder = defineCandidateFinder({
  id: "review/media-alternatives",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds media elements (<video>, <audio>, <iframe>) that need human review for transcripts, captions, and audio descriptions.",
    reviewPrompt:
      "Verify that prerecorded audio has a transcript, prerecorded video has captions and an audio description or full text alternative, and iframes with media content have accessible alternatives.",
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
    // literal iframes in runtime DOM-builder libraries (jQuery,
    // fancybox) are not rendered iframes. See the DOM_ORIGIN_EXTENSIONS
    // comment above.
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
  for (const tag of MEDIA_TAGS) {
    for (const el of findHtmlElementsByTag(root, tag)) {
      for (const criterionId of CRITERION_IDS) {
        // Confidence "high": deterministic tag match on <video>,
        // <audio>, <iframe>. The reviewer question is about
        // transcripts/captions/alternatives — the element is
        // unambiguous.
        candidates.push({
          criterionId,
          location: {
            filePath,
            line: el.loc.start.line,
            column: el.loc.start.column,
          },
          reason: reasonForTag(tag),
          snippet: source.slice(el.range.start, Math.min(el.range.start + 120, el.range.end)),
          confidence: "high",
        });
      }
    }
  }
}

function findJsxCandidates(
  root: TsxModule,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  for (const tag of MEDIA_TAGS) {
    for (const el of findJsxElementsByTag(root, tag)) {
      for (const criterionId of CRITERION_IDS) {
        // Confidence "high": deterministic tag match on <video>,
        // <audio>, <iframe>. The reviewer question is about
        // transcripts/captions/alternatives — the element is
        // unambiguous.
        candidates.push({
          criterionId,
          location: {
            filePath,
            line: el.loc.start.line,
            column: el.loc.start.column,
          },
          reason: reasonForTag(tag),
          snippet: source.slice(el.range.start, Math.min(el.range.start + 120, el.range.end)),
          confidence: "high",
        });
      }
    }
  }
}
