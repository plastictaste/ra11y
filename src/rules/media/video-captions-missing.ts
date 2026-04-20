/**
 * Rule: media/video-captions-missing
 * Satisfies: wcag22:1.2.2, wcag21:1.2.2
 * Spec: https://www.w3.org/TR/WCAG22/#captions-prerecorded
 *
 * > Captions are provided for all prerecorded audio content in
 * > synchronized media, except when the media is a media alternative
 * > for text and is clearly labeled as such.
 *
 * Source: https://www.w3.org/TR/WCAG22/#captions-prerecorded
 *
 * Flags `<video>` elements with no child `<track kind="captions">`
 * (or `kind="subtitles"`, which the HTML spec treats as user-facing
 * captions for a different language). Static analysis cannot tell
 * whether a given video is purely decorative; the rule is a warning
 * so teams can suppress it case-by-case via inline disables.
 *
 * Notes:
 *   - The rule does NOT fire on `<video muted>` — muted video still
 *     needs captions if it contains audio content, and the muted
 *     attribute is a display hint, not a semantic one.
 *   - The rule does NOT fire when the video declares
 *     aria-hidden="true" — the whole element is marked as
 *     decorative so captions are moot.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/video-captions-missing",
  satisfies: ["wcag22:1.2.2", "wcag21:1.2.2"],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<video> elements with audio content need a <track kind='captions'> child so deaf and hard-of-hearing users can follow the dialogue.",
    rationale:
      "Captions are the minimum accessible representation of spoken content in prerecorded video. Without them, deaf users are locked out of the information — and in contexts where sound is off by default (social feeds, waiting rooms, open-plan offices) captions also benefit hearing users.",
    goodExample: `<video src="launch.mp4" controls><track kind="captions" src="launch.vtt" srclang="en" label="English"></video>`,
    badExample: `<video src="launch.mp4" controls></video>`,
    normativeQuote:
      "Captions are provided for all prerecorded audio content in synchronized media.",
    references: [
      "https://www.w3.org/TR/WCAG22/#captions-prerecorded",
      "https://www.w3.org/WAI/media/av/captions/",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const docLang = findHtmlDocumentLang(doc);
  for (const video of findHtmlElementsByTag(doc, "video")) {
    if (getHtmlAttribute(video, "aria-hidden") === "true") continue;
    if (hasCaptionsChildHtml(video)) continue;
    const videoSrc = getHtmlAttribute(video, "src") ?? findFirstSourceSrcHtml(video);
    emit(buildViolation(video.loc.start, videoSrc, docLang));
  }
}

function hasCaptionsChildHtml(video: HtmlElement): boolean {
  for (const child of video.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "track") continue;
    const kind = (getHtmlAttribute(child, "kind") ?? "").toLowerCase();
    if (kind === "captions" || kind === "subtitles") return true;
  }
  return false;
}

/**
 * First `<source src="…">` child's value, or `null` if the video has
 * none. HTML `<video>` carries media URLs on either its own `src`
 * attribute or on any number of `<source>` children; this fallback
 * mirrors the browser's media-resource selection algorithm by picking
 * the first source declared.
 */
function findFirstSourceSrcHtml(video: HtmlElement): string | null {
  for (const child of video.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "source") continue;
    const src = getHtmlAttribute(child, "src");
    if (src !== null && src.length > 0) return src;
  }
  return null;
}

/**
 * Reads the document root's `<html lang="…">` value for the srclang
 * example. Returns the raw lang attribute (trimmed) or `null` when the
 * document has no `<html>` element or no lang. The fix builder
 * substitutes `"en"` when this is `null`.
 */
function findHtmlDocumentLang(doc: HtmlDocument): string | null {
  for (const html of findHtmlElementsByTag(doc, "html")) {
    const lang = getHtmlAttribute(html, "lang");
    if (lang !== null && lang.trim().length > 0) return lang.trim();
  }
  return null;
}

function checkJsx(module: TsxModule, emit: Emit): void {
  const docLang = findJsxDocumentLang(module);
  for (const video of findJsxElementsByTag(module, "video")) {
    if (getJsxAttributeString(video, "aria-hidden") === "true") continue;
    if (hasCaptionsChildJsx(video)) continue;
    const videoSrc = getJsxAttributeString(video, "src") ?? findFirstSourceSrcJsx(video);
    emit(buildViolation(video.loc.start, videoSrc, docLang));
  }
}

function hasCaptionsChildJsx(video: JsxElement): boolean {
  for (const child of video.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName !== "track") continue;
    const kind = getJsxAttributeString(child, "kind");
    if (kind === "captions" || kind === "subtitles") return true;
  }
  return false;
}

/**
 * First `<source src="…">` child's value on a JSX `<video>`. JSX
 * preserves case, so we compare the lowercase form — `<Source>` is
 * almost always a wrapper component this rule deliberately skips.
 */
function findFirstSourceSrcJsx(video: JsxElement): string | null {
  for (const child of video.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName !== "source") continue;
    const src = getJsxAttributeString(child, "src");
    if (src !== null && src.length > 0) return src;
  }
  return null;
}

/**
 * Looks for an `<html lang="…">` in a JSX module — a common shape in
 * Next.js / Remix root layouts (`<html lang="en"><body>…</body></html>`).
 * Returns `null` when no `<html>` element is in the module or none
 * carries a string-literal `lang`.
 */
function findJsxDocumentLang(module: TsxModule): string | null {
  for (const html of findJsxElementsByTag(module, "html")) {
    const lang = getJsxAttributeString(html, "lang");
    if (lang !== null && lang.trim().length > 0) return lang.trim();
  }
  return null;
}

function buildViolation(
  loc: { line: number; column: number },
  videoSrc: string | null,
  docLang: string | null,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: buildMessage(videoSrc),
    suggestion: buildSuggestion(videoSrc, docLang),
  };
}

function buildMessage(videoSrc: string | null): string {
  if (videoSrc !== null) {
    // `basename` derives from a user-authored `src` URL/path; long
    // path tails (signed URLs, deeply-nested fixture paths) would
    // otherwise blow up the echo.
    const basename = truncateForEcho(filenameFromPath(videoSrc));
    return `<video src="${basename}"> has no <track kind="captions"> child — deaf and hard-of-hearing users can't follow the dialogue.`;
  }
  return `<video> has no <track kind="captions"> child — deaf and hard-of-hearing users can't follow the dialogue.`;
}

function buildSuggestion(videoSrc: string | null, docLang: string | null): string {
  const srclang = docLang ?? "en";
  const label = describeLangLabel(srclang);
  const kindNote =
    'kind="captions" is for deaf/hard-of-hearing viewers (includes sound effects and speaker IDs); kind="subtitles" is for translation only.';
  if (videoSrc !== null) {
    // Same rationale as the message: cap both user-derived names.
    // `vttName` is derived from `basename` via extension swap, so
    // capping the basename first keeps both echoes bounded.
    const basename = truncateForEcho(filenameFromPath(videoSrc));
    const vttName = truncateForEcho(vttFilename(filenameFromPath(videoSrc)));
    return `Add \`<track kind="captions" src="${vttName}" srclang="${srclang}" label="${label}" default>\` inside \`<video src="${basename}">\`, pointing at a VTT file with time-synced captions for that clip. ${kindNote} If the video is decorative (no audio content), mark it with aria-hidden="true" instead.`;
  }
  return `Add a \`<track kind="captions" src="captions.vtt" srclang="${srclang}" label="${label}" default>\` child of \`<video>\` pointing at a VTT file with time-synced captions. ${kindNote} If the video is decorative (no audio content), mark it with aria-hidden="true" instead.`;
}

/** Strips directory path; returns the final path segment. */
function filenameFromPath(src: string): string {
  const slash = Math.max(src.lastIndexOf("/"), src.lastIndexOf("\\"));
  return slash === -1 ? src : src.slice(slash + 1);
}

/**
 * Derives a VTT filename from a media basename by swapping the
 * extension. `launch.mp4` → `launch.vtt`; `intro.webm` → `intro.vtt`;
 * an extensionless input (`clip`) becomes `clip.vtt`. Query strings
 * and fragments are dropped first — `launch.mp4?v=2` → `launch.vtt`.
 */
function vttFilename(basename: string): string {
  const stripped = basename.replace(/[?#].*$/, "");
  const dot = stripped.lastIndexOf(".");
  const stem = dot > 0 ? stripped.slice(0, dot) : stripped;
  return `${stem || "captions"}.vtt`;
}

/**
 * Human-readable `label` for the generated track. The label attribute
 * is surfaced in the browser's native track picker, so it should read
 * like a sentence (`"English captions"`), not a tag (`"en captions"`).
 * Only the common primary subtags are spelled out; anything else falls
 * through to a generic `captions` label so the suggestion stays honest
 * rather than guessing a language name from an unfamiliar code.
 */
function describeLangLabel(lang: string): string {
  const primary = lang.split(/[-_]/)[0]?.toLowerCase() ?? "";
  const names: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    it: "Italian",
    pt: "Portuguese",
    ja: "Japanese",
    zh: "Chinese",
    ko: "Korean",
    ar: "Arabic",
    ru: "Russian",
    nl: "Dutch",
  };
  const pretty = names[primary];
  return pretty ? `${pretty} captions` : "captions";
}
