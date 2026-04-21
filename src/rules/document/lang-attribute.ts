/**
 * Rule: document/lang-attribute
 * Satisfies: wcag22:3.1.1, wcag21:3.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#language-of-page
 *
 * > The default human language of each web page can be programmatically
 * > determined.
 *
 * Source: https://www.w3.org/TR/WCAG22/#language-of-page
 *
 * Flags HTML documents whose <html> element is missing a non-empty
 * `lang` attribute. Screen readers switch pronunciation dictionaries
 * based on this attribute; without it, English content read with a
 * Japanese voice (or vice versa) is unintelligible.
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, getHtmlAttribute } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

export const rule = defineRule({
  id: "document/lang-attribute",
  satisfies: ["wcag22:3.1.1", "wcag21:3.1.1"],
  severity: "error",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "HTML documents must declare their primary language via a non-empty lang attribute on <html>.",
    rationale:
      "Screen readers and translation tools rely on the lang attribute to pick the right pronunciation dictionary and voice. A missing or empty lang attribute makes English content announced with a Japanese voice (or vice versa) unintelligible.",
    goodExample: `<html lang="en">`,
    badExample: `<html>`,
    normativeQuote:
      "The default human language of each web page can be programmatically determined.",
    references: [
      "https://www.w3.org/TR/WCAG22/#language-of-page",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H57",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    const htmlElements = findHtmlElementsByTag(doc, "html");
    // If there's no <html> element, we're looking at a fragment — not
    // our concern. The page-titled rule handles the "no root" case
    // separately.
    if (htmlElements.length === 0) return;
    const htmlEl = htmlElements[0];
    if (!htmlEl) return;

    const lang = getHtmlAttribute(htmlEl, "lang");
    const xmlLang = getHtmlAttribute(htmlEl, "xml:lang");
    const langTrimmed = lang?.trim() ?? "";
    const xmlLangTrimmed = xmlLang?.trim() ?? "";
    const langPresent = lang !== null && langTrimmed.length > 0;
    const xmlLangPresent = xmlLang !== null && xmlLangTrimmed.length > 0;

    // Mismatch branch: both attributes are present and non-empty, but
    // their normalized values disagree. WCAG 3.1.1 requires the page's
    // language to be *programmatically determinable*; when two sources
    // of truth contradict (e.g. `xml:lang="en"` vs `lang="en-us"`), a
    // conforming AT is free to consult either, and the announced
    // language is nondeterministic. We don't pick a winner — the agent
    // reading the surrounding content is the only correct arbiter.
    if (langPresent && xmlLangPresent) {
      if (!bcp47TagsMatch(langTrimmed, xmlLangTrimmed)) {
        ctx.emit({
          severity: "error",
          location: {
            filePath: "",
            line: htmlEl.loc.start.line,
            column: htmlEl.loc.start.column,
          },
          message: `<html> declares lang="${langTrimmed}" but xml:lang="${xmlLangTrimmed}" — the two disagree, so assistive technologies that consult either attribute will announce different languages for the same page.`,
          suggestion: `Pick one BCP 47 tag and use it for both attributes, or drop one of them. If the page is ${langTrimmed}, set xml:lang="${langTrimmed}"; if it's ${xmlLangTrimmed}, set lang="${xmlLangTrimmed}". Serving XHTML as HTML only needs lang; a legacy XHTML document served as application/xhtml+xml only needs xml:lang.`,
        });
      }
      return;
    }

    if (langPresent || xmlLangPresent) return;

    ctx.emit({
      severity: "error",
      location: {
        filePath: "",
        line: htmlEl.loc.start.line,
        column: htmlEl.loc.start.column,
      },
      message:
        lang === null
          ? "<html> element is missing the lang attribute — screen readers won't know how to pronounce the page content."
          : "<html lang> is empty — screen readers won't know how to pronounce the page content.",
      suggestion: buildSuggestion(doc),
    });
  },
});

/**
 * Case-insensitive BCP 47 equality. Two tags match iff their
 * subtag sequences (split on `-`, lowercased) are equal. This treats
 * `en-US` === `EN-us` (a formatting difference) but `en` !== `en-US`
 * (a genuine specificity difference). We deliberately do not try to
 * canonicalize (e.g. RFC 4647 extended filtering or IANA-registered
 * suppress-script tags like `zh-Hans` ≡ `zh`) — those are semantic
 * policy calls the agent should make on the rendered content, not
 * static heuristics. A strict token-equality check is the honest
 * minimum; see ai-first-consumer.md "No heuristic suppression".
 */
function bcp47TagsMatch(a: string, b: string): boolean {
  const normalize = (s: string): string =>
    s
      .split("-")
      .map((p) => p.toLowerCase())
      .join("-");
  return normalize(a) === normalize(b);
}

/**
 * Context-aware fix text. Walks the current document for in-file language
 * signals the author has already written, and folds them into the
 * suggestion so the agent sees a concrete candidate rather than a
 * generic "use BCP 47" instruction. Sibling-file inspection would
 * violate the "rules are pure" invariant (CLAUDE.md §3.6), so the
 * ladder uses only signals reachable from `ctx.ast`.
 *
 * Ladder (first match wins):
 *   1. `<meta http-equiv="Content-Language" content="xx">` — the HTML
 *      spec's own authoritative fallback for page language. If the
 *      author already wrote it, echo the value back as the lang.
 *   2. `<meta name="language" content="xx">` — non-standard but common
 *      in CMS output; lower confidence than http-equiv but still
 *      concrete.
 *   3. `<meta charset="...">` with a legacy region-bound encoding
 *      (shift_jis, euc-jp, gb2312, big5, iso-8859-{2..15},
 *      windows-125{0..8}). UTF-8 is ambiguous and skipped. Legacy
 *      encodings carry enough signal to hint at a region's language
 *      family without asserting certainty.
 *   4. Generic BCP 47 fallback with multiple examples. Preserves the
 *      existing "BCP 47" phrase the unit tests assert on.
 */
function buildSuggestion(doc: HtmlDocument): string {
  const metas = findHtmlElementsByTag(doc, "meta");

  const httpEquiv = findMetaHttpEquivLanguage(metas);
  if (httpEquiv !== null) {
    return `Add lang="${httpEquiv}" to <html> to match <meta http-equiv="Content-Language" content="${httpEquiv}"> already declared on the page. Use a valid BCP 47 code.`;
  }

  const nameLanguage = findMetaNameLanguage(metas);
  if (nameLanguage !== null) {
    return `Add lang="${nameLanguage}" to <html> to match <meta name="language" content="${nameLanguage}"> already declared on the page (non-standard meta, but a strong hint). Use a valid BCP 47 code.`;
  }

  const charsetHint = charsetLanguageHint(metas);
  if (charsetHint !== null) {
    return `Add lang="…" to <html>. <meta charset="${charsetHint.charset}"> is a legacy encoding commonly paired with ${charsetHint.languageHint} — if the page is in ${charsetHint.languageExample}, use lang="${charsetHint.bcp47Example}". Use a valid BCP 47 code.`;
  }

  return 'Add a lang attribute matching the primary language of the page, e.g. lang="en" for English, lang="fr" for French, lang="ja" for Japanese, or lang="zh-Hans" for Simplified Chinese. Use a valid BCP 47 code.';
}

/** Returns the trimmed `content` of the first `<meta http-equiv="Content-Language">`. */
function findMetaHttpEquivLanguage(metas: readonly HtmlElement[]): string | null {
  for (const meta of metas) {
    const equiv = getHtmlAttribute(meta, "http-equiv");
    if (equiv === null || equiv.toLowerCase() !== "content-language") continue;
    const content = getHtmlAttribute(meta, "content");
    if (content === null) continue;
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    // Content-Language can carry a comma-separated list — the primary
    // language is the first entry.
    const primary = trimmed.split(",")[0]?.trim() ?? "";
    if (primary.length === 0) continue;
    return primary;
  }
  return null;
}

/** Returns the trimmed `content` of the first `<meta name="language">`. */
function findMetaNameLanguage(metas: readonly HtmlElement[]): string | null {
  for (const meta of metas) {
    const name = getHtmlAttribute(meta, "name");
    if (name === null || name.toLowerCase() !== "language") continue;
    const content = getHtmlAttribute(meta, "content");
    if (content === null) continue;
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return null;
}

interface CharsetHint {
  readonly charset: string;
  readonly languageHint: string;
  readonly languageExample: string;
  readonly bcp47Example: string;
}

/**
 * Returns a region hint for legacy `<meta charset>` encodings. UTF-8
 * is ambiguous and yields null. The mapping is deliberately shallow —
 * encoded as additive context in the `reason` prose, not as a
 * confident language assertion (cf. ai-first-consumer.md: "No
 * heuristic suppression"). The agent decides.
 */
function charsetLanguageHint(metas: readonly HtmlElement[]): CharsetHint | null {
  for (const meta of metas) {
    const charsetAttr = getHtmlAttribute(meta, "charset");
    const charset = charsetAttr ?? extractCharsetFromContentType(meta);
    if (charset === null) continue;
    const lowered = charset.toLowerCase();
    const hint = CHARSET_HINTS[lowered];
    if (hint !== undefined) {
      return { charset: lowered, ...hint };
    }
  }
  return null;
}

/** Pulls `charset=xxx` out of a legacy `<meta http-equiv="Content-Type" content="...">`. */
function extractCharsetFromContentType(meta: HtmlElement): string | null {
  const equiv = getHtmlAttribute(meta, "http-equiv");
  if (equiv === null || equiv.toLowerCase() !== "content-type") return null;
  const content = getHtmlAttribute(meta, "content");
  if (content === null) return null;
  const match = content.match(/charset\s*=\s*([^;\s]+)/i);
  return match?.[1] ?? null;
}

/**
 * Shallow charset → region mapping. Keys are lowercase encoding names.
 * Each entry carries a human-readable hint plus one BCP 47 example the
 * agent can copy verbatim if the guess is right. UTF-8 is intentionally
 * absent — it's region-neutral and would be a dishonest hint.
 */
const CHARSET_HINTS: Readonly<Record<string, Omit<CharsetHint, "charset">>> = {
  shift_jis: { languageHint: "Japanese content", languageExample: "Japanese", bcp47Example: "ja" },
  "shift-jis": {
    languageHint: "Japanese content",
    languageExample: "Japanese",
    bcp47Example: "ja",
  },
  sjis: { languageHint: "Japanese content", languageExample: "Japanese", bcp47Example: "ja" },
  "euc-jp": { languageHint: "Japanese content", languageExample: "Japanese", bcp47Example: "ja" },
  "iso-2022-jp": {
    languageHint: "Japanese content",
    languageExample: "Japanese",
    bcp47Example: "ja",
  },
  "euc-kr": { languageHint: "Korean content", languageExample: "Korean", bcp47Example: "ko" },
  gb2312: {
    languageHint: "Simplified Chinese content",
    languageExample: "Simplified Chinese",
    bcp47Example: "zh-Hans",
  },
  gbk: {
    languageHint: "Simplified Chinese content",
    languageExample: "Simplified Chinese",
    bcp47Example: "zh-Hans",
  },
  gb18030: {
    languageHint: "Simplified Chinese content",
    languageExample: "Simplified Chinese",
    bcp47Example: "zh-Hans",
  },
  big5: {
    languageHint: "Traditional Chinese content",
    languageExample: "Traditional Chinese",
    bcp47Example: "zh-Hant",
  },
  "iso-8859-2": {
    languageHint: "Central European languages (Polish, Czech, Hungarian, …)",
    languageExample: "Polish",
    bcp47Example: "pl",
  },
  "iso-8859-5": {
    languageHint: "Cyrillic-script languages (Russian, Ukrainian, …)",
    languageExample: "Russian",
    bcp47Example: "ru",
  },
  "iso-8859-6": { languageHint: "Arabic", languageExample: "Arabic", bcp47Example: "ar" },
  "iso-8859-7": { languageHint: "Greek", languageExample: "Greek", bcp47Example: "el" },
  "iso-8859-8": { languageHint: "Hebrew", languageExample: "Hebrew", bcp47Example: "he" },
  "iso-8859-9": { languageHint: "Turkish", languageExample: "Turkish", bcp47Example: "tr" },
  "windows-1250": {
    languageHint: "Central European languages (Polish, Czech, Hungarian, …)",
    languageExample: "Polish",
    bcp47Example: "pl",
  },
  "windows-1251": {
    languageHint: "Cyrillic-script languages (Russian, Ukrainian, …)",
    languageExample: "Russian",
    bcp47Example: "ru",
  },
  "windows-1253": { languageHint: "Greek", languageExample: "Greek", bcp47Example: "el" },
  "windows-1254": { languageHint: "Turkish", languageExample: "Turkish", bcp47Example: "tr" },
  "windows-1255": { languageHint: "Hebrew", languageExample: "Hebrew", bcp47Example: "he" },
  "windows-1256": { languageHint: "Arabic", languageExample: "Arabic", bcp47Example: "ar" },
  "windows-1257": {
    languageHint: "Baltic languages (Lithuanian, Latvian, Estonian)",
    languageExample: "Lithuanian",
    bcp47Example: "lt",
  },
  "tis-620": { languageHint: "Thai", languageExample: "Thai", bcp47Example: "th" },
};
