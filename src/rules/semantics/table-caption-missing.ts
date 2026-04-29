/**
 * Rule: semantics/table-caption-missing
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, section508:1.3.1, en301549:9.1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags data `<table>` elements that have no accessible name. A table
 * with data cells (`<td>` or `<th>`) needs a programmatic label so
 * screen readers can announce what the table represents before they
 * start reading cells — "Quarterly sales, table, 3 columns, 4 rows"
 * rather than "table, 3 columns, 4 rows". WCAG 1.3.1 requires the
 * structural relationship between the table and its label to be
 * programmatically determinable.
 *
 * Accepted labels (any one suffices):
 *   - A `<caption>` child (per HTML spec, must be the first child of
 *     the `<table>`; we don't enforce position since screen readers
 *     accept either — the rule's concern is the *presence* of a label).
 *   - `aria-label="…"` with non-empty trimmed value.
 *   - `aria-labelledby="id1 id2"` referencing at least one id.
 *   - `title="…"` with non-empty trimmed value (a weaker name source
 *     that assistive technologies generally honor — surfaced as
 *     compliant but the agent can tighten in source review).
 *
 * Exclusions:
 *   - Tables with `role="presentation"` or `role="none"` — explicitly
 *     layout tables, not data tables.
 *   - Tables with zero `<td>` and zero `<th>` descendants (not counting
 *     cells of nested tables) — empty / decorative scaffolding.
 *
 * Nested tables are evaluated independently: an unlabeled inner table
 * is flagged regardless of its outer's caption, and vice versa. When
 * counting cells and looking for a caption for a given `<table>`,
 * descent stops at child `<table>` elements.
 *
 * Severity is `warning`, not `error`: in narrow cases (a tiny status
 * table whose surrounding heading already names it), the missing
 * caption is a practical non-issue even though the spec prefers the
 * relationship be explicit. The rule surfaces so the agent can verify
 * intent in source; no heuristic suppression.
 *
 * Conceded-uncertainty refinement (markdown-source / fragment host file):
 * when the host file is a Markdown source (`.md`/`.markdown`/`.mkdn`)
 * or is fragment-classified (no `<html>`/`<body>` opener, no layout
 * directive, not under a `_layouts/` segment), the rule's emission
 * concedes its predicate may not hold. Markdown has no first-class
 * `<caption>` analogue — pipe-table syntax does not encode one — so a
 * `<table>` block authored in Markdown would naturally lack a caption
 * the static scanner can see, but the rendered page may carry one
 * supplied by the SSG (Pandoc table-caption, MultiMarkdown caption
 * syntax `Table: …`, kramdown IAL `{:caption=…}`) or by a parent
 * layout's heading. Fragment-classified HTML files have the same
 * shape: the file's missing caption may be supplied by a sibling
 * partial composing into the rendered page.
 *
 * Per `docs/kb/architecture/ai-first-consumer.md` "Per-finding
 * confidence must reflect per-rule coverage limitations" + "Parser-
 * failure invalidates per-file confidence", the rule still surfaces
 * (per "Surface, don't suppress") but the per-finding `confidence`
 * downgrades to `"medium"` and the finding carries either
 * `["markdown_table_no_caption_syntax_in_md"]` (Markdown source),
 * `["fragment_input_no_document_envelope"]` (fragment-classified
 * HTML), or both (a Markdown file that is also fragment-classified).
 * Severity stays at `warning` — confidence is the predicate-strength
 * axis, severity is the budget axis.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasJsxAttribute,
  htmlTextContent,
  jsxHasContentChildren,
  jsxTextContent,
} from "../../engine/ast-helpers.ts";
import { isFragmentFile } from "../../engine/layout-partial.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ViolationEvidence } from "../../types/violation.ts";
import { extension } from "../../utils/path.ts";

/**
 * Structured `couldBeWrongBecause` codes attached to markdown-source
 * or fragment-host emits. Each code names a distinct predicate-
 * strength concession:
 *
 *   - `markdown_table_no_caption_syntax_in_md` — host file is a
 *     Markdown source. Markdown's pipe-table syntax has no native
 *     `<caption>` analogue, so the absence of a caption in the static
 *     residue does not confirm the rendered page lacks one (Pandoc
 *     table-caption, MultiMarkdown `Table: …`, kramdown IAL caption
 *     attributes, or a heading promoted by the SSG can supply the
 *     caption at render time).
 *   - `fragment_input_no_document_envelope` — host file is fragment-
 *     classified (no `<html>` opener, no layout directive, not under
 *     a `_layouts/` segment). The composed parent layout may inject
 *     a heading, `<figcaption>`, or `aria-labelledby` target that the
 *     static scanner cannot see.
 *
 * Both can co-occur when a `.md` file ALSO classifies as a fragment;
 * the predicate-uncertainty has two distinct sources and each is
 * independently meaningful — an agent dismissing on confirmed SSG
 * caption rendering keys on the first; an agent dismissing on a
 * confirmed parent-layout caption keys on the second.
 */
const MARKDOWN_TABLE_NO_CAPTION_SYNTAX_IN_MD = "markdown_table_no_caption_syntax_in_md";
const FRAGMENT_INPUT_NO_DOCUMENT_ENVELOPE = "fragment_input_no_document_envelope";

/**
 * True when `filePath` is a Markdown source file routed through
 * `parseMarkdown` (`.md`, `.markdown`, `.mkdn`). Mirrors the
 * `isMarkdownSourceFile` predicate used by `semantics/heading-
 * hierarchy.ts` — both rules need to know whether the AST they're
 * walking came from a markdown-residue projection rather than native
 * HTML, because residue-derived findings concede their predicate may
 * not hold (the SSG may render syntax the residue stripped).
 */
function isMarkdownSourceFile(filePath: string): boolean {
  const ext = extension(filePath);
  return ext === ".md" || ext === ".markdown" || ext === ".mkdn";
}

export const rule = defineRule({
  id: "semantics/table-caption-missing",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1"],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Data tables must have an accessible name via <caption>, aria-label, aria-labelledby, or title so screen readers announce what the table represents before reading its cells.",
    rationale:
      "Without a label, screen readers announce only 'table, N columns, M rows' — users get the dimensions but not the subject. A caption (or aria-label / aria-labelledby) establishes the relationship between the table and its meaning programmatically, which is exactly what WCAG 1.3.1 requires for information conveyed through presentation. <caption> is the HTML-native mechanism and appears inline for sighted users too; aria-label is appropriate when the label is already visible in surrounding prose.",
    goodExample:
      '<table>\n  <caption>Quarterly sales by region</caption>\n  <thead><tr><th scope="col">Region</th><th scope="col">Q1</th></tr></thead>\n  <tbody><tr><td>North</td><td>$100</td></tr></tbody>\n</table>',
    badExample:
      '<table>\n  <thead><tr><th scope="col">Region</th><th scope="col">Q1</th></tr></thead>\n  <tbody><tr><td>North</td><td>$100</td></tr></tbody>\n</table>',
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/tutorials/tables/caption-summary/",
      "https://html.spec.whatwg.org/multipage/tables.html#the-caption-element",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      const doc = ctx.ast as HtmlDocument;
      // Conceded-uncertainty enrichment: when the host file is a
      // Markdown source OR is fragment-classified, the rule's "no
      // accessible name" claim concedes its predicate may not hold —
      // either Markdown's missing first-class caption syntax routes
      // the caption through the SSG layer, or the parent layout
      // composes a caption / heading the static scanner cannot see.
      // The two axes can co-occur (a `.md` file is often also
      // fragment-classified). Per `docs/kb/architecture/ai-first-
      // consumer.md` "Per-finding confidence must reflect per-rule
      // coverage limitations," surface the finding (per "Surface,
      // don't suppress") with `confidence: "medium"` and the matching
      // axis codes so the agent triages the conceded uncertainty
      // rather than budgeting against a contradictory confidence /
      // severity pair. Severity stays at `warning`. JSX modules are
      // file-scoped by design (no document-envelope concept and no
      // markdown-residue projection), so this gate only applies on
      // the HTML branch.
      const codes = computeConcededUncertaintyCodes(doc, ctx.source, ctx.filePath);
      checkHtml(doc, codes, (v) => ctx.emit(v));
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

/**
 * Walks the two independent gates (markdown source extension,
 * fragment-classified HTML) and returns the ordered list of
 * `couldBeWrongBecause` codes that apply. Empty array means neither
 * gate fired — the rule emits at its normal high-confidence shape.
 *
 * Order matches the file-shape evidence chain a reader follows: the
 * extension is the cheapest, most-visible signal; the structural
 * fragment classification is the deeper read.
 */
function computeConcededUncertaintyCodes(
  doc: HtmlDocument,
  source: string,
  filePath: string,
): readonly string[] {
  const codes: string[] = [];
  if (isMarkdownSourceFile(filePath)) codes.push(MARKDOWN_TABLE_NO_CAPTION_SYNTAX_IN_MD);
  if (isFragmentFile(doc, source, filePath)) codes.push(FRAGMENT_INPUT_NO_DOCUMENT_ENVELOPE);
  return codes;
}

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  confidence?: "high" | "medium" | "low" | "inherited";
  couldBeWrongBecause?: readonly string[];
}) => void;

// ---------------------------------------------------------------------------
// Shared suggestion builder
// ---------------------------------------------------------------------------

interface PrecedingHeadingInfo {
  readonly tag: string;
  readonly line: number;
  readonly id?: string;
}

interface CaptionHint {
  /** Proposed caption text inferred from surrounding context; may be empty. */
  readonly inferredLabel: string;
  /** Where the inference came from — included in the suggestion so the agent knows. */
  readonly inferredFrom: "preceding-heading" | "figcaption-sibling" | "none";
  /**
   * Structured details for a preceding-heading inference, populated only
   * when {@link inferredFrom} is `"preceding-heading"`. Drives both the
   * `aria-labelledby` alternative-fix prose in the suggestion and the
   * per-finding {@link ViolationEvidence} sub-shape so an agent reading
   * either channel sees the same heading anchor.
   */
  readonly precedingHeading?: PrecedingHeadingInfo;
}

function buildSuggestion(hint: CaptionHint): string {
  const template =
    hint.inferredLabel.length > 0
      ? `<caption>${hint.inferredLabel}</caption>`
      : "<caption>Describe what this table shows</caption>";

  const origin =
    hint.inferredFrom === "preceding-heading"
      ? ` (inferred from the nearest preceding heading)`
      : hint.inferredFrom === "figcaption-sibling"
        ? ` (inferred from the sibling <figcaption>)`
        : "";

  // When a preceding heading is in scope, surface the `aria-labelledby`
  // path with concrete id wiring (mint one if the heading lacks an id)
  // alongside the `<caption>` insertion. Both fixes are valid per the
  // accessible-name spec; surfacing both lets the agent pick based on
  // whether the heading is already visible to sighted users.
  const labelledByAlternative = buildLabelledByAlternative(hint.precedingHeading);

  return (
    `Add \`${template}\` as the first child of this <table>${origin}. ` +
    "The <caption> is the HTML-native accessible name for a table and is announced by screen readers before the cells. " +
    `${labelledByAlternative} ` +
    'If this <table> is used purely for visual layout, mark it `role="presentation"` instead.'
  );
}

/**
 * Builds the `aria-labelledby` alternative-fix sentence. When a preceding
 * heading is known, names the existing heading id (or instructs to mint
 * one when absent) so the agent can apply the alternative as a mechanical
 * edit. Falls back to generic prose when no preceding heading is in scope.
 */
function buildLabelledByAlternative(heading: PrecedingHeadingInfo | undefined): string {
  if (!heading) {
    return 'Alternative labels: `aria-label="…"` on the <table>, or `aria-labelledby="<id-of-existing-heading>"` when the label is already visible in surrounding prose.';
  }
  if (heading.id !== undefined && heading.id.length > 0) {
    return `Alternative: add \`aria-labelledby="${heading.id}"\` to the <table>, pointing at the preceding <${heading.tag}> (line ${heading.line}). \`aria-label="…"\` on the <table> also works.`;
  }
  return `Alternative: add \`id="<slug>"\` to the preceding <${heading.tag}> (line ${heading.line}) and \`aria-labelledby="<slug>"\` to the <table>. \`aria-label="…"\` on the <table> also works.`;
}

/**
 * Builds the structured `evidence` sub-shape for the preceding-heading
 * variant. See {@link ViolationEvidence} for the union contract.
 */
function precedingHeadingEvidence(heading: PrecedingHeadingInfo): ViolationEvidence {
  return {
    kind: "table-caption-preceding-heading",
    tag: heading.tag,
    line: heading.line,
    ...(heading.id === undefined || heading.id.length === 0 ? {} : { id: heading.id }),
  };
}

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, concededCodes: readonly string[], emit: Emit): void {
  for (const table of findHtmlElementsByTag(doc, "table")) {
    if (isLayoutHtmlTable(table)) continue;
    if (!hasHtmlDataCells(table)) continue;
    if (hasHtmlAccessibleName(table)) continue;
    emit(buildHtmlViolation(table, doc, concededCodes));
  }
}

function isLayoutHtmlTable(table: HtmlElement): boolean {
  const role = getHtmlAttribute(table, "role");
  if (role === null) return false;
  const lowered = role.toLowerCase();
  return lowered === "presentation" || lowered === "none";
}

function hasHtmlDataCells(table: HtmlElement): boolean {
  let found = false;
  const visit = (node: HtmlNode): void => {
    if (found) return;
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    // Don't count cells belonging to a nested table.
    if (tag === "table") return;
    if (tag === "td" || tag === "th") {
      found = true;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return found;
}

function hasHtmlAccessibleName(table: HtmlElement): boolean {
  if (hasHtmlCaptionChild(table)) return true;

  const ariaLabel = getHtmlAttribute(table, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;

  const ariaLabelledBy = getHtmlAttribute(table, "aria-labelledby");
  if (ariaLabelledBy !== null && ariaLabelledBy.trim().length > 0) return true;

  const title = getHtmlAttribute(table, "title");
  if (title !== null && title.trim().length > 0) return true;

  return false;
}

/**
 * True when the table has a direct-descendant `<caption>` whose content
 * is non-empty (after trim). An empty `<caption></caption>` is a
 * structural shell with no label — treat as missing. We search the
 * *direct* children first (per HTML spec), then fall back to a shallow
 * descendant walk stopping at nested tables in case the caption is
 * wrapped in e.g. `<thead>` by a templating system — screen readers
 * don't care about strict position; our concern is "is a label there?".
 */
function hasHtmlCaptionChild(table: HtmlElement): boolean {
  let found = false;
  const visit = (node: HtmlNode): void => {
    if (found) return;
    if (node.kind !== "HtmlElement") return;
    const tag = node.tagName.toLowerCase();
    if (tag === "table") return;
    if (tag === "caption") {
      if (htmlTextContent(node).length > 0) found = true;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return found;
}

function buildHtmlViolation(
  table: HtmlElement,
  doc: HtmlDocument,
  concededCodes: readonly string[],
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  confidence?: "high" | "medium" | "low" | "inherited";
  couldBeWrongBecause?: readonly string[];
  evidence?: ViolationEvidence;
} {
  const hint = inferHtmlCaptionHint(table, doc);
  // Conceded-uncertainty annotation: when the host file is markdown-
  // source or fragment-classified, the rule's "missing accessible
  // name" claim concedes its predicate may not hold (the SSG layer
  // or parent layout may supply the caption). Append a short suffix
  // to the message so the agent reading the message channel sees the
  // same uncertainty the `confidence` / `couldBeWrongBecause`
  // channels carry. Per `docs/kb/architecture/ai-first-consumer.md`
  // "Reason / priority / fix-description must agree across all
  // three channels."
  const messageBase =
    "<table> has data cells but no <caption>, aria-label, aria-labelledby, or title — screen readers announce only the dimensions, not what the table represents.";
  const concededSuffix = buildConcededSuffix(concededCodes);
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: table.loc.start.line,
      column: table.loc.start.column,
    },
    message: `${messageBase}${concededSuffix}`,
    suggestion: buildSuggestion(hint),
    ...(concededCodes.length > 0
      ? { confidence: "medium" as const, couldBeWrongBecause: concededCodes }
      : {}),
    ...(hint.precedingHeading ? { evidence: precedingHeadingEvidence(hint.precedingHeading) } : {}),
  };
}

/**
 * Builds the message-channel suffix that names the conceded-
 * uncertainty axes. Empty when no axis fires; otherwise a short
 * sentence the agent reads alongside the `couldBeWrongBecause` codes
 * so the message and the structured codes agree.
 */
function buildConcededSuffix(codes: readonly string[]): string {
  if (codes.length === 0) return "";
  const parts: string[] = [];
  if (codes.includes(MARKDOWN_TABLE_NO_CAPTION_SYNTAX_IN_MD)) {
    parts.push(
      "Host file is a Markdown source — Markdown has no first-class caption syntax, so a caption may be supplied at SSG render time (Pandoc table-caption, MultiMarkdown `Table: …`, kramdown IAL).",
    );
  }
  if (codes.includes(FRAGMENT_INPUT_NO_DOCUMENT_ENVELOPE)) {
    parts.push(
      "Host file is fragment-classified (no document envelope) — a parent layout may compose a caption / heading the static scanner cannot see; verify the rendered shape before fixing.",
    );
  }
  return ` ${parts.join(" ")}`;
}

function inferHtmlCaptionHint(table: HtmlElement, doc: HtmlDocument): CaptionHint {
  const figcaption = findHtmlFigcaptionSibling(table, doc);
  if (figcaption) {
    const text = htmlTextContent(figcaption);
    if (text.length > 0) return { inferredLabel: text, inferredFrom: "figcaption-sibling" };
  }
  const heading = findHtmlPrecedingHeading(table, doc);
  if (heading) {
    const text = htmlTextContent(heading);
    if (text.length > 0) {
      const id = getHtmlAttribute(heading, "id");
      const headingInfo: PrecedingHeadingInfo = {
        tag: heading.tagName.toLowerCase(),
        line: heading.loc.start.line,
        ...(id !== null && id.trim().length > 0 ? { id: id.trim() } : {}),
      };
      return {
        inferredLabel: text,
        inferredFrom: "preceding-heading",
        precedingHeading: headingInfo,
      };
    }
  }
  return { inferredLabel: "", inferredFrom: "none" };
}

/**
 * Walk the parent chain to the root, looking for a `<figure>` ancestor
 * whose direct children include a `<figcaption>`. Returns the first
 * such figcaption.
 */
function findHtmlFigcaptionSibling(table: HtmlElement, doc: HtmlDocument): HtmlElement | undefined {
  const chain = collectHtmlAncestors(table, doc);
  for (const ancestor of chain) {
    if (ancestor.tagName.toLowerCase() !== "figure") continue;
    for (const child of ancestor.children) {
      if (child.kind !== "HtmlElement") continue;
      if (child.tagName.toLowerCase() === "figcaption") return child;
    }
  }
  return undefined;
}

/**
 * Returns the nearest heading (`<h1>`–`<h6>`) that appears *before* the
 * table in document order, searching up the ancestor chain. Only
 * previous siblings at each ancestor level are considered — a heading
 * deeper inside a sibling subtree doesn't count as "preceding" in any
 * structural sense relevant to the caption.
 */
function findHtmlPrecedingHeading(table: HtmlElement, doc: HtmlDocument): HtmlElement | undefined {
  const ancestorChain = [table, ...collectHtmlAncestors(table, doc)];
  for (let i = 0; i < ancestorChain.length - 1; i++) {
    const child = ancestorChain[i];
    const parent = ancestorChain[i + 1];
    if (!(child && parent)) continue;
    const siblings = parent.children;
    const idx = siblings.indexOf(child);
    for (let j = idx - 1; j >= 0; j--) {
      const sib = siblings[j];
      if (!sib || sib.kind !== "HtmlElement") continue;
      if (isHeadingTag(sib.tagName)) return sib;
    }
  }
  return undefined;
}

function isHeadingTag(tag: string): boolean {
  const lowered = tag.toLowerCase();
  return (
    lowered === "h1" ||
    lowered === "h2" ||
    lowered === "h3" ||
    lowered === "h4" ||
    lowered === "h5" ||
    lowered === "h6"
  );
}

/** Collects ancestor chain from the element's parent up to the document root. */
function collectHtmlAncestors(target: HtmlElement, doc: HtmlDocument): HtmlElement[] {
  const parents = new Map<HtmlElement, HtmlElement>();
  const indexNode = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    for (const child of node.children) {
      if (child.kind === "HtmlElement") parents.set(child, node);
      indexNode(child);
    }
  };
  for (const child of doc.children) indexNode(child);
  const out: HtmlElement[] = [];
  let cur = parents.get(target);
  while (cur) {
    out.push(cur);
    cur = parents.get(cur);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const table of findJsxElementsByTag(module, "table")) {
    if (isLayoutJsxTable(table)) continue;
    if (!hasJsxDataCells(table)) continue;
    if (hasJsxAccessibleName(table)) continue;
    emit(buildJsxViolation(table, module));
  }
}

function isLayoutJsxTable(table: JsxElement): boolean {
  const role = getJsxAttributeString(table, "role");
  if (role === null) return false;
  const lowered = role.toLowerCase();
  return lowered === "presentation" || lowered === "none";
}

function hasJsxDataCells(table: JsxElement): boolean {
  let found = false;
  const visit = (node: JsxNode): void => {
    if (found) return;
    if (node.kind !== "JsxElement") return;
    const tag = node.tagName;
    if (tag === "table") return;
    if (tag === "td" || tag === "th") {
      found = true;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return found;
}

function hasJsxAccessibleName(table: JsxElement): boolean {
  if (hasJsxCaptionChild(table)) return true;

  const ariaLabel = getJsxAttributeString(table, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  // aria-label bound to an expression we can't read statically — surface
  // as labeled (agent reviews source).
  if (ariaLabel === null && hasJsxAttribute(table, "aria-label")) return true;

  const ariaLabelledBy = getJsxAttributeString(table, "aria-labelledby");
  if (ariaLabelledBy !== null && ariaLabelledBy.trim().length > 0) return true;
  if (ariaLabelledBy === null && hasJsxAttribute(table, "aria-labelledby")) return true;

  const title = getJsxAttributeString(table, "title");
  if (title !== null && title.trim().length > 0) return true;
  if (title === null && hasJsxAttribute(table, "title")) return true;

  return false;
}

function hasJsxCaptionChild(table: JsxElement): boolean {
  let found = false;
  const visit = (node: JsxNode): void => {
    if (found) return;
    if (node.kind !== "JsxElement") return;
    const tag = node.tagName;
    if (tag === "table") return;
    if (tag === "caption") {
      if (jsxHasContentChildren(node) || jsxTextContent(node).length > 0) found = true;
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of table.children) visit(child);
  return found;
}

function buildJsxViolation(
  table: JsxElement,
  module: TsxModule,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  evidence?: ViolationEvidence;
} {
  const hint = inferJsxCaptionHint(table, module);
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: table.loc.start.line,
      column: table.loc.start.column,
    },
    message:
      "<table> has data cells but no <caption>, aria-label, aria-labelledby, or title — screen readers announce only the dimensions, not what the table represents.",
    suggestion: buildSuggestion(hint),
    ...(hint.precedingHeading ? { evidence: precedingHeadingEvidence(hint.precedingHeading) } : {}),
  };
}

function inferJsxCaptionHint(table: JsxElement, module: TsxModule): CaptionHint {
  const parents = buildJsxParentMap(module);
  const figcaption = findJsxFigcaptionSibling(table, parents);
  if (figcaption) {
    const text = jsxTextContent(figcaption);
    if (text.length > 0) return { inferredLabel: text, inferredFrom: "figcaption-sibling" };
  }
  const heading = findJsxPrecedingHeading(table, parents);
  if (heading) {
    const text = jsxTextContent(heading);
    if (text.length > 0) {
      const id = getJsxAttributeString(heading, "id");
      const headingInfo: PrecedingHeadingInfo = {
        tag: heading.tagName,
        line: heading.loc.start.line,
        ...(id !== null && id.trim().length > 0 ? { id: id.trim() } : {}),
      };
      return {
        inferredLabel: text,
        inferredFrom: "preceding-heading",
        precedingHeading: headingInfo,
      };
    }
  }
  return { inferredLabel: "", inferredFrom: "none" };
}

type JsxParentMap = Map<JsxElement, JsxElement>;

function buildJsxParentMap(module: TsxModule): JsxParentMap {
  const parents: JsxParentMap = new Map();
  const index = (element: JsxElement): void => {
    for (const child of element.children) {
      if (child.kind !== "JsxElement") continue;
      parents.set(child, element);
      index(child);
    }
  };
  for (const root of module.jsxElements) index(root);
  return parents;
}

function collectJsxAncestors(target: JsxElement, parents: JsxParentMap): JsxElement[] {
  const out: JsxElement[] = [];
  let cur = parents.get(target);
  while (cur) {
    out.push(cur);
    cur = parents.get(cur);
  }
  return out;
}

function findJsxFigcaptionSibling(
  table: JsxElement,
  parents: JsxParentMap,
): JsxElement | undefined {
  for (const ancestor of collectJsxAncestors(table, parents)) {
    if (ancestor.tagName !== "figure") continue;
    for (const child of ancestor.children) {
      if (child.kind !== "JsxElement") continue;
      if (child.tagName === "figcaption") return child;
    }
  }
  return undefined;
}

function findJsxPrecedingHeading(table: JsxElement, parents: JsxParentMap): JsxElement | undefined {
  const chain = [table, ...collectJsxAncestors(table, parents)];
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!(child && parent)) continue;
    const idx = parent.children.indexOf(child);
    for (let j = idx - 1; j >= 0; j--) {
      const sib = parent.children[j];
      if (!sib || sib.kind !== "JsxElement") continue;
      if (isHeadingTag(sib.tagName)) return sib;
    }
  }
  return undefined;
}
