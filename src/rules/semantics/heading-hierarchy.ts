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

    reportMissingH1(headings, (v) => ctx.emit(v));
    reportSkippedLevels(headings, (v) => ctx.emit(v));
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
}) => void;

function reportMissingH1(headings: readonly HeadingEntry[], emit: Emit): void {
  if (headings.some((h) => h.level === 1)) return;
  const first = headings[0];
  if (!first) return;
  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: first.element.loc.start.line,
      column: first.element.loc.start.column,
    },
    message: `Document has no <h1>. The first heading is <${first.element.tagName}> at line ${first.element.loc.start.line}.`,
    suggestion:
      'A document without an <h1> loses the single top-of-document landmark AT relies on; verify the page has a designated main heading via <h1> or role="heading" aria-level="1". If this page is a fragment or layout intentionally rendered inside a parent with its own <h1>, suppress with <!-- ra11y-disable wcag22:1.3.1 -->.',
  });
}

function reportSkippedLevels(headings: readonly HeadingEntry[], emit: Emit): void {
  let previous: HeadingEntry | undefined = headings[0];
  for (let i = 1; i < headings.length; i += 1) {
    const current = headings[i];
    if (!current) continue;
    // Going deeper is only allowed by +1 at a time. Going shallower
    // (to a lower number) is always fine — you can jump from h3 back
    // to h2 or h1.
    if (previous && current.level > previous.level + 1) {
      const previousLine = previous.element.loc.start.line;
      emit({
        severity: "warning",
        location: {
          filePath: "",
          line: current.element.loc.start.line,
          column: current.element.loc.start.column,
        },
        // Inline the previous heading's line so an agent can verify
        // intent without re-walking the file.
        message: `Heading level skipped: previous was <h${previous.level}> at line ${previousLine}, this is <${current.element.tagName}>. Skipped ${current.level - previous.level - 1} level(s).`,
        suggestion: `Change this to <h${previous.level + 1}> so the hierarchy is continuous, or add intermediate headings between the previous <h${previous.level}> (line ${previousLine}) and this one.`,
      });
    }
    previous = current;
  }
}
