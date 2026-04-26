/**
 * Rule: semantics/empty-heading
 * Satisfies: wcag22:2.4.6, wcag21:2.4.6
 * Spec: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * > Headings and labels describe topic or purpose.
 *
 * Source: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * Flags <h1>-<h6> elements that are empty, contain only whitespace,
 * or contain only non-text children (e.g., an <svg> or <img> without
 * alt text). An empty heading is invisible to screen-reader navigation
 * shortcuts and degrades the heading outline.
 *
 * Complements semantics/heading-hierarchy (which checks order, not content).
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import {
  htmlElementOnlyChildIsTemplateDirective,
  htmlSubtreeHasStrippedDirective,
  TEMPLATE_DIRECTIVE_STRIPPED_SUFFIX,
} from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const rule = defineRule({
  id: "semantics/empty-heading",
  satisfies: ["wcag22:2.4.6", "wcag21:2.4.6"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Heading elements (<h1>-<h6>) must have text content. Empty or whitespace-only headings are invisible to assistive technology.",
    rationale:
      "Screen-reader users navigate pages by jumping between headings. An empty heading appears in the heading outline as a blank entry, providing no context and disrupting navigation flow.",
    goodExample: `<h2>Contact Information</h2>`,
    badExample: `<h2></h2>\n<h2>   </h2>\n<h2><svg aria-hidden="true"></svg></h2>`,
    normativeQuote: "Headings and labels describe topic or purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#headings-and-labels",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G130",
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

/**
 * A heading observed in document order. `text` is the trimmed text
 * content (empty string for the offending headings the rule flags).
 * `level` is parsed from the tag so the fix builder can compare
 * level deltas without re-parsing.
 */
interface HeadingEntry {
  readonly tagName: string;
  readonly level: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const headings = collectHtmlHeadings(doc);
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading === undefined) continue;
    const el = findHtmlHeadingAt(doc, heading);
    if (el === null) continue;
    if (hasAccessibleContentHtml(el)) continue;
    // Predicate-axis closure: when the heading's only child is a
    // stripped template directive (`<h1>{{ page.title }}</h1>`), the
    // static scanner has no evidence the rendered text is empty — the
    // binding might resolve to a non-empty string. The rule must not
    // assert "empty" as a violation. The review/headings-and-labels
    // finder picks up the same shape at confidence "low" with reason
    // text framing the binding-resolves question; suppressing here
    // avoids double-surfacing while keeping the location visible to
    // the agent through the manual-review surface.
    if (htmlElementOnlyChildIsTemplateDirective(el)) continue;
    const preceding = findPrecedingNonEmpty(headings, i);
    // Mixed-content fallback: when a stripped directive sits alongside
    // other empty/whitespace nodes (predicate above caught the
    // canonical case) or in any other shape that survived
    // `hasAccessibleContentHtml`, the finding still emits — reason
    // text carries the template_directive_stripped signal so the
    // agent routes to "verify rendered output" in one read.
    const templateStripped = htmlSubtreeHasStrippedDirective(el);
    emitViolation(heading, preceding, templateStripped, emit);
  }
}

/**
 * Walks the HTML document once in document order and records every
 * heading's tag, level, location, and trimmed text. The entries feed
 * the fix builder so the suggestion can reference the section the
 * empty heading appears under — the rule's detection logic is
 * unchanged.
 */
function collectHtmlHeadings(doc: HtmlDocument): readonly HeadingEntry[] {
  const out: HeadingEntry[] = [];
  for (const el of walkHtmlElements(doc)) {
    const lowered = el.tagName.toLowerCase();
    if (!HEADING_TAGS.has(lowered)) continue;
    const level = Number.parseInt(lowered.slice(1), 10);
    if (!Number.isFinite(level)) continue;
    out.push({
      tagName: lowered,
      level,
      line: el.loc.start.line,
      column: el.loc.start.column,
      text: htmlTextContent(el),
    });
  }
  return out;
}

function findHtmlHeadingAt(doc: HtmlDocument, entry: HeadingEntry): HtmlElement | null {
  for (const el of walkHtmlElements(doc)) {
    if (
      el.tagName.toLowerCase() === entry.tagName &&
      el.loc.start.line === entry.line &&
      el.loc.start.column === entry.column
    ) {
      return el;
    }
  }
  return null;
}

function hasAccessibleContentHtml(element: HtmlElement): boolean {
  // Direct text content
  if (htmlTextContent(element).length > 0) return true;
  // aria-label provides an accessible name
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  // aria-labelledby references an external label
  if (hasHtmlAttribute(element, "aria-labelledby")) return true;
  // Check for child <img> with alt text
  if (hasChildImageWithAltHtml(element)) return true;
  return false;
}

function hasChildImageWithAltHtml(element: HtmlElement): boolean {
  for (const child of element.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() === "img") {
      const alt = getHtmlAttribute(child, "alt");
      if (alt !== null && alt.trim().length > 0) return true;
    }
    // Recurse into nested elements
    if (hasChildImageWithAltHtml(child)) return true;
  }
  return false;
}

function checkJsx(module: TsxModule, emit: Emit): void {
  const headings = collectJsxHeadings(module);
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (heading === undefined) continue;
    const el = findJsxHeadingAt(module, heading);
    if (el === null) continue;
    if (hasAccessibleContentJsx(el)) continue;
    if (el.hasSpreadProps) {
      emitPrimitiveViolation(heading.tagName, heading.line, heading.column, emit);
      continue;
    }
    const preceding = findPrecedingNonEmpty(headings, i);
    // JSX branch: expression-child guard in `hasAccessibleContentJsx`
    // already exempts `<h1>{label}</h1>`, so no template-stripped
    // enrichment is needed on this path.
    emitViolation(heading, preceding, false, emit);
  }
}

function collectJsxHeadings(module: TsxModule): readonly HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  for (const el of walkJsxElements(module)) {
    if (!HEADING_TAGS.has(el.tagName)) continue;
    const level = Number.parseInt(el.tagName.slice(1), 10);
    if (!Number.isFinite(level)) continue;
    entries.push({
      tagName: el.tagName,
      level,
      line: el.loc.start.line,
      column: el.loc.start.column,
      text: jsxTextContent(el),
    });
  }
  // Sort by source position so "preceding heading" is computed in
  // document order (walkJsxElements yields outer-first / children
  // after, which isn't document order for nested JSX).
  entries.sort((a, b) => a.line - b.line || a.column - b.column);
  return entries;
}

function findJsxHeadingAt(module: TsxModule, entry: HeadingEntry): JsxElement | null {
  for (const el of walkJsxElements(module)) {
    if (
      el.tagName === entry.tagName &&
      el.loc.start.line === entry.line &&
      el.loc.start.column === entry.column
    ) {
      return el;
    }
  }
  return null;
}

function hasAccessibleContentJsx(element: JsxElement): boolean {
  // Direct text content
  if (jsxTextContent(element).length > 0) return true;
  // aria-label provides an accessible name
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  // aria-labelledby references an external label
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  // Runtime expression children — assume developer is computing content
  if (hasExpressionChild(element)) return true;
  // Check for child <img> with alt text
  if (hasChildImageWithAltJsx(element)) return true;
  return false;
}

function hasExpressionChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind === "JsxExpression") return true;
  }
  return false;
}

function hasChildImageWithAltJsx(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName === "img") {
      const alt = getJsxAttributeString(child, "alt");
      if (alt !== null && alt.trim().length > 0) return true;
    }
    // PascalCase components might render accessible content
    if (/^[A-Z]/.test(child.tagName)) return true;
    if (hasChildImageWithAltJsx(child)) return true;
  }
  return false;
}

/**
 * Walks backwards from index `i` and returns the nearest preceding
 * heading that actually carries text. Anchors the fix text in the
 * document's surrounding outline — "Empty <h3> follows <h2>Contact
 * Information</h2>" rather than the generic "Add descriptive text"
 * that the previous builder emitted. Returns `null` when no such
 * heading exists (empty heading at the top of the document).
 */
function findPrecedingNonEmpty(headings: readonly HeadingEntry[], i: number): HeadingEntry | null {
  for (let j = i - 1; j >= 0; j--) {
    const prev = headings[j];
    if (prev !== undefined && prev.text.length > 0) return prev;
  }
  return null;
}

function emitViolation(
  entry: HeadingEntry,
  preceding: HeadingEntry | null,
  templateStripped: boolean,
  emit: Emit,
): void {
  const base = `<${entry.tagName}> is empty — it appears in the heading outline but describes no topic or purpose.`;
  emit({
    severity: "error",
    location: { filePath: "", line: entry.line, column: entry.column },
    message: templateStripped ? `${base}${TEMPLATE_DIRECTIVE_STRIPPED_SUFFIX}` : base,
    suggestion: buildEmptyHeadingSuggestion(entry, preceding),
  });
}

/**
 * Four-branch ladder that inlines the document's actual surrounding
 * heading outline into the fix text:
 *
 * 1. Preceding heading one level higher (`<h2>` before `<h3>`) —
 *    canonical "continue the hierarchy" case. Names the parent
 *    heading's text so the agent can pick a sibling title.
 * 2. Preceding heading at the same level — sibling branch. Suggests
 *    the next section's title or removal.
 * 3. Preceding heading at any other level (lower, or a skip) —
 *    flags the hierarchy irregularity alongside the fill/remove
 *    choice so the agent knows to check `semantics/heading-hierarchy`.
 * 4. No preceding heading — top-of-document fallback. Names the
 *    screen-reader navigation gap an empty heading creates and
 *    retains the styled-`<p>`/`<div>` alternative.
 *
 * The final clause of every branch retains the "or remove the
 * heading" option so the spec-anchored remediation (add content or
 * stop being a heading) is always one of the two paths.
 */
function buildEmptyHeadingSuggestion(entry: HeadingEntry, preceding: HeadingEntry | null): string {
  const tag = `<${entry.tagName}>`;
  if (preceding === null) {
    return `Empty ${tag} at start of document — fill with the page's primary section title or remove the heading; screen readers announce heading levels, so an empty heading creates a navigation gap. If the heading is used for visual styling only, replace it with a styled <p> or <div>.`;
  }
  const prevTag = `<${preceding.tagName}>`;
  const prevText = truncate(preceding.text, 80);
  const prevSnippet = `${prevTag}${prevText}</${preceding.tagName}>`;
  if (preceding.level === entry.level - 1) {
    return `Empty ${tag} follows ${prevSnippet} at line ${preceding.line} — fill with a subsection title that continues the "${prevText}" hierarchy, or remove the heading if no section follows.`;
  }
  if (preceding.level === entry.level) {
    return `Empty ${tag} follows a sibling ${prevSnippet} at line ${preceding.line} — fill with the next section's title, or remove if this heading was left empty by mistake.`;
  }
  return `Empty ${tag} — heading hierarchy appears broken (previous heading was ${prevSnippet} at line ${preceding.line}, level h${preceding.level} before this h${entry.level}). Fill with a title that fits the outline or remove the heading; check semantics/heading-hierarchy for the level sequence.`;
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

function emitPrimitiveViolation(tagName: string, line: number, column: number, emit: Emit): void {
  emit({
    severity: "info",
    location: { filePath: "", line, column },
    message: `<${tagName}> has no visible children but receives {...spread} props — this looks like a component primitive (MDX override, styled heading). Whether the heading is empty at render time depends on what the caller passes. Verify at usage sites.`,
    suggestion: `If the component is only ever called with children, this is fine — add \`{/* ra11y-disable semantics/empty-heading */}\` at the top of the file to silence this info note. Otherwise ensure every call site passes text content.`,
  });
}
