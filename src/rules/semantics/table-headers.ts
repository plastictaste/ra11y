/**
 * Rule: semantics/table-headers
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags data tables that have one or more `<td>` cells but no `<th>`
 * header cells. Header cells are the mechanism by which screen readers
 * announce column/row context for each data cell — "Price, $50" rather
 * than just "$50". A data table with no `<th>` is a named data
 * structure with no labels.
 *
 * Excluded from the check (handled as layout or empty scaffolding):
 *   - Tables with `role="presentation"` or `role="none"` — explicitly
 *     layout tables.
 *   - Tables with zero `<td>` descendants — probably empty/decorative
 *     scaffolding, or a structure holding other content.
 *
 * Nested tables are evaluated independently. When counting cells for a
 * given `<table>`, descent stops at child `<table>` elements so each
 * table is judged on its own cells, not its nested descendants'.
 *
 * Severity is `warning`, not `error`: ra11y can't always tell a
 * one-row caption layout from a real data table, so we surface the
 * concern for human review instead of hard-failing the scan.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  htmlTextContent,
  jsxTextContent,
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
  id: "semantics/table-headers",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Data tables must have <th> header cells so screen readers can announce column or row context for each data cell. A <table> with <td> cells but no <th> is flagged.",
    rationale:
      "Screen readers associate each <td> with its corresponding <th> and announce the header before (or alongside) the cell value, producing 'Price, $50' instead of just '$50'. Without <th>, the table is a named data structure with no labels — non-sighted users get a stream of values with no context. If the table is for visual layout only, mark it explicitly with role='presentation'.",
    goodExample: `<table>\n  <thead><tr><th scope="col">Product</th><th scope="col">Price</th></tr></thead>\n  <tbody><tr><td>Widget</td><td>$50</td></tr></tbody>\n</table>`,
    badExample: `<table>\n  <tr><td>Product</td><td>Price</td></tr>\n  <tr><td>Widget</td><td>$50</td></tr>\n</table>`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/tutorials/tables/",
      "https://www.w3.org/WAI/tutorials/tables/two-headers/",
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

// ---------------------------------------------------------------------------
// Header-shape heuristic (shared between HTML and JSX branches)
// ---------------------------------------------------------------------------

/**
 * A cell's trimmed text "looks header-shaped" when it is short, non-empty,
 * not purely numeric/currency/punctuation, and title-cased or sentence-cased.
 * We keep the bar deliberately conservative — the heuristic only enriches
 * the fix suggestion; detection remains "has <td> but no <th>".
 */
function looksHeaderShaped(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  // Purely numeric / currency / percentage / signed: "$50", "12.5%", "-3".
  if (/^[\s\d.,$%+\-€£¥]+$/.test(trimmed)) return false;
  // Needs at least one letter.
  if (!/[A-Za-z]/.test(trimmed)) return false;
  const firstAlpha = trimmed.match(/[A-Za-z]/)?.[0];
  if (!firstAlpha || firstAlpha !== firstAlpha.toUpperCase()) return false;
  // Reject ALL-CAPS SENTENCES (>2 words) — they read as shout copy, not labels.
  // A single ALL-CAPS word ("SKU", "URL") is fine.
  const words = trimmed.split(/\s+/);
  if (words.length > 2 && words.every((w) => /[A-Z]/.test(w) && w === w.toUpperCase())) {
    return false;
  }
  return true;
}

/**
 * Classify a table's first row and first column based on how many cells
 * read as header-shaped. Returns the detected candidate strings (deduped,
 * capped at 5) so the suggestion can inline them verbatim.
 *
 * Ratio gate: ≥60% of the inspected cells must pass `looksHeaderShaped`
 * AND at least 2 cells must be present (a single short cell is noise).
 */
interface HeaderDetection {
  readonly firstRow: readonly string[]; // populated if first row is header-shaped
  readonly firstCol: readonly string[]; // populated if first column is header-shaped
}

function classifyHeaders(
  firstRowCells: readonly string[],
  firstColCells: readonly string[],
): HeaderDetection {
  return {
    firstRow: headerCandidates(firstRowCells),
    firstCol: headerCandidates(firstColCells),
  };
}

function headerCandidates(cells: readonly string[]): readonly string[] {
  if (cells.length < 2) return [];
  const shaped = cells.filter(looksHeaderShaped);
  const ratio = shaped.length / cells.length;
  if (ratio < 0.6) return [];
  // Dedupe (preserves order) and cap at 5 for suggestion readability.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of shaped) {
    const key = s.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length === 5) break;
  }
  return out;
}

/**
 * Shared ladder that composes a context-aware suggestion from a
 * HeaderDetection. Four branches:
 *   1. both rows + cols → mention scope="col" and scope="row", plus hint
 *      about scope="colgroup" for complex tables.
 *   2. row-only → inline detected column headers, recommend scope="col".
 *   3. col-only → name the row-header pattern, recommend scope="row".
 *   4. neither → fallback listing both scopes and the layout-table escape.
 */
function buildSuggestionFromDetection(detection: HeaderDetection): string {
  const rowList = quoteList(detection.firstRow);
  const colList = quoteList(detection.firstCol);

  if (detection.firstRow.length > 0 && detection.firstCol.length > 0) {
    return (
      `First row of <table> appears to contain column headers (${rowList}) ` +
      `and the first column of each row appears to hold row headers (${colList}). ` +
      `Convert the first-row <td> cells to <th scope="col"> and the first-column <td> ` +
      `cells to <th scope="row">. For complex tables with grouped columns, consider ` +
      `<th scope="colgroup"> on the spanning header cell.`
    );
  }
  if (detection.firstRow.length > 0) {
    return (
      `First row of <table> appears to contain header text: ${rowList}. ` +
      `Convert those first-row <td> cells to <th scope="col"> (or wrap the first ` +
      `<tr> in <thead>) so screen readers announce each column's label with the cell value.`
    );
  }
  if (detection.firstCol.length > 0) {
    return (
      `First column of <table> appears to contain row-header labels: ${colList}. ` +
      `Convert the first cell of each row from <td> to <th scope="row"> so screen readers ` +
      `announce the row label before each data value.`
    );
  }
  return (
    'Add <th scope="col"> cells in the first <tr> (or wrap them in <thead>) so each ' +
    'column is labeled. For a row-keyed table, use <th scope="row"> as the first cell of ' +
    "each row. If this <table> is purely for visual layout, mark it with " +
    'role="presentation" instead.'
  );
}

function quoteList(items: readonly string[]): string {
  return items.map((s) => `\`${s}\``).join(", ");
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const table of findHtmlElementsByTag(doc, "table")) {
    if (isLayoutHtmlTable(table)) continue;
    const counts = countHtmlCells(table);
    if (counts.td === 0) continue;
    if (counts.th > 0) continue;
    emit(buildHtmlViolation(table, counts.td));
  }
}

function isLayoutHtmlTable(table: HtmlElement): boolean {
  const role = getHtmlAttribute(table, "role");
  if (role === null) return false;
  const lowered = role.toLowerCase();
  return lowered === "presentation" || lowered === "none";
}

interface CellCounts {
  readonly th: number;
  readonly td: number;
}

function countHtmlCells(table: HtmlElement): CellCounts {
  let th = 0;
  let td = 0;
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    // Stop at nested tables so each table is judged on its own cells.
    if (tag === "table") return;
    if (tag === "th") th += 1;
    else if (tag === "td") td += 1;
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return { th, td };
}

/**
 * Collect the data rows of this table (not nested). Returns each row's
 * `<td>` text contents in source order. Rows with zero `<td>` are skipped.
 */
function collectHtmlDataRows(table: HtmlElement): readonly (readonly string[])[] {
  const rows: string[][] = [];
  const rowElements: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") return; // don't descend into nested tables
    if (tag === "tr") {
      rowElements.push(node);
      return; // don't recurse into the <tr> via the generic walker
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);

  for (const tr of rowElements) {
    const tds: string[] = [];
    for (const child of tr.children) {
      if (child.kind !== "HtmlElement") continue;
      if (child.tagName.toLowerCase() !== "td") continue;
      tds.push(htmlTextContent(child));
    }
    if (tds.length > 0) rows.push(tds);
  }
  return rows;
}

function detectHtmlHeaders(table: HtmlElement): HeaderDetection {
  const rows = collectHtmlDataRows(table);
  if (rows.length === 0) return { firstRow: [], firstCol: [] };
  const firstRow = rows[0] ?? [];
  const firstColCells = rows.map((r) => r[0] ?? "");
  return classifyHeaders(firstRow, firstColCells);
}

function buildHtmlViolation(
  table: HtmlElement,
  tdCount: number,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const detection = detectHtmlHeaders(table);
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: table.loc.start.line,
      column: table.loc.start.column,
    },
    message: `<table> has ${tdCount} <td> cell${tdCount === 1 ? "" : "s"} but no <th> header cells — screen readers will announce each value with no column or row context.`,
    suggestion: buildSuggestionFromDetection(detection),
  };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const table of findJsxElementsByTag(module, "table")) {
    if (isLayoutJsxTable(table)) continue;
    const counts = countJsxCells(table);
    if (counts.td === 0) continue;
    if (counts.th > 0) continue;
    emit(buildJsxViolation(table, counts.td));
  }
}

function isLayoutJsxTable(table: JsxElement): boolean {
  const role = getJsxAttributeString(table, "role");
  if (role === null) return false;
  const lowered = role.toLowerCase();
  return lowered === "presentation" || lowered === "none";
}

function countJsxCells(table: JsxElement): CellCounts {
  let th = 0;
  let td = 0;
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    const tag = node.tagName;
    if (tag === "table") return;
    if (tag === "th") th += 1;
    else if (tag === "td") td += 1;
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return { th, td };
}

function collectJsxDataRows(table: JsxElement): readonly (readonly string[])[] {
  const rows: string[][] = [];
  const rowElements: JsxElement[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    const tag = node.tagName;
    if (tag === "table") return;
    if (tag === "tr") {
      rowElements.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);

  for (const tr of rowElements) {
    const tds: string[] = [];
    for (const child of tr.children) {
      if (child.kind !== "JsxElement") continue;
      if (child.tagName !== "td") continue;
      tds.push(jsxTextContent(child));
    }
    if (tds.length > 0) rows.push(tds);
  }
  return rows;
}

function detectJsxHeaders(table: JsxElement): HeaderDetection {
  const rows = collectJsxDataRows(table);
  if (rows.length === 0) return { firstRow: [], firstCol: [] };
  const firstRow = rows[0] ?? [];
  const firstColCells = rows.map((r) => r[0] ?? "");
  return classifyHeaders(firstRow, firstColCells);
}

function buildJsxViolation(
  table: JsxElement,
  tdCount: number,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const detection = detectJsxHeaders(table);
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: table.loc.start.line,
      column: table.loc.start.column,
    },
    message: `<table> has ${tdCount} <td> cell${tdCount === 1 ? "" : "s"} but no <th> header cells — screen readers will announce each value with no column or row context.`,
    suggestion: buildSuggestionFromDetection(detection),
  };
}
