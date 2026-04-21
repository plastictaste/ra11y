/**
 * Rule: document/page-titled
 * Satisfies: wcag22:2.4.2, wcag21:2.4.2
 * Spec: https://www.w3.org/TR/WCAG22/#page-titled
 *
 * > Web pages have titles that describe topic or purpose.
 *
 * Source: https://www.w3.org/TR/WCAG22/#page-titled
 *
 * Flags HTML documents whose <head> contains no <title> element or
 * whose <title> is empty. Screen readers announce the title first
 * when a page loads — a missing or empty title leaves users unsure
 * what they landed on.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  htmlTextContent,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument } from "../../types/ast.ts";

export const rule = defineRule({
  id: "document/page-titled",
  satisfies: ["wcag22:2.4.2", "wcag21:2.4.2"],
  severity: "error",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      "HTML documents must have a non-empty <title> element describing topic or purpose.",
    rationale:
      "Screen readers announce the page title when a document loads. A missing or empty title leaves non-sighted users unsure what they've landed on; it also breaks browser tabs, bookmarks, and search engine results.",
    goodExample: `<title>Settings — Acme Dashboard</title>`,
    badExample: `<title></title>`,
    normativeQuote: "Web pages have titles that describe topic or purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#page-titled",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G88",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    // Only check complete documents — if there's no <html> root, we're
    // looking at a fragment and it's not meaningful to require a title.
    const htmlElements = findHtmlElementsByTag(doc, "html");
    if (htmlElements.length === 0) return;

    const titles = findHtmlElementsByTag(doc, "title");
    // Ignore <title> elements under <svg> or similar namespaces — those
    // are graphical titles, not document titles. For the HTML parser
    // we don't track namespace, so walk up the ancestor chain via tag
    // name heuristic: a document <title> is inside <head>.
    const docTitles = titles.filter((t) => isInsideHead(doc, t));

    // Fragment-shape detection (Q4-PARTIAL-PAGE-TITLED). SSG head-
    // partials (Jekyll `_includes/head.html`, Hugo `partials/head.html`,
    // Eleventy / Astro equivalents) open `<html>` + `<head>` but leave
    // `<body>` to the parent layout, and often inject `<title>` via a
    // template directive (`{% seo %}`, `{% include title.html %}`) that
    // static analysis cannot observe. Per docs/kb/architecture/
    // ai-first-consumer.md "Surface, don't suppress" and "No heuristic
    // suppression," we do NOT skip the finding — the fragment might
    // legitimately be missing a title generator — but we enrich the
    // emit with a structured `couldBeWrongBecause` code and a message
    // suffix so an agent reading the finding routes to the parent
    // layout (or applies the source-level disable pragma) in one read.
    // See docs/adr/0009-violation-could-be-wrong-because.md.
    const fragmentShape = findHtmlElementsByTag(doc, "body").length === 0;

    if (docTitles.length === 0) {
      const htmlEl = htmlElements[0];
      ctx.emit(
        buildEmit(
          doc,
          fragmentShape,
          htmlEl?.loc.start.line ?? 1,
          htmlEl?.loc.start.column ?? 1,
          MESSAGE_MISSING,
        ),
      );
      return;
    }

    for (const title of docTitles) {
      const text = htmlTextContent(title);
      if (text.length === 0) {
        ctx.emit(
          buildEmit(
            doc,
            fragmentShape,
            title.loc.start.line,
            title.loc.start.column,
            MESSAGE_EMPTY,
          ),
        );
      }
    }
  },
});

const MESSAGE_MISSING =
  "HTML document is missing a <title> element — browsers and screen readers have nothing to announce.";
const MESSAGE_EMPTY =
  "<title> is empty — screen readers will announce nothing when the page loads.";
const FRAGMENT_SUFFIX =
  " This file has no <body> so it may be a template partial whose <title> is template-injected" +
  " (e.g. Jekyll {% seo %} / Hugo partials / Eleventy includes) — verify against the parent layout before acting.";

/**
 * Builds the emit object shared between the missing-title and
 * empty-title branches. Splits the fragment-shape enrichment out of
 * the main `afterFile` body so the hot path stays under the cognitive-
 * complexity budget — both branches route through the same `ctx.emit`
 * shape, so duplicating the spread at each call site was both verbose
 * and lint-hostile.
 */
function buildEmit(
  doc: HtmlDocument,
  fragmentShape: boolean,
  line: number,
  column: number,
  baseMessage: string,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause?: readonly string[];
} {
  return {
    severity: "error",
    location: { filePath: "", line, column },
    message: fragmentShape ? `${baseMessage}${FRAGMENT_SUFFIX}` : baseMessage,
    suggestion: buildSuggestion(doc),
    ...(fragmentShape ? { couldBeWrongBecause: [TITLE_MAY_BE_TEMPLATE_INJECTED] } : {}),
  };
}

/**
 * Structured `couldBeWrongBecause` code emitted on fragment-shape
 * files (no `<body>`) where the `<title>` could be rendered by a
 * template directive the static scanner cannot observe. Per
 * docs/kb/architecture/ai-first-consumer.md §"No heuristic suppression,"
 * the scanner surfaces the finding with this signal rather than
 * silently skipping — the agent reading the file has categorically
 * stronger evidence than our tag-level heuristic.
 */
const TITLE_MAY_BE_TEMPLATE_INJECTED = "title_may_be_template_injected";

function isInsideHead(doc: HtmlDocument, target: { range: { start: number } }): boolean {
  // Heuristic: does any <head> element's range encompass the target's
  // start offset? In-house HTML parser doesn't track parent pointers,
  // so we use offset containment.
  const heads = findHtmlElementsByTag(doc, "head");
  if (heads.length === 0) return true; // No <head> — treat <title> as document title anyway.
  for (const head of heads) {
    if (head.range.start <= target.range.start && target.range.start <= head.range.end) {
      return true;
    }
  }
  return false;
}

/**
 * Context-aware fix text. Walks the current document for in-file signals
 * the author has already written — the page's own `<h1>` text and its
 * `<meta name="description">` — and folds them into the suggestion so the
 * agent sees a concrete title candidate rather than a generic "write
 * something specific" instruction. Cross-file inspection (sibling pages,
 * site-name detection) would violate the "rules are pure" invariant
 * (CLAUDE.md §3.6), so the ladder uses only signals reachable from
 * `ctx.ast`.
 *
 * Ladder (first match wins):
 *   1. `<h1>` text present — inline it as the candidate title (shortest,
 *      most specific signal the author has already written). When a
 *      meta description also exists, mention it as the longer fallback.
 *   2. `<meta name="description">` present but no `<h1>` — derive a
 *      title candidate from the description (truncated to ~60 chars at
 *      a word boundary, trailing punctuation trimmed).
 *   3. Neither — fallback guidance naming the ≤60 char length budget and
 *      the "differ from sibling pages" constraint.
 */
function buildSuggestion(doc: HtmlDocument): string {
  const h1Text = findFirstH1Text(doc);
  const metaDescription = findMetaDescription(doc);

  if (h1Text !== null) {
    const descNote =
      metaDescription === null
        ? ""
        : ` A longer candidate from <meta name="description"> (line ${metaDescription.line}) is also available as a fallback.`;
    return `Set <title>${h1Text.text}</title>. Candidate derived from the page's existing <h1> (line ${h1Text.line}). Append a site name if you have one, e.g. <title>${h1Text.text} — Acme</title>.${descNote}`;
  }

  if (metaDescription !== null) {
    const candidate = truncateForTitle(metaDescription.content);
    return `Set <title>${candidate}</title>. Candidate derived from <meta name="description" content="${metaDescription.content}"> (line ${metaDescription.line}); truncated to ~60 characters. Edit to a concise page-topic phrase and append a site name if you have one.`;
  }

  return "Set <title> to a concise (≤60 char) description of this page's primary purpose. A good title differs from sibling pages and does not duplicate the site name alone — e.g. <title>Contact — Acme</title>, not <title>Acme</title>.";
}

interface H1Text {
  readonly text: string;
  readonly line: number;
}

/** Returns the trimmed text + source line of the first non-empty `<h1>`. */
function findFirstH1Text(doc: HtmlDocument): H1Text | null {
  for (const h1 of findHtmlElementsByTag(doc, "h1")) {
    const text = htmlTextContent(h1);
    if (text.length === 0) continue;
    return { text, line: h1.loc.start.line };
  }
  return null;
}

interface MetaDescription {
  readonly content: string;
  readonly line: number;
}

/** Returns the trimmed `content` + source line of the first `<meta name="description">`. */
function findMetaDescription(doc: HtmlDocument): MetaDescription | null {
  for (const meta of findHtmlElementsByTag(doc, "meta")) {
    const name = getHtmlAttribute(meta, "name");
    if (name === null || name.toLowerCase() !== "description") continue;
    const content = getHtmlAttribute(meta, "content");
    if (content === null) continue;
    const trimmed = content.trim();
    if (trimmed.length === 0) continue;
    return { content: trimmed, line: meta.loc.start.line };
  }
  return null;
}

/**
 * Truncates a meta-description candidate to roughly 60 characters at
 * the nearest word boundary, then strips trailing punctuation (`.`,
 * `,`, `;`, `:`, `—`, `-`) so the candidate reads as a title rather
 * than a sentence fragment. Short descriptions pass through unchanged.
 */
function truncateForTitle(description: string): string {
  const MAX_LEN = 60;
  if (description.length <= MAX_LEN) return stripTrailingPunctuation(description);
  const window = description.slice(0, MAX_LEN);
  const lastSpace = window.lastIndexOf(" ");
  const truncated = lastSpace > 20 ? window.slice(0, lastSpace) : window;
  return stripTrailingPunctuation(truncated);
}

function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.,;:—\-\s]+$/, "");
}
