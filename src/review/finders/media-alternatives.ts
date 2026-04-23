/**
 * Candidate finder: review/media-alternatives
 * Criteria: wcag22:1.2.1, wcag21:1.2.1, wcag22:1.2.3, wcag21:1.2.3,
 *           wcag22:1.2.5, wcag21:1.2.5
 * Spec: https://www.w3.org/TR/WCAG22/#audio-only-and-video-only-prerecorded
 *       https://www.w3.org/TR/WCAG22/#audio-description-or-media-alternative-prerecorded
 *       https://www.w3.org/TR/WCAG22/#audio-description-prerecorded
 *
 * Finds <video>, <audio>, and qualifying <iframe> elements that need
 * human review to verify transcripts, captions, and audio descriptions
 * are provided.
 *
 * Iframe gating: not every `<iframe>` is media. Docs pages, CMS dashboard
 * widgets, payment flows, and map embeds all render iframes, and
 * promoting those to 1.2.x review candidates silently flips
 * `likelyIrrelevant` to `needsReview` on projects with no real A/V.
 * The finder treats an iframe as media ONLY when its `src` points at
 * one of the known video-embed hosts (YouTube, Vimeo, Wistia,
 * Brightcove, Loom). Same allowlist the rule `media/video-captions-
 * missing` uses for the captions side — both live in
 * `src/utils/video-embed-hosts.ts`. See that file and the AI-first
 * doctrine page (`docs/kb/architecture/ai-first-consumer.md`) for the
 * "provable from code" rule that requires this gate.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";
import { mediaEmbedHost } from "../../utils/video-embed-hosts.ts";

const CRITERION_IDS = [
  "wcag22:1.2.1",
  "wcag21:1.2.1",
  "wcag22:1.2.3",
  "wcag21:1.2.3",
  "wcag22:1.2.5",
  "wcag21:1.2.5",
] as const;

type MediaTag = "video" | "audio" | "iframe";

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

function reasonForTag(tag: MediaTag, platformName?: string): string {
  switch (tag) {
    case "video":
      return "video element -- verify transcript or audio description is provided";
    case "audio":
      return "audio element -- verify transcript is provided";
    case "iframe": {
      const platformSuffix = platformName ? ` (${platformName})` : "";
      return `iframe element embedding video${platformSuffix} -- verify the embedded source provides transcript/audio-description; captions must be enabled on the host platform`;
    }
  }
}

export const finder = defineCandidateFinder({
  id: "review/media-alternatives",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds media elements (<video>, <audio>, and video-host <iframe> embeds on the YouTube/Vimeo/Wistia/Brightcove/Loom allowlist) that need human review for transcripts, captions, and audio descriptions.",
    reviewPrompt:
      "Verify that prerecorded audio has a transcript, prerecorded video has captions and an audio description or full text alternative, and video-host iframe embeds have accessible alternatives enabled on the host platform.",
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
  for (const el of findHtmlElementsByTag(root, "video"))
    emitHtml(el, "video", undefined, filePath, source, candidates);
  for (const el of findHtmlElementsByTag(root, "audio"))
    emitHtml(el, "audio", undefined, filePath, source, candidates);
  for (const el of findHtmlElementsByTag(root, "iframe")) {
    // Iframe allowlist: only iframes pointing at known video-embed
    // hosts count as media. Bare iframes (docs CMS widgets, payment
    // flows, map embeds) never flip 1.2.* out of `likelyIrrelevant` —
    // an agent reading the iframe `src` for a non-video host has no
    // evidence the criterion applies, so emitting a candidate would
    // just bloat the checklist. See the shared allowlist rationale in
    // `src/utils/video-embed-hosts.ts`.
    const src = getHtmlAttribute(el, "src");
    const platform = mediaEmbedHost(src);
    if (platform === null) continue;
    emitHtml(el, "iframe", platform.name, filePath, source, candidates);
  }
}

function findJsxCandidates(
  root: TsxModule,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of findJsxElementsByTag(root, "video"))
    emitJsx(el, "video", undefined, filePath, source, candidates);
  for (const el of findJsxElementsByTag(root, "audio"))
    emitJsx(el, "audio", undefined, filePath, source, candidates);
  for (const el of findJsxElementsByTag(root, "iframe")) {
    // JSX iframe gating mirrors the HTML path — host-allowlist only.
    // `src={dynamicUrl}` (non-string literal) returns `null` from
    // `getJsxAttributeString` and is skipped: we don't guess whether
    // an expression value points at a video host.
    const src = getJsxAttributeString(el, "src");
    const platform = mediaEmbedHost(src);
    if (platform === null) continue;
    emitJsx(el, "iframe", platform.name, filePath, source, candidates);
  }
}

function emitHtml(
  el: HtmlElement,
  tag: MediaTag,
  platformName: string | undefined,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  const reason = reasonForTag(tag, platformName);
  const snippet = source.slice(el.range.start, Math.min(el.range.start + 120, el.range.end));
  const location = { filePath, line: el.loc.start.line, column: el.loc.start.column };
  for (const criterionId of CRITERION_IDS) {
    // Confidence "high": deterministic tag match on <video>,
    // <audio>, or an allowlisted video-host <iframe>. The reviewer
    // question is about transcripts/captions/alternatives — the
    // element's media nature is unambiguous.
    candidates.push({ criterionId, location, reason, snippet, confidence: "high" });
  }
}

function emitJsx(
  el: JsxElement,
  tag: MediaTag,
  platformName: string | undefined,
  filePath: string,
  source: string,
  candidates: ReviewCandidate[],
): void {
  const reason = reasonForTag(tag, platformName);
  const snippet = source.slice(el.range.start, Math.min(el.range.start + 120, el.range.end));
  const location = { filePath, line: el.loc.start.line, column: el.loc.start.column };
  for (const criterionId of CRITERION_IDS) {
    candidates.push({ criterionId, location, reason, snippet, confidence: "high" });
  }
}
