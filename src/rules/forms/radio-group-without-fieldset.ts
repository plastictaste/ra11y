/**
 * Rule: forms/radio-group-without-fieldset
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1, wcag22:3.3.2, wcag21:3.3.2, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available
 * > in text.
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * A radio group is a set of `<input type="radio">` elements that share
 * a `name` attribute — they compete as mutually-exclusive choices. The
 * visual grouping ("Shipping speed: Standard / Express / Overnight")
 * must also be programmatically determinable so screen readers announce
 * the group's purpose — "Shipping speed, radio group, 3 items" — not
 * just each individual option.
 *
 * A radio group is properly grouped when wrapped by EITHER:
 *
 *   1. `<fieldset>` with a non-empty `<legend>` descendant. The legend
 *      text becomes the group's accessible name; the fieldset role
 *      ("group") is announced together with it.
 *   2. An element with `role="radiogroup"` AND an accessible name —
 *      either a non-empty `aria-label` or `aria-labelledby` pointing
 *      at one or more labeling elements. The WAI-ARIA pattern for
 *      custom radio groups.
 *
 * Flagged cases:
 *   - Two or more radios sharing a name with no wrapping fieldset and
 *     no role="radiogroup" container.
 *   - Radios inside a `<fieldset>` that has no `<legend>` (or an empty
 *     one) AND no `aria-label[-ledby]` on the fieldset — the fieldset
 *     role alone announces "group" with no name.
 *   - Radios inside a `role="radiogroup"` container with no accessible
 *     name (missing / empty `aria-label`, missing `aria-labelledby`).
 *
 * Complementary to `forms/fieldset-legend` — that rule fires on every
 * `<fieldset>` lacking a legend, regardless of its contents; this rule
 * fires on radio GROUPS that lack any correct wrapper. The two overlap
 * on "fieldset wrapping radios, no legend" by design: the fieldset rule
 * speaks to the wrapper's own naming; this rule speaks to the group's
 * wiring.
 *
 * One finding per radio group (not per input) — the fix is a single
 * structural change. Reported at the location of the first radio in
 * the group, in document order.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

export const rule = defineRule({
  id: "forms/radio-group-without-fieldset",
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
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Radio inputs sharing a name must be wrapped by <fieldset>+<legend> or a role='radiogroup' container with an accessible name, so the group is programmatically announced with its purpose.",
    rationale:
      "Radios sharing a `name` are mutually-exclusive choices — a group, not independent controls. Without a fieldset+legend or role='radiogroup' with a name, screen readers announce each option in isolation ('Standard, radio button, 1 of …?') but never the group's purpose ('Shipping speed'). The visually-obvious relationship fails to reach assistive technology; WCAG 1.3.1 (structure), 3.3.2 (label for the input set), and 4.1.2 (name/role for the group) all fail together.",
    goodExample: `<fieldset>\n  <legend>Shipping speed</legend>\n  <label><input type="radio" name="speed" value="std"> Standard</label>\n  <label><input type="radio" name="speed" value="exp"> Express</label>\n</fieldset>`,
    badExample: `<label><input type="radio" name="speed" value="std"> Standard</label>\n<label><input type="radio" name="speed" value="exp"> Express</label>`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/TR/WCAG22/#labels-or-instructions",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/ARIA/apg/patterns/radio/",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H71",
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

type WrapperReason = "no-wrapper" | "fieldset-without-legend" | "radiogroup-without-name";

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const parentOf = buildHtmlParentMap(doc);
  const groups = collectHtmlRadioGroups(doc);
  for (const [name, inputs] of groups) {
    if (inputs.length < 2) continue;
    const first = inputs[0];
    if (!first) continue;
    const diagnosis = diagnoseHtmlGroup(inputs, parentOf);
    if (diagnosis === null) continue;
    emit(buildViolation(name, inputs.length, diagnosis, first.loc.start));
  }
}

function collectHtmlRadioGroups(doc: HtmlDocument): Map<string, HtmlElement[]> {
  const groups = new Map<string, HtmlElement[]>();
  for (const input of findHtmlElementsByTag(doc, "input")) {
    const type = (getHtmlAttribute(input, "type") ?? "").toLowerCase();
    if (type !== "radio") continue;
    const name = getHtmlAttribute(input, "name");
    if (name === null || name.trim().length === 0) continue;
    const bucket = groups.get(name);
    if (bucket) bucket.push(input);
    else groups.set(name, [input]);
  }
  return groups;
}

/**
 * Returns the "wrapper problem" the group suffers, or `null` when at
 * least one correct wrapper encloses every radio in the group.
 *
 * Short-circuits on the first valid wrapper found — if ANY input in the
 * group has a correct fieldset/radiogroup ancestor AND every other input
 * in the group shares that ancestor, the group is fine. (A split group
 * — some radios in a fieldset, some outside — is treated as ungrouped
 * because assistive tech will announce the outsiders separately.)
 */
function diagnoseHtmlGroup(
  inputs: readonly HtmlElement[],
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): WrapperReason | null {
  const kinds: AncestorKind[] = inputs.map((i) => classifyHtmlAncestor(i, parentOf));
  return summarizeKinds(kinds);
}

/**
 * Reduces the per-input wrapper kinds to a single group-level diagnosis.
 *
 * - All "ok" (fieldset with name OR radiogroup with name): `null` — the
 *   group is correctly wrapped. We don't verify every radio sits under
 *   the *same* ancestor node; if two legend-bearing fieldsets split the
 *   group between them, assistive tech announces two groups — author's
 *   intent, not this rule's concern.
 * - Any "bad-fieldset" in the kinds: the author reached for the fieldset
 *   pattern but forgot the legend.
 * - Any "bad-radiogroup": role="radiogroup" container with no
 *   accessible name.
 * - Otherwise: no wrapper at all.
 */
function summarizeKinds(kinds: readonly AncestorKind[]): WrapperReason | null {
  if (kinds.every((k) => k === "ok-fieldset" || k === "ok-radiogroup")) return null;
  if (kinds.some((k) => k === "bad-fieldset")) return "fieldset-without-legend";
  if (kinds.some((k) => k === "bad-radiogroup")) return "radiogroup-without-name";
  return "no-wrapper";
}

function classifyHtmlAncestor(
  input: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): AncestorKind {
  let bad: "bad-fieldset" | "bad-radiogroup" | null = null;
  let ancestor = parentOf.get(input);
  while (ancestor) {
    const kind = classifyHtmlAncestorNode(ancestor);
    if (kind === "ok-fieldset" || kind === "ok-radiogroup") return kind;
    if (kind !== "none" && bad === null) bad = kind;
    ancestor = parentOf.get(ancestor);
  }
  return bad ?? "none";
}

function classifyHtmlAncestorNode(ancestor: HtmlElement): AncestorKind {
  const tag = ancestor.tagName.toLowerCase();
  if (tag === "fieldset") {
    return htmlFieldsetHasAccessibleName(ancestor) ? "ok-fieldset" : "bad-fieldset";
  }
  const role = (getHtmlAttribute(ancestor, "role") ?? "").toLowerCase();
  if (role === "radiogroup") {
    return htmlHasAriaName(ancestor) ? "ok-radiogroup" : "bad-radiogroup";
  }
  return "none";
}

type AncestorKind = "ok-fieldset" | "ok-radiogroup" | "bad-fieldset" | "bad-radiogroup" | "none";

function htmlFieldsetHasAccessibleName(fieldset: HtmlElement): boolean {
  if (htmlHasAriaName(fieldset)) return true;
  for (const child of fieldset.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "legend") continue;
    if (htmlTextContent(child).length > 0) return true;
  }
  return false;
}

function htmlHasAriaName(element: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  const ariaLabelledby = getHtmlAttribute(element, "aria-labelledby");
  if (ariaLabelledby !== null && ariaLabelledby.trim().length > 0) return true;
  return false;
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
  const groups = collectJsxRadioGroups(module);
  for (const [name, inputs] of groups) {
    if (inputs.length < 2) continue;
    const first = inputs[0];
    if (!first) continue;
    const diagnosis = diagnoseJsxGroup(inputs, parentOf);
    if (diagnosis === null) continue;
    emit(buildViolation(name, inputs.length, diagnosis, first.loc.start));
  }
}

function collectJsxRadioGroups(module: TsxModule): Map<string, JsxElement[]> {
  const groups = new Map<string, JsxElement[]>();
  for (const input of findJsxElementsByTag(module, "input")) {
    const type = getJsxAttributeString(input, "type");
    if (type !== "radio") continue;
    const name = getJsxAttributeString(input, "name");
    if (name === null || name.trim().length === 0) continue;
    const bucket = groups.get(name);
    if (bucket) bucket.push(input);
    else groups.set(name, [input]);
  }
  return groups;
}

function diagnoseJsxGroup(
  inputs: readonly JsxElement[],
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): WrapperReason | null {
  const kinds: AncestorKind[] = inputs.map((i) => classifyJsxAncestor(i, parentOf));
  return summarizeKinds(kinds);
}

function classifyJsxAncestor(
  input: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): AncestorKind {
  let bad: "bad-fieldset" | "bad-radiogroup" | null = null;
  let ancestor = parentOf.get(input);
  while (ancestor) {
    const kind = classifyJsxAncestorNode(ancestor);
    if (kind === "ok-fieldset" || kind === "ok-radiogroup") return kind;
    if (kind !== "none" && bad === null) bad = kind;
    ancestor = parentOf.get(ancestor);
  }
  return bad ?? "none";
}

function classifyJsxAncestorNode(ancestor: JsxElement): AncestorKind {
  if (ancestor.tagName === "fieldset") {
    return jsxFieldsetHasAccessibleName(ancestor) ? "ok-fieldset" : "bad-fieldset";
  }
  const role = getJsxAttributeString(ancestor, "role");
  if (role !== null && role.toLowerCase() === "radiogroup") {
    return jsxHasAriaName(ancestor) ? "ok-radiogroup" : "bad-radiogroup";
  }
  return "none";
}

function jsxFieldsetHasAccessibleName(fieldset: JsxElement): boolean {
  if (jsxHasAriaName(fieldset)) return true;
  for (const child of fieldset.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName !== "legend") continue;
    if (jsxTextContent(child).length > 0) return true;
    if (jsxHasExpressionChild(child)) return true;
  }
  return false;
}

function jsxHasAriaName(element: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  // Runtime expression values — can't statically verify; assume OK so
  // we don't spam false positives on dynamic labels.
  const ariaLabelAttr = getJsxAttribute(element, "aria-label");
  if (ariaLabelAttr?.value?.kind === "Expression") return true;
  return false;
}

function jsxHasExpressionChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind === "JsxExpression") return true;
  }
  return false;
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
// Violation builder
// ---------------------------------------------------------------------------

function buildViolation(
  groupName: string,
  groupSize: number,
  reason: WrapperReason,
  loc: { line: number; column: number },
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: buildMessage(groupName, groupSize, reason),
    suggestion: buildSuggestion(groupName, reason),
  };
}

function buildMessage(name: string, size: number, reason: WrapperReason): string {
  const subject = `${size} <input type="radio" name="${name}"> elements`;
  if (reason === "fieldset-without-legend") {
    return `${subject} are wrapped by a <fieldset>, but it has no <legend> and no aria-label — screen readers announce "group" for the set with no indication of what the choice is about.`;
  }
  if (reason === "radiogroup-without-name") {
    return `${subject} are wrapped by a role="radiogroup" container with no accessible name — aria-label is missing or empty and there is no aria-labelledby, so screen readers announce "radio group" with no indication of the group's purpose.`;
  }
  return `${subject} share a name (so they are one mutually-exclusive choice), but no ancestor <fieldset>+<legend> or role="radiogroup" wraps them — screen readers announce each option individually with no group context.`;
}

function buildSuggestion(name: string, reason: WrapperReason): string {
  const groupAttrs = `name="${name}"`;
  if (reason === "fieldset-without-legend") {
    return `Add a <legend> as the first child of the fieldset with text that names the choice (e.g. <legend>Shipping speed</legend>). If a visible heading already labels the group, set aria-labelledby="<that-heading-id>" on the fieldset instead. If you prefer the ARIA pattern, replace <fieldset> with a container that has role="radiogroup" and either aria-label="Shipping speed" or aria-labelledby="<heading-id>".`;
  }
  if (reason === "radiogroup-without-name") {
    return `Add an accessible name to the role="radiogroup" container: either aria-label="<group purpose>" (e.g. aria-label="Shipping speed") or aria-labelledby="<id-of-visible-heading>". If a visible heading exists next to the group, prefer aria-labelledby so the visible and programmatic names stay in sync.`;
  }
  return `Wrap the <input type="radio" ${groupAttrs}> set in a <fieldset> with a <legend> that names the choice:\n  <fieldset>\n    <legend>Shipping speed</legend>\n    <label><input type="radio" ${groupAttrs} value="std"> Standard</label>\n    <label><input type="radio" ${groupAttrs} value="exp"> Express</label>\n  </fieldset>\nAlternatively, wrap in a container with role="radiogroup" and either aria-label="<group purpose>" or aria-labelledby="<id-of-visible-heading>".`;
}
