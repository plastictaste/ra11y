/**
 * Rule: forms/asterisk-required-marker
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
 * Sister rule to `forms/required-marker-without-required-attr`. That
 * rule fires on element-wrapped required markers — `<span>*</span>`,
 * `<sup>*</sup>`, `<abbr title="required">`, or the literal word
 * "required" inside the label. This rule fires on the **bare-asterisk**
 * shape that the sister rule deliberately excludes:
 *
 *   <label for="email">Email *</label>
 *   <input id="email" type="email">
 *
 *   <input type="email" placeholder="Email *">
 *
 * Sighted users see the trailing `*` and infer the field is required;
 * a screen-reader user hearing "Email star edit text" has no
 * programmatic signal that the field is required. The control sets
 * neither `required` nor `aria-required="true"`, so the requiredness
 * is not in the accessibility tree at all.
 *
 * Why this is a separate rule (not folded into the sister rule):
 *   The sister rule excludes bare-asterisk-in-text on a precision
 *   argument — a label like `Cell *2*` (a footnote marker mid-text)
 *   would false-positive. We restore detection only for the narrower
 *   "trimmed label text **ends** with `*`" shape, which avoids the
 *   mid-text footnote class. Severity is `warning` (not `error`)
 *   because a small residue of false positives remains — labels where
 *   the trailing `*` is genuinely a fine-print disclaimer marker
 *   ("Subtotal *" pointing at a "* taxes excluded" disclosure). The
 *   reason text frames the question so the agent can dismiss with one
 *   read, and the source-level disable pragma is the durable escape.
 *
 * Pattern:
 *   1. Find a `<label>` (or labelable element via `aria-labelledby`)
 *      whose:
 *        a. trimmed visible text **ends** with `*`, AND
 *        b. has no element-wrapped `*` child (those are the sister
 *           rule's territory), AND
 *        c. has no occurrence of the word "required" (also sister
 *           rule's territory).
 *      OR find a labelable form control whose `placeholder` attribute
 *      value's trimmed text ends with `*`.
 *   2. Resolve the label to its associated control (`for`/`htmlFor`,
 *      or implicit nesting). Placeholder marker case applies to the
 *      control directly.
 *   3. The control is `<input>` (excluding hidden/submit/reset/
 *      button/image), `<select>`, or `<textarea>`.
 *   4. The control sets neither the boolean `required` attribute nor
 *      `aria-required="true"`. `aria-required="false"` does NOT
 *      satisfy — it actively contradicts the visible marker.
 *
 * Out of scope:
 *   - Document-level legend exemption (`<p>* indicates required</p>`).
 *     Per the AI-first consumer model, heuristic suppression of
 *     emissions based on guessed sibling content is dishonest — the
 *     document might or might not include such a legend. Surface
 *     honestly; the agent dismisses with a `<!-- ra11y-disable -->`
 *     pragma if a legend is present and the convention is documented.
 *   - CSS `::after { content: "*" }` markers — static analysis cannot
 *     see generated content reliably.
 *   - Wrappers / custom components (`<TextField placeholder="…">`) —
 *     we only inspect bare native form controls. Wrapper-level
 *     coverage lives in `forms/required-indicator-missing`.
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

// Mirrors `forms/required-marker-without-required-attr` and
// `forms/labels-required` so the form-rule family agrees on scope.
const NON_LABELABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

export const rule = defineRule({
  id: "forms/asterisk-required-marker",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2"],
  severity: "warning",
  scope: "document",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'A <label> whose trimmed text ends with a bare `*` (or a control whose `placeholder` ends with `*`) must pair with an input that sets `required` or `aria-required="true"` — the asterisk-equals-required convention is sighted-only without a programmatic signal.',
    rationale:
      "The trailing-asterisk-equals-required convention is widespread in form design (a Nielsen Norman survey usability standard) but it lives entirely in the visual layer — a screen-reader user hearing 'Email star edit text' has no way to know the field is required until submission fails. The sister rule `forms/required-marker-without-required-attr` covers element-wrapped markers (`<span>*</span>`, `<abbr title=\"required\">`); this rule covers the bare-text shape that's just as common in handwritten HTML and JSX. Severity is `warning` rather than `error` because a small residue of false positives remains (labels where the trailing `*` is a footnote marker pointing to a fine-print disclosure rather than a required-field convention) — the reason text frames the question so an agent can dismiss with one read.",
    goodExample: '<label for="email">Email *</label>\n<input id="email" type="email" required>',
    badExample: '<label for="email">Email *</label>\n<input id="email" type="email">',
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

interface MarkerSource {
  /** Where the bare `*` was found, for the message. */
  readonly origin: "label-text" | "placeholder";
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const idIndex = collectHtmlIdIndex(doc);
  const flagged = new Set<HtmlElement>();
  emitHtmlLabelTextMarkers(doc, idIndex, flagged, emit);
  emitHtmlPlaceholderMarkers(doc, flagged, emit);
}

function emitHtmlLabelTextMarkers(
  doc: HtmlDocument,
  idIndex: ReadonlyMap<string, HtmlElement>,
  flagged: Set<HtmlElement>,
  emit: Emit,
): void {
  for (const label of walkHtmlElements(doc)) {
    if (label.tagName.toLowerCase() !== "label") continue;
    if (!htmlLabelHasBareAsteriskMarker(label)) continue;
    for (const control of resolveHtmlLabelControls(label, idIndex)) {
      tryEmitHtml(control, flagged, "label-text", emit);
    }
  }
}

function emitHtmlPlaceholderMarkers(
  doc: HtmlDocument,
  flagged: Set<HtmlElement>,
  emit: Emit,
): void {
  for (const control of walkHtmlElements(doc)) {
    if (!FORM_CONTROL_TAGS.has(control.tagName.toLowerCase())) continue;
    const placeholder = getHtmlAttribute(control, "placeholder");
    if (placeholder === null) continue;
    if (!trimmedEndsWithBareAsterisk(placeholder)) continue;
    tryEmitHtml(control, flagged, "placeholder", emit);
  }
}

function tryEmitHtml(
  control: HtmlElement,
  flagged: Set<HtmlElement>,
  origin: MarkerSource["origin"],
  emit: Emit,
): void {
  if (htmlControlOptedOut(control)) return;
  if (htmlControlExposesRequired(control)) return;
  if (flagged.has(control)) return;
  flagged.add(control);
  emit(buildHtmlViolation(control, { origin }));
}

function collectHtmlIdIndex(doc: HtmlDocument): ReadonlyMap<string, HtmlElement> {
  const idx = new Map<string, HtmlElement>();
  for (const el of walkHtmlElements(doc)) {
    const id = getHtmlAttribute(el, "id");
    if (id !== null && id.length > 0 && !idx.has(id)) idx.set(id, el);
  }
  return idx;
}

function htmlLabelHasBareAsteriskMarker(label: HtmlElement): boolean {
  // Sister-rule territory: any descendant element whose own text content
  // is exactly `*`. Skip — `forms/required-marker-without-required-attr`
  // owns that shape.
  for (const desc of walkHtmlElements(label)) {
    if (desc === label) continue;
    if (htmlTextContent(desc).trim() === "*") return false;
    if (desc.tagName.toLowerCase() === "abbr") {
      const title = getHtmlAttribute(desc, "title");
      if (title && /required/i.test(title)) return false;
    }
  }
  // Sister-rule territory: literal "required" word anywhere in the label
  // visible text. Also skip — the sister rule covers it.
  const text = htmlTextContent(label);
  if (/\brequired\b/i.test(text)) return false;
  // Bare-asterisk predicate: trimmed label text ends with `*`.
  return trimmedEndsWithBareAsterisk(text);
}

/**
 * The narrow predicate: after trimming whitespace, the last non-space
 * character is `*` and the text is non-trivially long. Avoids firing on
 * an empty label (length 0) or a lone `*` (length 1) — those are
 * handled by other rules.
 */
function trimmedEndsWithBareAsterisk(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  return trimmed.endsWith("*");
}

function resolveHtmlLabelControls(
  label: HtmlElement,
  idIndex: ReadonlyMap<string, HtmlElement>,
): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  for (const desc of walkHtmlElements(label)) {
    if (desc === label) continue;
    if (FORM_CONTROL_TAGS.has(desc.tagName.toLowerCase())) out.push(desc);
  }
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

function buildHtmlViolation(control: HtmlElement, marker: MarkerSource): Parameters<Emit>[0] {
  const tag = control.tagName.toLowerCase();
  const typeAttr = tag === "input" ? getHtmlAttribute(control, "type") : null;
  const descriptor = typeAttr ? `<${tag} type="${typeAttr}">` : `<${tag}>`;
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: control.loc.start.line,
      column: control.loc.start.column,
    },
    message: buildMessage(descriptor, marker),
    suggestion: buildHtmlSuggestion(tag, descriptor, marker),
  };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  const idIndex = collectJsxIdIndex(module);
  const flagged = new Set<JsxElement>();
  emitJsxLabelTextMarkers(module, idIndex, flagged, emit);
  emitJsxPlaceholderMarkers(module, flagged, emit);
}

function emitJsxLabelTextMarkers(
  module: TsxModule,
  idIndex: ReadonlyMap<string, JsxElement>,
  flagged: Set<JsxElement>,
  emit: Emit,
): void {
  for (const label of walkJsxElements(module)) {
    if (label.tagName !== "label") continue;
    if (!jsxLabelHasBareAsteriskMarker(label)) continue;
    for (const control of resolveJsxLabelControls(label, idIndex)) {
      tryEmitJsx(control, flagged, "label-text", emit);
    }
  }
}

function emitJsxPlaceholderMarkers(module: TsxModule, flagged: Set<JsxElement>, emit: Emit): void {
  for (const control of walkJsxElements(module)) {
    if (!FORM_CONTROL_TAGS.has(control.tagName.toLowerCase())) continue;
    const placeholder = getJsxAttributeString(control, "placeholder");
    if (placeholder === null) continue;
    if (!trimmedEndsWithBareAsterisk(placeholder)) continue;
    tryEmitJsx(control, flagged, "placeholder", emit);
  }
}

function tryEmitJsx(
  control: JsxElement,
  flagged: Set<JsxElement>,
  origin: MarkerSource["origin"],
  emit: Emit,
): void {
  if (jsxControlOptedOut(control)) return;
  if (jsxControlExposesRequired(control)) return;
  if (flagged.has(control)) return;
  flagged.add(control);
  emit(buildJsxViolation(control, { origin }));
}

function collectJsxIdIndex(module: TsxModule): ReadonlyMap<string, JsxElement> {
  const idx = new Map<string, JsxElement>();
  for (const el of walkJsxElements(module)) {
    const id = getJsxAttributeString(el, "id");
    if (id !== null && id.length > 0 && !idx.has(id)) idx.set(id, el);
  }
  return idx;
}

function jsxLabelHasBareAsteriskMarker(label: JsxElement): boolean {
  for (const desc of walkJsxDescendants(label)) {
    if (jsxTextContent(desc).trim() === "*") return false;
    if (desc.tagName.toLowerCase() === "abbr") {
      const title = getJsxAttributeString(desc, "title");
      if (title && /required/i.test(title)) return false;
    }
  }
  const text = jsxTextContent(label);
  if (/\brequired\b/i.test(text)) return false;
  return trimmedEndsWithBareAsterisk(text);
}

function resolveJsxLabelControls(
  label: JsxElement,
  idIndex: ReadonlyMap<string, JsxElement>,
): readonly JsxElement[] {
  const out: JsxElement[] = [];
  for (const desc of walkJsxDescendants(label)) {
    if (FORM_CONTROL_TAGS.has(desc.tagName.toLowerCase())) out.push(desc);
  }
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
  if (hasJsxAttribute(control, "required")) {
    const attr = getJsxAttribute(control, "required");
    return attr !== null;
  }
  const ariaAttr = getJsxAttribute(control, "aria-required");
  if (!ariaAttr) return false;
  if (ariaAttr.value?.kind === "Expression") return true;
  const literal = getJsxAttributeString(control, "aria-required");
  return literal === "true";
}

function buildJsxViolation(control: JsxElement, marker: MarkerSource): Parameters<Emit>[0] {
  const tag = control.tagName;
  const typeAttr = tag.toLowerCase() === "input" ? getJsxAttributeString(control, "type") : null;
  const descriptor = typeAttr ? `<${tag} type="${typeAttr}">` : `<${tag}>`;
  return {
    severity: "warning",
    location: {
      filePath: "",
      line: control.loc.start.line,
      column: control.loc.start.column,
    },
    message: buildMessage(descriptor, marker),
    suggestion: buildJsxSuggestion(tag, descriptor, marker),
  };
}

// ---------------------------------------------------------------------------
// Shared messaging
// ---------------------------------------------------------------------------

function buildMessage(descriptor: string, marker: MarkerSource): string {
  if (marker.origin === "placeholder") {
    return `${descriptor}'s \`placeholder\` text ends with a bare \`*\` (the asterisk-equals-required convention) but the control sets neither \`required\` nor \`aria-required="true"\` — screen-reader users won't know the field is required until submission fails.`;
  }
  return `the associated <label>'s text ends with a bare \`*\` (the asterisk-equals-required convention) but ${descriptor} sets neither \`required\` nor \`aria-required="true"\` — screen-reader users won't know the field is required until submission fails.`;
}

function buildHtmlSuggestion(tag: string, descriptor: string, marker: MarkerSource): string {
  const placeholderNote =
    marker.origin === "placeholder"
      ? " (placeholders also disappear on focus — pair the marker with a real <label> when possible)"
      : "";
  return `Add the boolean \`required\` attribute to ${descriptor} (the browser then exposes the required state to assistive tech and blocks submission), or set \`aria-required="true"\` on the <${tag}> if blocking submission would change validation flow${placeholderNote}. If the trailing \`*\` here is actually a footnote marker pointing at a disclosure (not a required-field convention), suppress with \`<!-- ra11y-disable forms/asterisk-required-marker -->\` so the dismissal is durable. Either programmatic signal alone satisfies SC 1.3.1 + 3.3.2 for this control.`;
}

function buildJsxSuggestion(tag: string, descriptor: string, marker: MarkerSource): string {
  const placeholderNote =
    marker.origin === "placeholder"
      ? " (placeholders also disappear on focus — pair the marker with a real <label> when possible)"
      : "";
  return `Add the \`required\` prop to ${descriptor} (the browser exposes the required state to assistive tech and blocks submission), or set \`aria-required="true"\` (or \`aria-required={isRequired}\` for a computed value) on the <${tag}> if blocking submission would change validation flow${placeholderNote}. If the trailing \`*\` here is actually a footnote marker pointing at a disclosure (not a required-field convention), suppress with \`{/* ra11y-disable forms/asterisk-required-marker */}\` so the dismissal is durable. Either programmatic signal alone satisfies SC 1.3.1 + 3.3.2 for this control.`;
}
