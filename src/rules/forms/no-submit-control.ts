/**
 * Rule: forms/no-submit-control
 * Satisfies: wcag22:3.3.2, wcag21:3.3.2
 * Spec: https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *
 * > Labels or instructions are provided when content requires user input.
 *
 * Source: https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *         https://www.w3.org/WAI/WCAG22/Techniques/general/G184
 *
 * Catches broken-stub contact forms: a `<form>` that contains text
 * inputs (or `<textarea>`) but no submit control of any kind, leaving
 * users with no documented way to send the data they typed. The
 * "labels or instructions" criterion covers the affordance for
 * *completing* a form, not just labelling its fields — a form a user
 * has no way to submit is a form whose instructions for completion
 * are absent.
 *
 * A submit control is one of:
 *   - `<input type="submit">` or `<input type="image">`
 *   - `<button type="submit">`
 *   - `<button>` with no explicit `type` attribute (HTML spec defaults
 *     a `<button>` inside a form to `type="submit"`)
 *
 * Skip conditions (intentional non-fires, NOT heuristic suppression
 * of a real predicate — these are cases where the predicate "user has
 * no way to submit" is provably false from the AST):
 *   - The form has an `onSubmit` handler in JSX. The handler is the
 *     submission path even if no default-type button is present
 *     (e.g. submission triggered by Enter on an input, custom
 *     keybindings, or a parent component's call to `form.requestSubmit()`).
 *   - The form's only inputs are hidden / radio / checkbox / button
 *     types. A radio-only form is a poll widget; without a text input
 *     the "broken contact form" pattern doesn't apply, and many
 *     radio-only forms intentionally submit on change.
 *   - There are no inputs at all. An empty `<form>` is a markup error
 *     other rules cover; this rule's predicate ("text input but no
 *     submit") doesn't apply.
 *
 * Complementary to `forms/submit-not-button-or-input`, which catches
 * the form-with-only-an-anchor-styled-as-button case.
 */
import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasJsxAttribute,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "email",
  "password",
  "tel",
  "url",
  "search",
  "number",
]);

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "radio",
  "checkbox",
  "button",
  "submit",
  "image",
  "reset",
  "file",
  "color",
  "range",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

export const rule = defineRule({
  id: "forms/no-submit-control",
  satisfies: ["wcag22:3.3.2", "wcag21:3.3.2"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<form> with text inputs but no submit control (button[type=submit], input[type=submit], or default-type <button>) leaves users with no way to submit.",
    rationale:
      "WCAG 3.3.2 covers labels OR instructions for completing a form — the affordance to submit is part of the instructions. A contact form with name/email/message inputs but no Send button is the canonical broken stub: the author started building a form, scaffolded the inputs, and never came back to add the submit control. Sighted users hunt for a button and find none; keyboard users press Enter, which only submits implicitly when a default-type submit button exists in the form. Static detection is reliable because the absence is structural — no DOM render, no CSS state, no JS path is needed to confirm 'this form has nowhere to send the typed data.'",
    goodExample: `<form action="/contact" method="post">\n  <label>Name <input type="text" name="name"></label>\n  <label>Message <textarea name="message"></textarea></label>\n  <button>Send</button>\n</form>`,
    badExample: `<form action="/contact" method="post">\n  <label>Name <input type="text" name="name"></label>\n  <label>Message <textarea name="message"></textarea></label>\n  <button type="button">Reset</button>\n</form>`,
    normativeQuote: "Labels or instructions are provided when content requires user input.",
    references: [
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G184",
      "https://html.spec.whatwg.org/multipage/form-elements.html#attr-button-type",
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

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const form of findHtmlElementsByTag(doc, "form")) {
    if (!htmlFormHasTextInput(form)) continue;
    if (htmlFormHasSubmit(form)) continue;
    emit({
      severity: "error",
      location: { filePath: "", line: form.loc.start.line, column: form.loc.start.column },
      message: buildMessage(describeHtmlForm(form)),
      suggestion: buildSuggestion(),
    });
  }
}

function htmlFormHasTextInput(form: HtmlElement): boolean {
  for (const el of walkHtmlElements(form)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      // Per HTML spec, omitted `type` defaults to "text".
      const type = (getHtmlAttribute(el, "type") ?? "text").toLowerCase();
      if (TEXT_INPUT_TYPES.has(type)) return true;
      if (!NON_TEXT_INPUT_TYPES.has(type)) {
        // Unknown type tokens fall back to "text" per HTML spec
        // (https://html.spec.whatwg.org/#attr-input-type-keywords).
        return true;
      }
    }
  }
  return false;
}

function htmlFormHasSubmit(form: HtmlElement): boolean {
  for (const el of walkHtmlElements(form)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "button") {
      // <button> defaults to type="submit"; only type="button" or
      // type="reset" disqualify.
      const type = (getHtmlAttribute(el, "type") ?? "submit").toLowerCase();
      if (type === "submit") return true;
      continue;
    }
    if (tag === "input") {
      const type = getHtmlAttribute(el, "type")?.toLowerCase();
      if (type === "submit" || type === "image") return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const form of findJsxElementsByTag(module, "form")) {
    if (!jsxFormHasTextInput(form)) continue;
    if (jsxFormHasSubmit(form)) continue;
    if (hasJsxAttribute(form, "onSubmit")) continue;
    emit({
      severity: "error",
      location: { filePath: "", line: form.loc.start.line, column: form.loc.start.column },
      message: buildMessage(describeJsxForm(form)),
      suggestion: buildSuggestion(),
    });
  }
}

function jsxFormHasTextInput(form: JsxElement): boolean {
  for (const el of walkJsxDescendants(form)) {
    const tag = el.tagName;
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = (getJsxAttributeString(el, "type") ?? "text").toLowerCase();
      if (TEXT_INPUT_TYPES.has(type)) return true;
      if (!NON_TEXT_INPUT_TYPES.has(type)) return true;
    }
  }
  return false;
}

function jsxFormHasSubmit(form: JsxElement): boolean {
  for (const el of walkJsxDescendants(form)) {
    const tag = el.tagName;
    if (tag === "button") {
      const type = (getJsxAttributeString(el, "type") ?? "submit").toLowerCase();
      if (type === "submit") return true;
      continue;
    }
    if (tag === "input") {
      const type = getJsxAttributeString(el, "type")?.toLowerCase();
      if (type === "submit" || type === "image") return true;
    }
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

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

function buildMessage(formDesc: string): string {
  return `${formDesc} contains text input(s) but no submit control. Users have no way to submit the form — no <button>, no <button type="submit">, no <input type="submit">, no <input type="image">.`;
}

function buildSuggestion(): string {
  return `Add a submit control inside the form: <button>Send</button> (a <button> with no explicit type defaults to type="submit"), or <button type="submit">Send</button>, or <input type="submit" value="Send">. If submission is meant to fire from JS only, attach an onSubmit handler so Enter-on-input triggers it (and the form has a documented submission path).`;
}

function describeHtmlForm(form: HtmlElement): string {
  const id = getHtmlAttribute(form, "id");
  if (id && id.trim().length > 0) return `<form id="${id}">`;
  const action = getHtmlAttribute(form, "action");
  if (action && action.trim().length > 0) return `<form action="${action}">`;
  const name = getHtmlAttribute(form, "name");
  if (name && name.trim().length > 0) return `<form name="${name}">`;
  return "<form>";
}

function describeJsxForm(form: JsxElement): string {
  const id = getJsxAttributeString(form, "id");
  if (id && id.trim().length > 0) return `<form id="${id}">`;
  const action = getJsxAttributeString(form, "action");
  if (action && action.trim().length > 0) return `<form action="${action}">`;
  const name = getJsxAttributeString(form, "name");
  if (name && name.trim().length > 0) return `<form name="${name}">`;
  return "<form>";
}
