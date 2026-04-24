/**
 * Rule: semantics/heading-hierarchy
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:2.4.6, wcag21:2.4.6
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text. (1.3.1)
 *
 * > Headings and labels describe topic or purpose. (2.4.6)
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *         https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * Flags three structural problems in heading order:
 *   1. A full-page document with no <h1> at all (variant:
 *      `missing-h1-on-full-page`). Anchored at the <body> line so the
 *      finding sits at the natural insertion point for an h1, rather
 *      than at an unrelated h2/h3 that happens to be the first heading
 *      in the file. Fires only when `looksLikeFullPage` is true — a
 *      bare component fragment (alt-text snippet, attribute-rule
 *      fixture, email template) has nothing to anchor a top-level
 *      heading to and doesn't deserve the warning.
 *   2. A document that contains other headings (h2+) but no <h1>, and
 *      doesn't reach the full-page bar — anchored at the first
 *      heading. Catches the partial-page / fragment case where the
 *      author wrote `<h2>Section</h2>` without a parent layout
 *      supplying the page title.
 *   3. A heading that skips a level (e.g., <h1> followed directly by
 *      <h3>, or <h2> followed by <h4>).
 *
 * Heading hierarchy is how screen-reader users navigate a page — the
 * virtual cursor jumps between headings with a shortcut key, and
 * skipped levels break the mental model of "this is a subsection of
 * that". A page with no <h1> at all leaves the user with no
 * top-of-document landmark to anchor on. SC 1.3.1 governs the
 * structural relationship; SC 2.4.6 is satisfied by the page having
 * headings whose presence and ordering convey topic — a page without
 * any top-level heading fails both.
 *
 * Document-scoped. Works on HTML (not JSX — JSX heading detection is
 * handled by the upcoming semantics/headings-non-empty rule because
 * the checks overlap and share a JSX walker).
 */

import { defineRule } from "../../api/plugin.ts";
import { findHtmlElementsByTag, walkHtmlElements } from "../../engine/ast-helpers.ts";
import {
  hasLeadingTemplateDirective,
  looksLikeContentPartialPath,
  looksLikeFullPage,
} from "../../engine/layout-partial.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import { extension } from "../../utils/path.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * True when `filePath` is a markdown source file whose ATX / Setext
 * headings get stripped by `parseMarkdown` before the rule runs. The
 * extension list mirrors the EXTENSION_ALIASES entry in
 * `src/utils/path.ts` that routes `.md` / `.markdown` into the
 * HTML-family rule gate.
 */
function isMarkdownSourceFile(filePath: string): boolean {
  const ext = extension(filePath);
  return ext === ".md" || ext === ".markdown";
}

export const rule = defineRule({
  id: "semantics/heading-hierarchy",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:2.4.6", "wcag21:2.4.6"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      'Heading levels should follow a logical hierarchy without skipping levels (e.g., h1 → h3); a full-page document without an <h1> should add one (or an equivalent role="heading" aria-level="1") so screen-reader users have a top-of-document landmark.',
    rationale:
      'Screen-reader users navigate by heading with the H key. A skipped level (h1 → h3) tells them "this is a sub-sub-section of something that doesn\'t exist", breaking their mental model of the page structure. A full page with no <h1> at all leaves the user with no top-of-document landmark to anchor on. SC 1.3.1 governs the structural relationship; SC 2.4.6 is satisfied by the page having headings whose presence and ordering convey topic — a page without any top-level heading fails both.',
    goodExample: `<h1>Page</h1>\n  <h2>Section</h2>\n    <h3>Detail</h3>`,
    badExample: `<h1>Page</h1>\n    <h3>Detail</h3>  <!-- skipped h2 -->`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text. Headings and labels describe topic or purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#headings-and-labels",
      "https://www.w3.org/WAI/tutorials/page-structure/headings/",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    // Markdown ingestion gap (V1-HEADING-HIERARCHY-MARKDOWN-SELF-CONTRADICTION).
    // `.md` / `.markdown` files route through `parseMarkdown`, which
    // strips ATX (`# …`) and Setext headings before the residue reaches
    // `parseHtml` — see `src/input/parsers/markdown.ts` §"Passes" and
    // ADR 0025 which names heading hierarchy as an accepted residue gap.
    // The rule then only sees whatever HTML `<h1>`-`<h6>` tags survived
    // in embedded blocks (admonition divs, callout widgets, etc.),
    // which is systematically a *partial* view of the file's real
    // outline: a README whose sole heading is `# Bootstrap` presents to
    // this rule as zero headings, and a Jekyll doc whose top-level
    // outline is ATX but whose only embedded HTML is an admonition
    // `<h5>` presents as "no <h1>, first heading is <h5>". Emitting
    // against that residue contradicts the scanner's own
    // `analysisCoverage` hint ("Markdown files parsed as HTML residue:
    // … heading hierarchy … [is] not [checked]"). Skip on `.md` /
    // `.markdown` so the rule's behavior matches what we tell agents.
    if (isMarkdownSourceFile(ctx.filePath)) return;
    const doc = ctx.ast as HtmlDocument;
    const headings = collectHeadings(doc);

    // Partial / layout enrichment (Q4-HEADING-HIERARCHY-PARTIAL-ENRICH-REASON).
    // Jekyll `_docs/*.md`, `_includes/*.html`, Hugo partials and
    // Eleventy includes routinely begin a heading sequence at <h5> or
    // similar deep level — the composed page's <h1> is supplied by the
    // parent layout via `page.title` front-matter or template
    // injection. The scanner cannot see the composed DOM, so a confident
    // "no <h1>" / "skipped level" emit on these files reads as a false
    // positive in the field. Per docs/kb/architecture/ai-first-consumer.md
    // §"Surface, don't suppress" the candidate stays in the primary
    // list; the enrichment only annotates the message + adds a
    // structured `couldBeWrongBecause` code so the agent reads the
    // composed layout (or applies a source-level disable) in one pass.
    // Pairs with Q4-PARTIAL-PAGE-TITLED on `document/page-titled` and
    // the `partial_or_layout_file_requires_composed_check` shape on
    // `semantics/landmark-main`.
    const partialShape = looksLikePartialFile(ctx.filePath, ctx.source);

    // Variant: missing-h1-on-full-page (Q3-HEADING-HIERARCHY-MISSING-H1-VARIANT).
    // Bootstrap visual-test pages, 50projects50days demos, and similar
    // hand-authored hobby pages routinely ship with full-page DOCTYPE +
    // <html> + <body> shape but zero <h1> — the level-skip check above
    // is silent because there's no skip when there are no headings, and
    // the missing-h1 emit on `headings[0]` is silent because there's no
    // heading to anchor at. The variant fills that gap: when the body
    // looks like a real page (`looksLikeFullPage`) and has no <h1>, we
    // anchor at the <body> tag — the natural insertion point for the
    // missing top-level heading. Partial files are skipped because their
    // composed page may supply <h1> from a parent layout (same rationale
    // as the `partialShape` enrichment above; for the variant, it's a
    // hard skip rather than an enrichment because the variant's whole
    // point is "full pages should have an h1" and partials aren't full
    // pages). When the variant fires, the legacy first-heading emit is
    // suppressed for the same file so we don't double-report.
    const hasH1 = headings.some((h) => h.level === 1);
    const fullPageMissingH1 = !(hasH1 || partialShape) && isFullPageBody(doc);
    if (fullPageMissingH1) {
      reportMissingH1OnFullPage(doc, headings, (v) => ctx.emit(v));
    } else if (headings.length > 0) {
      reportMissingH1(headings, partialShape, (v) => ctx.emit(v));
    }

    if (headings.length > 0) {
      reportSkippedLevels(headings, partialShape, (v) => ctx.emit(v));
    }
  },
});

interface HeadingEntry {
  readonly element: HtmlElement;
  readonly level: number;
}

function collectHeadings(doc: HtmlDocument): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  for (const el of walkHtmlElements(doc)) {
    const lowered = el.tagName.toLowerCase();
    if (!HEADING_TAGS.has(lowered)) continue;
    const level = Number.parseInt(lowered.slice(1), 10);
    if (Number.isFinite(level)) out.push({ element: el, level });
  }
  return out;
}

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause?: readonly string[];
  variantKey?: string;
}) => void;

/**
 * True when the file reads as a content partial or layout fragment
 * whose composed `<h1>` is supplied by a parent template — either the
 * file's path lives under a known SSG partial directory (`_docs/`,
 * `_includes/`, `_layouts/`, `_posts/`, `_partials/`) OR the file's
 * first non-whitespace token is a Liquid / Jinja / ERB template
 * directive (`{% include %}`, `{{ page.title }}`, `<%= yield %>`).
 *
 * Path check fires even when the file's source is plain HTML residue
 * with no template directives — Jekyll `_docs/intro.md` typically
 * embeds raw `<h5>` for a sub-section heading, with no `{% … %}` tag
 * anywhere visible to static analysis. The leading-directive check
 * covers files outside the conventional path tree (e.g. a sibling
 * `header.html` next to other full pages) whose top-of-file directive
 * still signals partial composition.
 */
function looksLikePartialFile(filePath: string, source: string): boolean {
  if (looksLikeContentPartialPath(filePath)) return true;
  if (hasLeadingTemplateDirective(source)) return true;
  return false;
}

/**
 * True when the document carries a `<body>` whose shape clears the
 * `looksLikeFullPage` bar (the same predicate `semantics/landmark-main`
 * uses to decide whether to expect a `<main>` landmark). Bodyless
 * documents and minimal fragments return false — we don't expect them
 * to carry a top-level heading.
 */
function isFullPageBody(doc: HtmlDocument): boolean {
  const bodies = findHtmlElementsByTag(doc, "body");
  const body = bodies[0];
  if (!body) return false;
  return looksLikeFullPage(body, doc);
}

const PARTIAL_OR_LAYOUT_CODE = "partial_or_layout_file_requires_composed_check";
const PARTIAL_NOTE_SUFFIX =
  " Note: this file looks like a partial / layout (path under _docs/_includes/_layouts/_posts/_partials, or starts with a Liquid / ERB template directive) — the composed page's heading hierarchy depends on the parent layout. Verify the rendered page has <h1> before acting, or add a source-level disable pragma if the composition is intentional.";

/**
 * Emits the `missing-h1-on-full-page` variant. Anchored at the `<body>`
 * tag — the natural insertion point for the missing top-level heading.
 * When the file has other headings (h2+), the message inlines the first
 * one so the agent can decide whether to promote it to <h1> or insert
 * a new <h1> above it. When the file has no headings at all, the
 * message simply states the gap.
 */
function reportMissingH1OnFullPage(
  doc: HtmlDocument,
  headings: readonly HeadingEntry[],
  emit: Emit,
): void {
  const body = findHtmlElementsByTag(doc, "body")[0];
  // Caller has already confirmed isFullPageBody(doc), so body is
  // guaranteed present — fall back to 1:1 defensively.
  const line = body?.loc.start.line ?? 1;
  const column = body?.loc.start.column ?? 1;
  const first = headings[0];
  const headingHint = first
    ? ` The first heading in the document is <${first.element.tagName}> at line ${first.element.loc.start.line} — promote it to <h1> if it names the page, or insert a new <h1> above it.`
    : " The document has no headings at all; add an <h1> that names the page.";
  emit({
    severity: "warning",
    location: { filePath: "", line, column },
    message: `Page contains no <h1> heading; the document outline lacks a top-level title for screen reader users.${headingHint}`,
    suggestion: first
      ? `Insert an <h1> at the top of <body> that names the page, or change the existing <${first.element.tagName}> at line ${first.element.loc.start.line} to <h1> if it serves as the page title. Screen readers expose <h1> as the document's primary landmark; without one, the user has no anchor for "what is this page about".`
      : 'Insert an <h1> at the top of <body> that names the page. Screen readers expose <h1> as the document\'s primary landmark; without one, the user has no anchor for "what is this page about". If this page is rendered inside a parent layout that supplies the title, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.',
    variantKey: "missing-h1-on-full-page",
  });
}

function reportMissingH1(
  headings: readonly HeadingEntry[],
  partialShape: boolean,
  emit: Emit,
): void {
  if (headings.some((h) => h.level === 1)) return;
  const first = headings[0];
  if (!first) return;
  const baseMessage = `Document has no <h1>. The first heading is <${first.element.tagName}> at line ${first.element.loc.start.line}.`;
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: first.element.loc.start.line,
      column: first.element.loc.start.column,
    },
    message: partialShape ? `${baseMessage}${PARTIAL_NOTE_SUFFIX}` : baseMessage,
    suggestion:
      'A document without an <h1> loses the single top-of-document landmark AT relies on; verify the page has a designated main heading via <h1> or role="heading" aria-level="1". If this page is a fragment or layout intentionally rendered inside a parent with its own <h1>, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.',
    ...(partialShape ? { couldBeWrongBecause: [PARTIAL_OR_LAYOUT_CODE] } : {}),
  });
}

function reportSkippedLevels(
  headings: readonly HeadingEntry[],
  partialShape: boolean,
  emit: Emit,
): void {
  let previous: HeadingEntry | undefined = headings[0];
  for (let i = 1; i < headings.length; i += 1) {
    const current = headings[i];
    if (!current) continue;
    // Going deeper is only allowed by +1 at a time. Going shallower
    // (to a lower number) is always fine — you can jump from h3 back
    // to h2 or h1.
    if (previous && current.level > previous.level + 1) {
      const previousLine = previous.element.loc.start.line;
      const baseMessage = `Heading level skipped: previous was <h${previous.level}> at line ${previousLine}, this is <${current.element.tagName}>. Skipped ${current.level - previous.level - 1} level(s).`;
      emit({
        severity: "warning",
        location: {
          filePath: "",
          line: current.element.loc.start.line,
          column: current.element.loc.start.column,
        },
        // Inline the previous heading's line so an agent can verify
        // intent without re-walking the file.
        message: partialShape ? `${baseMessage}${PARTIAL_NOTE_SUFFIX}` : baseMessage,
        suggestion: `Change this to <h${previous.level + 1}> so the hierarchy is continuous, or add intermediate headings between the previous <h${previous.level}> (line ${previousLine}) and this one.`,
        ...(partialShape ? { couldBeWrongBecause: [PARTIAL_OR_LAYOUT_CODE] } : {}),
      });
    }
    previous = current;
  }
}
