/**
 * Rule: semantics/layout-table-no-presentation-role
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, section508:1.3.1, en301549:9.1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags `<table>` elements used purely for visual layout — no `<th>`,
 * no `<thead>`, no `<tfoot>`, no `<caption>`, no `scope` attribute on
 * any cell, no `headers=` association, no ARIA labelling — that have
 * not been declared `role="presentation"` / `role="none"`. Without the
 * presentational role, a screen reader announces "table, N rows, M
 * columns" and reads each cell as a data cell, leaking the layout
 * artifact into the assistive-technology experience.
 *
 * The conjunction is the load-bearing predicate: a table with even
 * one of `<th>`, `<thead>`, `<tfoot>`, `<caption>`, `scope=`,
 * `headers=`, `aria-label`, `aria-labelledby`, or `title` is plausibly
 * a data table the author wired up incompletely (covered by sibling
 * rules — `table-th-scope-missing`, `table-caption-missing`). Only
 * when *all* of those signals are absent does "this is layout" become
 * the high-confidence reading from the AST alone.
 *
 * Exclusions:
 *   - `<table role="presentation">` / `<table role="none">` — already
 *     declared layout; the rule is satisfied. Other roles
 *     (`role="grid"`, `role="treegrid"`) are also non-firing — those
 *     are explicit ARIA opt-ins to the data-table contract.
 *   - Tables containing any `<th>`, `<thead>`, `<tfoot>`, or
 *     `<caption>` descendant (descent stops at nested `<table>` so an
 *     inner data table does not rescue the outer layout table — they
 *     are evaluated independently).
 *   - Tables where any descendant cell carries a `scope=` or
 *     `headers=` attribute (same descent rule).
 *   - Tables with `aria-label`, `aria-labelledby`, or `title` on the
 *     `<table>` element itself — those signal the author intended
 *     this to be a named data table.
 *
 * Severity is `warning`: the structure is unambiguous, but the agent
 * still has to confirm the table was *meant* to be layout (vs. a
 * data table the author forgot to mark up). The suggestion offers
 * both fixes — add `role="presentation"` if it is layout, or add the
 * missing semantic structure if it is data.
 *
 * Nested tables: each `<table>` is evaluated independently. When
 * scanning a given table for semantic markers, descent stops at child
 * `<table>` elements so nested data tables don't suppress the rule on
 * the outer layout table, and vice versa.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

export const rule = defineRule({
  id: "semantics/layout-table-no-presentation-role",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1"],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Layout-only <table> elements (no <th>, <thead>, <tfoot>, <caption>, scope, headers, or ARIA name) should declare role="presentation" so screen readers don\'t announce them as data tables.',
    rationale:
      'A <table> without any header cell, caption, scope/headers wiring, or ARIA name is structurally indistinguishable from a div grid — and is overwhelmingly used for visual layout in legacy HTML, email templates, and old CMS output. Without role="presentation", screen readers honor the <table> semantics: they announce "table, N rows, M columns" and read each <td> as a data cell, forcing the user to navigate through layout scaffolding as if it were tabular data. role="presentation" / role="none" tells assistive technology to treat the element as a generic container, which matches the author\'s intent and removes the noise. The alternative — adding <th>/<caption> to make it a real data table — only applies when the content actually is tabular.',
    goodExample:
      '<table role="presentation">\n  <tr><td><img src="logo.png" alt="Acme"/></td><td>Header text</td></tr>\n  <tr><td colspan="2">Body content laid out in a grid</td></tr>\n</table>',
    badExample:
      '<table>\n  <tr><td><img src="logo.png" alt="Acme"/></td><td>Header text</td></tr>\n  <tr><td colspan="2">Body content laid out in a grid</td></tr>\n</table>',
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/tutorials/tables/",
      "https://www.w3.org/TR/wai-aria-1.2/#presentation",
      "https://html.spec.whatwg.org/multipage/tables.html#the-table-element",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
      return;
    }
    if (
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

interface LayoutTableShape {
  readonly rows: number;
  readonly cols: number;
}

// ---------------------------------------------------------------------------
// Shared suggestion builder
// ---------------------------------------------------------------------------

function buildSuggestion(shape: LayoutTableShape): string {
  const dims = `${shape.rows}-row × ${shape.cols}-column <table>`;
  return (
    `This ${dims} has no <th>, <thead>, <tfoot>, <caption>, scope=, headers=, aria-label, aria-labelledby, or title — every signal that distinguishes a data table is absent. ` +
    'If the table is layout scaffolding (legacy HTML, email template, side-by-side panels), add `role="presentation"` (or `role="none"`) to the <table> so screen readers skip the row/column announcement and read the cell content as flow text. ' +
    'If the content is genuinely tabular, give it the missing structure: a <caption> naming the table, a <thead> with <th scope="col"> headers, and <th scope="row"> row headers as appropriate.'
  );
}

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const table of findHtmlElementsByTag(doc, "table")) {
    if (htmlTableHasRole(table)) continue;
    if (htmlTableHasAriaName(table)) continue;
    if (htmlTableHasSemanticMarkers(table)) continue;
    emit(buildHtmlViolation(table));
  }
}

/**
 * True when the `<table>` already declares a `role` attribute. Any
 * non-empty role short-circuits the rule:
 *   - `presentation` / `none` → already correctly marked layout.
 *   - `grid` / `treegrid` → explicit ARIA opt-in to the data-table
 *     contract; the author has spoken.
 *   - Anything else → an unusual choice but still an explicit
 *     declaration; let other rules catch it if it's wrong.
 *
 * The trim guard rejects `role=""` as "absent" so a stray empty
 * attribute doesn't silently suppress the rule.
 */
function htmlTableHasRole(table: HtmlElement): boolean {
  const role = getHtmlAttribute(table, "role");
  return role !== null && role.trim().length > 0;
}

function htmlTableHasAriaName(table: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(table, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  const ariaLabelledBy = getHtmlAttribute(table, "aria-labelledby");
  if (ariaLabelledBy !== null && ariaLabelledBy.trim().length > 0) return true;
  const title = getHtmlAttribute(table, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

/**
 * True when the table contains any descendant marker that suggests
 * "this might be a data table": a `<th>`, `<thead>`, `<tfoot>`, or
 * `<caption>` element, or a `<td>` / `<th>` carrying a `scope=` or
 * `headers=` attribute. Descent stops at nested `<table>` elements
 * so an inner data table does not rescue the outer layout table.
 */
function htmlTableHasSemanticMarkers(table: HtmlElement): boolean {
  let found = false;
  const visit = (node: HtmlNode): void => {
    if (found) return;
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") return; // do not descend into nested tables
    if (isHtmlSemanticMarkerTag(tag)) {
      found = true;
      return;
    }
    if (tag === "td" && htmlCellHasScopeOrHeaders(node)) {
      found = true;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return found;
}

function isHtmlSemanticMarkerTag(tag: string): boolean {
  return tag === "th" || tag === "thead" || tag === "tfoot" || tag === "caption";
}

function htmlCellHasScopeOrHeaders(cell: HtmlElement): boolean {
  const scope = getHtmlAttribute(cell, "scope");
  if (scope !== null && scope.trim().length > 0) return true;
  const headers = getHtmlAttribute(cell, "headers");
  return headers !== null && headers.trim().length > 0;
}

function computeHtmlShape(table: HtmlElement): LayoutTableShape {
  const rows: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") return;
    if (tag === "tr") {
      rows.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  let maxCols = 0;
  for (const row of rows) {
    let cols = 0;
    for (const child of row.children) {
      if (child.kind !== "HtmlElement") continue;
      const tag = child.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      cols += parseSpan(getHtmlAttribute(child, "colspan"));
    }
    if (cols > maxCols) maxCols = cols;
  }
  return { rows: rows.length, cols: maxCols };
}

function parseSpan(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function buildHtmlViolation(table: HtmlElement): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const shape = computeHtmlShape(table);
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: table.loc.start.line,
      column: table.loc.start.column,
    },
    message:
      '<table> has no header cells, caption, scope/headers wiring, or ARIA name — it appears to be a layout table. Screen readers will still announce it as a data table unless it declares role="presentation".',
    suggestion: buildSuggestion(shape),
  };
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const table of findJsxElementsByTag(module, "table")) {
    if (jsxTableHasRole(table)) continue;
    if (jsxTableHasAriaName(table)) continue;
    if (jsxTableHasSemanticMarkers(table)) continue;
    emit(buildJsxViolation(table));
  }
}

/**
 * True when the `<table>` declares a `role` attribute. Same semantics
 * as the HTML branch. JSX expression-valued `role={...}` counts as
 * "declared" — we can't read the runtime value statically and must
 * not flag a table whose author may be conditionally setting
 * `role="presentation"` from props (false-positive footgun).
 */
function jsxTableHasRole(table: JsxElement): boolean {
  const literal = getJsxAttributeString(table, "role");
  if (literal !== null && literal.trim().length > 0) return true;
  // Expression-valued or absent. hasJsxAttribute distinguishes the two.
  return literal === null && hasJsxAttribute(table, "role");
}

function jsxTableHasAriaName(table: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(table, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (ariaLabel === null && hasJsxAttribute(table, "aria-label")) return true;
  const ariaLabelledBy = getJsxAttributeString(table, "aria-labelledby");
  if (ariaLabelledBy !== null && ariaLabelledBy.trim().length > 0) return true;
  if (ariaLabelledBy === null && hasJsxAttribute(table, "aria-labelledby")) return true;
  const title = getJsxAttributeString(table, "title");
  if (title !== null && title.trim().length > 0) return true;
  if (title === null && hasJsxAttribute(table, "title")) return true;
  return false;
}

function jsxTableHasSemanticMarkers(table: JsxElement): boolean {
  let found = false;
  const visit = (node: JsxNode): void => {
    if (found) return;
    if (node.kind !== "JsxElement") return;
    const tag = node.tagName;
    if (tag === "table") return; // do not descend into nested tables
    if (isJsxSemanticMarkerTag(tag)) {
      found = true;
      return;
    }
    if (tag === "td" && jsxCellHasScopeOrHeaders(node)) {
      found = true;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return found;
}

function isJsxSemanticMarkerTag(tag: string): boolean {
  return tag === "th" || tag === "thead" || tag === "tfoot" || tag === "caption";
}

/**
 * True when the cell carries a `scope=` or `headers=` attribute,
 * either as a non-empty string literal or as an expression. An
 * expression-valued `scope={...}` we treat as "declared" for the
 * same reason as `role={...}` in `jsxTableHasRole`: false positives
 * on dynamic attributes are the documented authoring footgun.
 */
function jsxCellHasScopeOrHeaders(cell: JsxElement): boolean {
  const scopeLit = getJsxAttributeString(cell, "scope");
  if (scopeLit !== null && scopeLit.trim().length > 0) return true;
  if (scopeLit === null && hasJsxAttribute(cell, "scope")) return true;
  const headersLit = getJsxAttributeString(cell, "headers");
  if (headersLit !== null && headersLit.trim().length > 0) return true;
  if (headersLit === null && hasJsxAttribute(cell, "headers")) return true;
  return false;
}

function computeJsxShape(table: JsxElement): LayoutTableShape {
  const rows: JsxElement[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    if (node.tagName === "table") return;
    if (node.tagName === "tr") {
      rows.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  let maxCols = 0;
  for (const row of rows) {
    let cols = 0;
    for (const child of row.children) {
      if (child.kind !== "JsxElement") continue;
      if (child.tagName !== "td" && child.tagName !== "th") continue;
      cols += parseSpan(
        getJsxAttributeString(child, "colSpan") ?? getJsxAttributeString(child, "colspan"),
      );
    }
    if (cols > maxCols) maxCols = cols;
  }
  return { rows: rows.length, cols: maxCols };
}

function buildJsxViolation(table: JsxElement): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const shape = computeJsxShape(table);
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: table.loc.start.line,
      column: table.loc.start.column,
    },
    message:
      '<table> has no header cells, caption, scope/headers wiring, or ARIA name — it appears to be a layout table. Screen readers will still announce it as a data table unless it declares role="presentation".',
    suggestion: buildSuggestion(shape),
  };
}
