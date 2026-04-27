/**
 * Adjacent-unassociated label predicate, shared between
 * `forms/label-adjacent-unassociated` (consumer + emitter) and
 * `forms/labels-required` (suppression set).
 *
 * The two rules historically dual-fired on the same `<input>` whose
 * visible-but-unassociated `<label>` is a structural sibling under the
 * same parent (canonical Bootstrap-template shape:
 * `<div class="form-group"><label>Email</label><input type="email"></div>`).
 * Both findings pointed at the same defect with the same single fix
 * (add `for=`/`id=`); shipping both wasted the agent's attention budget
 * and made the more specific, mechanically-fixable signal compete with
 * the generic guidance.
 *
 * Resolution: `forms/label-adjacent-unassociated` owns the adjacent
 * shape; `forms/labels-required` re-detects the same predicate via
 * this helper and skips emission when the more specific rule will
 * speak. The adjacency evidence already lives in the unassociated
 * finding's reason text + mechanical fixPaths, so the agent loses no
 * signal — the dedup just stops doubling the count.
 *
 * Predicate: a labelable control whose immediately-preceding element
 * sibling (skipping whitespace text and comments) is a `<label>` with
 * NO `for=` / `htmlFor=` attribute and which does NOT wrap the control
 * implicitly. Matches `applicableHtmlLabel` /
 * `applicableJsxLabel` in `label-adjacent-unassociated.ts`. The
 * exclusion-bypass cases (control already carries `aria-label` /
 * `aria-labelledby`, JSX spread props) are handled symmetrically: when
 * `label-adjacent-unassociated` declines to fire on those cases,
 * `labels-required` retains its own emission, so `htmlHasLabel` /
 * `jsxHasLabel` already shadowed those paths and the suppression set
 * never picks them up.
 */

import { getHtmlAttribute, hasHtmlAttribute, hasJsxAttribute } from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

const LABELABLE_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * Walk the document and collect every labelable control on which
 * `forms/label-adjacent-unassociated` would fire. Caller (typically
 * `labels-required`) uses the returned set as a suppression filter so
 * the same defect doesn't surface twice.
 */
export function collectHtmlAdjacentUnassociatedControls(
  doc: HtmlDocument,
): ReadonlySet<HtmlElement> {
  const out = new Set<HtmlElement>();
  visitHtmlChildren(doc.children, out);
  return out;
}

function visitHtmlChildren(children: readonly HtmlNode[], out: Set<HtmlElement>): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || child.kind !== "HtmlElement") continue;
    const tag = child.tagName.toLowerCase();
    if (LABELABLE_TAGS.has(tag) && htmlControlIsAdjacentUnassociated(child, children, i)) {
      out.add(child);
    }
    visitHtmlChildren(child.children, out);
  }
}

function htmlControlIsAdjacentUnassociated(
  control: HtmlElement,
  parentChildren: readonly HtmlNode[],
  index: number,
): boolean {
  if (isExcludedHtmlControl(control)) return false;
  // Honor the explicit-author-intent channels the sibling rule honors.
  // When the control already carries an aria-label / aria-labelledby,
  // `labels-required` already considers it labeled; surfacing the
  // adjacency finding on those cases would be redundant. Mirroring the
  // sibling rule keeps the two predicates' fire-shapes aligned.
  if (htmlControlHasAriaName(control)) return false;
  const label = findPrecedingHtmlLabelSibling(parentChildren, index);
  if (label === null) return false;
  if (hasHtmlAttribute(label, "for")) return false;
  if (htmlLabelWrapsControl(label)) return false;
  return true;
}

function isExcludedHtmlControl(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type")?.toLowerCase();
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

function htmlControlHasAriaName(el: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
  return false;
}

function findPrecedingHtmlLabelSibling(
  children: readonly HtmlNode[],
  index: number,
): HtmlElement | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const sibling = children[i];
    if (!sibling) return null;
    if (sibling.kind === "HtmlElement") {
      return sibling.tagName.toLowerCase() === "label" ? sibling : null;
    }
    if (sibling.kind === "HtmlText") {
      // Non-whitespace prose between label and control weakens the
      // visual association — same call the sibling rule makes.
      if (sibling.value.trim().length > 0) return null;
    }
    // Comments / doctype are render-invisible; keep walking back.
  }
  return null;
}

function htmlLabelWrapsControl(label: HtmlElement): boolean {
  for (const descendant of walkHtmlElementDescendants(label)) {
    if (LABELABLE_TAGS.has(descendant.tagName.toLowerCase())) return true;
  }
  return false;
}

function* walkHtmlElementDescendants(root: HtmlElement): Iterable<HtmlElement> {
  for (const child of root.children) {
    if (child.kind === "HtmlElement") {
      yield child;
      yield* walkHtmlElementDescendants(child);
    }
  }
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

/**
 * JSX equivalent of {@link collectHtmlAdjacentUnassociatedControls}.
 * Walks every JSX parent (the module's top-level roots treated as a
 * synthetic root + every `JsxElement.children` array) and collects
 * labelable controls whose preceding element sibling is an
 * unassociated `<label>` — the predicate `label-adjacent-unassociated`
 * fires on.
 */
export function collectJsxAdjacentUnassociatedControls(
  module: TsxModule,
): ReadonlySet<JsxElement> {
  const out = new Set<JsxElement>();
  visitJsxRoots(module.jsxElements, out);
  return out;
}

function visitJsxRoots(roots: readonly JsxElement[], out: Set<JsxElement>): void {
  // Treat the module's top-level roots as a sibling array so a fragment
  // like `<><label/><input/></>` flattening onto roots still matches.
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    if (!root) continue;
    const tag = root.tagName.toLowerCase();
    if (LABELABLE_TAGS.has(tag) && jsxControlIsAdjacentUnassociated(root, roots, i)) {
      out.add(root);
    }
    visitJsxChildren(root.children, out);
  }
}

function visitJsxChildren(children: readonly JsxNode[], out: Set<JsxElement>): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || child.kind !== "JsxElement") continue;
    const tag = child.tagName.toLowerCase();
    if (LABELABLE_TAGS.has(tag) && jsxControlIsAdjacentUnassociated(child, children, i)) {
      out.add(child);
    }
    visitJsxChildren(child.children, out);
  }
}

function jsxControlIsAdjacentUnassociated(
  control: JsxElement,
  parentChildren: readonly JsxNode[],
  index: number,
): boolean {
  if (isExcludedJsxControl(control)) return false;
  if (jsxControlHasAriaName(control)) return false;
  // `label-adjacent-unassociated` bails on spread-bearing controls
  // because the spread may carry an external aria-label / id. Matching
  // that branch keeps the two predicates' fire-shapes aligned —
  // suppressing `labels-required` here would silently hide the spread
  // primitive's `severity: "info"` finding.
  if (control.hasSpreadProps) return false;
  const label = findPrecedingJsxLabelSibling(parentChildren, index);
  if (label === null) return false;
  if (hasJsxAttribute(label, "htmlFor") || hasJsxAttribute(label, "for")) return false;
  if (jsxLabelWrapsControl(label)) return false;
  return true;
}

function isExcludedJsxControl(el: JsxElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = readJsxLiteralType(el);
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

function readJsxLiteralType(el: JsxElement): string | null {
  for (const attr of el.attributes) {
    if (attr.name !== "type") continue;
    if (!attr.value) return null;
    if (attr.value.kind === "StringLiteral") return attr.value.value.toLowerCase();
    return null;
  }
  return null;
}

function jsxControlHasAriaName(el: JsxElement): boolean {
  for (const attr of el.attributes) {
    if (attr.name === "aria-label") {
      if (!attr.value) return false;
      if (attr.value.kind === "StringLiteral") return attr.value.value.trim().length > 0;
      // Expression-valued aria-label — runtime-computed name. The
      // sibling rule trusts it; mirror that here.
      return true;
    }
    if (attr.name === "aria-labelledby") return true;
  }
  return false;
}

function findPrecedingJsxLabelSibling(
  children: readonly JsxNode[],
  index: number,
): JsxElement | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const sibling = children[i];
    if (!sibling) return null;
    if (sibling.kind === "JsxElement") {
      // Lowercase `<label>` only — uppercase `<Label>` is a wrapper
      // component the agent should read the source for.
      return sibling.tagName === "label" ? sibling : null;
    }
    if (sibling.kind === "JsxText") {
      if (sibling.value.trim().length > 0) return null;
      continue;
    }
    if (sibling.kind === "JsxExpression") {
      // Opaque expression child — same call the sibling rule makes.
      return null;
    }
  }
  return null;
}

function jsxLabelWrapsControl(label: JsxElement): boolean {
  for (const descendant of walkJsxElementDescendants(label)) {
    if (LABELABLE_TAGS.has(descendant.tagName.toLowerCase())) return true;
  }
  return false;
}

function* walkJsxElementDescendants(root: JsxElement): Iterable<JsxElement> {
  for (const child of root.children) {
    if (child.kind === "JsxElement") {
      yield child;
      yield* walkJsxElementDescendants(child);
    }
  }
}
