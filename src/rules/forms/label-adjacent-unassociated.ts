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
 *   1. the labelable control's (<input>/<select>/<textarea>) immediately-
 *      preceding element sibling is a <label>,
 *   2. the only nodes between label and control are whitespace text or
 *      comments (no <br>, no prose, no intervening elements — those weaken
 *      the association enough that the agent needs to read the file), and
 *   3. the label has no `for=` / `htmlFor=` attribute and does not wrap the
 *      control implicitly.
 *
 * The control does NOT need to carry an `id` already — the canonical
 * Bootstrap-templated shape `<label>Text Input</label><input class="form-
 * control">` has 12+ instances per form and omits the id entirely. When
 * the control has no id the rule synthesizes one from the label's visible
 * text (kebab-case; collision-suffixed against existing document ids)
 * and emits TWO mechanical edits: one to add `for="<synthesized>"` on the
 * label, one to add `id="<synthesized>"` on the control. The agent
 * applies both via `apply_fix`.
 *
 * Distinct from `forms/labels-required`. That rule fires whenever an
 * input has no accessible name at all; this one fires specifically on
 * the adjacent-but-unassociated shape. Both may fire on the same input
 * today — the agent sees both findings and the distinct suggestions tell
 * it which lever to pull (add `for=` + `id=`, vs. add a label from
 * scratch). De-overlapping the two rules is tracked as a follow-up;
 * silently suppressing one on this shape would hide the more specific,
 * mechanically-fixable signal.
 *
 * The mechanical edits fire whenever the corresponding open tag is
 * simple enough to rewrite safely (attribute-free `<label>` for the
 * label edit; `<input …>` / `<textarea …>` / `<select …>` for the
 * control edit). When an open tag already carries attributes the rule
 * still fires, but ships guidance for that side only — the insertion
 * point (before/after `class=`, end of tag) is a style call.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
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
  const taken = new Set(collectHtmlDocumentIds(doc));
  for (const control of collectHtmlLabelableControls(doc)) {
    const hit = applicableHtmlLabel(control);
    if (hit === null) continue;
    const resolved = resolveControlId(control.el, hit.label, taken);
    if (resolved === null) continue;
    if (resolved.synthesized) taken.add(resolved.id);
    emit(buildHtmlViolation(hit.label, control.el, resolved.id, source, resolved.synthesized));
  }
}

/**
 * Walks the control's candidate preconditions and returns the label
 * we should fire on, or null when nothing about this control is
 * actionable. Extracted so the main loop stays shallow.
 */
function applicableHtmlLabel(control: HtmlControlRef): { readonly label: HtmlElement } | null {
  if (isExcludedHtmlControl(control.el)) return null;
  // If the control is already associated (any of the channels
  // `forms/labels-required` recognises), this rule has nothing to say.
  // We intentionally DO NOT probe for the "nested inside a <label>"
  // case here — `labels-required` covers it and this rule is scoped
  // to the sibling shape by name.
  if (isHtmlAssociatedSomeOtherWay(control.el)) return null;
  const label = findPrecedingHtmlLabelSibling(control.parentChildren, control.index);
  if (label === null) return null;
  if (hasHtmlAttribute(label, "for")) return null;
  // A label that already wraps the control is an implicit-association
  // case, handled by `labels-required`. We only fire when the label
  // sits beside the control.
  if (htmlLabelWrapsControl(label)) return null;
  return { label };
}

/**
 * Return the id we'll cite in the fix: the control's own id when set,
 * or a synthesized one derived from the label text. The `taken` set
 * is the caller's running ledger — existing document ids plus ids the
 * rule has already proposed during this pass. Returns null when no id
 * can be synthesized (label text fully empty after fallback + ledger
 * exhausted), caller skips the candidate.
 */
function resolveControlId(
  control: HtmlElement,
  label: HtmlElement,
  taken: ReadonlySet<string>,
): { readonly id: string; readonly synthesized: boolean } | null {
  const existingId = getHtmlAttribute(control, "id");
  if (existingId !== null && existingId.length > 0) {
    return { id: existingId, synthesized: false };
  }
  const synthesized = synthesizeId(htmlTextContent(label), taken);
  return synthesized === null ? null : { id: synthesized, synthesized: true };
}

/** Collect every `id` attribute value already present in the document. */
function collectHtmlDocumentIds(doc: HtmlDocument): readonly string[] {
  const out: string[] = [];
  for (const el of walkHtmlElements(doc)) {
    const v = getHtmlAttribute(el, "id");
    if (v !== null && v.length > 0) out.push(v);
  }
  return out;
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
  // `aria-label` and `aria-labelledby` are explicit author-intent
  // signals — the developer reached for an ARIA attribute precisely
  // to override the default name source, so honoring that intent here
  // suppresses what would otherwise be noise. `title=` is NOT in the
  // same class: per the ARIA accessible-name algorithm `title` is the
  // last-resort fallback (step 5+), and in Bootstrap-derived templates
  // it is overwhelmingly authored as an inline validation tooltip
  // ("Please enter a valid email"), not as a deliberate accessible
  // name. When an adjacent <label> sits next to a control with only
  // `title=`, the author drew a visible label and intended IT to be
  // the label — the for/id pair is still missing, sighted users still
  // expect click-to-focus on the visible label, and the screen-reader
  // experience announces the tooltip text instead of the visible
  // label, which is its own confusion. Surface the orphan-shape
  // finding regardless of `title=`.
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
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
  synthesized: boolean,
): Parameters<Emit>[0] {
  const edit = buildHtmlEditPair(label, id, source);
  const controlEdit = synthesized ? buildHtmlControlIdInsertPair(control, id, source) : null;
  return buildViolation({
    line: label.loc.start.line,
    column: label.loc.start.column,
    controlTag: control.tagName.toLowerCase(),
    controlType: getHtmlAttribute(control, "type"),
    id,
    synthesized,
    edit,
    controlEdit,
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

/**
 * Rewrite the control's open tag to inject `id="<synthesized>"` as the
 * first attribute (keeps existing attributes in their original order).
 * Only fires when the control's open tag is a simple `<tag ...>` or
 * `<tag .../>` with no quoted `>` inside an attribute value — the
 * regex match covers the canonical Bootstrap-template shapes
 * (`<input class="form-control">`, `<input type="text" name="x">`).
 * When the shape is too exotic to pattern-match safely we return null
 * and ship guidance instead.
 */
function buildHtmlControlIdInsertPair(
  control: HtmlElement,
  id: string,
  source: string,
): { readonly oldText: string; readonly newText: string } | null {
  const raw = source.slice(control.range.start, control.range.end);
  // Match `<tag` + attributes + optional `/` + `>`. The attribute-run
  // regex rejects any `>` between attribute quotes — if the source is
  // weirder than that, we bail.
  const openMatch =
    /^<([A-Za-z]+)((?:\s+[^>"'=\s][^>"']*(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)(\s*\/?\s*)>/.exec(
      raw,
    );
  if (!openMatch) return null;
  const tag = openMatch[1];
  const attrs = openMatch[2] ?? "";
  const trailing = openMatch[3] ?? "";
  const oldText = openMatch[0];
  // Insert the id as the first attribute so the edit is deterministic
  // regardless of the caller's attribute style.
  const newText = `<${tag} id="${escapeAttributeValue(id)}"${attrs}${trailing}>`;
  return { oldText, newText };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, source: string, emit: Emit): void {
  const taken = new Set(collectJsxModuleIds(module));
  for (const control of collectJsxLabelableControls(module)) {
    const hit = applicableJsxLabel(control);
    if (hit === null) continue;
    const resolved = resolveJsxControlId(control.el, hit.label, taken);
    if (resolved === null) continue;
    if (resolved.synthesized) taken.add(resolved.id);
    emit(buildJsxViolation(hit.label, control.el, resolved.id, source, resolved.synthesized));
  }
}

function applicableJsxLabel(control: JsxControlRef): { readonly label: JsxElement } | null {
  if (isExcludedJsxControl(control.el)) return null;
  if (isJsxAssociatedSomeOtherWay(control.el)) return null;
  const label = findPrecedingJsxLabelSibling(control.parentChildren, control.index);
  if (label === null) return null;
  if (hasJsxAttribute(label, "htmlFor") || hasJsxAttribute(label, "for")) return null;
  if (jsxLabelWrapsControl(label)) return null;
  return { label };
}

function resolveJsxControlId(
  control: JsxElement,
  label: JsxElement,
  taken: ReadonlySet<string>,
): { readonly id: string; readonly synthesized: boolean } | null {
  const existingId = getJsxAttributeString(control, "id");
  if (existingId !== null && existingId.length > 0) {
    return { id: existingId, synthesized: false };
  }
  // Expression-valued `id={…}` is opaque; we can't synthesize because
  // the label's synthesized literal wouldn't match whatever the
  // expression resolves to. Bail so the agent reads the file.
  const idAttr = getJsxAttribute(control, "id");
  if (idAttr?.value?.kind === "Expression") return null;
  const synthesized = synthesizeId(jsxTextContent(label), taken);
  return synthesized === null ? null : { id: synthesized, synthesized: true };
}

/** Collect every literal-string `id=` attribute value across the module. */
function collectJsxModuleIds(module: TsxModule): readonly string[] {
  const out: string[] = [];
  const visit = (el: JsxElement): void => {
    const v = getJsxAttributeString(el, "id");
    if (v !== null && v.length > 0) out.push(v);
    for (const child of el.children) {
      if (child.kind === "JsxElement") visit(child);
    }
  };
  for (const root of module.jsxElements) visit(root);
  return out;
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
  // `title=` intentionally NOT included here — see the rationale in
  // `isHtmlAssociatedSomeOtherWay`. Bootstrap-style templates routinely
  // ship `title=` as a validation tooltip on inputs that are otherwise
  // visually labeled by an adjacent <label>; treating that as a
  // sufficient accessible name silently hides the orphan-label finding
  // on every contact-page derived from those templates.
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  const ariaLabelAttr = getJsxAttribute(el, "aria-label");
  if (ariaLabelAttr?.value?.kind === "Expression") return true;
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
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
  synthesized: boolean,
): Parameters<Emit>[0] {
  const edit = buildJsxEditPair(label, id, source);
  const controlEdit = synthesized ? buildJsxControlIdInsertPair(control, id, source) : null;
  return buildViolation({
    line: label.loc.start.line,
    column: label.loc.start.column,
    controlTag: control.tagName.toLowerCase(),
    controlType: getJsxAttributeString(control, "type"),
    id,
    synthesized,
    edit,
    controlEdit,
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

/**
 * Rewrite the JSX control's open tag to inject `id="<synthesized>"` as
 * the first prop. Matches the canonical `<input className="..." />` /
 * `<input type="text" />` shapes. Refuses expression-valued attributes
 * or attribute names it can't parse safely.
 */
function buildJsxControlIdInsertPair(
  control: JsxElement,
  id: string,
  source: string,
): { readonly oldText: string; readonly newText: string } | null {
  const raw = source.slice(control.range.start, control.range.end);
  // `<Tag attrs />` or `<Tag attrs>`. Attributes are limited to
  // `name`, `name="value"`, `name='value'` — we bail on `name={…}` to
  // avoid interleaving with expressions whose evaluation we can't see.
  const openMatch =
    /^<([A-Za-z]+)((?:\s+[A-Za-z_][\w:-]*(?:=(?:"[^"]*"|'[^']*'))?)*)(\s*\/?\s*)>/.exec(raw);
  if (!openMatch) return null;
  const tag = openMatch[1];
  const attrs = openMatch[2] ?? "";
  const trailing = openMatch[3] ?? "";
  const oldText = openMatch[0];
  const newText = `<${tag} id="${escapeAttributeValue(id)}"${attrs}${trailing}>`;
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
  /**
   * True when the id did NOT exist on the control in source and was
   * synthesized from the label's visible text. Drives two shape
   * changes: the message mentions the synthesis so the agent knows
   * the id is a proposal (not observed), and the fixPaths gain a
   * second mechanical edit that inserts `id=` on the control itself.
   */
  readonly synthesized: boolean;
  readonly edit: { readonly oldText: string; readonly newText: string } | null;
  readonly controlEdit: { readonly oldText: string; readonly newText: string } | null;
  readonly attr: "for" | "htmlFor";
}

function buildViolation(args: ViolationArgs): Parameters<Emit>[0] {
  const ctx = buildMessageContext(args);
  const fixPaths = buildFixPaths(args, ctx);
  const alt0 = fixPaths.alternatives[0]?.label ?? "";
  const alt1 = fixPaths.alternatives[1]?.label ?? "";
  const suggestion = `Primary fix: ${ctx.primaryLabel}. Alternatives: (a) ${alt0}; (b) ${alt1}.`;
  return {
    severity: "error",
    location: { filePath: "", line: args.line, column: args.column },
    message: ctx.message,
    suggestion,
    fixPaths,
  };
}

interface MessageContext {
  readonly idHint: string;
  readonly controlDescriptor: string;
  readonly message: string;
  readonly primaryLabel: string;
}

function buildMessageContext(args: ViolationArgs): MessageContext {
  const idHint = truncateForEcho(args.id);
  const controlDescriptor = args.controlType
    ? `<${args.controlTag} type="${args.controlType}">`
    : `<${args.controlTag}>`;
  const idClause = args.synthesized
    ? `the adjacent ${controlDescriptor} has no id at all, so the association is visual-only and screen readers announce the control as unlabeled. Adding \`${args.attr}="${idHint}"\` on the <label> AND \`id="${idHint}"\` on the control (id synthesized from the label text) fixes both sides in one pass`
    : `the label sits next to ${controlDescriptor} id="${idHint}" but the association is visual-only, so screen readers announce the control as unlabeled`;
  const message = `adjacent <label> has no ${args.attr}="${idHint}" — ${idClause}.`;
  const primaryLabel = args.synthesized
    ? `add ${args.attr}="${idHint}" to the <label> AND add id="${idHint}" to the adjacent ${controlDescriptor} so the association resolves (id synthesized from the label's visible text)`
    : `add ${args.attr}="${idHint}" to the <label> to associate it with the adjacent ${controlDescriptor}`;
  return { idHint, controlDescriptor, message, primaryLabel };
}

function buildFixPaths(args: ViolationArgs, ctx: MessageContext): FixPaths {
  const wrapAlternative = {
    label: `wrap the ${ctx.controlDescriptor} inside the <label> element — <label>…<${args.controlTag}>…</${args.controlTag}></label> creates an implicit association without needing a matching id`,
  };
  const ambiguousAlternative = {
    label: `if the adjacent <label> was intended for a *different* control and this ${ctx.controlDescriptor} has no real label, add an \`aria-label="…"\` or a separate <label ${args.attr}="${ctx.idHint}"> to this control — verify which control the existing label was meant for first`,
  };
  const alternatives = args.synthesized
    ? [buildControlEditAlternative(args, ctx), wrapAlternative, ambiguousAlternative]
    : [wrapAlternative, ambiguousAlternative];
  return {
    primary: {
      label: ctx.primaryLabel,
      ...(args.edit ? { edit: { ...args.edit } } : {}),
    },
    alternatives,
  };
}

function buildControlEditAlternative(args: ViolationArgs, ctx: MessageContext) {
  return {
    label: `add id="${ctx.idHint}" to the adjacent ${ctx.controlDescriptor} — companion edit to the <label> rewrite above; both must land for the association to resolve`,
    ...(args.controlEdit ? { edit: { ...args.controlEdit } } : {}),
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

// ---------------------------------------------------------------------------
// id synthesis
// ---------------------------------------------------------------------------

/**
 * Synthesize a stable id from a label's visible text:
 *   - lowercase ASCII letters / digits
 *   - any other run (whitespace, punctuation, template-directive residue)
 *     collapses to a single `-`
 *   - leading/trailing `-` trimmed
 *   - prefix with `input-` if the result starts with a digit (HTML ids
 *     are legal starting with a digit, but CSS selectors like `#2fa`
 *     are not, so the prefix keeps the synthesized id useful for the
 *     adjacent stylesheet too)
 *   - fall back to `input` when no ASCII-usable tokens remain (e.g.
 *     pure CJK or emoji label)
 *
 * Collision resolution: append `-2`, `-3`, … until the proposal is
 * not in `taken`. `taken` is caller-owned and mutated by the caller
 * after accepting a returned id.
 *
 * Returns null only when the label text is completely empty after the
 * fallback — caller treats that as "can't synthesize, don't fire."
 * With the fallback above, this in practice only happens if `taken`
 * somehow already contains every numeric suffix; the `-1000` ceiling
 * is a safety valve, not an expected limit.
 */
function synthesizeId(labelText: string, taken: ReadonlySet<string>): string | null {
  const base = kebabize(labelText);
  const safeBase = base.length > 0 ? base : "input";
  const needsPrefix = /^\d/.test(safeBase);
  const root = needsPrefix ? `input-${safeBase}` : safeBase;
  if (!taken.has(root)) return root;
  for (let suffix = 2; suffix <= 1000; suffix += 1) {
    const candidate = `${root}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

function kebabize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
