/**
 * Rule: semantics/heading-hierarchy
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags two structural problems in heading order:
 *   1. A document with no <h1>.
 *   2. A heading that skips a level (e.g., <h1> followed directly by
 *      <h3>, or <h2> followed by <h4>).
 *
 * Heading hierarchy is how screen-reader users navigate a page — the
 * virtual cursor jumps between headings with a shortcut key, and
 * skipped levels break the mental model of "this is a subsection of
 * that". SC 1.3.1 does not mandate an <h1>, but a document without
 * one loses the single top-of-document landmark AT relies on; authors
 * should verify the page has a designated main heading (via <h1> or
 * an equivalent role="heading" aria-level="1").
 *
 * Document-scoped. Works on HTML (not JSX — JSX heading detection is
 * handled by the upcoming semantics/headings-non-empty rule because
 * the checks overlap and share a JSX walker).
 */

import { defineRule } from "../../api/plugin.ts";
import { walkHtmlElements } from "../../engine/ast-helpers.ts";
import {
  hasLeadingTemplateDirective,
  looksLikeContentPartialPath,
} from "../../engine/layout-partial.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const rule = defineRule({
  id: "semantics/heading-hierarchy",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm"],
  },
  docs: {
    description:
      'Heading levels should follow a logical hierarchy without skipping levels (e.g., h1 → h3); a document without an <h1> should have a designated main heading via <h1> or role="heading" aria-level="1".',
    rationale:
      'Screen-reader users navigate by heading with the H key. A skipped level (h1 → h3) tells them "this is a sub-sub-section of something that doesn\'t exist", breaking their mental model of the page structure. SC 1.3.1 does not mandate an <h1>, but a document without one loses the single top-of-document landmark AT relies on; verify the page has a designated main heading via <h1> or role="heading" aria-level="1".',
    goodExample: `<h1>Page</h1>\n  <h2>Section</h2>\n    <h3>Detail</h3>`,
    badExample: `<h1>Page</h1>\n    <h3>Detail</h3>  <!-- skipped h2 -->`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/tutorials/page-structure/headings/",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "html") return;
    const doc = ctx.ast as HtmlDocument;
    const headings = collectHeadings(doc);
    if (headings.length === 0) return;

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

    reportMissingH1(headings, partialShape, (v) => ctx.emit(v));
    reportSkippedLevels(headings, partialShape, (v) => ctx.emit(v));
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

const PARTIAL_OR_LAYOUT_CODE = "partial_or_layout_file_requires_composed_check";
const PARTIAL_NOTE_SUFFIX =
  " Note: this file looks like a partial / layout (path under _docs/_includes/_layouts/_posts/_partials, or starts with a Liquid / ERB template directive) — the composed page's heading hierarchy depends on the parent layout. Verify the rendered page has <h1> before acting, or add a source-level disable pragma if the composition is intentional.";

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
