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
 * Flags four structural problems in heading order:
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
 *   4. A document containing more than one <h1> (variant:
 *      `multiple-h1`). The HTML living standard's outline algorithm was
 *      never implemented by browsers and assistive tech, so a single
 *      page-title <h1> remains the de-facto anchor screen-reader users
 *      navigate to with the "1" hotkey. Each extra <h1> is emitted
 *      individually so the agent can decide whether to demote each one
 *      to <h2> or wrap it in a <section> with its own outline scope.
 *      Keeps firing on fragments — multiple h1s in one fragment file
 *      compose into multiple h1s in the rendered page regardless of
 *      whether the parent layout supplies its own.
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
  isFragmentFile,
  looksLikeContentPartialPath,
  looksLikeFullPage,
} from "../../engine/layout-partial.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import { extension } from "../../utils/path.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * True when `filePath` is a markdown source file whose ATX / Setext
 * headings get stripped by `parseMarkdown` before the rule runs. The
 * `.md` / `.markdown` extensions mirror the EXTENSION_ALIASES entry in
 * `src/utils/path.ts` that routes them into the HTML-family rule gate;
 * `.mkdn` is included defensively so any future PARSEABLE_EXTENSIONS
 * widening (or third-party adapter routing through parseMarkdown) keeps
 * the rule's residue-aware framing intact.
 */
function isMarkdownSourceFile(filePath: string): boolean {
  const ext = extension(filePath);
  return ext === ".md" || ext === ".markdown" || ext === ".mkdn";
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
      'Heading levels should follow a logical hierarchy without skipping levels (e.g., h1 → h3); a full-page document without an <h1> should add one (or an equivalent role="heading" aria-level="1") so screen-reader users have a top-of-document landmark; and the document should contain exactly one <h1> page-title (browsers and AT ignore the HTML5 outline algorithm, so additional <h1>s expose as multiple top-level headings).',
    rationale:
      'Screen-reader users navigate by heading with the H key. A skipped level (h1 → h3) tells them "this is a sub-sub-section of something that doesn\'t exist", breaking their mental model of the page structure. A full page with no <h1> at all leaves the user with no top-of-document landmark to anchor on. Multiple <h1>s read as multiple page titles — the HTML5 outline algorithm that would have scoped them by <section> was never implemented by browsers or assistive tech, so VoiceOver / NVDA / JAWS expose every <h1> as a top-level heading regardless of nesting. SC 1.3.1 governs the structural relationship; SC 2.4.6 is satisfied by the page having headings whose presence and ordering convey topic — a page without any top-level heading, or with multiple competing top-level headings, fails both.',
    goodExample: `<h1>Page</h1>\n  <h2>Section</h2>\n    <h3>Detail</h3>`,
    badExample: `<h1>Page</h1>\n    <h3>Detail</h3>  <!-- skipped h2 -->\n<h1>Other</h1>  <!-- multiple <h1> -->`,
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
    // Markdown-residue enrichment (V1-HEADING-HIERARCHY-MARKDOWN-FIRES-DESPITE-HINT).
    // `.md` / `.markdown` / `.mkdn` files route through `parseMarkdown`,
    // which strips ATX (`# …`) and Setext headings before the residue
    // reaches `parseHtml` — see `src/input/parsers/markdown.ts` §"Passes"
    // and ADR 0025 which names heading hierarchy as an accepted residue
    // gap. The rule then sees only whatever HTML `<h1>`-`<h6>` tags
    // survived in embedded blocks (admonition divs, callout widgets,
    // etc.). The embedded headings really ARE part of the rendered
    // output — a `<div class="admonition"><h5>Note</h5></div>` ships to
    // every reader as a level-5 heading — so the predicate may still
    // hold and silent suppression is a real-violation miss waiting to
    // happen. But the rule's residue view is systematically *partial*:
    // a Jekyll doc whose top-level outline is ATX but whose only
    // embedded HTML is an admonition `<h5>` would emit "no <h1>, first
    // heading is <h5>" against a residue that omits the ATX outline.
    // The honest call (per docs/kb/architecture/ai-first-consumer.md
    // "surface, don't suppress" + "per-finding confidence must reflect
    // per-rule coverage limitations") is to surface AND enrich each
    // finding's reason text with a partial-document-view note pointing
    // the agent at the markdown source — the agent reading the whole
    // file is the correct arbiter of whether the rendered outline is
    // well-formed once the ATX headings come back.
    const markdownResidue = isMarkdownSourceFile(ctx.filePath);
    const doc = ctx.ast as HtmlDocument;
    const headings = collectHeadings(doc);

    // Fragment-file gate (Q7-FRAGMENT-FILE-HEADING-HIERARCHY).
    // Component-fragment files without root <html>/<body>/<head>,
    // content-fragment files with `---` front-matter, and partials under
    // `_includes/`, `_layouts/`, `_partials/`, `partials/`, `components/`
    // do not own the document envelope — the composed parent layout
    // supplies <h1>. The "Document has no <h1>" branch is suppressed
    // outright on these files; the skipped-level branch continues to
    // fire because a level skip is a real ordering bug regardless of
    // whether the envelope is supplied elsewhere. Per
    // docs/kb/architecture/ai-first-consumer.md, this suppression is
    // honest because fragment classification is structural evidence
    // (root-tag absence, front-matter delimiter, fragment-path
    // segment) — not a heuristic guess about composition. Pairs with
    // Q7-RULE-LANDMARK-MAIN-FRAGMENT-SCOPE which extends the same gate
    // to the landmark-main rule. The shared helper lives in
    // `src/engine/layout-partial.ts` so both rules consume the same
    // "is this file a fragment?" predicate.
    const fragment = isFragmentFile(doc, ctx.source, ctx.filePath);

    // Partial / layout enrichment (Q4-HEADING-HIERARCHY-PARTIAL-ENRICH-REASON).
    // For files that are NOT fragments but still look like partials (a
    // full-document layout opener with composition directives, a file
    // outside the conventional partial-path tree whose top-of-file is
    // a Liquid / ERB directive), the rule still surfaces the finding
    // and enriches the message with a structured `couldBeWrongBecause`
    // so the agent reads the composed layout in one pass. The
    // enrichment is the right shape for *partials* (where the rule
    // emits a "please verify" candidate); the `isFragmentFile` gate
    // above handles the stronger *fragment* case (where the rule
    // suppresses outright).
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
    // missing top-level heading. Fragment / partial files are skipped
    // because their composed page may supply <h1> from a parent layout.
    // When the variant fires, the legacy first-heading emit is
    // suppressed for the same file so we don't double-report.
    const hasH1 = headings.some((h) => h.level === 1);
    if (!(hasH1 || fragment)) {
      const fullPageMissingH1 = !partialShape && isFullPageBody(doc);
      if (fullPageMissingH1) {
        reportMissingH1OnFullPage(doc, headings, markdownResidue, (v) => ctx.emit(v));
      } else if (headings.length > 0) {
        reportMissingH1(headings, partialShape, markdownResidue, (v) => ctx.emit(v));
      }
    }

    if (headings.length > 0) {
      reportSkippedLevels(headings, partialShape, markdownResidue, (v) => ctx.emit(v));
    }

    // Variant: multiple-h1. Emits one finding per extra <h1> beyond the
    // first one. The HTML5 outline algorithm that would have scoped each
    // <h1> by its containing <section> was never implemented by browsers
    // or AT — VoiceOver, NVDA, JAWS still treat every <h1> in the
    // document as a top-level heading. A user pressing "1" lands on
    // each, and the page outline reads as "two top-level topics" when
    // the author meant "this is the page" + "this is a sub-region".
    // Keeps firing on fragments because the composed page inherits the
    // duplicate; the partial enrichment still applies because a partial
    // may legitimately render its <h1> down to <h2> via composition.
    reportMultipleH1(headings, partialShape, markdownResidue, (v) => ctx.emit(v));
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
const MARKDOWN_RESIDUE_CODE = "markdown_atx_headings_stripped_only_html_residue_visible";
const MARKDOWN_RESIDUE_NOTE_SUFFIX =
  " Note: this file is markdown source (.md/.markdown/.mkdn). Markdown ATX-syntax headings (e.g. `# Title`) and Setext underlines were stripped by the markdown adapter before this rule ran, so the rule sees only whatever <h1>-<h6> tags survived in embedded HTML blocks (admonition divs, callout widgets). The rendered document outline may be well-formed once the ATX headings come back — read the markdown source itself to verify, or add a source-level disable pragma if the embedded heading is intentional.";

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
  markdownResidue: boolean,
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
  const baseMessage = `Page contains no <h1> heading; the document outline lacks a top-level title for screen reader users.${headingHint}`;
  emit({
    severity: "warning",
    location: { filePath: "", line, column },
    message: markdownResidue ? `${baseMessage}${MARKDOWN_RESIDUE_NOTE_SUFFIX}` : baseMessage,
    suggestion: first
      ? `Insert an <h1> at the top of <body> that names the page, or change the existing <${first.element.tagName}> at line ${first.element.loc.start.line} to <h1> if it serves as the page title. Screen readers expose <h1> as the document's primary landmark; without one, the user has no anchor for "what is this page about".`
      : 'Insert an <h1> at the top of <body> that names the page. Screen readers expose <h1> as the document\'s primary landmark; without one, the user has no anchor for "what is this page about". If this page is rendered inside a parent layout that supplies the title, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.',
    variantKey: "missing-h1-on-full-page",
    ...(markdownResidue ? { couldBeWrongBecause: [MARKDOWN_RESIDUE_CODE] } : {}),
  });
}

function reportMissingH1(
  headings: readonly HeadingEntry[],
  partialShape: boolean,
  markdownResidue: boolean,
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
    message: composeMessage(baseMessage, partialShape, markdownResidue),
    suggestion:
      'A document without an <h1> loses the single top-of-document landmark AT relies on; verify the page has a designated main heading via <h1> or role="heading" aria-level="1". If this page is a fragment or layout intentionally rendered inside a parent with its own <h1>, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.',
    ...wrongBecause(partialShape, markdownResidue),
  });
}

function reportSkippedLevels(
  headings: readonly HeadingEntry[],
  partialShape: boolean,
  markdownResidue: boolean,
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
        message: composeMessage(baseMessage, partialShape, markdownResidue),
        suggestion: `Change this to <h${previous.level + 1}> so the hierarchy is continuous, or add intermediate headings between the previous <h${previous.level}> (line ${previousLine}) and this one.`,
        ...wrongBecause(partialShape, markdownResidue),
      });
    }
    previous = current;
  }
}

/**
 * Emits one finding per extra `<h1>` beyond the first. Anchored at each
 * extra `<h1>`'s own location so the agent can act on each instance
 * independently (some pages legitimately have a primary `<h1>` and a
 * sibling `<h1>` that should be demoted to `<h2>`; others have two
 * `<h1>`s where one should be wrapped in `<section>` to scope a new
 * outline). Variant key `multiple-h1` keeps the emit distinct from the
 * skipped-level branch's stamp so suppression pragmas can target
 * individual instances.
 */
function reportMultipleH1(
  headings: readonly HeadingEntry[],
  partialShape: boolean,
  markdownResidue: boolean,
  emit: Emit,
): void {
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length <= 1) return;
  const first = h1s[0];
  if (!first) return;
  const firstLine = first.element.loc.start.line;
  for (let i = 1; i < h1s.length; i += 1) {
    const extra = h1s[i];
    if (!extra) continue;
    const baseMessage = `Document has ${h1s.length} <h1> elements; expected exactly 1 page-title <h1>. The first <h1> is at line ${firstLine}; this is extra <h1> #${i + 1}. Subsequent h1s likely should be <h2> or sectioned with <section> to scope a new outline.`;
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: extra.element.loc.start.line,
        column: extra.element.loc.start.column,
      },
      message: composeMessage(baseMessage, partialShape, markdownResidue),
      suggestion: `Change this <h1> to <h2> if it names a section under the page-title <h1> at line ${firstLine}, or wrap it in a <section> element to scope a new outline. Browsers and assistive tech ignore the HTML5 outline algorithm — every <h1> is exposed as a top-level heading regardless of nesting, so multiple <h1>s read to a screen reader user as multiple page titles.`,
      variantKey: "multiple-h1",
      ...wrongBecause(partialShape, markdownResidue),
    });
  }
}

/**
 * Appends partial-or-layout and/or markdown-residue notes to the base
 * emit message. Both can apply (e.g. a `_docs/intro.md` that is BOTH
 * under a partial path AND a markdown source) — the notes stack so the
 * agent reads both signals.
 */
function composeMessage(base: string, partialShape: boolean, markdownResidue: boolean): string {
  let out = base;
  if (partialShape) out += PARTIAL_NOTE_SUFFIX;
  if (markdownResidue) out += MARKDOWN_RESIDUE_NOTE_SUFFIX;
  return out;
}

/**
 * Builds the `couldBeWrongBecause` payload, conditional-spread style.
 * Returns an empty object when neither flag applies so the field stays
 * omitted (per CLAUDE.md §1 "Ambiguous field shapes are dishonest" —
 * empty arrays are sentinel-empty, omission is honest).
 */
function wrongBecause(
  partialShape: boolean,
  markdownResidue: boolean,
): { couldBeWrongBecause?: readonly string[] } {
  const codes: string[] = [];
  if (partialShape) codes.push(PARTIAL_OR_LAYOUT_CODE);
  if (markdownResidue) codes.push(MARKDOWN_RESIDUE_CODE);
  return codes.length > 0 ? { couldBeWrongBecause: codes } : {};
}
