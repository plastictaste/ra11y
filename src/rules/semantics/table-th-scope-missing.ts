/**
 * Rule: semantics/table-th-scope-missing
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, section508:1.3.1, en301549:9.1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags `<th>` elements in multi-row AND multi-column tables that
 * lack a `scope` attribute and are not wired up through the
 * `headers=`/`id` association pattern. Without either mechanism, a
 * screen reader has to guess whether a header labels its column, its
 * row, a colgroup, or a rowgroup — the guess is usually right for a
 * top-left header in a simple 2-D table, but wrong often enough that
 * WCAG 1.3.1 requires the relationship be programmatically
 * determinable rather than inferred.
 *
 * Why multi-row AND multi-column: a single-row table ("metric: value")
 * or a single-column table has an unambiguous header association by
 * structure alone — the `<th>` can only label the row it's in (for
 * single-column) or the column below it (for single-row). Adding
 * `scope` to those tables is belt-and-braces, not a correctness
 * requirement; flagging them would produce noise the agent
 * categorically cannot act on.
 *
 * Alternative association: `headers="id1 id2"` on every `<td>`
 * pointing at `<th id="id1">` elements is the complex-table mechanism
 * per HTML spec. If every `<td>` in the table has a non-empty
 * `headers` attribute whose tokens all resolve to `<th>` ids inside
 * the same table, we accept the association and skip the entire
 * table. A partial `headers` wiring (some `<td>`s have it, others
 * don't, or a referenced id is missing) is NOT accepted — we flag
 * any `<th>` that also lacks scope, because the structure is
 * incomplete.
 *
 * Exclusions:
 *   - Tables with `role="presentation"` or `role="none"` — explicitly
 *     non-tabular layout tables; `<th>` inside them has no semantic
 *     weight.
 *   - Tables with < 2 rows OR < 2 columns — see above.
 *   - `<th>` elements with a recognized `scope` value (col, row,
 *     colgroup, rowgroup — case-insensitive). An unrecognized or
 *     empty `scope` value is treated as missing.
 *
 * Nested tables: each table is evaluated independently. Descent
 * through the outer table stops at a nested `<table>` element so the
 * inner table's rows/cells don't contaminate the outer's dimensions.
 *
 * Severity is `warning`: the rule's detection is deterministic but
 * the *correct* scope value for any given `<th>` depends on authorial
 * intent (is this a column header or a row header?). The suggestion
 * narrows the choice based on the `<th>`'s position (first row →
 * col, first cell of each row → row, colspan≥2 → colgroup, rowspan≥2
 * → rowgroup), but the agent still has to confirm in source.
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
  id: "semantics/table-th-scope-missing",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1"],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Header cells in multi-row and multi-column tables must declare a scope (col/row/colgroup/rowgroup), or every data cell must reference its header's id via headers=, so screen readers can unambiguously pair each data cell with its header.",
    rationale:
      "In a 2-D data table, a <th> in the top-left corner could be a column header, a row header, or a section label — a screen reader cannot tell without help. scope='col' / scope='row' / scope='colgroup' / scope='rowgroup' makes the relationship explicit; the headers=/id pattern handles irregular layouts (merged cells, section subheads) the scope attribute can't. Either mechanism is enough; neither means the cell-to-header association is guesswork.",
    goodExample:
      '<table>\n  <thead><tr><th scope="col">Product</th><th scope="col">Price</th></tr></thead>\n  <tbody>\n    <tr><th scope="row">Widget</th><td>$50</td></tr>\n    <tr><th scope="row">Gadget</th><td>$75</td></tr>\n  </tbody>\n</table>',
    badExample:
      "<table>\n  <thead><tr><th>Product</th><th>Price</th></tr></thead>\n  <tbody>\n    <tr><td>Widget</td><td>$50</td></tr>\n    <tr><td>Gadget</td><td>$75</td></tr>\n  </tbody>\n</table>",
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/tutorials/tables/two-headers/",
      "https://www.w3.org/WAI/tutorials/tables/multi-level/",
      "https://html.spec.whatwg.org/multipage/tables.html#attr-th-scope",
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

const VALID_SCOPES: ReadonlySet<string> = new Set(["col", "row", "colgroup", "rowgroup"]);

/**
 * Where a `<th>` sits relative to the data grid. Drives the
 * suggestion's scope recommendation.
 */
type ThPosition =
  | { readonly kind: "first-row" } // first row in the table → scope="col"
  | { readonly kind: "first-col" } // first cell of its row (but not first row) → scope="row"
  | { readonly kind: "colgroup"; readonly span: number } // colspan >= 2 → scope="colgroup"
  | { readonly kind: "rowgroup"; readonly span: number } // rowspan >= 2 → scope="rowgroup"
  | { readonly kind: "other" }; // interior header — suggest both, author picks

interface TableDimensions {
  readonly rows: number;
  readonly cols: number;
}

// ---------------------------------------------------------------------------
// Shared suggestion builder
// ---------------------------------------------------------------------------

function buildSuggestion(position: ThPosition, dims: TableDimensions): string {
  const dimStr = `${dims.rows}-row × ${dims.cols}-column <table>`;
  if (position.kind === "first-row") {
    return (
      `This <th> sits in the first row of a ${dimStr} — it is labeling a column. ` +
      'Add `scope="col"` to this cell (and every other <th> in this row). ' +
      "Screen readers will then announce the column label before each <td> value."
    );
  }
  if (position.kind === "first-col") {
    return (
      `This <th> sits in the first cell of its row in a ${dimStr} — it is labeling the row. ` +
      'Add `scope="row"` to this cell (and every other first-column <th>). ' +
      "Screen readers will then announce the row label before each <td> value in that row."
    );
  }
  if (position.kind === "colgroup") {
    return (
      `This <th> has colspan="${position.span}" in a ${dimStr} — it is labeling a group of columns. ` +
      'Add `scope="colgroup"` so screen readers associate the grouped columns with this header; ' +
      'the individual column headers beneath it should keep `scope="col"`.'
    );
  }
  if (position.kind === "rowgroup") {
    return (
      `This <th> has rowspan="${position.span}" in a ${dimStr} — it is labeling a group of rows. ` +
      'Add `scope="rowgroup"` so screen readers associate the grouped rows with this header; ' +
      'the individual row headers beside it should keep `scope="row"`.'
    );
  }
  return (
    `This <th> sits in a ${dimStr} but has no scope attribute. ` +
    'Add `scope="col"` if it labels a column, `scope="row"` if it labels a row, ' +
    '`scope="colgroup"` / `scope="rowgroup"` for grouped cells. ' +
    'Alternatively, give this <th> an id and set `headers="<id>"` on every <td> ' +
    "it labels (the complex-table association pattern)."
  );
}

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const table of findHtmlElementsByTag(doc, "table")) {
    checkHtmlTable(table, emit);
  }
}

function checkHtmlTable(table: HtmlElement, emit: Emit): void {
  if (isLayoutHtmlTable(table)) return;
  const rows = collectHtmlRows(table);
  const dims = computeHtmlDimensions(rows);
  if (dims.rows < 2 || dims.cols < 2) return;
  if (htmlHasCompleteHeadersAssociation(rows)) return;
  emitHtmlRowViolations(rows, dims, emit);
}

function emitHtmlRowViolations(rows: readonly HtmlRow[], dims: TableDimensions, emit: Emit): void {
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row) continue;
    for (let cellIdx = 0; cellIdx < row.cells.length; cellIdx++) {
      const cell = row.cells[cellIdx];
      if (!cell || cell.tag !== "th") continue;
      if (htmlScopeIsValid(cell.element)) continue;
      const position = classifyHtmlThPosition(cell.element, rowIdx, cellIdx);
      emit(buildHtmlViolation(cell.element, position, dims));
    }
  }
}

function isLayoutHtmlTable(table: HtmlElement): boolean {
  const role = getHtmlAttribute(table, "role");
  if (role === null) return false;
  const lowered = role.toLowerCase();
  return lowered === "presentation" || lowered === "none";
}

function htmlScopeIsValid(th: HtmlElement): boolean {
  const scope = getHtmlAttribute(th, "scope");
  if (scope === null) return false;
  return VALID_SCOPES.has(scope.trim().toLowerCase());
}

interface HtmlCell {
  readonly tag: "th" | "td";
  readonly element: HtmlElement;
  readonly colspan: number;
}

interface HtmlRow {
  readonly cells: readonly HtmlCell[];
}

/**
 * Collect data rows of this table (depth-first, stopping at nested
 * `<table>` elements). Each row yields its direct `<th>` / `<td>`
 * children in source order. Rows with zero cells are skipped —
 * an empty `<tr>` is usually a templating artifact, not a
 * structural row.
 */
function collectHtmlRows(table: HtmlElement): readonly HtmlRow[] {
  const rowElements: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") return; // do not descend into nested tables
    if (tag === "tr") {
      rowElements.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);

  const rows: HtmlRow[] = [];
  for (const tr of rowElements) {
    const cells: HtmlCell[] = [];
    for (const child of tr.children) {
      if (child.kind !== "HtmlElement") continue;
      const childTag = child.tagName.toLowerCase();
      if (childTag !== "th" && childTag !== "td") continue;
      cells.push({
        tag: childTag,
        element: child,
        colspan: parseSpan(getHtmlAttribute(child, "colspan")),
      });
    }
    if (cells.length > 0) rows.push({ cells });
  }
  return rows;
}

function computeHtmlDimensions(rows: readonly HtmlRow[]): TableDimensions {
  let maxCols = 0;
  for (const row of rows) {
    let colsInRow = 0;
    for (const cell of row.cells) colsInRow += cell.colspan;
    if (colsInRow > maxCols) maxCols = colsInRow;
  }
  return { rows: rows.length, cols: maxCols };
}

function parseSpan(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/**
 * True when every `<td>` in the table has a non-empty `headers`
 * attribute AND every referenced token resolves to a `<th id=...>`
 * present in the same table. Accepts the complex-table association
 * pattern as a scope alternative.
 */
function htmlHasCompleteHeadersAssociation(rows: readonly HtmlRow[]): boolean {
  const thIds = collectHtmlThIds(rows);
  if (thIds.size === 0) return false;
  return allHtmlTdsWireToThIds(rows, thIds);
}

function collectHtmlThIds(rows: readonly HtmlRow[]): ReadonlySet<string> {
  const thIds = new Set<string>();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.tag !== "th") continue;
      const id = getHtmlAttribute(cell.element, "id");
      if (id !== null && id.trim().length > 0) thIds.add(id.trim());
    }
  }
  return thIds;
}

function allHtmlTdsWireToThIds(rows: readonly HtmlRow[], thIds: ReadonlySet<string>): boolean {
  let anyTd = false;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.tag !== "td") continue;
      anyTd = true;
      const headers = getHtmlAttribute(cell.element, "headers");
      if (!headersTokensAllKnown(headers, thIds)) return false;
    }
  }
  return anyTd;
}

/**
 * True when `raw` is a non-empty whitespace-separated id list and
 * every token is present in `known`. `null` / empty / any unknown
 * token → false.
 */
function headersTokensAllKnown(raw: string | null, known: ReadonlySet<string>): boolean {
  if (raw === null) return false;
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  for (const token of tokens) if (!known.has(token)) return false;
  return true;
}

function classifyHtmlThPosition(th: HtmlElement, rowIdx: number, cellIdx: number): ThPosition {
  const rowspan = parseSpan(getHtmlAttribute(th, "rowspan"));
  if (rowspan >= 2) return { kind: "rowgroup", span: rowspan };
  const colspan = parseSpan(getHtmlAttribute(th, "colspan"));
  if (colspan >= 2) return { kind: "colgroup", span: colspan };
  if (rowIdx === 0) return { kind: "first-row" };
  if (cellIdx === 0) return { kind: "first-col" };
  return { kind: "other" };
}

function buildHtmlViolation(
  th: HtmlElement,
  position: ThPosition,
  dims: TableDimensions,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: th.loc.start.line,
      column: th.loc.start.column,
    },
    message: `<th> in a ${dims.rows}-row × ${dims.cols}-column <table> has no scope attribute — screen readers cannot tell whether it labels a column or a row.`,
    suggestion: buildSuggestion(position, dims),
  };
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const table of findJsxElementsByTag(module, "table")) {
    checkJsxTable(table, emit);
  }
}

function checkJsxTable(table: JsxElement, emit: Emit): void {
  if (isLayoutJsxTable(table)) return;
  const rows = collectJsxRows(table);
  const dims = computeJsxDimensions(rows);
  if (dims.rows < 2 || dims.cols < 2) return;
  if (jsxHasCompleteHeadersAssociation(rows)) return;
  emitJsxRowViolations(rows, dims, emit);
}

function emitJsxRowViolations(rows: readonly JsxRow[], dims: TableDimensions, emit: Emit): void {
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    if (!row) continue;
    for (let cellIdx = 0; cellIdx < row.cells.length; cellIdx++) {
      const cell = row.cells[cellIdx];
      if (!cell || cell.tag !== "th") continue;
      if (jsxScopeIsValid(cell.element)) continue;
      const position = classifyJsxThPosition(cell.element, rowIdx, cellIdx);
      emit(buildJsxViolation(cell.element, position, dims));
    }
  }
}

function isLayoutJsxTable(table: JsxElement): boolean {
  const role = getJsxAttributeString(table, "role");
  if (role === null) return false;
  const lowered = role.toLowerCase();
  return lowered === "presentation" || lowered === "none";
}

/**
 * A JSX `scope` whose value is an expression (`scope={isCol ? "col"
 * : "row"}`) is accepted — we can't read the runtime value
 * statically, and false-positives on expression-valued attributes
 * are the documented rule-authoring footgun. A string literal must
 * match one of the valid values.
 */
function jsxScopeIsValid(th: JsxElement): boolean {
  const literal = getJsxAttributeString(th, "scope");
  if (literal !== null) return VALID_SCOPES.has(literal.trim().toLowerCase());
  // Expression-valued or absent. hasJsxAttribute distinguishes the two.
  return hasJsxAttribute(th, "scope");
}

interface JsxCell {
  readonly tag: "th" | "td";
  readonly element: JsxElement;
  readonly colspan: number;
}

interface JsxRow {
  readonly cells: readonly JsxCell[];
}

function collectJsxRows(table: JsxElement): readonly JsxRow[] {
  const rowElements: JsxElement[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    if (node.tagName === "table") return;
    if (node.tagName === "tr") {
      rowElements.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);

  const rows: JsxRow[] = [];
  for (const tr of rowElements) {
    const cells: JsxCell[] = [];
    for (const child of tr.children) {
      if (child.kind !== "JsxElement") continue;
      if (child.tagName !== "th" && child.tagName !== "td") continue;
      cells.push({
        tag: child.tagName,
        element: child,
        colspan: parseSpan(
          getJsxAttributeString(child, "colSpan") ?? getJsxAttributeString(child, "colspan"),
        ),
      });
    }
    if (cells.length > 0) rows.push({ cells });
  }
  return rows;
}

function computeJsxDimensions(rows: readonly JsxRow[]): TableDimensions {
  let maxCols = 0;
  for (const row of rows) {
    let colsInRow = 0;
    for (const cell of row.cells) colsInRow += cell.colspan;
    if (colsInRow > maxCols) maxCols = colsInRow;
  }
  return { rows: rows.length, cols: maxCols };
}

function jsxHasCompleteHeadersAssociation(rows: readonly JsxRow[]): boolean {
  const thIds = collectJsxThIds(rows);
  if (thIds.size === 0) return false;
  return allJsxTdsWireToThIds(rows, thIds);
}

function collectJsxThIds(rows: readonly JsxRow[]): ReadonlySet<string> {
  const thIds = new Set<string>();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.tag !== "th") continue;
      const id = getJsxAttributeString(cell.element, "id");
      if (id !== null && id.trim().length > 0) thIds.add(id.trim());
    }
  }
  return thIds;
}

function allJsxTdsWireToThIds(rows: readonly JsxRow[], thIds: ReadonlySet<string>): boolean {
  let anyTd = false;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.tag !== "td") continue;
      anyTd = true;
      // Expression-valued headers (`headers={ids}`) return null here;
      // we can't prove it resolves correctly, so the association is
      // indeterminate and we fall back to per-<th> scope detection.
      const headers = getJsxAttributeString(cell.element, "headers");
      if (!headersTokensAllKnown(headers, thIds)) return false;
    }
  }
  return anyTd;
}

function classifyJsxThPosition(th: JsxElement, rowIdx: number, cellIdx: number): ThPosition {
  const rowspan = parseSpan(
    getJsxAttributeString(th, "rowSpan") ?? getJsxAttributeString(th, "rowspan"),
  );
  if (rowspan >= 2) return { kind: "rowgroup", span: rowspan };
  const colspan = parseSpan(
    getJsxAttributeString(th, "colSpan") ?? getJsxAttributeString(th, "colspan"),
  );
  if (colspan >= 2) return { kind: "colgroup", span: colspan };
  if (rowIdx === 0) return { kind: "first-row" };
  if (cellIdx === 0) return { kind: "first-col" };
  return { kind: "other" };
}

function buildJsxViolation(
  th: JsxElement,
  position: ThPosition,
  dims: TableDimensions,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: th.loc.start.line,
      column: th.loc.start.column,
    },
    message: `<th> in a ${dims.rows}-row × ${dims.cols}-column <table> has no scope attribute — screen readers cannot tell whether it labels a column or a row.`,
    suggestion: buildSuggestion(position, dims),
  };
}
