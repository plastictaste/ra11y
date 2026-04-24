/**
 * Rule: forms/required-marker-without-required-attr
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:3.3.2, wcag21:3.3.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text. (SC 1.3.1)
 *
 * > Labels or instructions are provided when content requires user
 * > input. (SC 3.3.2)
 *
 * Sources:
 *   https://www.w3.org/TR/WCAG22/#info-and-relationships
 *   https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *
 * Flags the canonical "visible-only required indicator" shape:
 *
 *   <label>Email <span class="text-danger">*</span></label>
 *   <input type="text" class="form-control">
 *
 * Sighted users see the asterisk and infer the field is required.
 * Screen-reader users hear "Email star edit text" — the requirement
 * is communicated only visually (or by colour, when the marker is a
 * red `*`). The control itself sets neither `required` nor
 * `aria-required="true"`, so the requiredness is not in the
 * accessibility tree at all.
 *
 * The sibling rule `color/meaning-by-color-only` already fires on
 * the red `*` itself (the colour-only side of the failure). This
 * rule covers the **other** side — the input that fails to expose
 * its required state programmatically — and the two findings
 * together describe the full bug.
 *
 * Pattern:
 *   1. Find a `<label>` that contains a "required marker" — one of:
 *        - an element child whose visible text content is exactly
 *          `*` (e.g. `<span class="text-danger">*</span>`,
 *          `<sup>*</sup>`, `<i>*</i>`, `<em>*</em>`),
 *        - an `<abbr title="required">` (or "required field"),
 *        - the case-insensitive substring `required` in any non-
 *          element-wrapped text inside the label.
 *      A bare `*` in a text node is intentionally NOT a marker on
 *      its own — too many labels contain incidental `*` characters
 *      ("Cell *2*"); we require an element wrapper or the explicit
 *      "required" word.
 *   2. Resolve the label to its associated control:
 *        - explicit: `<label for="X">` paired with `<input id="X">`,
 *        - implicit: a labelable control descendant of the `<label>`.
 *   3. The control is `<input>` (excluding hidden/submit/reset/
 *      button/image), `<select>`, or `<textarea>`.
 *   4. The control sets neither the boolean `required` attribute
 *      nor `aria-required="true"`. `aria-required="false"` does NOT
 *      satisfy — it actively contradicts the visible marker.
 *
 * Out of scope:
 *   - CSS `::after { content: "*" }` markers — static analysis
 *     cannot see generated content reliably.
 *   - Aria-required value-via-expression (`aria-required={isRequired}`)
 *     in JSX. We trust an expression-valued aria-required the same
 *     way `forms/aria-invalid-missing` trusts an expression-valued
 *     aria-invalid: the developer is computing it at render time.
 *   - Wrappers / custom components named like `<TextField>` or
 *     `<Input>`. We only inspect bare native form controls. The
 *     companion rule `forms/required-indicator-missing` covers the
 *     wrapper-definition side.
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
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

// Input `type` values that don't take a label / required state in any
// meaningful sense. Mirrors `forms/labels-required` and
// `forms/label-adjacent-unassociated` so the form-rule family agrees on
// scope.
const NON_LABELABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

export const rule = defineRule({
  id: "forms/required-marker-without-required-attr",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2"],
  severity: "error",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'A <label> with a visible required marker (* in an element wrapper, <abbr title="required">, or the literal word \'required\') must pair with an input that sets `required` or `aria-required="true"` — visual-only required cues are inaccessible to screen readers.',
    rationale:
      "When a label tells sighted users a field is required (via an asterisk, a red marker, or the word 'required'), the same information must reach assistive tech. If the underlying control sets neither `required` nor `aria-required=\"true\"`, the requirement is communicated visually only — a screen-reader user hears 'Email star edit text' with no programmatic signal that the field is required, and submission failures become the first time they learn the rule. The companion rule `color/meaning-by-color-only` flags the red `*` itself; this rule flags the input that fails to expose the required state. Both findings together describe the full failure.",
    goodExample: `<label for="email">Email <span class="text-danger">*</span></label>\n<input id="email" type="email" required>`,
    badExample: `<label for="email">Email <span class="text-danger">*</span></label>\n<input id="email" type="email">`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA2",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H90",
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
  const idIndex = collectHtmlIdIndex(doc);
  for (const label of walkHtmlElements(doc)) {
    if (label.tagName.toLowerCase() !== "label") continue;
    const marker = describeHtmlRequiredMarker(label);
    if (marker === null) continue;
    const controls = resolveHtmlLabelControls(label, idIndex);
    for (const control of controls) {
      if (htmlControlOptedOut(control)) continue;
      if (htmlControlExposesRequired(control)) continue;
      emit(buildHtmlViolation(control, marker));
    }
  }
}

function collectHtmlIdIndex(doc: HtmlDocument): ReadonlyMap<string, HtmlElement> {
  const idx = new Map<string, HtmlElement>();
  for (const el of walkHtmlElements(doc)) {
    const id = getHtmlAttribute(el, "id");
    if (id !== null && id.length > 0 && !idx.has(id)) idx.set(id, el);
  }
  return idx;
}

interface MarkerDescription {
  /** Short human-readable phrase describing the marker, for the message. */
  readonly phrase: string;
}

function describeHtmlRequiredMarker(label: HtmlElement): MarkerDescription | null {
  // Pass 1: element-wrapped `*` (span, sup, em, i, strong, abbr, b).
  for (const el of walkHtmlElements(label)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "abbr") {
      const title = getHtmlAttribute(el, "title");
      if (title && /required/i.test(title)) {
        return { phrase: `<abbr title="${title}">` };
      }
    }
    // Element wrapper around a bare `*` — the canonical markup pattern.
    if (htmlTextContent(el).trim() === "*") {
      const className = getHtmlAttribute(el, "class");
      const phrase = className ? `<${tag} class="${className}">*</${tag}>` : `<${tag}>*</${tag}>`;
      return { phrase };
    }
  }
  // Pass 2: literal "required" word in the label's overall visible text.
  const text = htmlTextContent(label);
  if (/\brequired\b/i.test(text)) {
    return { phrase: `the word "required" in the label text` };
  }
  return null;
}

function resolveHtmlLabelControls(
  label: HtmlElement,
  idIndex: ReadonlyMap<string, HtmlElement>,
): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  // Implicit: any labelable descendant.
  for (const desc of walkHtmlElements(label)) {
    if (FORM_CONTROL_TAGS.has(desc.tagName.toLowerCase())) out.push(desc);
  }
  // Explicit: for="X" → element with id="X".
  const target = getHtmlAttribute(label, "for");
  if (target !== null && target.length > 0) {
    const el = idIndex.get(target);
    if (el && FORM_CONTROL_TAGS.has(el.tagName.toLowerCase())) out.push(el);
  }
  return out;
}

function htmlControlOptedOut(control: HtmlElement): boolean {
  if (control.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(control, "type")?.toLowerCase();
  if (!type) return false;
  return NON_LABELABLE_INPUT_TYPES.has(type);
}

function htmlControlExposesRequired(control: HtmlElement): boolean {
  if (hasHtmlAttribute(control, "required")) return true;
  const ariaRequired = getHtmlAttribute(control, "aria-required");
  return ariaRequired === "true";
}

function buildHtmlViolation(control: HtmlElement, marker: MarkerDescription): Parameters<Emit>[0] {
  const tag = control.tagName.toLowerCase();
  const typeAttr = tag === "input" ? getHtmlAttribute(control, "type") : null;
  const descriptor = typeAttr ? `<${tag} type="${typeAttr}">` : `<${tag}>`;
  return {
    severity: "error",
    location: {
      filePath: "",
      line: control.loc.start.line,
      column: control.loc.start.column,
    },
    message: buildMessage(descriptor, marker),
    suggestion: buildSuggestion(tag, descriptor),
  };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  const idIndex = collectJsxIdIndex(module);
  for (const label of walkJsxElements(module)) {
    if (label.tagName !== "label") continue;
    const marker = describeJsxRequiredMarker(label);
    if (marker === null) continue;
    const controls = resolveJsxLabelControls(label, idIndex);
    for (const control of controls) {
      if (jsxControlOptedOut(control)) continue;
      if (jsxControlExposesRequired(control)) continue;
      emit(buildJsxViolation(control, marker));
    }
  }
}

function collectJsxIdIndex(module: TsxModule): ReadonlyMap<string, JsxElement> {
  const idx = new Map<string, JsxElement>();
  for (const el of walkJsxElements(module)) {
    const id = getJsxAttributeString(el, "id");
    if (id !== null && id.length > 0 && !idx.has(id)) idx.set(id, el);
  }
  return idx;
}

function describeJsxRequiredMarker(label: JsxElement): MarkerDescription | null {
  for (const el of walkJsxDescendants(label)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "abbr") {
      const title = getJsxAttributeString(el, "title");
      if (title && /required/i.test(title)) {
        return { phrase: `<abbr title="${title}">` };
      }
    }
    if (jsxTextContent(el).trim() === "*") {
      const className =
        getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
      const phrase = className
        ? `<${el.tagName} className="${className}">*</${el.tagName}>`
        : `<${el.tagName}>*</${el.tagName}>`;
      return { phrase };
    }
  }
  const text = jsxTextContent(label);
  if (/\brequired\b/i.test(text)) {
    return { phrase: `the word "required" in the label text` };
  }
  return null;
}

function resolveJsxLabelControls(
  label: JsxElement,
  idIndex: ReadonlyMap<string, JsxElement>,
): readonly JsxElement[] {
  const out: JsxElement[] = [];
  for (const desc of walkJsxDescendants(label)) {
    if (FORM_CONTROL_TAGS.has(desc.tagName.toLowerCase())) out.push(desc);
  }
  // Accept React's `htmlFor` as well as legacy `for`.
  const target = getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
  if (target !== null && target.length > 0) {
    const el = idIndex.get(target);
    if (el && FORM_CONTROL_TAGS.has(el.tagName.toLowerCase())) out.push(el);
  }
  return out;
}

function* walkJsxDescendants(element: JsxElement): Iterable<JsxElement> {
  for (const child of element.children) {
    if (child.kind === "JsxElement") {
      yield child;
      yield* walkJsxDescendants(child);
    }
  }
}

function jsxControlOptedOut(control: JsxElement): boolean {
  if (control.tagName.toLowerCase() !== "input") return false;
  const type = getJsxAttributeString(control, "type")?.toLowerCase();
  if (!type) return false;
  return NON_LABELABLE_INPUT_TYPES.has(type);
}

function jsxControlExposesRequired(control: JsxElement): boolean {
  // `required` shorthand or any value: trust the developer.
  if (hasJsxAttribute(control, "required")) {
    const attr = getJsxAttribute(control, "required");
    // `required={false}` cannot be detected reliably from the AST shape
    // here without parsing the expression; accept any required= as
    // exposing required (consistent with `forms/aria-invalid-missing`).
    return attr !== null;
  }
  const ariaAttr = getJsxAttribute(control, "aria-required");
  if (!ariaAttr) return false;
  // Expression-valued aria-required={…}: trust the developer is
  // computing it at render time, mirroring `forms/aria-invalid-missing`.
  if (ariaAttr.value?.kind === "Expression") return true;
  const literal = getJsxAttributeString(control, "aria-required");
  return literal === "true";
}

function buildJsxViolation(control: JsxElement, marker: MarkerDescription): Parameters<Emit>[0] {
  const tag = control.tagName;
  const typeAttr = tag.toLowerCase() === "input" ? getJsxAttributeString(control, "type") : null;
  const descriptor = typeAttr ? `<${tag} type="${typeAttr}">` : `<${tag}>`;
  return {
    severity: "error",
    location: {
      filePath: "",
      line: control.loc.start.line,
      column: control.loc.start.column,
    },
    message: buildMessage(descriptor, marker),
    suggestion: buildJsxSuggestion(tag, descriptor),
  };
}

// ---------------------------------------------------------------------------
// Shared messaging
// ---------------------------------------------------------------------------

function buildMessage(descriptor: string, marker: MarkerDescription): string {
  return `the associated <label> shows a visible required marker (${marker.phrase}) but ${descriptor} sets neither \`required\` nor \`aria-required="true"\` — screen-reader users won't know the field is required until submission fails.`;
}

function buildSuggestion(tag: string, descriptor: string): string {
  return `Add the boolean \`required\` attribute to ${descriptor} (the browser then exposes the required state to assistive tech and blocks submission), or set \`aria-required="true"\` on the <${tag}> if blocking submission would change validation flow. Either alone satisfies SC 1.3.1 + 3.3.2 for this control; the visible marker can stay as-is.`;
}

function buildJsxSuggestion(tag: string, descriptor: string): string {
  return `Add the \`required\` prop to ${descriptor} (the browser exposes the required state to assistive tech and blocks submission), or set \`aria-required="true"\` (or \`aria-required={isRequired}\` for a computed value) on the <${tag}> if blocking submission would change validation flow. Either alone satisfies SC 1.3.1 + 3.3.2 for this control; the visible marker can stay as-is.`;
}
