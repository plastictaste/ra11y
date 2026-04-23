/**
 * Rule: forms/error-message-not-associated
 * Satisfies: wcag22:3.3.1, wcag21:3.3.1, wcag22:3.3.3, wcag21:3.3.3
 * Spec: https://www.w3.org/TR/WCAG22/#error-identification
 *       https://www.w3.org/TR/WCAG22/#error-suggestion
 *
 * > If an input error is automatically detected, the item that is in
 * > error is identified and the error is described to the user in text.
 * > (SC 3.3.1 — Error Identification)
 *
 * > If an input error is automatically detected and suggestions for
 * > correction are known, then the suggestions are provided to the user,
 * > unless it would jeopardize the security or purpose of the content.
 * > (SC 3.3.3 — Error Suggestion)
 *
 * Sources:
 *   https://www.w3.org/TR/WCAG22/#error-identification
 *   https://www.w3.org/TR/WCAG22/#error-suggestion
 *
 * Flags an "error message" element — `.invalid-feedback` (Bootstrap's
 * server-side validation convention), `[role="alert"]` (the generic ARIA
 * live-region status mechanism), or `.error-message` (common hand-rolled
 * convention) — whose sibling form control has no `aria-describedby`
 * attribute that references the error element's `id`. Without that
 * association, a screen-reader user who tabs into the field hears the
 * field's label and state but never hears the error message — the page
 * "identifies" the error visually for sighted users, not
 * programmatically for assistive tech. Per SC 3.3.1 the item in error
 * must be identified AND the error described in text that reaches the
 * user; per SC 3.3.3 any correction suggestion must likewise be
 * announced. The association glue is `aria-describedby` — without it,
 * the text exists on the page but is not connected to the control.
 *
 * Canonical failing pattern (Bootstrap 5 docs, "Server-side"):
 *
 *   <input type="email" class="form-control is-invalid">
 *   <div class="invalid-feedback" id="email-error">
 *     Please enter a valid email.
 *   </div>
 *
 * Pass: the same markup with `aria-describedby="email-error"` on the
 * input. The rule does NOT try to deduce the "right" id — the author's
 * choice of `id` is respected; the rule only verifies the link exists.
 *
 * Detection model:
 *
 *   1. Find every error-message element in the document: `.invalid-
 *      feedback`, `.error-message`, or `[role="alert"]`.
 *   2. For each, walk its parent's direct children to find a sibling
 *      form control (`<input>`, `<textarea>`, `<select>`). Direct
 *      siblings only — deeper nested structures (field-within-column
 *      layouts) are out of scope for v1, to keep the signal high.
 *   3. If the sibling control has `aria-describedby` and at least one
 *      token in it equals the error element's `id`, the pair is
 *      associated — skip.
 *   4. Otherwise, emit on the error-message element with a fix that
 *      names the control and the id to add (or to create, if the error
 *      element has no id yet).
 *
 * Scope considerations:
 *
 *   - The rule does NOT fire on an error-message element with no
 *     sibling form control. A standalone `[role="alert"]` at page level
 *     (e.g. a flash-message banner) is a different pattern — live-region
 *     announcement, not field-level error identification. That case is
 *     covered by `aria/live-region-valid`.
 *   - The rule does NOT fire when the control already carries a
 *     matching `aria-describedby`, even if other tokens also appear
 *     (multiple id references are valid — `aria-describedby="hint
 *     email-error"` is the common pattern for help-text + error-text).
 *   - When the control uses a JSX expression value for
 *     `aria-describedby` (`aria-describedby={errorId}`) we do NOT fire —
 *     the developer is computing the id at render time; same tradeoff
 *     `aria-invalid-missing` makes for expression values.
 *   - When the error element has no `id` at all, the failure mode is
 *     broader (no id = no possible reference). We still fire, with a
 *     fix that instructs the author to add an id AND wire it into
 *     `aria-describedby`.
 *
 * Out of scope (deliberate):
 *
 *   - Cross-file / cross-component id references. Rules are per-file;
 *     validating a `aria-describedby` that resolves in a parent
 *     component is a runtime concern.
 *   - Generic `<div>` error text without `.invalid-feedback`,
 *     `.error-message`, or `role="alert"`. Without a recognizable
 *     marker, the static signal "this is an error message" is not
 *     strong enough; the `forms/labels-required` + `aria-invalid-
 *     missing` rules cover the adjacent concerns.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
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

/** Form-control tags whose sibling error message must be associated. */
const FORM_CONTROL_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

/**
 * Class tokens that mark an element as an error-message surface. The
 * set is deliberately narrow — only well-established error conventions.
 * Generic tokens like `.error` are too ambiguous (could be a status
 * banner, could be a CSS state class). Bootstrap's `.invalid-feedback`
 * is canonical; `.error-message` is the common hand-rolled convention.
 */
const ERROR_MESSAGE_CLASSES: ReadonlySet<string> = new Set(["invalid-feedback", "error-message"]);

export const rule = defineRule({
  id: "forms/error-message-not-associated",
  satisfies: ["wcag22:3.3.1", "wcag21:3.3.1", "wcag22:3.3.3", "wcag21:3.3.3"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  // Per the scope note above: cross-file / cross-component
  // `aria-describedby` resolutions are out of scope for the per-file
  // check. The error-message element may be rendered in a parent
  // component that injects `aria-describedby` on the control at the
  // composition site, so a clean tally on the leaf component alone
  // is not honest. `crossFileCapable: false` downgrades to
  // `coverageConfidence: "medium"` with the IDREF-resolution reason
  // code per ADR 0026.
  crossFileCapable: false,
  docs: {
    description:
      "An error-message element (.invalid-feedback / .error-message / [role=alert]) adjacent to a form control must be referenced via aria-describedby on that control, or screen-reader users never hear the error.",
    rationale:
      'SC 3.3.1 requires the item in error to be identified AND the error described in text that reaches the user. "Reaches the user" is the load-bearing clause for assistive-tech consumers: a `<div class="invalid-feedback">` next to an `<input>` shows a red error message to sighted users, but a screen-reader user tabbing into the field hears only the label and state — the error text is in the DOM but not wired to the control. `aria-describedby` is the association mechanism; without it the text is invisible to the accessibility tree. SC 3.3.3 then piles on for the correction-suggestion case — an error message that says "enter a valid email" is a suggestion that must also be announced with the control. The fix is one attribute (`aria-describedby="<error-id>"`) plus, if missing, an `id` on the error element. Static analysis can prove the link is broken cheaply: the error element is present, the control is present, and the `aria-describedby` token either exists or it does not.',
    goodExample: `<input type="email" class="form-control is-invalid" aria-describedby="email-error">
<div class="invalid-feedback" id="email-error">Please enter a valid email.</div>`,
    badExample: `<input type="email" class="form-control is-invalid">
<div class="invalid-feedback" id="email-error">Please enter a valid email.</div>`,
    normativeQuote:
      "If an input error is automatically detected, the item that is in error is identified and the error is described to the user in text. (SC 3.3.1) If an input error is automatically detected and suggestions for correction are known, the suggestions are provided to the user. (SC 3.3.3)",
    references: [
      "https://www.w3.org/TR/WCAG22/#error-identification",
      "https://www.w3.org/TR/WCAG22/#error-suggestion",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA18",
      "https://getbootstrap.com/docs/5.3/forms/validation/#server-side",
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
  severity: "error";
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
    if (!isHtmlErrorMessage(el)) continue;
    const parent = parentOf.get(el);
    if (!parent) continue;
    const control = findHtmlSiblingControl(parent, el);
    if (!control) continue;
    const errorId = getHtmlAttribute(el, "id");
    const describedBy = getHtmlAttribute(control, "aria-describedby");
    if (errorId !== null && errorId !== "" && describedByIncludes(describedBy, errorId)) continue;
    emit(buildHtmlViolation(el, control, errorId, describedBy));
  }
}

function isHtmlErrorMessage(el: HtmlElement): boolean {
  const role = getHtmlAttribute(el, "role");
  if (role !== null && role.trim().toLowerCase() === "alert") return true;
  const classAttr = getHtmlAttribute(el, "class");
  if (classAttr === null) return false;
  return classContainsAnyToken(classAttr, ERROR_MESSAGE_CLASSES);
}

function findHtmlSiblingControl(
  parent: HtmlElement,
  errorEl: HtmlElement,
): HtmlElement | undefined {
  for (const child of parent.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child === errorEl) continue;
    if (FORM_CONTROL_TAGS.has(child.tagName.toLowerCase())) return child;
  }
  return undefined;
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
    if (!isJsxErrorMessage(el)) continue;
    const parent = parentOf.get(el);
    if (!parent) continue;
    const control = findJsxSiblingControl(parent, el);
    if (!control) continue;
    const errorId = getJsxAttributeString(el, "id");
    // Expression-valued aria-describedby: we can't prove the link, but
    // we trust the developer is computing the id at render time (same
    // tradeoff aria-invalid-missing and labels-required make). A
    // StringLiteral we parse and token-check; null value means bare
    // attribute (no value) which is useless for describedby.
    const describedByAttr = getJsxAttribute(control, "aria-describedby");
    if (describedByAttr?.value?.kind === "Expression") continue;
    const describedBy =
      describedByAttr?.value?.kind === "StringLiteral" ? describedByAttr.value.value : null;
    if (errorId !== null && errorId !== "" && describedByIncludes(describedBy, errorId)) continue;
    emit(buildJsxViolation(el, control, errorId, describedBy));
  }
}

function isJsxErrorMessage(el: JsxElement): boolean {
  const role = getJsxAttributeString(el, "role");
  if (role !== null && role.trim().toLowerCase() === "alert") return true;
  const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classValue === null) return false;
  return classContainsAnyToken(classValue, ERROR_MESSAGE_CLASSES);
}

function findJsxSiblingControl(parent: JsxElement, errorEl: JsxElement): JsxElement | undefined {
  for (const child of parent.children) {
    if (child.kind !== "JsxElement") continue;
    if (child === errorEl) continue;
    // JSX tag names are case-sensitive by convention; native HTML tags
    // stay lowercase. Comparing against the lowercased set matches the
    // expected `<input>` / `<select>` / `<textarea>` author style.
    if (FORM_CONTROL_TAGS.has(child.tagName.toLowerCase())) return child;
  }
  return undefined;
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

function classContainsAnyToken(classValue: string, tokens: ReadonlySet<string>): boolean {
  for (const t of classValue.split(/\s+/u)) {
    if (tokens.has(t)) return true;
  }
  return false;
}

/**
 * True when `describedBy` contains `errorId` as a whole,
 * whitespace-delimited token. `aria-describedby` accepts a space-
 * separated list of id references — `aria-describedby="help email-error"`
 * must match both `help` and `email-error` but not `email`.
 */
function describedByIncludes(describedBy: string | null, errorId: string): boolean {
  if (describedBy === null) return false;
  for (const t of describedBy.split(/\s+/u)) {
    if (t === errorId) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Violation builders
// ---------------------------------------------------------------------------

interface ViolationInput {
  readonly errorKind: ErrorKind;
  readonly controlTag: string;
  readonly controlType: string | null;
  readonly errorId: string | null;
  readonly describedBy: string | null;
  readonly location: { readonly line: number; readonly column: number };
}

type ErrorKind = "invalid-feedback" | "error-message" | "role-alert";

function buildHtmlViolation(
  errorEl: HtmlElement,
  control: HtmlElement,
  errorId: string | null,
  describedBy: string | null,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return buildViolation({
    errorKind: classifyHtmlErrorElement(errorEl),
    controlTag: control.tagName.toLowerCase(),
    controlType: getHtmlAttribute(control, "type"),
    errorId,
    describedBy,
    location: { line: errorEl.loc.start.line, column: errorEl.loc.start.column },
  });
}

function buildJsxViolation(
  errorEl: JsxElement,
  control: JsxElement,
  errorId: string | null,
  describedBy: string | null,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return buildViolation({
    errorKind: classifyJsxErrorElement(errorEl),
    controlTag: control.tagName.toLowerCase(),
    controlType: getJsxAttributeString(control, "type"),
    errorId,
    describedBy,
    location: { line: errorEl.loc.start.line, column: errorEl.loc.start.column },
  });
}

function classifyHtmlErrorElement(el: HtmlElement): ErrorKind {
  const role = getHtmlAttribute(el, "role");
  if (role !== null && role.trim().toLowerCase() === "alert") return "role-alert";
  const classAttr = getHtmlAttribute(el, "class") ?? "";
  return classAttr.split(/\s+/u).includes("invalid-feedback")
    ? "invalid-feedback"
    : "error-message";
}

function classifyJsxErrorElement(el: JsxElement): ErrorKind {
  const role = getJsxAttributeString(el, "role");
  if (role !== null && role.trim().toLowerCase() === "alert") return "role-alert";
  const classValue =
    getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class") ?? "";
  return classValue.split(/\s+/u).includes("invalid-feedback")
    ? "invalid-feedback"
    : "error-message";
}

function buildViolation(input: ViolationInput): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const errorDescriptor = describeErrorElement(input.errorKind);
  const controlDescriptor = describeControl(input.controlTag, input.controlType);
  return {
    severity: "error",
    location: { filePath: "", line: input.location.line, column: input.location.column },
    message: buildMessage(errorDescriptor, controlDescriptor, input.describedBy),
    suggestion: buildSuggestion(
      errorDescriptor,
      controlDescriptor,
      input.errorId,
      input.describedBy,
    ),
  };
}

function describeErrorElement(kind: ErrorKind): string {
  if (kind === "role-alert") return 'this [role="alert"] element';
  if (kind === "invalid-feedback") return 'this <div class="invalid-feedback">';
  return "this .error-message element";
}

function describeControl(tag: string, type: string | null): string {
  if (tag === "input" && type !== null && type !== "") return `the sibling <input type="${type}">`;
  return `the sibling <${tag}>`;
}

function buildMessage(
  errorDescriptor: string,
  controlDescriptor: string,
  describedBy: string | null,
): string {
  if (describedBy !== null && describedBy.length > 0) {
    return `${errorDescriptor} is adjacent to a form control but ${controlDescriptor} has aria-describedby="${describedBy}" which does not reference this error element's id — screen-reader users tabbing into the field will not hear the error text.`;
  }
  return `${errorDescriptor} is adjacent to a form control but ${controlDescriptor} has no aria-describedby — screen-reader users tabbing into the field will not hear the error text.`;
}

function buildSuggestion(
  errorDescriptor: string,
  controlDescriptor: string,
  errorId: string | null,
  describedBy: string | null,
): string {
  if (errorId === null || errorId === "") {
    return `Add an id to ${errorDescriptor} (e.g. id="field-error") and set aria-describedby="field-error" on ${controlDescriptor}. The id name is authorship — any stable, document-unique string works — but both attributes must exist and the token in aria-describedby must match the id exactly.`;
  }
  if (describedBy !== null && describedBy.length > 0) {
    return `Append "${errorId}" to ${controlDescriptor}'s aria-describedby (e.g. aria-describedby="${describedBy} ${errorId}"). aria-describedby accepts a space-separated list of ids, so you keep the existing help-text reference and add the error reference — both will be announced after the field label.`;
  }
  return `Add aria-describedby="${errorId}" to ${controlDescriptor} so assistive tech announces the error text alongside the field's label and state. If the control also needs to carry other descriptions (help text, format hints), include their ids in the same attribute separated by spaces.`;
}
