/**
 * Rule: forms/placeholder-as-label
 * Satisfies: wcag22:3.3.2, wcag21:3.3.2, wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#labels-or-instructions
 *       https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Labels or instructions are provided when content requires user input.
 * > (SC 3.3.2 — Labels or Instructions)
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text. (SC 1.3.1 — Info and Relationships)
 *
 * Flags the placeholder-as-label antipattern: a `<input>`, `<textarea>`,
 * or `<select>` whose only hint is the `placeholder` attribute — no
 * `<label for>`, no wrapping `<label>`, no `aria-label`, no
 * `aria-labelledby`, no `title`. Placeholders are assistive-tech
 * unstable: they disappear on focus, are announced inconsistently
 * across screen readers, and are low-contrast by default in most
 * browser UAs. A persistent visible label or programmatic accessible
 * name is the spec-compliant channel; the placeholder can stay as a
 * secondary format hint but cannot carry the label duty alone.
 *
 * Distinct from `forms/labels-required` (which fires when a control
 * has no label AT ALL). This rule is strictly narrower: it fires only
 * when the missing-label condition holds AND a `placeholder="…"` is
 * present. The subset earns its own finding because the remediation
 * is different — the author already typed label copy (it's sitting
 * inside the placeholder), so the fix is usually "promote the
 * placeholder text to a label" rather than "write label copy from
 * scratch." Both rules cite SC 3.3.2; the spec-level overlap is
 * honest (the input violates both SCs in parallel) per the
 * "Surface, don't suppress" doctrine.
 *
 * Scope: native `<input>` (excluding `hidden`/`submit`/`reset`/
 * `button`/`image` — placeholder is meaningless there), `<textarea>`,
 * `<select>`; JSX natives, PascalCase wrappers opted in via
 * `nativeWrappers: { MyInput: "input" }`, and polymorphic `<X as=…>`
 * / `<X asChild>` channels (mirrors `forms/labels-required`).
 * Empty `placeholder=""` and whitespace-only values are treated as
 * "no placeholder" (no label-like content to mistake for a label).
 * Bootstrap's floating-label pattern (placeholder duplicates a
 * CSS-rendered float label) is a future tightening for a different
 * finder and is out of scope here.
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
import {
  collectFailingHtmlControls,
  computeHtmlCollapseDecisions,
  computeJsxCollapseDecisions,
  type SiblingInstance,
} from "./_label-sibling-collapse.ts";

/** Form controls whose `placeholder` attribute the user sees as a label. */
const LABELABLE_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

/**
 * Input types where `placeholder` has no meaningful rendering and the
 * accessible-name channels differ (submit/reset/button use `value`;
 * hidden is not rendered). These are excluded to match
 * `forms/labels-required` so we don't double-fire a narrower rule on
 * a case the broader rule already excludes.
 */
const EXCLUDED_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);

export const rule = defineRule({
  id: "forms/placeholder-as-label",
  satisfies: ["wcag22:3.3.2", "wcag21:3.3.2", "wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  // Opt in: PascalCase wrappers declared as rendering `<input>` via
  // the object form of `nativeWrappers` get the same placeholder-vs-
  // label check. Mirrors `forms/labels-required`.
  wrapperTreatsAsElement: "input",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Form control has a placeholder but no label, aria-label, aria-labelledby, or wrapping <label> — the placeholder is the only hint, but it disappears on focus and is announced inconsistently by screen readers.",
    rationale:
      'Placeholder text is assistive-tech unstable: it disappears the moment a user focuses the field (so a sighted user who looks away loses the hint), it is announced inconsistently across screen readers, and most browser UAs render it at low contrast. SC 3.3.2 requires labels or instructions when content requires input; SC 1.3.1 requires the label-to-control relationship to be programmatically determinable. A `placeholder="Email"` satisfies neither — the field has no persistent name for AT to announce and no programmatic association between the hint and the control. The fix is inexpensive (move the placeholder copy into a `<label>` or an `aria-label`), and the author usually already has the label text — it\'s sitting inside the placeholder.',
    goodExample: `<label for="email">Email</label>
<input id="email" type="email" placeholder="name@example.com">`,
    badExample: `<input type="email" placeholder="Email">`,
    normativeQuote:
      "Labels or instructions are provided when content requires user input. (SC 3.3.2) Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text. (SC 1.3.1)",
    references: [
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G131",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F68",
      "https://www.w3.org/WAI/tutorials/forms/labels/",
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
  siblingInstances?: readonly SiblingInstance[];
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const labelFors = collectLabelFors(doc);
  const implicitIds = collectImplicitlyLabeledElementRanges(doc);

  // Sibling-collapse: when ≥3 direct-child labelable controls under one
  // parent share the same `(tagName, type, attributes-modulo-id)`
  // fingerprint AND all fail the placeholder-vs-label predicate, emit
  // ONE canonical finding carrying `siblingInstances` instead of N
  // near-identical findings. Mirrors `forms/labels-required` so a
  // visually-grouped sign-up form (six `<input placeholder="Email">`
  // siblings) reads as one row instead of six entries colliding under
  // one `findingId` (the line-text-keyed id recipe collapses bytes-
  // identical line text by design — collapse at emit time keeps the
  // per-cluster id unique and surfaces the per-sibling trail).
  const isFailing = (el: HtmlElement): boolean =>
    !(
      isExcludedHtmlControl(el) ||
      getNonEmptyPlaceholder(el) === null ||
      htmlHasLabel(el, labelFors, implicitIds)
    );
  const failingByParent = collectFailingHtmlControls(
    doc,
    LABELABLE_TAGS,
    isFailing,
    walkHtmlElements,
  );
  const { primary, consumed } = computeHtmlCollapseDecisions(failingByParent);

  for (const tag of LABELABLE_TAGS) {
    for (const el of findHtmlElementsByTag(doc, tag)) {
      if (!isFailing(el)) continue;
      if (consumed.has(el)) continue;
      const placeholder = getNonEmptyPlaceholder(el);
      // Predicate already gated on non-null placeholder — narrow the
      // type for the builder.
      if (placeholder === null) continue;
      emit(buildHtmlViolation(el, placeholder, primary.get(el)));
    }
  }
}

function getNonEmptyPlaceholder(el: HtmlElement): string | null {
  const raw = getHtmlAttribute(el, "placeholder");
  if (raw === null) return null;
  if (raw.trim().length === 0) return null;
  return raw;
}

function isExcludedHtmlControl(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type")?.toLowerCase();
  if (!type) return false;
  return EXCLUDED_INPUT_TYPES.has(type);
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
 * Collects the `range.start` of every labelable element wrapped inside
 * a `<label>` (implicit labeling). Same shape `forms/labels-required`
 * uses — re-implemented here because rule-to-rule imports are banned by
 * the pure-function invariant (CLAUDE.md §3). Keeping the logic
 * identical keeps the two rules' "has a label" decision coherent.
 */
function collectImplicitlyLabeledElementRanges(doc: HtmlDocument): Set<number> {
  const ranges = new Set<number>();
  for (const label of findHtmlElementsByTag(doc, "label")) {
    for (const descendant of walkHtmlElements(label)) {
      if (LABELABLE_TAGS.has(descendant.tagName.toLowerCase())) {
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

function buildHtmlViolation(
  el: HtmlElement,
  placeholder: string,
  siblings: readonly SiblingInstance[] | undefined,
): Parameters<Emit>[0] {
  const type = getHtmlAttribute(el, "type");
  const message =
    siblings === undefined
      ? buildMessage(el.tagName, type, placeholder)
      : buildPlaceholderSiblingCollapsedMessage(el.tagName, type, placeholder, siblings.length);
  return {
    severity: "warning",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message,
    suggestion: buildSuggestion(el.tagName, type, getHtmlAttribute(el, "id"), placeholder),
    ...(siblings === undefined ? {} : { siblingInstances: siblings }),
  };
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, wrappersForInput: ReadonlySet<string>, emit: Emit): void {
  const labelHtmlFors = collectJsxLabelHtmlFors(module);
  const implicitRanges = collectJsxImplicitlyLabeledElementRanges(module, wrappersForInput);

  // Sibling-collapse: same shape as the HTML branch — when ≥3 direct-
  // child intrinsic `<input>` / `<select>` / `<textarea>` siblings share
  // a `(tagName, attributes-modulo-id)` fingerprint AND all fail the
  // placeholder-vs-label predicate, emit ONE canonical finding carrying
  // `siblingInstances` instead of N near-identical findings. Wrappers
  // and polymorphic `<Tag as="input">` resolutions stay out of collapse
  // (the helper opts them out — clusters of those are rare and the
  // fingerprint would be less stable across the resolution boundary).
  const { primary, consumed } = computeJsxCollapseDecisions(module, LABELABLE_TAGS, (el) => {
    if (isExcludedJsxControl(el)) return false;
    if (getNonEmptyJsxPlaceholder(el) === null) return false;
    if (jsxHasLabel(el, labelHtmlFors, implicitRanges)) return false;
    return true;
  });

  // `<input>` via native-tag + wrapper + polymorphic channels.
  const seen = new Set<JsxElement>();
  for (const el of findJsxElementsForTag(module, "input", wrappersForInput)) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (isExcludedJsxControl(el)) continue;
    if (consumed.has(el)) continue;
    maybeEmitJsxViolation(el, labelHtmlFors, implicitRanges, primary.get(el), emit);
  }

  // `<select>` and `<textarea>` native-only (no wrapper opt-in; same
  // scope decision as `forms/labels-required`).
  for (const tag of ["select", "textarea"] as const) {
    for (const el of findJsxElementsByTag(module, tag)) {
      if (consumed.has(el)) continue;
      maybeEmitJsxViolation(el, labelHtmlFors, implicitRanges, primary.get(el), emit);
    }
  }
}

/** Runs the placeholder-vs-label check for a single JSX element. */
function maybeEmitJsxViolation(
  el: JsxElement,
  labelHtmlFors: ReadonlySet<string>,
  implicitRanges: ReadonlySet<number>,
  siblings: readonly SiblingInstance[] | undefined,
  emit: Emit,
): void {
  const placeholder = getNonEmptyJsxPlaceholder(el);
  if (placeholder === null) return;
  if (jsxHasLabel(el, labelHtmlFors, implicitRanges)) return;
  emit(buildJsxViolation(el, placeholder, siblings));
}

function getNonEmptyJsxPlaceholder(el: JsxElement): string | null {
  const attr = getJsxAttribute(el, "placeholder");
  if (!attr) return null;
  // Expression-valued placeholder (`placeholder={t('email')}`) — we
  // can't read the literal, but its presence still signals the author
  // intends a placeholder. Treat as present with a generic phrasing;
  // the message makes it clear the literal was an expression.
  if (attr.value?.kind === "Expression") return "<expression>";
  if (attr.value?.kind !== "StringLiteral") return null;
  const value = attr.value.value;
  if (value.trim().length === 0) return null;
  return value;
}

function isExcludedJsxControl(el: JsxElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getJsxAttributeString(el, "type")?.toLowerCase();
  if (!type) return false;
  return EXCLUDED_INPUT_TYPES.has(type);
}

function collectJsxLabelHtmlFors(module: TsxModule): Set<string> {
  const fors = new Set<string>();
  for (const label of findJsxElementsByTag(module, "label")) {
    const htmlFor = getJsxAttributeString(label, "htmlFor") ?? getJsxAttributeString(label, "for");
    if (htmlFor && htmlFor.length > 0) {
      fors.add(htmlFor);
      continue;
    }
    // Expression-valued htmlFor — same "trust the developer" tradeoff
    // `forms/labels-required` makes. Use a sentinel so `jsxHasLabel`
    // can pair expression-valued ids with expression-valued htmlFors.
    const forAttr = getJsxAttribute(label, "htmlFor") ?? getJsxAttribute(label, "for");
    if (forAttr?.value?.kind === "Expression") fors.add("__expr__");
  }
  return fors;
}

function collectJsxImplicitlyLabeledElementRanges(
  module: TsxModule,
  wrappersForInput: ReadonlySet<string>,
): Set<number> {
  const ranges = new Set<number>();
  for (const label of findJsxElementsByTag(module, "label")) {
    for (const descendant of walkJsxDescendants(label)) {
      const tag = descendant.tagName;
      if (LABELABLE_TAGS.has(tag.toLowerCase()) || wrappersForInput.has(tag)) {
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

/** Non-empty aria-label (literal or expression — either counts). */
function jsxHasAriaLabel(el: JsxElement): boolean {
  const literal = getJsxAttributeString(el, "aria-label");
  if (literal !== null && literal.trim().length > 0) return true;
  const attr = getJsxAttribute(el, "aria-label");
  return attr?.value?.kind === "Expression";
}

/** Non-empty aria-labelledby reference (literal or expression). */
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

/**
 * True when the element's id (literal or expression) is referenced by
 * a `<label htmlFor>` in the same file. Expression-valued ids match
 * the `__expr__` sentinel that `collectJsxLabelHtmlFors` populates
 * when it sees an expression-valued htmlFor — same "trust the
 * developer" tradeoff `forms/labels-required` makes.
 */
function jsxHasForAssociation(el: JsxElement, labelHtmlFors: ReadonlySet<string>): boolean {
  const id = getJsxAttributeString(el, "id");
  if (id && labelHtmlFors.has(id)) return true;
  const idAttr = getJsxAttribute(el, "id");
  return idAttr?.value?.kind === "Expression" && labelHtmlFors.has("__expr__");
}

function buildJsxViolation(
  el: JsxElement,
  placeholder: string,
  siblings: readonly SiblingInstance[] | undefined,
): Parameters<Emit>[0] {
  const type = getJsxAttributeString(el, "type");
  const id = getJsxAttributeString(el, "id");
  const message =
    siblings === undefined
      ? buildMessage(el.tagName, type, placeholder)
      : buildPlaceholderSiblingCollapsedMessage(el.tagName, type, placeholder, siblings.length);
  return {
    severity: "warning",
    location: { filePath: "", line: el.loc.start.line, column: el.loc.start.column },
    message,
    suggestion: buildSuggestion(el.tagName, type, id, placeholder),
    ...(siblings === undefined ? {} : { siblingInstances: siblings }),
  };
}

// ---------------------------------------------------------------------------
// Messages (context-aware — quote the actual placeholder)
// ---------------------------------------------------------------------------

function buildMessage(tagName: string, type: string | null, placeholder: string): string {
  const descriptor = type ? `<${tagName} type="${type}">` : `<${tagName}>`;
  const quoted =
    placeholder === "<expression>"
      ? "an expression-valued placeholder"
      : `\`placeholder="${truncateForEcho(placeholder)}"\``;
  return `${descriptor} has ${quoted} but no <label>, aria-label, aria-labelledby, or title — the placeholder is the field's only hint, but it disappears on focus and is announced inconsistently by screen readers.`;
}

/**
 * Message for the canonical sibling-rollup finding when ≥3 direct-
 * child labelable controls under one parent share a fingerprint and
 * all fail the placeholder-vs-label predicate. Names the cluster
 * shape and the rollup count so an agent reading the message alone
 * knows it is one finding standing in for N siblings — and knows to
 * read `siblingInstances` for the per-sibling line/id trail. Quotes
 * the actual placeholder copy (truncated) so the agent sees the
 * concrete antipattern the cluster shares.
 *
 * The shared `_label-sibling-collapse.ts` helper ships its own
 * collapsed-message builder for `forms/labels-required` (the "no
 * accessible name" framing); this one is rule-specific because the
 * placeholder antipattern wording quotes the placeholder text, which
 * the labels-required surface doesn't carry.
 */
function buildPlaceholderSiblingCollapsedMessage(
  tagName: string,
  type: string | null,
  placeholder: string,
  count: number,
): string {
  const descriptor = type ? `<${tagName} type="${type}">` : `<${tagName}>`;
  const quoted =
    placeholder === "<expression>"
      ? "an expression-valued placeholder"
      : `\`placeholder="${truncateForEcho(placeholder)}"\``;
  const others = count - 1;
  return (
    `${descriptor} has ${quoted} but no <label>, aria-label, aria-labelledby, or title — and` +
    ` ${others} adjacent sibling ${tagName} element${others === 1 ? "" : "s"} sharing the same` +
    ` parent and the same (tag, type, attributes-modulo-id) shape carry the same placeholder-as-` +
    `label antipattern (collapsed into one finding; see siblingInstances for the per-sibling` +
    ` line/id trail). The placeholder disappears on focus and is announced inconsistently by` +
    ` screen readers; the fix is the same per-cluster — promote the placeholder copy into a` +
    ` persistent <label> or aria-label on every sibling, or wrap the cluster in a single` +
    ` <fieldset><legend> when one shared label fits the whole group.`
  );
}

function buildSuggestion(
  tagName: string,
  type: string | null,
  id: string | null,
  placeholder: string,
): string {
  const idHint = truncateForEcho(id ?? inferIdFromType(type));
  const placeholderQuoted =
    placeholder === "<expression>"
      ? "the computed placeholder value"
      : `\`"${truncateForEcho(placeholder)}"\``;
  return `Add a persistent \`<label>\` or \`aria-label\`; placeholder text is AT-unstable (disappears on focus, may not be announced depending on screen reader). Current placeholder ${placeholderQuoted} may carry the intent — verify accuracy before using as label copy. Options: (1) wrap with \`<label for="${idHint}">\` and give the ${tagName} \`id="${idHint}"\`, (2) set \`aria-label="…"\` directly on the ${tagName}, or (3) \`aria-labelledby="…"\` pointing at an existing visible heading. Keep the placeholder as a format hint (e.g., \`placeholder="name@example.com"\`) only if the label copy is different.`;
}

function inferIdFromType(type: string | null): string {
  if (!type) return "field";
  const map: Readonly<Record<string, string>> = {
    email: "email",
    password: "password",
    search: "search",
    tel: "phone",
    url: "url",
    number: "number",
    date: "date",
    time: "time",
    file: "upload",
  };
  return map[type.toLowerCase()] ?? "field";
}
