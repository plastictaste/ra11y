/**
 * Rule: forms/labels-required
 * Satisfies: wcag22:3.3.2, wcag21:3.3.2
 * Spec: https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *
 * > Labels or instructions are provided when content requires user input.
 *
 * Source: https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *
 * This rule flags form controls without an accessible name. A form
 * control is considered labeled when any of the following are true:
 *   1. It has a non-empty `aria-label` attribute
 *   2. It has an `aria-labelledby` referencing another element
 *   3. Its `id` is referenced by a `<label for="…">` somewhere in
 *      the same document
 *   4. It's wrapped inside a `<label>` element (implicit label)
 *   5. It's `type="hidden"`, `type="submit"`, `type="reset"`, or
 *      `type="button"` — these have intrinsic or author-specified
 *      accessible names (value attribute)
 *
 * Covers: <input> (except hidden/submit/reset/button types),
 * <select>, <textarea>, and contenteditable hosts (any element with
 * `contenteditable="true"` / `contentEditable={true}` / bare
 * `contenteditable` — Slack-style composers, Notion-style editors).
 * A contenteditable host acts as a form control under WCAG 1.3.2 and
 * 3.3.2 and carries the same accessible-name requirement.
 * `contenteditable="false"` and `contenteditable="inherit"` do NOT
 * make an element a form control and are not flagged.
 *
 * Does NOT cover custom widgets built with div/span + ARIA — those
 * are covered by aria/name-role-value.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import {
  buildSiblingCollapsedMessage,
  collectFailingHtmlControls,
  computeHtmlCollapseDecisions,
  computeJsxCollapseDecisions,
  type SiblingInstance,
} from "./_label-sibling-collapse.ts";

const LABELABLE_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

const IMPLICIT_SUBMIT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

export const rule = defineRule({
  id: "forms/labels-required",
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
  fixClass: "verify-in-source",
  // Opt in: wrapper components declared as rendering `<input>` via the
  // object form of `nativeWrappers` (e.g. `{ TextField: "input",
  // EmailInput: "input" }`) get the same label-or-aria-label check as a
  // bare `<input>`. select/textarea wrappers aren't covered here —
  // `wrapperTreatsAsElement` names a single native tag; users with
  // `<SelectBox>` wrappers either declare them as `"input"` (works,
  // same accessible-name requirement) or leave the rule to catch the
  // missing label inside the wrapper definition file.
  wrapperTreatsAsElement: "input",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Form controls must have an accessible name — a <label>, aria-label, or aria-labelledby.",
    rationale:
      "Screen readers announce a form control's accessible name when the user tabs to it. Without a label, users hear 'edit' or 'combobox' and have no way to know what to type. A missing label is also a sighted-user problem: inputs without visible labels rely on placeholder text that disappears when the user starts typing.",
    goodExample: `<label for="email">Email</label>\n<input id="email" type="email">`,
    badExample: `<input type="email" placeholder="Email">`,
    normativeQuote: "Labels or instructions are provided when content requires user input.",
    references: [
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G131",
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
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  siblingInstances?: readonly SiblingInstance[];
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const labelFors = collectLabelFors(doc);
  const implicitLabelIds = collectImplicitlyLabeledIds(doc);
  checkHtmlNativeControls(doc, labelFors, implicitLabelIds, emit);
  checkHtmlEditableHosts(doc, labelFors, implicitLabelIds, emit);
}

function checkHtmlNativeControls(
  doc: HtmlDocument,
  labelFors: ReadonlySet<string>,
  implicitLabelIds: ReadonlySet<string>,
  emit: Emit,
): void {
  // Collapse decisions are computed per-parent over the failing-control
  // set: same parent + same `(tagName, type, attributes-modulo-id)`
  // fingerprint AND ≥3 siblings → emit ONE finding with
  // `siblingInstances`; otherwise emit each individually as before.
  // The `consumed` set marks elements rolled into a collapsed finding
  // so the per-tag loop below skips them.
  const isFailing = (el: HtmlElement): boolean =>
    !(isExcludedHtmlControl(el) || htmlHasLabel(el, labelFors, implicitLabelIds));
  const failing = collectFailingHtmlControls(doc, LABELABLE_TAGS, isFailing, walkHtmlElements);
  const { primary, consumed } = computeHtmlCollapseDecisions(failing);

  for (const tag of LABELABLE_TAGS) {
    for (const el of findHtmlElementsByTag(doc, tag)) {
      if (!isFailing(el)) continue;
      if (consumed.has(el)) continue;
      emit(buildHtmlNativeControlViolation(el, primary.get(el)));
    }
  }
}

function buildHtmlNativeControlViolation(
  el: HtmlElement,
  siblings: readonly SiblingInstance[] | undefined,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  siblingInstances?: readonly SiblingInstance[];
} {
  const type = getHtmlAttribute(el, "type");
  const message =
    siblings === undefined
      ? buildMessage(el.tagName, type)
      : buildSiblingCollapsedMessage(el.tagName, type, siblings.length);
  return {
    severity: "error",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message,
    suggestion: buildSuggestion(
      el.tagName,
      type,
      getHtmlAttribute(el, "id"),
      getNonEmptyHtmlPlaceholder(el),
    ),
    ...(siblings === undefined ? {} : { siblingInstances: siblings }),
  };
}

// contenteditable hosts — any element with contenteditable="true" (or
// bare, or empty value — both equate to "true" per the HTML spec's
// enumerated default) behaves as a form control. Same accessible-name
// requirement as <input>/<select>/<textarea>; same label association
// channels (aria-label, aria-labelledby, <label for> → matching id,
// wrapping <label>).
function checkHtmlEditableHosts(
  doc: HtmlDocument,
  labelFors: ReadonlySet<string>,
  implicitLabelIds: ReadonlySet<string>,
  emit: Emit,
): void {
  for (const el of walkHtmlElements(doc)) {
    if (LABELABLE_TAGS.has(el.tagName.toLowerCase())) continue;
    if (!isHtmlEditableHost(el)) continue;
    if (htmlHasLabel(el, labelFors, implicitLabelIds)) continue;
    emit({
      severity: "error",
      location: {
        filePath: "",
        line: el.loc.start.line,
        column: el.loc.start.column,
      },
      message: buildEditableMessage(el.tagName),
      suggestion: buildEditableSuggestion(el.tagName, getHtmlAttribute(el, "id")),
    });
  }
}

function collectLabelFors(doc: HtmlDocument): Set<string> {
  const fors = new Set<string>();
  for (const label of findHtmlElementsByTag(doc, "label")) {
    const forAttr = getHtmlAttribute(label, "for");
    if (forAttr && forAttr.length > 0) fors.add(forAttr);
  }
  return fors;
}

function collectImplicitlyLabeledIds(doc: HtmlDocument): Set<string> {
  const ids = new Set<string>();
  for (const label of findHtmlElementsByTag(doc, "label")) {
    for (const descendant of walkHtmlElements(label)) {
      const isLabelable =
        LABELABLE_TAGS.has(descendant.tagName.toLowerCase()) || isHtmlEditableHost(descendant);
      if (!isLabelable) continue;
      const id = getHtmlAttribute(descendant, "id");
      if (id) ids.add(id);
      // Wrapped control without an id still counts — use a placeholder
      // marker via the element's range so we can check identity later.
      ids.add(`__range:${descendant.range.start}`);
    }
  }
  return ids;
}

/**
 * True when the element has `contenteditable` with a value the HTML
 * spec treats as "true" — i.e. the element is an editable host and
 * acts as a form control. Per the HTML Living Standard's enumerated
 * attribute semantics, the empty string `""` and the bare attribute
 * (no value) both map to the "true" state. Only the literal values
 * `"false"` and `"inherit"` (case-insensitive) are non-editable.
 */
function isHtmlEditableHost(el: HtmlElement): boolean {
  if (!hasHtmlAttribute(el, "contenteditable")) return false;
  const raw = getHtmlAttribute(el, "contenteditable");
  // Bare attribute → parser yields value === null (or "" depending on
  // source). Either means "true" per HTML spec.
  if (raw === null || raw === "") return true;
  const value = raw.toLowerCase();
  return value === "true";
}

function isExcludedHtmlControl(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type")?.toLowerCase();
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

function htmlHasLabel(
  el: HtmlElement,
  labelFors: ReadonlySet<string>,
  implicitIds: ReadonlySet<string>,
): boolean {
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
  if (hasHtmlAttribute(el, "title")) {
    const title = getHtmlAttribute(el, "title");
    if (title && title.trim().length > 0) return true;
  }
  const id = getHtmlAttribute(el, "id");
  if (id && labelFors.has(id)) return true;
  if (implicitIds.has(`__range:${el.range.start}`)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, wrappersForInput: ReadonlySet<string>, emit: Emit): void {
  // JSX label/control association: htmlFor attribute on <label> must
  // match id attribute on the control. We collect the htmlFor set
  // first, then check each control. Implicit labeling (control nested
  // inside label) handled by JSX element children structure.
  const labelHtmlFors = collectJsxLabelHtmlFors(module);
  const implicitIds = collectJsxImplicitlyLabeledControls(module, wrappersForInput);

  // Pre-pass: detect collapsible sibling clusters among direct-child
  // intrinsic `<input>` / `<select>` / `<textarea>` failing controls.
  // Wrappers and polymorphic `<Tag as="input">` resolutions stay out of
  // collapse — clusters of those are rare and the fingerprint would be
  // less stable across the resolution boundary; per-element emit on
  // those is the safer default. The helper consumes the rule's
  // failing-predicate verdict (label-check + excluded-control filter)
  // via the {@link JsxFailingPredicate} callback.
  const { primary, consumed } = computeJsxCollapseDecisions(module, LABELABLE_TAGS, (el) => {
    if (isExcludedJsxControl(el)) return false;
    if (jsxHasLabel(el, labelHtmlFors, implicitIds)) return false;
    return true;
  });

  const seen = new Set<JsxElement>();
  checkJsxInputs(
    module,
    wrappersForInput,
    labelHtmlFors,
    implicitIds,
    seen,
    primary,
    consumed,
    emit,
  );
  checkJsxSelectsAndTextareas(module, labelHtmlFors, implicitIds, primary, consumed, emit);
  checkJsxEditableHosts(module, labelHtmlFors, implicitIds, seen, emit);
}

// `<input>` has three resolution channels (native, mapped wrapper,
// polymorphic `as="input"` / `asChild` → `<input>`); `findJsxElementsForTag`
// unifies all three.
function checkJsxInputs(
  module: TsxModule,
  wrappersForInput: ReadonlySet<string>,
  labelHtmlFors: ReadonlySet<string>,
  implicitIds: ReadonlySet<number>,
  seen: Set<JsxElement>,
  primary: ReadonlyMap<JsxElement, readonly SiblingInstance[]>,
  consumed: ReadonlySet<JsxElement>,
  emit: Emit,
): void {
  for (const el of findJsxElementsForTag(module, "input", wrappersForInput)) {
    if (seen.has(el)) continue;
    seen.add(el);
    // `isExcludedJsxControl` only skips when we can read a literal `type`
    // prop; PascalCase wrappers without a `type` fall through and get
    // the same label check as a bare `<input>`. Polymorphic resolution
    // doesn't change the decision — `type="submit"` on a polymorphic
    // `<Button as="input">` still excludes it.
    if (isExcludedJsxControl(el)) continue;
    if (jsxHasLabel(el, labelHtmlFors, implicitIds)) continue;
    if (consumed.has(el)) continue;
    const siblings = primary.get(el);
    emit(buildJsxViolation(el, siblings));
  }
}

// `<select>` and `<textarea>` keep native-only iteration —
// `wrapperTreatsAsElement` carries a single target tag, so polymorphic
// opt-in is scoped to `"input"` per Q2R2-POLYMORPHIC. Rule scope for
// those tags is unchanged.
function checkJsxSelectsAndTextareas(
  module: TsxModule,
  labelHtmlFors: ReadonlySet<string>,
  implicitIds: ReadonlySet<number>,
  primary: ReadonlyMap<JsxElement, readonly SiblingInstance[]>,
  consumed: ReadonlySet<JsxElement>,
  emit: Emit,
): void {
  for (const tag of ["select", "textarea"] as const) {
    for (const el of findJsxElementsByTag(module, tag)) {
      if (jsxHasLabel(el, labelHtmlFors, implicitIds)) continue;
      if (consumed.has(el)) continue;
      const siblings = primary.get(el);
      emit(buildJsxViolation(el, siblings));
    }
  }
}

// contenteditable hosts — any JSX element with `contentEditable={true}`,
// `contentEditable="true"`, or the bare `contentEditable` attribute
// behaves as a form control (Slack-style composers, Notion-style
// editors). Same accessible-name requirement as <input>. JSX attribute
// names are case-sensitive — React's convention is camelCase
// (`contentEditable`), but authors sometimes use the HTML spelling
// (`contenteditable`); accept either.
function checkJsxEditableHosts(
  module: TsxModule,
  labelHtmlFors: ReadonlySet<string>,
  implicitIds: ReadonlySet<number>,
  seen: Set<JsxElement>,
  emit: Emit,
): void {
  for (const el of walkJsxElements(module)) {
    if (seen.has(el)) continue;
    if (LABELABLE_TAGS.has(el.tagName.toLowerCase())) continue;
    if (el.tagName === "select" || el.tagName === "textarea") continue;
    if (!isJsxEditableHost(el)) continue;
    if (jsxHasLabel(el, labelHtmlFors, implicitIds)) continue;
    emit(buildJsxEditableViolation(el));
  }
}

/**
 * True when the JSX element has `contentEditable` / `contenteditable`
 * with a value the HTML spec treats as "true". Accepts:
 *   - Bare attribute (`<div contentEditable />`) — value `null`, maps
 *     to "true" per the HTML enumerated-attribute default.
 *   - String literal `"true"` (case-insensitive) or `""`.
 *   - Expression `{true}` — raw source interior is the literal `true`.
 * Rejects `"false"`, `"inherit"`, `{false}`, and dynamic expressions
 * (`{isEditing}`) — the last is ambiguous and the agent reading the
 * source is better positioned than a static heuristic.
 */
function isJsxEditableHost(el: JsxElement): boolean {
  const attr = getJsxAttribute(el, "contentEditable") ?? getJsxAttribute(el, "contenteditable");
  if (!attr) return false;
  // Bare attribute (`<div contentEditable />`).
  if (attr.value === null) return true;
  if (attr.value.kind === "StringLiteral") {
    const v = attr.value.value;
    if (v === "") return true;
    return v.toLowerCase() === "true";
  }
  // Expression — strip braces, trim, accept only the literal `true`.
  const inner = attr.value.raw.replace(/^\{/, "").replace(/\}$/, "").trim();
  return inner === "true";
}

function buildJsxEditableViolation(el: JsxElement) {
  const id = getJsxAttributeString(el, "id");
  const location = { filePath: "", line: el.loc.start.line, column: el.loc.start.column };
  if (el.hasSpreadProps) {
    return {
      severity: "info" as const,
      location,
      message: `<${el.tagName} contentEditable> has no static accessible name but receives {...spread} props — whether the editable region is labeled at render time depends on what the caller passes (aria-label, aria-labelledby, id matched by an external <label>). Verify at usage sites.`,
      suggestion: `If this primitive is only consumed by callers that pass \`aria-label\`, this is fine — add \`{/* ra11y-disable forms/labels-required */}\` at the top of the file to silence this info note. Otherwise require callers to pass a label via props.`,
    };
  }
  return {
    severity: "error" as const,
    location,
    message: buildEditableMessage(el.tagName),
    suggestion: buildEditableSuggestion(el.tagName, id),
  };
}

function buildJsxViolation(el: JsxElement, siblings?: readonly SiblingInstance[]) {
  const type = getJsxAttributeString(el, "type");
  const id = getJsxAttributeString(el, "id");
  const location = { filePath: "", line: el.loc.start.line, column: el.loc.start.column };
  if (el.hasSpreadProps) {
    return {
      severity: "info" as const,
      location,
      message: `<${el.tagName}${type ? ` type="${type}"` : ""}> has no static accessible name but receives {...spread} props — this looks like a component primitive (Input/Textarea wrapper). Whether the control is labeled at render time depends on what the caller passes (aria-label, id matched by an external <label>, etc.). Verify at usage sites.`,
      suggestion: `If the primitive is only consumed by callers that pass a label or aria-label, this is fine — add \`{/* ra11y-disable forms/labels-required */}\` at the top of the file to silence this info note. Otherwise require callers to pass a label via props.`,
    };
  }
  return {
    severity: "error" as const,
    location,
    message:
      siblings === undefined
        ? buildMessage(el.tagName, type)
        : buildSiblingCollapsedMessage(el.tagName, type, siblings.length),
    suggestion: buildSuggestion(el.tagName, type, id, getNonEmptyJsxPlaceholder(el)),
    ...(siblings === undefined ? {} : { siblingInstances: siblings }),
  };
}

function collectJsxLabelHtmlFors(module: TsxModule): ReadonlySet<string> {
  const fors = new Set<string>();
  for (const label of findJsxElementsByTag(module, "label")) {
    const htmlFor = getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
    if (htmlFor && htmlFor.length > 0) {
      fors.add(htmlFor);
      continue;
    }
    // Expression-valued htmlFor like htmlFor={selectId} — we can't resolve
    // the value but we know a label intends to reference a control. Add a
    // sentinel so jsxHasLabel can detect that expression-valued labels exist.
    const htmlForAttr = getJsxAttribute(label, "htmlFor") ?? getJsxAttribute(label, "for");
    if (htmlForAttr?.value?.kind === "Expression") fors.add("__expr__");
  }
  return fors;
}

function collectJsxImplicitlyLabeledControls(
  module: TsxModule,
  wrappersForInput: ReadonlySet<string> = new Set(),
): Set<number> {
  const ranges = new Set<number>();
  for (const label of findJsxElementsByTag(module, "label")) {
    for (const descendant of walkJsxDescendants(label)) {
      const tag = descendant.tagName;
      if (LABELABLE_TAGS.has(tag.toLowerCase()) || wrappersForInput.has(tag)) {
        ranges.add(descendant.range.start);
        continue;
      }
      // contenteditable host nested inside a <label> — e.g.
      // `<label>Message<div contentEditable /></label>`. Same implicit-
      // labeling semantics as a nested <input>.
      if (isJsxEditableHost(descendant)) {
        ranges.add(descendant.range.start);
        continue;
      }
      // Polymorphic `<Field as="input" />` nested inside a <label> — the
      // resolved tag is the labeled control even though the call-site tag
      // isn't. Keeps implicit labeling consistent with the rule's
      // polymorphic opt-in (Q2R2-POLYMORPHIC).
      const resolved = resolvePolymorphicTag(descendant);
      if (
        (resolved.resolvedFromAs || resolved.resolvedFromAsChild) &&
        resolved.tagName.toLowerCase() === "input"
      ) {
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

// Re-implementations scoped to this file so the module doesn't have
// a lint dependency on ast-helpers for findJsxElementsByTag (already
// imported) — but we need walkJsxDescendants because the helper is
// not exported. Keeping these inline is cleaner than plumbing new
// helpers for a single rule.
import {
  findJsxElementsByTag,
  findJsxElementsForTag,
  resolvePolymorphicTag,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";

function isExcludedJsxControl(el: JsxElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getJsxAttributeString(el, "type")?.toLowerCase();
  if (!type) return false;
  return IMPLICIT_SUBMIT_TYPES.has(type);
}

function jsxHasLabel(
  el: JsxElement,
  labelHtmlFors: ReadonlySet<string>,
  implicitIds: ReadonlySet<number>,
): boolean {
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) return true;
  // Expression-valued aria-label like aria-label={t('slider')} — trust the
  // developer is computing a name at runtime. Same tradeoff as alt-text-missing.
  const ariaLabelAttr = getJsxAttribute(el, "aria-label");
  if (ariaLabelAttr?.value?.kind === "Expression") return true;
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
  if (hasJsxAttribute(el, "title")) {
    const title = getJsxAttributeString(el, "title");
    if (title && title.trim().length > 0) return true;
  }
  const id = getJsxAttributeString(el, "id");
  if (id && labelHtmlFors.has(id)) return true;
  // Expression-valued id like id={selectId} paired with a label that has
  // expression-valued htmlFor — we can't verify the match statically
  // but the developer clearly intended the association. Trust it.
  const idAttr = getJsxAttribute(el, "id");
  if (idAttr?.value?.kind === "Expression" && labelHtmlFors.has("__expr__")) return true;
  if (implicitIds.has(el.range.start)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function buildMessage(tagName: string, type: string | null): string {
  const descriptor = type ? `<${tagName} type="${type}">` : `<${tagName}>`;
  return `${descriptor} has no accessible name — screen readers will announce it with no context.`;
}

function buildSuggestion(
  tagName: string,
  type: string | null,
  id: string | null,
  placeholder: string | null,
): string {
  // `id` is a user-authored attribute value echoed twice in this string
  // (`for="..."` and the prose tail) — cap it before interpolation.
  // `labelText` comes from a closed vocabulary in `inferLabelFromType`,
  // so it doesn't need wrapping unless we swap in the placeholder.
  const idHint = truncateForEcho(id ?? "field");
  // When the author wrote a placeholder, it's usually the label copy
  // they intended — use it as the primary label-text candidate in the
  // mechanical edit if it looks like a single descriptive phrase, and
  // always surface it verbatim as additive context. Phrase it as "may
  // carry the intent; verify" — the tool points, the agent decides.
  const suitablePlaceholder =
    placeholder !== null && isPlaceholderSuitableAsLabel(placeholder) ? placeholder : null;
  const labelText = suitablePlaceholder
    ? truncateForEcho(suitablePlaceholder)
    : inferLabelFromType(type);
  const base = `Add a \`<label for="${idHint}">${labelText}</label>\` referencing this ${tagName}'s id, or set an \`aria-label="${labelText}"\` attribute. If the control is decorative or duplicates a visible label, use \`aria-labelledby\` pointing at that element's id.`;
  if (placeholder === null) return base;
  const quoted = `\`"${truncateForEcho(placeholder)}"\``;
  return `${base} Placeholder text ${quoted} may carry the intent — verify it's accurate before using as label copy.`;
}

function buildEditableMessage(tagName: string): string {
  return `<${tagName} contenteditable="true"> acts as a form control but has no accessible name — screen readers will announce the editable region with no context.`;
}

function buildEditableSuggestion(tagName: string, id: string | null): string {
  // Same rationale as buildSuggestion above — `id` is user-authored and
  // echoed twice; cap before interpolation.
  const idHint = truncateForEcho(id ?? "editor");
  return `This <${tagName} contenteditable="true"> behaves like an <input>/<textarea> for assistive tech — it needs an accessible name. Add \`aria-label="…"\` describing the editable region (e.g., \`aria-label="Message"\` for a chat composer, \`aria-label="Document body"\` for a doc editor), or associate a visible \`<label for="${idHint}">\` by giving the ${tagName} \`id="${idHint}"\`. \`aria-labelledby\` pointing at an existing heading or visible label also works.`;
}

function inferLabelFromType(type: string | null): string {
  if (!type) return "Label";
  const map: Readonly<Record<string, string>> = {
    email: "Email",
    password: "Password",
    search: "Search",
    tel: "Phone",
    url: "URL",
    number: "Number",
    date: "Date",
    time: "Time",
    file: "Upload",
    checkbox: "Option",
    radio: "Choice",
  };
  return map[type.toLowerCase()] ?? "Label";
}

// ---------------------------------------------------------------------------
// Placeholder enrichment (Q6-PLACEHOLDER-IN-FIX-SUGGESTION)
// ---------------------------------------------------------------------------

/**
 * Returns the non-empty placeholder string on an HTML control, or null
 * when no placeholder is authored / value is empty / whitespace-only.
 * Scope: only `<input>` and `<textarea>` render a visible placeholder;
 * `<select>` does not support the attribute, so we return null there.
 */
function getNonEmptyHtmlPlaceholder(el: HtmlElement): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea") return null;
  const raw = getHtmlAttribute(el, "placeholder");
  if (raw === null) return null;
  if (raw.trim().length === 0) return null;
  return raw;
}

/**
 * Returns the non-empty placeholder string on a JSX control, or null.
 * Only literal string placeholders are surfaced — expression-valued
 * placeholders (`placeholder={t('email')}`) are not echoed because we
 * cannot read the literal text, and surfacing the raw expression adds
 * no label-copy signal.
 */
function getNonEmptyJsxPlaceholder(el: JsxElement): string | null {
  const tag = el.tagName.toLowerCase();
  // Native tags: limit to input/textarea. Wrapper tags (PascalCase) are
  // assumed to forward `placeholder` to an <input>; surface when present.
  if (tag !== "input" && tag !== "textarea" && !isPascalCaseTag(el.tagName)) return null;
  const value = getJsxAttributeString(el, "placeholder");
  if (value === null) return null;
  if (value.trim().length === 0) return null;
  return value;
}

function isPascalCaseTag(tagName: string): boolean {
  const first = tagName.charAt(0);
  return first >= "A" && first <= "Z";
}

/**
 * Heuristic: is this placeholder safe to drop in as the primary label-text
 * candidate in the mechanical `<label>…</label>` edit? Returns true only
 * for short, single-line, single-phrase strings that read like a noun
 * phrase (e.g. "Email address"). Returns false for anything that looks
 * like a format hint (contains `@`, digits, slashes), instructions
 * ("Enter your email"), multi-sentence prose, trailing punctuation
 * (colons, ellipses), or long strings. When this returns false, the
 * placeholder is still quoted verbatim in the additive context — only
 * the "use as label copy" substitution is skipped.
 *
 * Design note: this is an author-intent heuristic for the mechanical
 * edit — the placeholder is always surfaced verbatim regardless. Per
 * AI-first doctrine ("don't downgrade; surface and annotate"), the
 * agent sees the raw text and can pick whichever path fits; this
 * heuristic only decides which path the default edit proposes.
 */
function isPlaceholderSuitableAsLabel(placeholder: string): boolean {
  const trimmed = placeholder.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 40) return false;
  // Multi-line is never a single descriptive phrase.
  if (/[\n\r]/.test(trimmed)) return false;
  // Instructions like "Enter your email" / "Please type..." / "Type here".
  if (/^(enter|type|please|select|choose|search\s)/i.test(trimmed)) return false;
  // Format hints: emails, urls, dates, phone patterns, example syntax.
  if (/[@/\\]/.test(trimmed)) return false;
  if (/\d/.test(trimmed)) return false;
  // Trailing punctuation other than closing quotes → probably mid-phrase.
  if (/[:.…]$/.test(trimmed)) return false;
  // Multi-sentence.
  if (/[.!?].+[a-z]/i.test(trimmed)) return false;
  return true;
}
