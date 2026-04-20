/**
 * Rule: forms/non-empty-label
 * Satisfies: wcag22:2.4.6, wcag21:2.4.6, wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *
 * > Headings and labels describe topic or purpose.
 *
 * Flags `<label>` elements that exist in the markup but whose text
 * content is empty or whitespace-only. Empty labels defeat the
 * purpose — screen readers announce the control with no name, and
 * `forms/labels-required` thinks the control is labeled because a
 * `<label for="…">` points at it.
 *
 * Covers: HTML `<label>` and JSX `<label>` elements (including
 * lowercase JSX — PascalCase components like `<FormLabel>` render
 * opaque content we can't resolve at static-analysis time and stay
 * out of scope here).
 *
 * Whitespace-only content, comments-only, and a single `<br>` child
 * all count as empty. An `aria-label` attribute on the label element
 * itself does NOT rescue it — the attribute names the label, not
 * the control it labels, and browsers still announce the referenced
 * control by the (empty) label's text content.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "forms/non-empty-label",
  satisfies: ["wcag22:2.4.6", "wcag21:2.4.6", "wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "error",
  scope: "document",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<label> elements must contain descriptive text. Empty labels announce controls as unnamed and defeat assistive-tech navigation.",
    rationale:
      "Screen readers announce a form control by the text of its associated <label>. An empty label means the user hears 'edit' or 'combobox' with no hint as to what to type. An empty label is often a bug — someone wrapped `<input>` in `<label>` then forgot to add the visible text, or they pushed label text into a sibling div that styles as a label but isn't one.",
    goodExample: '<label for="email">Email address</label><input id="email">',
    badExample: '<label for="email"></label><input id="email">',
    normativeQuote: "Headings and labels describe topic or purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#headings-and-labels",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G131",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
      return;
    }
    if (ctx.language === "tsx" || ctx.language === "jsx") {
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

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const controls = collectHtmlControlsById(doc);
  for (const label of findHtmlElementsByTag(doc, "label")) {
    if (isEmptyHtml(label)) emit(emitHtml(label, controls));
  }
}

function checkJsx(module: TsxModule, emit: Emit): void {
  const controls = collectJsxControlsById(module);
  for (const label of findJsxElementsByTag(module, "label")) {
    if (!isEmptyJsx(label)) continue;
    emit(label.hasSpreadProps ? emitJsxPrimitive(label) : emitJsx(label, controls));
  }
}

// ---------------------------------------------------------------------------
// Emptiness checks
// ---------------------------------------------------------------------------

function isEmptyHtml(label: HtmlElement): boolean {
  return htmlTextContent(label).trim().length === 0;
}

function isEmptyJsx(label: JsxElement): boolean {
  return jsxTextContent(label).trim().length === 0;
}

// ---------------------------------------------------------------------------
// Control index (id → form-control summary)
// ---------------------------------------------------------------------------

/**
 * Summary of a form control used to derive a label candidate. All
 * fields are either non-empty strings or null — never the empty
 * string, so downstream branching stays honest (see the "ambiguous
 * field shapes" rule in the AI-first consumer doctrine).
 */
interface ControlSummary {
  readonly tag: string;
  readonly type: string | null;
  readonly name: string | null;
  readonly placeholder: string | null;
  readonly line: number;
}

const CONTROL_TAGS = new Set(["input", "select", "textarea"]);

function collectHtmlControlsById(doc: HtmlDocument): Map<string, ControlSummary> {
  const byId = new Map<string, ControlSummary>();
  for (const el of walkHtmlElements(doc)) {
    if (!CONTROL_TAGS.has(el.tagName.toLowerCase())) continue;
    const id = getHtmlAttribute(el, "id");
    if (id === null || id.length === 0) continue;
    if (byId.has(id)) continue;
    byId.set(id, {
      tag: el.tagName.toLowerCase(),
      type: nonEmpty(getHtmlAttribute(el, "type")),
      name: nonEmpty(getHtmlAttribute(el, "name")),
      placeholder: nonEmpty(getHtmlAttribute(el, "placeholder")),
      line: el.loc.start.line,
    });
  }
  return byId;
}

function collectJsxControlsById(module: TsxModule): Map<string, ControlSummary> {
  const byId = new Map<string, ControlSummary>();
  for (const el of walkJsxElements(module)) {
    if (!CONTROL_TAGS.has(el.tagName.toLowerCase())) continue;
    const id = getJsxAttributeString(el, "id");
    if (id === null || id.length === 0) continue;
    if (byId.has(id)) continue;
    byId.set(id, {
      tag: el.tagName.toLowerCase(),
      type: nonEmpty(getJsxAttributeString(el, "type")),
      name: nonEmpty(getJsxAttributeString(el, "name")),
      placeholder: nonEmpty(getJsxAttributeString(el, "placeholder")),
      line: el.loc.start.line,
    });
  }
  return byId;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

function emitHtml(label: HtmlElement, controls: ReadonlyMap<string, ControlSummary>) {
  const target = getHtmlAttribute(label, "for");
  return {
    severity: "error" as const,
    location: {
      filePath: "",
      line: label.loc.start.line,
      column: label.loc.start.column,
    },
    message: "<label> is empty — add visible text that describes the control it labels.",
    suggestion: buildSuggestion(target, controls, "html"),
  };
}

function emitJsx(label: JsxElement, controls: ReadonlyMap<string, ControlSummary>) {
  const target = getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
  return {
    severity: "error" as const,
    location: {
      filePath: "",
      line: label.loc.start.line,
      column: label.loc.start.column,
    },
    message: "<label> is empty — add visible text that describes the control it labels.",
    suggestion: buildSuggestion(target, controls, "jsx"),
  };
}

function emitJsxPrimitive(label: JsxElement) {
  return {
    severity: "info" as const,
    location: {
      filePath: "",
      line: label.loc.start.line,
      column: label.loc.start.column,
    },
    message:
      "<label> has no visible children but receives {...spread} props — this looks like a component primitive. Whether the label is empty at render time depends on what the caller passes. Verify at usage sites.",
    suggestion:
      "If the component is only ever called with text children, this is fine — add `{/* ra11y-disable forms/non-empty-label */}` at the top of the file to silence this info note. Otherwise ensure every call site passes label text.",
  };
}

// ---------------------------------------------------------------------------
// Suggestion builder (three-branch ladder)
// ---------------------------------------------------------------------------

type Dialect = "html" | "jsx";

function buildSuggestion(
  target: string | null,
  controls: ReadonlyMap<string, ControlSummary>,
  dialect: Dialect,
): string {
  // Branch A: no `for` / `htmlFor` — nothing to cross-reference; fall back to
  // the generic (but dialect-aware) advice about moving sibling text in.
  if (target === null || target.length === 0) {
    return dialect === "jsx"
      ? 'Put the human-readable label text as a child of the <label> element, e.g. <label htmlFor="email">Email</label>. If the label comes from a prop, assert it\'s non-empty at the component boundary.'
      : "Put the human-readable label text inside the <label> element. If the visible text lives in a sibling (e.g. a styled <div>), either move it inside the <label> or use aria-labelledby on the form control to point at the sibling's id.";
  }

  const control = controls.get(target);
  const forAttr = dialect === "jsx" ? "htmlFor" : "for";

  // Branch C: `for`/`htmlFor` points at an id with no control in this file.
  if (!control) {
    return `Label references ${forAttr}="${target}" but no <input>, <select>, or <textarea> with id="${target}" exists in this file. Verify the id (a typo like ${forAttr}="email" vs id="emial" breaks the association silently), or remove the empty <label> if the control lives in a different file.`;
  }

  const candidate = deriveLabelCandidate(control);
  const controlDescriptor = describeControl(control);

  // Branch B1: matching control found and we can derive a candidate.
  if (candidate !== null) {
    return `Label references ${forAttr}="${target}" (${controlDescriptor} at line ${control.line}). Candidate label: "${candidate.text}" — derived from the control's ${candidate.source}. Put the text inside the <label> element.`;
  }

  // Branch B2: matching control found but no hint; suggest short-noun fallback.
  return `Label references ${forAttr}="${target}" (${controlDescriptor} at line ${control.line}), but the control has no type, name, or placeholder to derive a candidate. Put a short noun describing what the user types inside the <label> (e.g. "Username" or "Full name").`;
}

interface LabelCandidate {
  readonly text: string;
  readonly source: string;
}

/**
 * Derives a label candidate from the control's attributes. Ladder:
 *
 *   1. `type` — known semantic types map to canonical labels
 *      (`type="email"` → "Email address", `type="tel"` → "Phone number",
 *      `type="search"` → "Search", `type="password"` → "Password", …).
 *   2. `placeholder` — already human prose; inline verbatim when present.
 *   3. `name` — machine identifier, humanized (`firstName` → "First name",
 *      `phone_number` → "Phone number").
 *
 * Returns `null` when the control has none of these — the caller then
 * falls back to the short-noun branch.
 */
function deriveLabelCandidate(control: ControlSummary): LabelCandidate | null {
  if (control.type !== null) {
    const fromType = labelFromType(control.type);
    if (fromType !== null) return { text: fromType, source: `type="${control.type}"` };
  }
  if (control.placeholder !== null) {
    return { text: control.placeholder, source: "placeholder" };
  }
  if (control.name !== null) {
    return { text: humanizeIdentifier(control.name), source: `name="${control.name}"` };
  }
  return null;
}

/** Canonical labels for the HTML input types that carry semantic meaning. */
function labelFromType(type: string): string | null {
  switch (type.toLowerCase()) {
    case "email":
      return "Email address";
    case "tel":
      return "Phone number";
    case "url":
      return "Website URL";
    case "search":
      return "Search";
    case "password":
      return "Password";
    case "number":
      return "Number";
    case "date":
      return "Date";
    case "time":
      return "Time";
    case "datetime-local":
      return "Date and time";
    case "month":
      return "Month";
    case "week":
      return "Week";
    case "color":
      return "Color";
    case "file":
      return "File";
    default:
      return null;
  }
}

/**
 * Humanizes a camelCase / snake_case / kebab-case identifier into
 * capitalized, space-separated prose. `firstName` → "First name",
 * `phone_number` → "Phone number", `full-name` → "Full name".
 */
function humanizeIdentifier(name: string): string {
  const split = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (split.length === 0) return name;
  return split.charAt(0).toUpperCase() + split.slice(1);
}

/** Describes the control by tag + type for inline context in the suggestion. */
function describeControl(control: ControlSummary): string {
  if (control.tag === "input" && control.type !== null) {
    return `<input type="${control.type}">`;
  }
  return `<${control.tag}>`;
}
