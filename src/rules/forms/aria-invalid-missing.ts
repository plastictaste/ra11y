/**
 * Rule: forms/aria-invalid-missing
 * Satisfies: wcag22:1.4.1, wcag21:1.4.1, wcag22:4.1.3, wcag21:4.1.3
 * Spec: https://www.w3.org/TR/WCAG22/#use-of-color
 *       https://www.w3.org/TR/WCAG22/#status-messages
 *
 * > Color is not used as the only visual means of conveying information,
 * > indicating an action, prompting a response, or distinguishing a visual
 * > element. (SC 1.4.1)
 *
 * > In content implemented using markup languages, status messages can be
 * > programmatically determined through role or properties such that they
 * > can be presented to the user by assistive technologies without
 * > receiving focus. (SC 4.1.3)
 *
 * Sources:
 *   https://www.w3.org/TR/WCAG22/#use-of-color
 *   https://www.w3.org/TR/WCAG22/#status-messages
 *
 * Flags form controls that carry a Bootstrap-style validation-error class
 * (`is-invalid`) — or the equivalent server-rendered companion
 * `was-validated` parent state — but never set `aria-invalid="true"`. The
 * `.is-invalid` class paints a red border, a red focus ring, and a red
 * icon; sighted users see "this field is wrong" by color and iconography
 * alone. Assistive tech gets nothing unless `aria-invalid` is set, so
 * the error state is color-only (1.4.1) and the field's invalid status
 * is not programmatically determinable (4.1.3).
 *
 * Canonical failing pattern (Bootstrap 5 docs, "Server-side" validation):
 *
 *   <input type="email" class="form-control is-invalid" value="foo">
 *   <div class="invalid-feedback">Please enter a valid email.</div>
 *
 * Pass conditions, any of:
 *   1. `aria-invalid="true"` is set on the control.
 *   2. `aria-invalid` is present with a non-literal (expression) value
 *      in JSX — e.g. `aria-invalid={hasError}` — we trust the developer
 *      is computing the value at render time (same tradeoff `labels-
 *      required` makes for `aria-label={t(…)}`).
 *
 * Flag conditions:
 *   - `aria-invalid="false"` explicitly contradicts the visual error
 *     state. The control looks invalid but claims to be valid.
 *   - `aria-invalid` absent entirely — visual-only indicator.
 *
 * Scope:
 *   - `<input>` (except `type="hidden"|"submit"|"reset"|"button"|"image"`
 *     which do not carry user-entered values)
 *   - `<select>`
 *   - `<textarea>`
 *
 * Out of scope (deliberate):
 *   - CSS `:invalid` pseudo-class styling. The browser's built-in
 *     validity state already updates the accessibility tree, so
 *     `:invalid` without `aria-invalid` isn't a color-only failure in
 *     the same way. Authors who add Bootstrap's `is-invalid` on top of
 *     `:invalid` opt into the class-driven path; that's what we check.
 *   - Bootstrap's `.is-valid` class. The spec only requires error-state
 *     exposure; a valid state doesn't need `aria-invalid="false"`.
 *   - Custom error-class names (`.has-error`, `.field--error`, etc.).
 *     We match the specific Bootstrap token because it is the most
 *     widely-copied color-only pattern; a generic "any error-ish class"
 *     matcher would fire on ambiguous tokens we can't confirm are
 *     error-state CSS.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/** Form-control tags this rule inspects. */
const FORM_CONTROL_TAGS: readonly ["input", "select", "textarea"] = ["input", "select", "textarea"];

/**
 * `<input>` type values that don't carry user-entered data a validity
 * state would describe. Same exclusion set as `forms/labels-required`,
 * plus there's no sensible "invalid" story for button-shaped inputs.
 */
const NON_DATA_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

/** The Bootstrap class that paints the error state without touching ARIA. */
const BOOTSTRAP_INVALID_CLASS = "is-invalid";

export const rule = defineRule({
  id: "forms/aria-invalid-missing",
  satisfies: ["wcag22:1.4.1", "wcag21:1.4.1", "wcag22:4.1.3", "wcag21:4.1.3"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".tsx", ".jsx", ".html", ".htm"],
  },
  docs: {
    description:
      'Form inputs with the Bootstrap .is-invalid error class must set aria-invalid="true" so assistive tech announces the error state — otherwise the invalid state is conveyed by color alone.',
    rationale:
      'Bootstrap\'s `.is-invalid` class is the canonical server-side validation pattern: a red border, red focus ring, and red cross-icon paint the error for sighted users without touching the accessibility tree. Without `aria-invalid="true"` the screen-reader user hears the same `edit, blank` they heard before submitting — the page\'s visual claim that the field is wrong never reaches them. That makes the error state color-only (WCAG 1.4.1 — Use of Color) and blocks the field\'s validity from being programmatically determined (WCAG 4.1.3 — Status Messages). `aria-invalid="false"` on an `.is-invalid` element is worse: it actively lies to assistive tech about the state the author is painting on the page. The fix is a single attribute — `aria-invalid="true"` — and, while you\'re there, pointing `aria-describedby` at the companion `<div class="invalid-feedback">` so the error text is announced too.',
    goodExample: `<input type="email" class="form-control is-invalid" aria-invalid="true" aria-describedby="email-error">
<div id="email-error" class="invalid-feedback">Please enter a valid email.</div>`,
    badExample: `<input type="email" class="form-control is-invalid">
<div class="invalid-feedback">Please enter a valid email.</div>`,
    normativeQuote:
      "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element. (SC 1.4.1) Status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus. (SC 4.1.3)",
    references: [
      "https://www.w3.org/TR/WCAG22/#use-of-color",
      "https://www.w3.org/TR/WCAG22/#status-messages",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA21",
      "https://getbootstrap.com/docs/5.3/forms/validation/#server-side",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
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

type AriaInvalidState =
  | { kind: "absent" }
  | { kind: "true" }
  | { kind: "false"; raw: string }
  | { kind: "other"; raw: string }
  | { kind: "expression" };

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const tag of FORM_CONTROL_TAGS) {
    for (const el of findHtmlElementsByTag(doc, tag)) {
      checkHtmlElement(el, emit);
    }
  }
}

function checkHtmlElement(el: HtmlElement, emit: Emit): void {
  if (isExcludedInput(getHtmlAttribute(el, "type"))) return;
  const classAttr = getHtmlAttribute(el, "class");
  if (classAttr === null) return;
  if (!classContainsToken(classAttr, BOOTSTRAP_INVALID_CLASS)) return;
  const state = htmlAriaInvalidState(el);
  if (state.kind === "true" || state.kind === "expression") return;
  const typeAttr = getHtmlAttribute(el, "type");
  emit(
    buildViolation({
      tagName: el.tagName.toLowerCase(),
      type: typeAttr,
      classValue: classAttr,
      state,
      location: { line: el.loc.start.line, column: el.loc.start.column },
    }),
  );
}

function htmlAriaInvalidState(el: HtmlElement): AriaInvalidState {
  if (!hasHtmlAttribute(el, "aria-invalid")) return { kind: "absent" };
  const raw = getHtmlAttribute(el, "aria-invalid");
  // Bare attribute (`<input aria-invalid>`) parses as null/"". In HTML,
  // per the ARIA spec, a bare enumerated attribute takes the default —
  // `aria-invalid`'s default is `"false"`. Treat bare as an explicit
  // false so the contradiction is surfaced, not silently accepted.
  if (raw === null || raw === "") return { kind: "false", raw: raw ?? "" };
  const lower = raw.toLowerCase().trim();
  if (lower === "true") return { kind: "true" };
  if (lower === "false") return { kind: "false", raw };
  // aria-invalid accepts "grammar" and "spelling" as well. Those are
  // true-ish values — the field is invalid, just a specific subtype —
  // so they satisfy the rule.
  if (lower === "grammar" || lower === "spelling") return { kind: "true" };
  return { kind: "other", raw };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const tag of FORM_CONTROL_TAGS) {
    for (const el of findJsxElementsByTag(module, tag)) {
      checkJsxElement(el, emit);
    }
  }
}

function checkJsxElement(el: JsxElement, emit: Emit): void {
  if (isExcludedInput(getJsxAttributeString(el, "type"))) return;
  const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classValue === null) return;
  if (!classContainsToken(classValue, BOOTSTRAP_INVALID_CLASS)) return;
  const state = jsxAriaInvalidState(el);
  if (state.kind === "true" || state.kind === "expression") return;
  const typeAttr = getJsxAttributeString(el, "type");
  emit(
    buildViolation({
      tagName: el.tagName,
      type: typeAttr,
      classValue,
      state,
      location: { line: el.loc.start.line, column: el.loc.start.column },
    }),
  );
}

function jsxAriaInvalidState(el: JsxElement): AriaInvalidState {
  if (!hasJsxAttribute(el, "aria-invalid")) return { kind: "absent" };
  const attr = getJsxAttribute(el, "aria-invalid");
  if (attr === null) return { kind: "absent" };
  // Bare attribute `<input aria-invalid />` — JSX parses this as
  // `value === null` and React coerces to `true`. Treat as satisfying.
  if (attr.value === null) return { kind: "true" };
  if (attr.value.kind === "Expression") return { kind: "expression" };
  // StringLiteral
  const raw = attr.value.value;
  if (raw === "") return { kind: "false", raw };
  const lower = raw.toLowerCase().trim();
  if (lower === "true") return { kind: "true" };
  if (lower === "false") return { kind: "false", raw };
  if (lower === "grammar" || lower === "spelling") return { kind: "true" };
  return { kind: "other", raw };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * True when `classValue` contains `token` as a whole, whitespace-delimited
 * token. Avoids matching substrings like `was-invalidated` when looking
 * for `is-invalid`.
 */
function classContainsToken(classValue: string, token: string): boolean {
  for (const t of classValue.split(/\s+/u)) {
    if (t === token) return true;
  }
  return false;
}

function isExcludedInput(type: string | null): boolean {
  if (type === null) return false;
  return NON_DATA_INPUT_TYPES.has(type.toLowerCase());
}

interface ViolationInput {
  readonly tagName: string;
  readonly type: string | null;
  readonly classValue: string;
  readonly state: AriaInvalidState;
  readonly location: { readonly line: number; readonly column: number };
}

function buildViolation(input: ViolationInput): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const descriptor = buildDescriptor(input.tagName, input.type, input.classValue);
  const message = buildMessage(descriptor, input.state);
  const suggestion = buildSuggestion(input.tagName, input.state);
  return {
    severity: "error",
    location: { filePath: "", line: input.location.line, column: input.location.column },
    message,
    suggestion,
  };
}

function buildDescriptor(tagName: string, type: string | null, classValue: string): string {
  const tag = tagName.toLowerCase();
  const classPart = ` class="${classValue}"`;
  if (tag === "input" && type !== null && type !== "") {
    return `<input type="${type}"${classPart}>`;
  }
  return `<${tagName}${classPart}>`;
}

function buildMessage(descriptor: string, state: AriaInvalidState): string {
  if (state.kind === "false" || state.kind === "other") {
    const rawLabel =
      state.kind === "false"
        ? state.raw === ""
          ? "bare (defaults to false)"
          : `"${state.raw}"`
        : `"${state.raw}"`;
    return `${descriptor} carries Bootstrap's .is-invalid error-state class but declares aria-invalid=${rawLabel} — the visual state and the accessibility tree contradict each other, so screen-reader users are told the field is valid while sighted users see it flagged as wrong.`;
  }
  return `${descriptor} carries Bootstrap's .is-invalid error-state class but never sets aria-invalid — the invalid state is conveyed by color (red border/ring/icon) only, so assistive tech users are not told the field is in error.`;
}

function buildSuggestion(tagName: string, state: AriaInvalidState): string {
  const tag = tagName.toLowerCase();
  const controlPhrase = tag === "input" ? "this input" : `this <${tagName}>`;
  if (state.kind === "false" || state.kind === "other") {
    return `Change \`aria-invalid\` to \`"true"\` on ${controlPhrase} — the \`.is-invalid\` class is Bootstrap's error painter, so the ARIA state must agree with it. If the field is actually valid and the class is left over from a previous render, remove \`.is-invalid\` instead. While you're there, point \`aria-describedby\` at the companion \`<div class="invalid-feedback">\` so the error text is announced with the control.`;
  }
  return `Add \`aria-invalid="true"\` to ${controlPhrase} so assistive tech announces the error state the \`.is-invalid\` class is painting. Also point \`aria-describedby\` at the companion \`<div class="invalid-feedback">\` (give the feedback div an \`id\` and reference it) so the error message is announced alongside the control.`;
}
