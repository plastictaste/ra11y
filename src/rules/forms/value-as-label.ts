/**
 * Rule: forms/value-as-label
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text. (SC 1.3.1 — Info and Relationships)
 *
 * > For all user interface components ... the name and role can be
 * > programmatically determined. (SC 4.1.2 — Name, Role, Value)
 *
 * Flags the value-as-label antipattern: a text-shaped `<input>` whose
 * `value` attribute carries label-shaped copy ("Username", "Email",
 * "Search") and whose only hint is that pre-filled value — no
 * `<label for>`, no wrapping `<label>`, no `aria-label`, no
 * `aria-labelledby`, no `title`. The pattern looks plausible to a
 * sighted user on first paint, but the moment the user focuses the
 * field and starts typing, the "label" disappears (it was input text
 * all along); screen readers announce the value as the field's
 * current content, not as its name; and form submission may carry the
 * literal "Username" or "Email" string upstream as the user's actual
 * value if they tab past without editing. This is a stricter shape of
 * the broader "no accessible name" class — `forms/labels-required`
 * also fires on the same control, and the spec-level overlap is
 * honest (the input violates 1.3.1 + 4.1.2 in parallel) per the
 * "Surface, don't suppress" doctrine.
 *
 * Distinct from `forms/placeholder-as-label` in two ways:
 *   1. The trigger is the `value` attribute, not `placeholder`.
 *   2. The predicate is conservative ("looks label-shaped") because
 *      a literal default value is a legitimate use of `value` (e.g.
 *      pre-filling an edit form with the user's saved data). The
 *      rule fires only when the value contains alphabetic characters
 *      AND the input is unlabeled AND there is no equivalent
 *      `placeholder` carrying the format hint AND the input is one
 *      of the text-shaped types where "label-as-value" is even
 *      plausible (text, email, search, tel, url, password, or no
 *      type attribute which defaults to text). All other input types
 *      (submit/reset/button/image/hidden/checkbox/radio/file/color/
 *      range/date/time/month/week/datetime-local/number) are out of
 *      scope — `value` carries semantic meaning there (default
 *      value, intrinsic accessible name via the value attribute, or
 *      a non-text payload), not a label.
 *
 * Per the AI-first doctrine "Heuristic emission is the symmetric
 * twin of heuristic suppression," we keep the predicate conservative
 * — false positives here are someone literally typing a default
 * value, and surfacing the finding lets the agent verify the intent
 * in one read; false negatives (under-firing on an unlabeled
 * pre-filled "Username" input) are silent misses an agent cannot
 * recover from. Severity stays `warning` to match
 * `forms/placeholder-as-label` (the antipattern's twin).
 *
 * Scope: native `<input>` (text-shaped types only); JSX natives,
 * PascalCase wrappers opted in via `nativeWrappers: { MyInput:
 * "input" }`. Empty `value=""` and whitespace-only values are treated
 * as "no value" (no label-like content to mistake for a label).
 * Numeric-only values (`value="0"`, `value="42"`) are treated as
 * defaults, not labels, and the rule does not fire. Expression-valued
 * `value={…}` in JSX is not flagged — the most common case is a
 * controlled-input binding to user data, which is not the antipattern.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Input types where this rule may fire. `value` on these types is
 * pre-filled visible text content; an unlabeled control whose `value`
 * looks like a label is the antipattern. `password` is included
 * because the same shape can occur (`<input type="password"
 * value="Password">`). No-type defaults to "text" per the HTML spec.
 */
const TEXT_SHAPED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "email",
  "search",
  "tel",
  "url",
  "password",
]);

export const rule = defineRule({
  id: "forms/value-as-label",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  // Opt in: PascalCase wrappers declared as rendering `<input>` via
  // the object form of `nativeWrappers` get the same value-as-label
  // check as a bare `<input>`. Mirrors `forms/labels-required` and
  // `forms/placeholder-as-label`.
  wrapperTreatsAsElement: "input",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Text-shaped <input> has a value attribute that looks like a label (e.g. value="Username") but no <label>, aria-label, aria-labelledby, or title — the value renders as pre-filled input text and disappears the moment the user starts typing.',
    rationale:
      "A pre-filled `value` is not a label channel. To a sighted user on first paint the visible text in the field looks like a hint, but it is input text — the moment focus arrives and the user types, the 'label' is gone. Screen readers announce a control's accessible name (label / aria-label / aria-labelledby / title), not its current value as a name; without one of those the field has no name to announce. SC 1.3.1 requires the label-to-control relationship to be programmatically determinable; SC 4.1.2 requires the name to be programmatically determinable. A `<input type=\"text\" value=\"Username\">` satisfies neither — there is no programmatic association between the displayed copy and the control, and the form may submit the literal string 'Username' if the user tabs past without editing. The fix is the same as the placeholder-as-label antipattern: promote the copy into a real `<label>` or `aria-label`.",
    goodExample: `<label for="username">Username</label>
<input id="username" type="text">`,
    badExample: `<input type="text" value="Username">`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text. (SC 1.3.1) For all user interface components ... the name and role can be programmatically determined. (SC 4.1.2)",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G131",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F68",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, ctx.wrappersForElement, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// Predicate: does the `value` look like a label?
// ---------------------------------------------------------------------------

/**
 * Conservative "looks like a label" predicate. We require alphabetic
 * characters because numeric-only values (`value="0"`, `value="42"`,
 * `value="2024"`) are defaults, not labels. A single alphabetic
 * character is enough — labels are typically 1+ words, but
 * abbreviations like "S", "M", "L" do appear and we err toward
 * surfacing.
 *
 * We do NOT match a closed list of known label tokens (Username,
 * Email, Search, etc.) — that would be a numeric-threshold-style
 * heuristic that hides everything outside the list. The predicate's
 * job is to filter out *non-text* defaults, not to gatekeep on a
 * curated label vocabulary.
 */
function looksLikeLabel(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const labelFors = collectLabelFors(doc);
  const implicitIds = collectImplicitlyLabeledInputRanges(doc);

  for (const el of findHtmlElementsByTag(doc, "input")) {
    if (!isTextShapedHtmlInput(el)) continue;
    const value = getNonEmptyHtmlValue(el);
    if (value === null) continue;
    if (!looksLikeLabel(value)) continue;
    // Guard rail per backlog guidance: only fire when there is no
    // equivalent `placeholder` carrying the hint. A control with both
    // an unlabeled `value` AND an unlabeled `placeholder` is already
    // covered by `forms/placeholder-as-label` with a more specific
    // remediation; surfacing both rules with the same primary
    // remediation ("add a label") would be the same finding twice.
    if (hasNonEmptyHtmlPlaceholder(el)) continue;
    if (htmlHasLabel(el, labelFors, implicitIds)) continue;
    emit(buildHtmlViolation(el, value));
  }
}

function isTextShapedHtmlInput(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type");
  if (type === null) return true; // no type attribute defaults to text
  return TEXT_SHAPED_INPUT_TYPES.has(type.toLowerCase());
}

function getNonEmptyHtmlValue(el: HtmlElement): string | null {
  const raw = getHtmlAttribute(el, "value");
  if (raw === null) return null;
  if (raw.trim().length === 0) return null;
  return raw;
}

function hasNonEmptyHtmlPlaceholder(el: HtmlElement): boolean {
  const raw = getHtmlAttribute(el, "placeholder");
  return raw !== null && raw.trim().length > 0;
}

function collectLabelFors(doc: HtmlDocument): Set<string> {
  const fors = new Set<string>();
  for (const label of findHtmlElementsByTag(doc, "label")) {
    const forAttr = getHtmlAttribute(label, "for");
    if (forAttr && forAttr.length > 0) fors.add(forAttr);
  }
  return fors;
}

/**
 * Collects the `range.start` of every `<input>` wrapped inside a
 * `<label>` (implicit labeling). Same shape `forms/labels-required`
 * uses — re-implemented here because rule-to-rule imports are banned
 * by the pure-function invariant (CLAUDE.md §3).
 */
function collectImplicitlyLabeledInputRanges(doc: HtmlDocument): Set<number> {
  const ranges = new Set<number>();
  for (const label of findHtmlElementsByTag(doc, "label")) {
    for (const descendant of walkHtmlElements(label)) {
      if (descendant.tagName.toLowerCase() === "input") {
        ranges.add(descendant.range.start);
      }
    }
  }
  return ranges;
}

function htmlHasLabel(
  el: HtmlElement,
  labelFors: ReadonlySet<string>,
  implicitRanges: ReadonlySet<number>,
): boolean {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) {
    const ref = getHtmlAttribute(el, "aria-labelledby");
    if (ref !== null && ref.trim().length > 0) return true;
  }
  const title = getHtmlAttribute(el, "title");
  if (title !== null && title.trim().length > 0) return true;
  const id = getHtmlAttribute(el, "id");
  if (id && labelFors.has(id)) return true;
  if (implicitRanges.has(el.range.start)) return true;
  return false;
}

function buildHtmlViolation(el: HtmlElement, value: string): Parameters<Emit>[0] {
  const type = getHtmlAttribute(el, "type");
  return {
    severity: "warning",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: buildMessage(el.tagName, type, value),
    suggestion: buildSuggestion(el.tagName, type, getHtmlAttribute(el, "id"), value),
  };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, wrappersForInput: ReadonlySet<string>, emit: Emit): void {
  const labelHtmlFors = collectJsxLabelHtmlFors(module);
  const implicitRanges = collectJsxImplicitlyLabeledInputRanges(module, wrappersForInput);

  const seen = new Set<JsxElement>();
  for (const el of findJsxElementsForTag(module, "input", wrappersForInput)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isTextShapedJsxInput(el)) continue;
    const value = getNonEmptyJsxValue(el);
    if (value === null) continue;
    if (!looksLikeLabel(value)) continue;
    if (hasNonEmptyJsxPlaceholder(el)) continue;
    if (jsxHasLabel(el, labelHtmlFors, implicitRanges)) continue;
    emit(buildJsxViolation(el, value));
  }
}

function isTextShapedJsxInput(el: JsxElement): boolean {
  // Wrappers (PascalCase) declared as rendering `<input>` reach this
  // branch via `findJsxElementsForTag(module, "input", wrappers)`.
  // For wrappers we trust the user-declared mapping and skip the
  // type-attribute check (the wrapper may not even expose `type` as
  // a prop; the rule applies in spirit because the wrapper renders
  // text-shaped controls).
  if (el.tagName !== "input") return true;
  const type = getJsxAttributeString(el, "type");
  if (type === null) {
    // No string-literal type. Could be expression-valued or absent.
    // Default to text-shaped: an absent type is "text" by spec, and
    // an expression-valued type is unverifiable so we keep the rule
    // applicable at the surface — the message names the antipattern
    // and the agent decides.
    return true;
  }
  return TEXT_SHAPED_INPUT_TYPES.has(type.toLowerCase());
}

function getNonEmptyJsxValue(el: JsxElement): string | null {
  const attr = getJsxAttribute(el, "value");
  if (!attr) return null;
  // Expression-valued (`value={username}`, `value={state.email}`,
  // `value={t('username')}`) — the literal isn't visible to us. The
  // most common case is a controlled-input binding to user data,
  // which is NOT the antipattern (the runtime value is whatever the
  // user has entered or the form has been hydrated with). Skip
  // expression-valued `value` to avoid false positives on controlled
  // components — the conservative-predicate doctrine applies here.
  if (attr.value?.kind === "Expression") return null;
  if (attr.value?.kind !== "StringLiteral") return null;
  const value = attr.value.value;
  if (value.trim().length === 0) return null;
  return value;
}

function hasNonEmptyJsxPlaceholder(el: JsxElement): boolean {
  const attr = getJsxAttribute(el, "placeholder");
  if (!attr) return false;
  if (attr.value?.kind === "Expression") return true;
  if (attr.value?.kind !== "StringLiteral") return false;
  return attr.value.value.trim().length > 0;
}

function collectJsxLabelHtmlFors(module: TsxModule): Set<string> {
  const fors = new Set<string>();
  for (const label of findJsxElementsByTag(module, "label")) {
    const htmlFor = getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
    if (htmlFor && htmlFor.length > 0) {
      fors.add(htmlFor);
      continue;
    }
    const forAttr = getJsxAttribute(label, "htmlFor") ?? getJsxAttribute(label, "for");
    if (forAttr?.value?.kind === "Expression") fors.add("__expr__");
  }
  return fors;
}

function collectJsxImplicitlyLabeledInputRanges(
  module: TsxModule,
  wrappersForInput: ReadonlySet<string>,
): Set<number> {
  const ranges = new Set<number>();
  for (const label of findJsxElementsByTag(module, "label")) {
    for (const descendant of walkJsxDescendants(label)) {
      const tag = descendant.tagName;
      if (tag.toLowerCase() === "input" || wrappersForInput.has(tag)) {
        ranges.add(descendant.range.start);
      }
    }
  }
  return ranges;
}

function* walkJsxDescendants(element: JsxElement): Iterable<JsxElement> {
  for (const child of element.children) {
    if (child.kind === "JsxElement") {
      yield child;
      yield* walkJsxDescendants(child);
    }
  }
}

function jsxHasLabel(
  el: JsxElement,
  labelHtmlFors: ReadonlySet<string>,
  implicitRanges: ReadonlySet<number>,
): boolean {
  if (jsxHasAriaLabel(el)) return true;
  if (jsxHasAriaLabelledby(el)) return true;
  if (jsxHasTitle(el)) return true;
  if (jsxHasForAssociation(el, labelHtmlFors)) return true;
  return implicitRanges.has(el.range.start);
}

function jsxHasAriaLabel(el: JsxElement): boolean {
  const literal = getJsxAttributeString(el, "aria-label");
  if (literal !== null && literal.trim().length > 0) return true;
  const attr = getJsxAttribute(el, "aria-label");
  return attr?.value?.kind === "Expression";
}

function jsxHasAriaLabelledby(el: JsxElement): boolean {
  if (!hasJsxAttribute(el, "aria-labelledby")) return false;
  const literal = getJsxAttributeString(el, "aria-labelledby");
  if (literal !== null && literal.trim().length > 0) return true;
  const attr = getJsxAttribute(el, "aria-labelledby");
  return attr?.value?.kind === "Expression";
}

function jsxHasTitle(el: JsxElement): boolean {
  const title = getJsxAttributeString(el, "title");
  return title !== null && title.trim().length > 0;
}

function jsxHasForAssociation(el: JsxElement, labelHtmlFors: ReadonlySet<string>): boolean {
  const id = getJsxAttributeString(el, "id");
  if (id && labelHtmlFors.has(id)) return true;
  const idAttr = getJsxAttribute(el, "id");
  return idAttr?.value?.kind === "Expression" && labelHtmlFors.has("__expr__");
}

function buildJsxViolation(el: JsxElement, value: string): Parameters<Emit>[0] {
  const type = getJsxAttributeString(el, "type");
  const id = getJsxAttributeString(el, "id");
  return {
    severity: "warning",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message: buildMessage(el.tagName, type, value),
    suggestion: buildSuggestion(el.tagName, type, id, value),
  };
}

// ---------------------------------------------------------------------------
// Messages (context-aware — quote the actual value)
// ---------------------------------------------------------------------------

function buildMessage(tagName: string, type: string | null, value: string): string {
  const descriptor = type ? `<${tagName} type="${type}">` : `<${tagName}>`;
  return `${descriptor} has \`value="${truncateForEcho(value)}"\` but no <label>, aria-label, aria-labelledby, or title — the value renders as pre-filled input text, not as the field's name. The moment a user focuses this field and types, the apparent "label" disappears (it was input text all along), and the form may submit "${truncateForEcho(value)}" upstream if the user tabs past without editing.`;
}

function buildSuggestion(
  tagName: string,
  type: string | null,
  id: string | null,
  value: string,
): string {
  const idHint = truncateForEcho(id ?? inferIdFromType(type) ?? inferIdFromValue(value));
  return `Promote \`value="${truncateForEcho(value)}"\` from input text to an accessible name; the value attribute is pre-filled content, not a label channel. The author usually meant the copy as a label — verify intent before transcribing. Options: (1) wrap with \`<label for="${idHint}">${truncateForEcho(value)}</label>\` and give the ${tagName} \`id="${idHint}"\` (remove the value attribute or replace it with \`placeholder="…"\` if a format hint is desired), (2) set \`aria-label="${truncateForEcho(value)}"\` directly on the ${tagName} and remove the value attribute, or (3) \`aria-labelledby="…"\` pointing at an existing visible heading. If the value really is a default the user should see (e.g. an edit form pre-filled with their saved data), keep it AND add a separate label — both can coexist.`;
}

function inferIdFromType(type: string | null): string | null {
  if (!type) return null;
  const map: Readonly<Record<string, string>> = {
    email: "email",
    password: "password",
    search: "search",
    tel: "phone",
    url: "url",
    text: "field",
  };
  return map[type.toLowerCase()] ?? null;
}

function inferIdFromValue(value: string): string {
  // Tokenize the first word; strip non-alphanumeric; lowercase. Falls
  // back to "field" if the value has no alphabetic characters at all.
  const first = value.trim().split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return cleaned.length > 0 ? cleaned : "field";
}
