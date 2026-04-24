/**
 * Rule: forms/label-adjacent-mismatch
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:3.3.2, wcag21:3.3.2, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through presentation
 * > can be programmatically determined or are available in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * The copy-paste mismatch shape:
 *
 *   <label for="email">Password:</label>
 *   <input id="password" type="password">
 *   ...
 *   <input id="email" type="text">
 *
 * The label's `for=` resolves to a real id elsewhere in the document, so
 * `forms/label-for-id-mismatch` (which fires on dangling refs) declines.
 * The label DOES have a `for`, so `forms/label-adjacent-unassociated`
 * (which fires on missing for=) also declines. Net result: assistive tech
 * announces the email label twice (once attached to the email input
 * elsewhere, once spoken aloud as it sits above the password field), and
 * the password field reports as unlabeled.
 *
 * The fix predicate fires when ALL of:
 *   1. `<label for="X">` carries a non-empty `for=`,
 *   2. id `X` resolves to some element in the same document (so this
 *      isn't a dangling-for case — `forms/label-for-id-mismatch` owns
 *      that), and
 *   3. the label's immediately-following sibling element is a labelable
 *      control (input/select/textarea, excluding submit/hidden/button/
 *      reset/image), AND
 *   4. that adjacent control's `id` (if present) is not `X`.
 *
 * Edge cases:
 *   - The resolved id `X` may attach to a `<button>`, `<a>`, or other
 *     non-form element — still flagged. The label's `for=` is wrong for
 *     the adjacent input regardless of what it does match.
 *   - The adjacent control may have no id at all — still flagged. The
 *     intent ("this label belongs to the next control") is contradicted
 *     by the `for=` value either way.
 *   - JSX uses `htmlFor` (and tolerates literal `for`); the predicate
 *     accepts both.
 *   - Whitespace text nodes and comments between label and control are
 *     transparent (formatting, not content). Any non-whitespace text or
 *     intervening element breaks adjacency — let the agent read the file.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
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

const LABELABLE_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

// Input `type` values that do not take a label (submit/reset/button get
// their accessible name from `value`; hidden inputs aren't user-facing;
// image inputs use `alt=`). Mirrors `forms/label-adjacent-unassociated`
// so the two sibling rules agree on scope.
const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

export const rule = defineRule({
  id: "forms/label-adjacent-mismatch",
  satisfies: [
    "wcag22:1.3.1",
    "wcag21:1.3.1",
    "wcag22:3.3.2",
    "wcag21:3.3.2",
    "wcag22:4.1.2",
    "wcag21:4.1.2",
  ],
  severity: "error",
  scope: "document",
  // Both arms of the fix require human-or-agent judgment: the for= might
  // belong to the adjacent control (typo / copy-paste residue), or the
  // adjacent control might be out of order (someone pasted it under the
  // wrong label). Static analysis sees the mismatch but can't pick the
  // arm safely — point the agent at the file.
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "A <label for='X'> immediately preceding a labelable control whose id is not X (and where X resolves to a different element in the same document) is a copy-paste mismatch — the visible label associates with the wrong control.",
    rationale:
      "Sighted users see a label sitting on top of a control and read them as a pair. When the label's for= resolves to a different element elsewhere in the document, assistive tech announces the label as the name of THAT element (often double-announcing it) while leaving the adjacent control unlabeled. forms/label-for-id-mismatch only catches dangling references; forms/label-adjacent-unassociated only catches missing for=. The mismatched-but-resolving case escapes both, even though the visual intent (label belongs to the adjacent control) is plain.",
    goodExample: `<label for="password">Password:</label>\n<input id="password" type="password">`,
    badExample: `<label for="email">Password:</label>\n<input id="password" type="password">\n<input id="email" type="text">`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H44",
      "https://html.spec.whatwg.org/multipage/forms.html#the-label-element",
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
  const ids = collectHtmlIds(doc);
  // Index parent → ordered children so we can find the label's next-element
  // sibling without re-walking from the document root for each label.
  const parentChildren = indexHtmlParentChildren(doc);
  for (const label of findHtmlElementsByTag(doc, "label")) {
    const hit = applicableHtmlMismatch(label, ids, parentChildren);
    if (hit === null) continue;
    emit(buildHtmlEmission(label, hit.adjacent, hit.target));
  }
}

interface HtmlMismatchHit {
  readonly adjacent: HtmlElement;
  readonly target: string;
}

function applicableHtmlMismatch(
  label: HtmlElement,
  ids: ReadonlySet<string>,
  parentChildren: ReadonlyMap<HtmlElement, HtmlSiblingRef>,
): HtmlMismatchHit | null {
  const target = getHtmlAttribute(label, "for");
  if (target === null || target.length === 0) return null;
  // Dangling for= is forms/label-for-id-mismatch's territory. Skip so we
  // don't double-flag the same source line with two rules saying
  // overlapping things.
  if (!ids.has(target)) return null;
  const siblings = parentChildren.get(label);
  if (!siblings) return null;
  const adjacent = findFollowingHtmlElementSibling(siblings.children, siblings.index);
  if (adjacent === null) return null;
  if (!LABELABLE_TAGS.has(adjacent.tagName.toLowerCase())) return null;
  if (isExcludedHtmlControl(adjacent)) return null;
  const adjacentId = getHtmlAttribute(adjacent, "id");
  if (adjacentId === target) return null;
  return { adjacent, target };
}

function buildHtmlEmission(
  label: HtmlElement,
  adjacent: HtmlElement,
  target: string,
): Parameters<Emit>[0] {
  const adjacentId = getHtmlAttribute(adjacent, "id");
  const adjacentTag = adjacent.tagName.toLowerCase();
  return {
    severity: "error",
    location: {
      filePath: "",
      line: label.loc.start.line,
      column: label.loc.start.column,
    },
    message: buildMessage(target, adjacentTag, adjacentId, "for"),
    suggestion: buildSuggestion(target, adjacentTag, adjacentId, "for"),
  };
}

function collectHtmlIds(doc: HtmlDocument): Set<string> {
  const ids = new Set<string>();
  for (const el of walkHtmlElements(doc)) {
    const id = getHtmlAttribute(el, "id");
    if (id !== null && id.length > 0) ids.add(id);
  }
  return ids;
}

interface HtmlSiblingRef {
  readonly children: readonly HtmlNode[];
  readonly index: number;
}

/**
 * Build a label → { siblings, index-of-label } map. Visiting the
 * document once and stashing the parent's children list on each label
 * lets the main loop ask "what comes after this label?" in O(1) per
 * label rather than re-walking from the root.
 */
function indexHtmlParentChildren(doc: HtmlDocument): Map<HtmlElement, HtmlSiblingRef> {
  const out = new Map<HtmlElement, HtmlSiblingRef>();
  visit(doc.children);
  return out;

  function visit(children: readonly HtmlNode[]): void {
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child || child.kind !== "HtmlElement") continue;
      if (child.tagName.toLowerCase() === "label") {
        out.set(child, { children, index: i });
      }
      visit(child.children);
    }
  }
}

function findFollowingHtmlElementSibling(
  children: readonly HtmlNode[],
  index: number,
): HtmlElement | null {
  for (let i = index + 1; i < children.length; i += 1) {
    const sibling = children[i];
    if (!sibling) return null;
    if (sibling.kind === "HtmlElement") return sibling;
    if (sibling.kind === "HtmlText") {
      // Any non-whitespace text breaks the "label sits directly above
      // the input" claim — let the agent read the file before we
      // mechanically reason about the association.
      if (sibling.value.trim().length > 0) return null;
    }
    // Comments, doctype nodes are transparent (no rendered content).
  }
  return null;
}

function isExcludedHtmlControl(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type")?.toLowerCase();
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  const ids = collectJsxIds(module);
  const parentChildren = indexJsxParentChildren(module);
  for (const label of findJsxElementsByTag(module, "label")) {
    const hit = applicableJsxMismatch(label, ids, parentChildren);
    if (hit === null) continue;
    emit(buildJsxEmission(label, hit.adjacent, hit.target));
  }
}

interface JsxMismatchHit {
  readonly adjacent: JsxElement;
  readonly target: string;
}

function applicableJsxMismatch(
  label: JsxElement,
  ids: ReadonlySet<string>,
  parentChildren: ReadonlyMap<JsxElement, JsxSiblingRef>,
): JsxMismatchHit | null {
  const target = getJsxLabelFor(label);
  if (target === null || target.length === 0) return null;
  if (!ids.has(target)) return null;
  const siblings = parentChildren.get(label);
  if (!siblings) return null;
  const adjacent = findFollowingJsxElementSibling(siblings.children, siblings.index);
  if (adjacent === null) return null;
  if (!LABELABLE_TAGS.has(adjacent.tagName.toLowerCase())) return null;
  if (isExcludedJsxControl(adjacent)) return null;
  // Spread props could supply a matching id at runtime — we can't see
  // through them. Stay silent to avoid a false positive on the
  // canonical `<input {...register("password")} />` pattern.
  if (adjacent.hasSpreadProps) return null;
  const adjacentId = getJsxAttributeString(adjacent, "id");
  if (adjacentId === target) return null;
  return { adjacent, target };
}

function buildJsxEmission(
  label: JsxElement,
  adjacent: JsxElement,
  target: string,
): Parameters<Emit>[0] {
  const adjacentId = getJsxAttributeString(adjacent, "id");
  const adjacentTag = adjacent.tagName.toLowerCase();
  return {
    severity: "error",
    location: {
      filePath: "",
      line: label.loc.start.line,
      column: label.loc.start.column,
    },
    message: buildMessage(target, adjacentTag, adjacentId, "htmlFor"),
    suggestion: buildSuggestion(target, adjacentTag, adjacentId, "htmlFor"),
  };
}

/** React uses `htmlFor`; authors sometimes still write `for`. Accept both. */
function getJsxLabelFor(label: JsxElement): string | null {
  return getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
}

function collectJsxIds(module: TsxModule): Set<string> {
  const ids = new Set<string>();
  for (const el of walkJsxElements(module)) {
    const id = getJsxAttributeString(el, "id");
    if (id !== null && id.length > 0) ids.add(id);
  }
  return ids;
}

interface JsxSiblingRef {
  readonly children: readonly JsxNode[];
  readonly index: number;
}

function indexJsxParentChildren(module: TsxModule): Map<JsxElement, JsxSiblingRef> {
  const out = new Map<JsxElement, JsxSiblingRef>();
  // Top-level roots also constitute a sibling array — fragments at the
  // file root produce label/input pairs as adjacent jsxElements entries.
  const roots = module.jsxElements;
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    if (!root) continue;
    if (root.tagName === "label") out.set(root, { children: roots, index: i });
    visit(root.children);
  }
  return out;

  function visit(children: readonly JsxNode[]): void {
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child || child.kind !== "JsxElement") continue;
      // Match case-insensitively against the lowercase native spelling;
      // `<Label>` is a wrapper component that may or may not render
      // <label> at runtime.
      if (child.tagName === "label") out.set(child, { children, index: i });
      visit(child.children);
    }
  }
}

function findFollowingJsxElementSibling(
  children: readonly JsxNode[],
  index: number,
): JsxElement | null {
  for (let i = index + 1; i < children.length; i += 1) {
    const sibling = children[i];
    if (!sibling) return null;
    if (sibling.kind === "JsxElement") return sibling;
    if (sibling.kind === "JsxText") {
      if (sibling.value.trim().length > 0) return null;
      continue;
    }
    if (sibling.kind === "JsxExpression") {
      // `{render()}` between label and input is opaque — we can't prove
      // the next labelable thing IS the rendered output. Stay silent.
      return null;
    }
  }
  return null;
}

function isExcludedJsxControl(el: JsxElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getJsxAttributeString(el, "type")?.toLowerCase();
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Messages — shared between HTML and JSX surfaces
// ---------------------------------------------------------------------------

function buildMessage(
  target: string,
  adjacentTag: string,
  adjacentId: string | null,
  attr: "for" | "htmlFor",
): string {
  const adjacentClause = adjacentId
    ? `but the immediately-following <${adjacentTag} id="${adjacentId}"> has a different id`
    : `but the immediately-following <${adjacentTag}> has no id at all`;
  return `<label ${attr}="${target}"> ${adjacentClause} — id="${target}" resolves to a different element in this document, so the visible label is associated with the wrong control (likely a copy-paste mismatch).`;
}

function buildSuggestion(
  target: string,
  adjacentTag: string,
  adjacentId: string | null,
  attr: "for" | "htmlFor",
): string {
  const idHint = adjacentId ? `"${adjacentId}"` : `the adjacent <${adjacentTag}>'s real id`;
  const primary = adjacentId
    ? `Change ${attr}="${target}" to ${attr}="${adjacentId}" so the label associates with the adjacent <${adjacentTag}> it visually sits above.`
    : `Add an id to the adjacent <${adjacentTag}> and change ${attr}="${target}" to match it.`;
  const verify = `Then verify the previously-correct association for id="${target}": whichever element it resolves to has lost its visible label and may need its own <label ${attr}="${target}"> nearby.`;
  const inverse = `Alternative: if the adjacent <${adjacentTag}> was inserted by mistake and id="${target}" really is the intended target, move the <label> next to ${idHint} or delete the adjacent control.`;
  return `${primary} ${verify} ${inverse}`;
}
