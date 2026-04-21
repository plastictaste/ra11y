/**
 * Rule: pointer/stretched-link-multiple-in-container
 * Satisfies: wcag22:2.4.4, wcag21:2.4.4
 * Spec: https://www.w3.org/TR/WCAG22/#link-purpose-in-context
 *
 * > The purpose of each link can be determined from the link text alone
 * > or from the link text together with its programmatically determined
 * > link context, except where the purpose of the link would be
 * > ambiguous to users in general.
 *
 * Source: https://www.w3.org/TR/WCAG22/#link-purpose-in-context
 *
 * Flags the Bootstrap "stretched-link" antipattern: when two or more
 * anchors carrying the `stretched-link` helper share the same positioned
 * ancestor (typically a `.card`), the first stretched anchor fills the
 * entire container via its `::after` overlay, and every subsequent one
 * is stacked on top of (or underneath) it. The activation target of
 * each additional link becomes indistinguishable from the first — a
 * pointer/tap on any pixel of the card activates whichever anchor
 * happens to win the z-index race, so the *purpose* of each link can
 * no longer be determined from the link-text-in-context pair the user
 * actually activates.
 *
 * Bootstrap's own `helpers/stretched-link.mdx` documents the rule in
 * prose ("Due to the way CSS `position` works, stretched links cannot
 * be mixed with other stretched-link elements inside the same
 * positioned container"). The scanner encodes that prose rule as a
 * static check against the markup.
 *
 * Static-analysis scope: we can only reliably identify the positioned
 * ancestor from markup. The deterministic signals are (a) Bootstrap's
 * `.card` (position: relative by default via the framework's CSS), (b)
 * the `.position-relative` / `.position-absolute` / `.position-sticky`
 * / `.position-fixed` utility classes, and (c) an inline
 * `style="position: ..."` declaration. That matches the real-world
 * authored-in-markup surface; a positioned ancestor established by a
 * CSS file alone is a runtime concern the agent reads source for.
 *
 * Document-scoped: builds a child→parent index, groups every
 * `.stretched-link` anchor by its nearest positioned ancestor, and
 * emits one violation per *additional* link in a group — the first one
 * is legitimate, every sibling is the conflict.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

/** Class names that establish a positioned ancestor from markup alone. */
const POSITIONED_ANCESTOR_CLASSES: ReadonlySet<string> = new Set([
  // Bootstrap cards default to position: relative via the framework's CSS.
  // Cards are the canonical stretched-link container.
  "card",
  // Bootstrap position utilities.
  "position-relative",
  "position-absolute",
  "position-sticky",
  "position-fixed",
]);

/** `position` values that take an element out of static flow. */
const POSITIONED_STYLE_VALUES: ReadonlySet<string> = new Set([
  "relative",
  "absolute",
  "sticky",
  "fixed",
]);

export const rule = defineRule({
  id: "pointer/stretched-link-multiple-in-container",
  satisfies: ["wcag22:2.4.4", "wcag21:2.4.4"],
  severity: "error",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Two or more `.stretched-link` anchors must not share the same positioned ancestor — the first overlay covers the entire container, leaving every subsequent link without a distinguishable activation target.",
    rationale:
      "Bootstrap's `.stretched-link` helper expands an anchor's hit area to fill its nearest positioned ancestor via a `::after` overlay. If a card contains two stretched links, only one activation target exists for the whole card — the one whose overlay wins the z-index race — and the purpose of every other link can no longer be determined from the link-text-in-context pair the user actually activates.",
    goodExample: `<div class="card">\n  <div class="card-body">\n    <h5 class="card-title">Product</h5>\n    <a href="/product" class="stretched-link">View product</a>\n  </div>\n</div>`,
    badExample: `<div class="card">\n  <div class="card-body">\n    <h5 class="card-title">Product</h5>\n    <a href="/product" class="stretched-link">View product</a>\n    <a href="/compare" class="stretched-link">Compare</a>\n  </div>\n</div>`,
    normativeQuote:
      "The purpose of each link can be determined from the link text alone or from the link text together with its programmatically determined link context, except where the purpose of the link would be ambiguous to users in general.",
    references: [
      "https://www.w3.org/TR/WCAG22/#link-purpose-in-context",
      "https://getbootstrap.com/docs/5.3/helpers/stretched-link/",
    ],
  },
  afterFile(ctx) {
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
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const parentOf = buildHtmlParentMap(doc);
  const groups = new Map<HtmlElement, HtmlElement[]>();
  for (const el of walkHtmlElements(doc)) {
    if (!isStretchedLinkHtml(el)) continue;
    const ancestor = findPositionedAncestorHtml(el, parentOf);
    if (!ancestor) continue;
    const bucket = groups.get(ancestor) ?? [];
    bucket.push(el);
    groups.set(ancestor, bucket);
  }
  for (const [ancestor, members] of groups) {
    if (members.length < 2) continue;
    emitHtmlViolations(ancestor, members, emit);
  }
}

function emitHtmlViolations(
  ancestor: HtmlElement,
  members: readonly HtmlElement[],
  emit: Emit,
): void {
  const first = members[0];
  if (!first) return;
  const ancestorDesc = describeHtml(ancestor);
  for (let i = 1; i < members.length; i++) {
    const current = members[i];
    if (!current) continue;
    emit(buildViolation(ancestorDesc, members.length, first.loc.start.line, current.loc.start));
  }
}

function isStretchedLinkHtml(element: HtmlElement): boolean {
  if (element.tagName.toLowerCase() !== "a") return false;
  return hasClassHtml(element, "stretched-link");
}

function findPositionedAncestorHtml(
  element: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): HtmlElement | null {
  let parent = parentOf.get(element);
  while (parent) {
    if (isPositionedAncestorHtml(parent)) return parent;
    parent = parentOf.get(parent);
  }
  return null;
}

function isPositionedAncestorHtml(element: HtmlElement): boolean {
  for (const cls of readClassesHtml(element)) {
    if (POSITIONED_ANCESTOR_CLASSES.has(cls)) return true;
  }
  const style = getHtmlAttribute(element, "style");
  if (style && hasPositionedInlineStyle(style)) return true;
  return false;
}

function hasClassHtml(element: HtmlElement, needle: string): boolean {
  for (const cls of readClassesHtml(element)) {
    if (cls === needle) return true;
  }
  return false;
}

function readClassesHtml(element: HtmlElement): readonly string[] {
  const raw = getHtmlAttribute(element, "class");
  if (raw === null) return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

function describeHtml(element: HtmlElement): string {
  const tag = element.tagName.toLowerCase();
  const classes = readClassesHtml(element);
  const card = classes.find((c) => c === "card");
  if (card) return `<${tag} class="card">`;
  const pos = classes.find((c) => POSITIONED_ANCESTOR_CLASSES.has(c));
  if (pos) return `<${tag} class="${pos}">`;
  return `<${tag}>`;
}

function buildHtmlParentMap(doc: HtmlDocument): Map<HtmlElement, HtmlElement> {
  const parentOf = new Map<HtmlElement, HtmlElement>();
  const visit = (node: HtmlNode, parent: HtmlElement | null): void => {
    if (node.kind !== "HtmlElement") return;
    if (parent) parentOf.set(node, parent);
    for (const child of node.children) visit(child, node);
  };
  for (const top of doc.children) visit(top, null);
  return parentOf;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  const parentOf = buildJsxParentMap(module);
  const groups = new Map<JsxElement, JsxElement[]>();
  for (const el of walkJsxElements(module)) {
    if (!isStretchedLinkJsx(el)) continue;
    const ancestor = findPositionedAncestorJsx(el, parentOf);
    if (!ancestor) continue;
    const bucket = groups.get(ancestor) ?? [];
    bucket.push(el);
    groups.set(ancestor, bucket);
  }
  for (const [ancestor, members] of groups) {
    if (members.length < 2) continue;
    emitJsxViolations(ancestor, members, emit);
  }
}

function emitJsxViolations(ancestor: JsxElement, members: readonly JsxElement[], emit: Emit): void {
  const first = members[0];
  if (!first) return;
  const ancestorDesc = describeJsx(ancestor);
  for (let i = 1; i < members.length; i++) {
    const current = members[i];
    if (!current) continue;
    emit(buildViolation(ancestorDesc, members.length, first.loc.start.line, current.loc.start));
  }
}

function isStretchedLinkJsx(element: JsxElement): boolean {
  if (element.tagName !== "a") return false;
  return hasClassJsx(element, "stretched-link");
}

function findPositionedAncestorJsx(
  element: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): JsxElement | null {
  let parent = parentOf.get(element);
  while (parent) {
    if (isPositionedAncestorJsx(parent)) return parent;
    parent = parentOf.get(parent);
  }
  return null;
}

function isPositionedAncestorJsx(element: JsxElement): boolean {
  for (const cls of readClassesJsx(element)) {
    if (POSITIONED_ANCESTOR_CLASSES.has(cls)) return true;
  }
  const style = getJsxAttributeString(element, "style");
  if (style && hasPositionedInlineStyle(style)) return true;
  return false;
}

function hasClassJsx(element: JsxElement, needle: string): boolean {
  for (const cls of readClassesJsx(element)) {
    if (cls === needle) return true;
  }
  return false;
}

function readClassesJsx(element: JsxElement): readonly string[] {
  // Accept both React's `className` and HTML-style `class` that authors
  // sometimes paste into JSX. Expression values (`className={foo}`) stay
  // unresolved — classList we can't see is a false-negative the agent
  // handles by reading source.
  const raw =
    getJsxAttributeString(element, "className") ?? getJsxAttributeString(element, "class");
  if (raw === null) return [];
  return raw.split(/\s+/).filter((s) => s.length > 0);
}

function describeJsx(element: JsxElement): string {
  const tag = element.tagName;
  const classes = readClassesJsx(element);
  const card = classes.find((c) => c === "card");
  if (card) return `<${tag} className="card">`;
  const pos = classes.find((c) => POSITIONED_ANCESTOR_CLASSES.has(c));
  if (pos) return `<${tag} className="${pos}">`;
  return `<${tag}>`;
}

function buildJsxParentMap(module: TsxModule): Map<JsxElement, JsxElement> {
  const parentOf = new Map<JsxElement, JsxElement>();
  const visit = (node: JsxNode, parent: JsxElement | null): void => {
    if (node.kind !== "JsxElement") return;
    if (parent) parentOf.set(node, parent);
    for (const child of node.children) visit(child, node);
  };
  for (const top of module.jsxElements) visit(top, null);
  return parentOf;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * True when a `style="..."` attribute value contains a `position:
 * <non-static>` declaration. Parses conservatively: we split on `;`,
 * then match the `property: value` shape, trimming whitespace and
 * stripping trailing `!important`. A malformed style string (missing
 * colon, unterminated value) produces no match — the agent can still
 * read the source if our parser disagrees with the browser's.
 */
function hasPositionedInlineStyle(style: string): boolean {
  for (const rawDecl of style.split(";")) {
    const decl = rawDecl.trim();
    if (decl.length === 0) continue;
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    if (prop !== "position") continue;
    const value = decl
      .slice(colon + 1)
      .trim()
      .replace(/!important\s*$/i, "")
      .trim()
      .toLowerCase();
    if (POSITIONED_STYLE_VALUES.has(value)) return true;
  }
  return false;
}

function buildViolation(
  ancestorDesc: string,
  total: number,
  firstLine: number,
  loc: { line: number; column: number },
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<a class="stretched-link"> shares its positioned ancestor ${ancestorDesc} with ${total - 1} other stretched-link anchor${total - 1 === 1 ? "" : "s"} (first one opened on line ${firstLine}) — only one stretched link can occupy a positioned container, so the activation target of this link is not distinguishable from the first.`,
    suggestion: `Either drop the \`stretched-link\` class from this anchor and style it as a regular inline link, or move it out of ${ancestorDesc} into its own positioned wrapper. The Bootstrap helper only works when a single anchor owns the overlay — additional links inside the same container stack unpredictably and give users no distinguishable tap target for anything beyond the first.`,
  };
}
