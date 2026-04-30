/**
 * Rule: semantics/interactive-ancestor-of-heading
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags the "card link" anti-pattern: an `<a href>` or `<button>`
 * wrapping one or more block-level headings (`<h1>`-`<h6>`). When AT
 * encounters this shape it announces "link" / "button" first and the
 * heading semantics are subsumed by the interactive role — the heading
 * outline either disappears from the screen-reader heading list (some
 * AT collapses heading-inside-link into the link's accessible name) or
 * gets announced as part of the link, so the structural relationship
 * SC 1.3.1 protects is no longer programmatically determinable.
 *
 * Idiomatic fix: invert the nesting. Place the `<a>` / `<button>`
 * inside the heading, not around it: `<h2><a href="post.html">…</a></h2>`.
 * The heading then enumerates in the heading list and the interactive
 * descendant retains its own role.
 *
 * Document-scoped: builds a child→parent index per AST and walks up
 * from every heading element looking for an interactive ancestor.
 * One violation per (interactive ancestor, heading descendant) pair.
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
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const rule = defineRule({
  id: "semantics/interactive-ancestor-of-heading",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "error",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".tsx", ".jsx", ".html", ".htm"],
  },
  docs: {
    description:
      "Block-level headings (<h1>-<h6>) must not sit inside an <a href> or <button> ancestor — the interactive role consumes the heading semantics so the structural relationship is no longer programmatically determinable.",
    rationale:
      "Wrapping a heading in an interactive control (the 'card link' anti-pattern) makes assistive technology announce 'link' / 'button' first; many AT either drop the heading from the heading-navigation list entirely or fold its text into the link's accessible name. Either way, the SC 1.3.1 requirement that heading structure be programmatically determinable is broken. Inverting the nesting — placing the interactive element *inside* the heading — preserves both the heading outline and the interactive control's own role.",
    goodExample: `<h2><a href="post.html">Post Title</a></h2>`,
    badExample: `<a href="post.html"><h2>Post Title</h2><h3>Subhead</h3></a>`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G115",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G117",
      "https://html.spec.whatwg.org/multipage/sections.html#headings-and-sections",
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
  for (const el of walkHtmlElements(doc)) {
    const tag = el.tagName.toLowerCase();
    if (!HEADING_TAGS.has(tag)) continue;
    if (!hasAccessibleHeadingTextHtml(el)) continue;
    const ancestor = findInteractiveHtmlAncestor(el, parentOf);
    if (!ancestor) continue;
    emit(
      buildViolation(describeHtmlAncestor(ancestor), tag, ancestor.loc.start.line, el.loc.start),
    );
  }
}

/**
 * True when the heading carries some accessible name — either textual
 * descendants, an `aria-label`, an `aria-labelledby` reference, or a
 * descendant `<img alt="non-empty">`. A heading whose only descendants
 * are `aria-hidden` glyphs or alt-less images contributes no accessible
 * name; the rule stays quiet on those (the empty-heading rule is the
 * channel for those, on a different SC). The card-link anti-pattern
 * the rule targets requires the heading to actually announce text — an
 * empty-named heading inside `<a href>` is empty either way and the
 * interactive role doesn't subsume anything.
 */
function hasAccessibleHeadingTextHtml(element: HtmlElement): boolean {
  if (htmlTextContent(element).length > 0) return true;
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(element, "aria-labelledby")) return true;
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
    if (hasChildImageWithAltHtml(child)) return true;
  }
  return false;
}

function findInteractiveHtmlAncestor(
  element: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): HtmlElement | null {
  let parent = parentOf.get(element);
  while (parent) {
    if (isInteractiveAncestorHtml(parent)) return parent;
    parent = parentOf.get(parent);
  }
  return null;
}

/**
 * The "interactive ancestor" predicate is intentionally narrower than
 * the general nested-interactive predicate. The card-link anti-pattern
 * names two specific shapes:
 *
 *   - `<a href="...">` — a real link with a destination
 *   - `<button>` — a real button (regardless of `type`)
 *
 * `<a>` without `href` is non-interactive (the spec treats it as a
 * placeholder); a `<div role="button">` without a focusable tabindex /
 * handler is a semantic wrapper, not a card link. The rule deliberately
 * does NOT fire on those — the spec text the rule cites (1.3.1
 * structural relationship) is preserved when the wrapper has no
 * interactive role of its own to subsume the heading's role.
 */
function isInteractiveAncestorHtml(element: HtmlElement): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return hasHtmlAttribute(element, "href");
  if (tag === "button") return true;
  return false;
}

function describeHtmlAncestor(element: HtmlElement): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return `<a href>`;
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
  for (const el of walkJsxElements(module)) {
    if (!HEADING_TAGS.has(el.tagName)) continue;
    if (!hasAccessibleHeadingTextJsx(el)) continue;
    const ancestor = findInteractiveJsxAncestor(el, parentOf);
    if (!ancestor) continue;
    emit(
      buildViolation(
        describeJsxAncestor(ancestor),
        el.tagName,
        ancestor.loc.start.line,
        el.loc.start,
      ),
    );
  }
}

/**
 * JSX counterpart to {@link hasAccessibleHeadingTextHtml}. Expression
 * children (`<h2>{title}</h2>`) count as textual evidence — the agent
 * reading the source verifies whether the binding can resolve to empty.
 */
function hasAccessibleHeadingTextJsx(element: JsxElement): boolean {
  if (jsxTextContent(element).length > 0) return true;
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  if (hasExpressionChild(element)) return true;
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
    if (hasChildImageWithAltJsx(child)) return true;
  }
  return false;
}

function findInteractiveJsxAncestor(
  element: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): JsxElement | null {
  let parent = parentOf.get(element);
  while (parent) {
    // PascalCase components are opaque — don't traverse through them.
    // A heading inside `<Card><h2>…</h2></Card>` is the caller's choice;
    // the agent reads `Card`'s definition to verify it doesn't render
    // an outer interactive element.
    if (isJsxPascalCase(parent.tagName)) return null;
    if (isInteractiveAncestorJsx(parent)) return parent;
    parent = parentOf.get(parent);
  }
  return null;
}

function isInteractiveAncestorJsx(element: JsxElement): boolean {
  const tag = element.tagName;
  if (tag === "a") return hasJsxAttribute(element, "href");
  if (tag === "button") return true;
  return false;
}

function describeJsxAncestor(element: JsxElement): string {
  const tag = element.tagName;
  if (tag === "a") return `<a href>`;
  return `<${tag}>`;
}

function isJsxPascalCase(tag: string): boolean {
  const first = tag[0];
  return first !== undefined && first >= "A" && first <= "Z";
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
// Violation builder
// ---------------------------------------------------------------------------

function buildViolation(
  ancestorDesc: string,
  headingTag: string,
  ancestorLine: number,
  loc: { line: number; column: number },
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const headingEl = `<${headingTag}>`;
  const closeHeading = `</${headingTag}>`;
  const ancestorOpen = ancestorDesc === "<a href>" ? `<a href="...">` : ancestorDesc;
  const ancestorClose = ancestorDesc === "<a href>" ? `</a>` : `</${ancestorDesc.slice(1, -1)}>`;
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `${headingEl} sits inside ${ancestorDesc} (opened on line ${ancestorLine}) — the interactive role consumes the heading semantics. Assistive technology announces the ${ancestorDesc} role and may collapse the heading into the link/button accessible name; SC 1.3.1's structural relationship is no longer programmatically determinable.`,
    suggestion: `Invert the nesting — wrap ${ancestorDesc} inside ${headingEl} rather than around it: \`${headingEl}${ancestorOpen}title${ancestorClose}${closeHeading}\`. The heading then enumerates in the heading list, ${ancestorDesc} retains its own role, and the interactive control's accessible name is the heading text. If the surrounding ${ancestorDesc} truly needs to be the click target for the whole card, move sibling content out of ${ancestorDesc} and overlay ${ancestorDesc} on the card with CSS (e.g. \`position: absolute; inset: 0\`) so only the heading-link remains in the DOM ancestor chain.`,
  };
}
