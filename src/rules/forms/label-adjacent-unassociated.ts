/**
 * Rule: forms/label-adjacent-unassociated
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:3.3.2, wcag21:3.3.2, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through presentation
 * > can be programmatically determined or are available in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags the pervasive "visual-only label" shape:
 *
 *   <label>Length</label>
 *   <input id="length" type="number" />
 *
 * The label sits immediately above the control, which reads fine sighted,
 * but there is no `for=` attribute associating them programmatically. The
 * control has an id — so the fix is mechanical — but assistive tech sees
 * an unlabeled control and an unattached piece of text.
 *
 * Narrow shape: only fires when
 *   1. the labelable control (<input>/<select>/<textarea>) carries an id,
 *   2. the control's immediately-preceding element sibling is a <label>,
 *   3. the only nodes between label and control are whitespace text or
 *      comments (no <br>, no prose, no intervening elements — those weaken
 *      the association enough that the agent needs to read the file), and
 *   4. the label has no `for=` / `htmlFor=` attribute and does not wrap the
 *      control implicitly.
 *
 * Distinct from `forms/labels-required`. That rule fires whenever an
 * input has no accessible name at all; this one fires specifically on
 * the adjacent-but-unassociated shape. Both may fire on the same input
 * today — the agent sees both findings and the distinct suggestions tell
 * it which lever to pull (add `for=` to the existing label, vs. add a
 * label from scratch). De-overlapping the two rules is tracked as a
 * follow-up; silently suppressing one on this shape would hide the more
 * specific, mechanically-fixable signal.
 *
 * Fix is mechanical: insert `for="<id>"` into the label's open tag. When
 * the label's raw open tag is the literal `<label>` with no attributes,
 * the rule emits a concrete `fixPaths.primary.edit` pair the agent can
 * apply without reading the source. When the label already has attributes,
 * the rule ships guidance only — the exact insertion point is a style
 * call (before `class=`, after `class=`, end of tag) the author should
 * make.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { FixPaths } from "../../types/violation.ts";

const LABELABLE_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

// Input `type` values that don't take a label (submit/reset buttons get
// their accessible name from `value`; hidden inputs aren't user-facing).
// Mirrors `forms/labels-required` so the two rules agree on scope.
const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

export const rule = defineRule({
  id: "forms/label-adjacent-unassociated",
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
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "A <label> immediately preceding an <input>/<select>/<textarea> with an id must carry a matching for= attribute — without it, the association is visual-only and invisible to assistive tech.",
    rationale:
      "Sighted users see a label and a control next to each other and read them as associated. Assistive tech does not — a <label> with no `for=` (and no implicit wrapping) is announced as unrelated text, and the control is announced as unlabeled. The control already has an id, so the fix is a one-attribute edit. Catching this shape statically surfaces a pervasive tutorial-propagated pattern that `forms/labels-required` flags generically but can't fix mechanically.",
    goodExample: `<label for="length">Length</label>\n<input id="length" type="number">`,
    badExample: `<label>Length</label>\n<input id="length" type="number">`,
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
      checkHtml(ctx.ast as HtmlDocument, ctx.source, (v) => ctx.emit(v));
      return;
    }
    if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, ctx.source, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  fixPaths: FixPaths;
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, source: string, emit: Emit): void {
  for (const control of collectHtmlLabelableControls(doc)) {
    const id = getHtmlAttribute(control.el, "id");
    if (id === null || id.length === 0) continue;
    if (isExcludedHtmlControl(control.el)) continue;
    // If the control is already associated (any of the channels
    // `forms/labels-required` recognises), this rule has nothing to say.
    // We intentionally DO NOT probe for the "nested inside a <label>"
    // case here — `labels-required` covers it and this rule is scoped
    // to the sibling shape by name.
    if (isHtmlAssociatedSomeOtherWay(control.el)) continue;
    const parentChildren = control.parentChildren;
    const label = findPrecedingHtmlLabelSibling(parentChildren, control.index);
    if (label === null) continue;
    if (hasHtmlAttribute(label, "for")) continue;
    // A label that already wraps the control is an implicit-association
    // case, handled by `labels-required`. We only fire when the label
    // sits beside the control.
    if (htmlLabelWrapsControl(label)) continue;
    emit(buildHtmlViolation(label, control.el, id, source));
  }
}

interface HtmlControlRef {
  readonly el: HtmlElement;
  readonly parentChildren: readonly HtmlNode[];
  readonly index: number;
}

function collectHtmlLabelableControls(doc: HtmlDocument): readonly HtmlControlRef[] {
  const out: HtmlControlRef[] = [];
  visitHtmlChildren(doc.children, out);
  return out;
}

function visitHtmlChildren(children: readonly HtmlNode[], out: HtmlControlRef[]): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || child.kind !== "HtmlElement") continue;
    const tag = child.tagName.toLowerCase();
    if (LABELABLE_TAGS.has(tag)) {
      out.push({ el: child, parentChildren: children, index: i });
    }
    visitHtmlChildren(child.children, out);
  }
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
      // Any non-whitespace text between label and control weakens the
      // association — prose like "Please enter…" or a stray comma means
      // the label isn't immediately adjacent in any meaningful sense.
      if (sibling.value.trim().length > 0) return null;
    }
    // Comments and doctype nodes between the two are harmless — they
    // produce no rendered content and no change in visual adjacency.
  }
  return null;
}

function isExcludedHtmlControl(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type")?.toLowerCase();
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

function isHtmlAssociatedSomeOtherWay(el: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
  const title = getHtmlAttribute(el, "title");
  if (title && title.trim().length > 0) return true;
  return false;
}

function htmlLabelWrapsControl(label: HtmlElement): boolean {
  for (const descendant of walkHtmlElements(label)) {
    if (LABELABLE_TAGS.has(descendant.tagName.toLowerCase())) return true;
  }
  return false;
}

function buildHtmlViolation(
  label: HtmlElement,
  control: HtmlElement,
  id: string,
  source: string,
): Parameters<Emit>[0] {
  const edit = buildHtmlEditPair(label, id, source);
  return buildViolation({
    line: label.loc.start.line,
    column: label.loc.start.column,
    controlTag: control.tagName.toLowerCase(),
    controlType: getHtmlAttribute(control, "type"),
    id,
    edit,
    attr: "for",
  });
}

/**
 * When the label's open tag is the attribute-free literal `<label>`
 * (matched case-insensitively against the raw source), we can emit a
 * safe oldText/newText pair. Attribute-carrying open tags ship guidance
 * only — the insertion point (before/after `class=`, end of tag, etc.)
 * is a style call.
 */
function buildHtmlEditPair(
  label: HtmlElement,
  id: string,
  source: string,
): { readonly oldText: string; readonly newText: string } | null {
  const raw = source.slice(label.range.start, label.range.end);
  // Anchored match on the *start* of the label's range so a nested
  // "<label" later in the content (vanishingly unlikely) can't trip us.
  const openMatch = /^<label(\s*)>/i.exec(raw);
  if (!openMatch) return null;
  const oldText = openMatch[0];
  const newText = `<label for="${escapeAttributeValue(id)}">`;
  return { oldText, newText };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, source: string, emit: Emit): void {
  for (const control of collectJsxLabelableControls(module)) {
    const id = getJsxAttributeString(control.el, "id");
    if (id === null || id.length === 0) continue;
    if (isExcludedJsxControl(control.el)) continue;
    if (isJsxAssociatedSomeOtherWay(control.el)) continue;
    const label = findPrecedingJsxLabelSibling(control.parentChildren, control.index);
    if (label === null) continue;
    if (hasJsxAttribute(label, "htmlFor") || hasJsxAttribute(label, "for")) continue;
    if (jsxLabelWrapsControl(label)) continue;
    emit(buildJsxViolation(label, control.el, id, source));
  }
}

interface JsxControlRef {
  readonly el: JsxElement;
  /**
   * Narrowed as `readonly JsxNode[]` for nested element children; for
   * top-level roots we store the module's `jsxElements` which is an
   * element-only subtype. `JsxElement` satisfies `JsxNode` so the same
   * sibling-walking logic handles both.
   */
  readonly parentChildren: readonly JsxNode[];
  readonly index: number;
}

function collectJsxLabelableControls(module: TsxModule): readonly JsxControlRef[] {
  const out: JsxControlRef[] = [];
  // Treat `module.jsxElements` itself as a sibling array — when a file
  // contains `<><label/><input/></>` the fragment fill-pattern shows up
  // in the parser's top-level roots list in document order, and the
  // label-before-input shape should still be detected there. Inside
  // each root, `children` carries the usual sibling relationships.
  const roots = module.jsxElements;
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    if (!root) continue;
    const tag = root.tagName.toLowerCase();
    if (LABELABLE_TAGS.has(tag)) {
      out.push({ el: root, parentChildren: roots, index: i });
    }
    visitJsxChildren(root.children, out);
  }
  return out;
}

function visitJsxChildren(children: readonly JsxNode[], out: JsxControlRef[]): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || child.kind !== "JsxElement") continue;
    const tag = child.tagName.toLowerCase();
    if (LABELABLE_TAGS.has(tag)) {
      out.push({ el: child, parentChildren: children, index: i });
    }
    visitJsxChildren(child.children, out);
  }
}

function findPrecedingJsxLabelSibling(
  children: readonly JsxNode[],
  index: number,
): JsxElement | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const sibling = children[i];
    if (!sibling) return null;
    if (sibling.kind === "JsxElement") {
      // Match case-insensitively — `<label>` is the native HTML spelling;
      // `<Label>` is a component wrapper the agent should read the
      // source for. Only the lowercase native element is a reliable
      // sibling to pattern-match on.
      return sibling.tagName === "label" ? sibling : null;
    }
    if (sibling.kind === "JsxText") {
      if (sibling.value.trim().length > 0) return null;
      continue;
    }
    if (sibling.kind === "JsxExpression") {
      // An expression child between label and input (`{render()}`,
      // `{state && <X/>}`) is opaque — we can't prove the association
      // holds, so we don't fire.
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

function isJsxAssociatedSomeOtherWay(el: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  const ariaLabelAttr = getJsxAttribute(el, "aria-label");
  if (ariaLabelAttr?.value?.kind === "Expression") return true;
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
  const title = getJsxAttributeString(el, "title");
  if (title && title.trim().length > 0) return true;
  // A spread may carry an aria-label / id-that-resolves-externally. We
  // can't see into it, so we skip — consistent with how `labels-required`
  // treats spread-bearing controls.
  if (el.hasSpreadProps) return true;
  return false;
}

function jsxLabelWrapsControl(label: JsxElement): boolean {
  for (const descendant of walkJsxDescendants(label)) {
    if (LABELABLE_TAGS.has(descendant.tagName.toLowerCase())) return true;
  }
  return false;
}

function* walkJsxDescendants(element: JsxElement): Iterable<JsxElement> {
  for (const child of element.children) {
    if (child.kind === "JsxElement") {
      yield child;
      yield* walkJsxDescendants(child);
    }
  }
}

function buildJsxViolation(
  label: JsxElement,
  control: JsxElement,
  id: string,
  source: string,
): Parameters<Emit>[0] {
  const edit = buildJsxEditPair(label, id, source);
  return buildViolation({
    line: label.loc.start.line,
    column: label.loc.start.column,
    controlTag: control.tagName.toLowerCase(),
    controlType: getJsxAttributeString(control, "type"),
    id,
    edit,
    // JSX uses `htmlFor`, not `for` — echo the JSX-correct attribute
    // name in the fix so the agent doesn't have to re-translate.
    attr: "htmlFor",
  });
}

function buildJsxEditPair(
  label: JsxElement,
  id: string,
  source: string,
): { readonly oldText: string; readonly newText: string } | null {
  const raw = source.slice(label.range.start, label.range.end);
  // JSX attribute-free open tag is always `<label>` exactly — no whitespace
  // variance like HTML — but accept optional whitespace defensively.
  const openMatch = /^<label(\s*)>/.exec(raw);
  if (!openMatch) return null;
  const oldText = openMatch[0];
  const newText = `<label htmlFor="${escapeAttributeValue(id)}">`;
  return { oldText, newText };
}

// ---------------------------------------------------------------------------
// Shared violation shape
// ---------------------------------------------------------------------------

interface ViolationArgs {
  readonly line: number;
  readonly column: number;
  readonly controlTag: string;
  readonly controlType: string | null;
  readonly id: string;
  readonly edit: { readonly oldText: string; readonly newText: string } | null;
  readonly attr: "for" | "htmlFor";
}

function buildViolation(args: ViolationArgs): Parameters<Emit>[0] {
  const idHint = truncateForEcho(args.id);
  const controlDescriptor = args.controlType
    ? `<${args.controlTag} type="${args.controlType}">`
    : `<${args.controlTag}>`;
  const message = `adjacent <label> has no ${args.attr}="${idHint}" — the label sits next to ${controlDescriptor} id="${idHint}" but the association is visual-only, so screen readers announce the control as unlabeled.`;
  const primaryLabel = `add ${args.attr}="${idHint}" to the <label> to associate it with the adjacent ${controlDescriptor}`;
  const fixPaths: FixPaths = {
    primary: {
      label: primaryLabel,
      ...(args.edit ? { edit: { ...args.edit } } : {}),
    },
    alternatives: [
      {
        label: `wrap the ${controlDescriptor} inside the <label> element — <label>…<${args.controlTag}>…</${args.controlTag}></label> creates an implicit association without needing a matching id`,
      },
      {
        label: `if the adjacent <label> was intended for a *different* control and this ${controlDescriptor} has no real label, add an \`aria-label="…"\` or a separate <label ${args.attr}="${idHint}"> to this control — verify which control the existing label was meant for first`,
      },
    ],
  };
  const suggestion = `Primary fix: ${primaryLabel}. Alternatives: (a) ${fixPaths.alternatives[0]?.label}; (b) ${fixPaths.alternatives[1]?.label}.`;
  return {
    severity: "error",
    location: { filePath: "", line: args.line, column: args.column },
    message,
    suggestion,
    fixPaths,
  };
}

/**
 * Escape a user-authored id before interpolating it into a double-quoted
 * HTML/JSX attribute value. HTML ids can in principle contain `"` and
 * `&` — escape both. Keeps the mechanical edit safe to apply as-is.
 */
function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
