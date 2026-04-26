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
 * Flags an "error message" element whose sibling form control has no
 * `aria-describedby` attribute that references the error element's
 * `id`. Without that association, a screen-reader user who tabs into
 * the field hears the field's label and state but never hears the
 * error message — the page "identifies" the error visually for sighted
 * users, not programmatically for assistive tech. Per SC 3.3.1 the item
 * in error must be identified AND the error described in text that
 * reaches the user; per SC 3.3.3 any correction suggestion must
 * likewise be announced. The association glue is `aria-describedby` —
 * without it, the text exists on the page but is not connected to the
 * control.
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
 * Container detection runs in two confidence tiers:
 *
 *   - **Canonical (high confidence, severity `error`)** — well-defined
 *     conventions whose sole purpose is per-field validation messaging:
 *     `.invalid-feedback` (Bootstrap 5+), `.error-message` (common
 *     hand-rolled convention), `[role="alert"]` (generic ARIA
 *     live-region status mechanism). When one of these sits adjacent to
 *     a form control with no matching `aria-describedby`, the
 *     association is provably broken from the markup alone.
 *
 *   - **Heuristic (medium confidence, severity `info`)** — older or
 *     more ambiguous conventions whose semantics are author-dependent:
 *     `.alert.alert-{error,danger,warning,success,info}` (older
 *     Bootstrap 3/4 alert family), and id-suffix patterns
 *     (`*Error` / `*Success` / `*Message`, e.g. `id="contactError"`).
 *     A `<div class="alert alert-danger">` adjacent to a form might be
 *     a per-field error message — or it might be a page-level
 *     server-error banner that intentionally announces independently.
 *     The static signal is not strong enough to assert a violation, so
 *     the rule surfaces the candidate at `info` with a `reason` that
 *     names what's uncertain (per the AI-first consumer rule on
 *     heuristic emission: speculation about composition belongs at
 *     review-candidate confidence, not at deterministic-finding
 *     severity). The agent reads the file and decides.
 *
 * Detection model:
 *
 *   1. Find every error-message element in the document via either
 *      tier above.
 *   2. For each, walk its parent's direct children to find a sibling
 *      form control (`<input>`, `<textarea>`, `<select>`). Direct
 *      siblings only — deeper nested structures (field-within-column
 *      layouts) are out of scope for v1, to keep the signal high.
 *   3. If the sibling control has `aria-describedby` and at least one
 *      token in it equals the error element's `id`, the pair is
 *      associated — skip.
 *   4. Otherwise, emit on the error-message element with severity
 *      determined by the tier that matched, and a fix that names the
 *      control and the id to add (or to create, if the error element
 *      has no id yet).
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
 *   - Generic `<div>` error text without one of the recognized
 *     containers above. Without any recognizable marker, the static
 *     signal "this is an error message" is not strong enough.
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
 * Variant tokens that, when paired with the `alert` base class, mark a
 * Bootstrap 3/4-style alert as a *candidate* error-message surface —
 * heuristic detection, severity `info`. The match requires BOTH `alert`
 * and one of these variants on the same element; bare `.alert` (without
 * a variant) or a bare variant token is ignored.
 *
 * `alert-danger` / `alert-error` / `alert-warning` strongly suggest a
 * problem state; `alert-success` / `alert-info` are weaker signals
 * (could be a page-level banner). All five variants surface at the same
 * `info` severity and let the agent triage from the file.
 *
 * The two *canonical* class tokens (`.invalid-feedback`, `.error-message`)
 * are matched inline in `classifyHtmlContainer` / `classifyJsxContainer`
 * so the canonical class names appear next to the heuristic
 * alert/id-suffix branches and the matching order is auditable in one
 * place. Generic tokens like `.error` are deliberately absent from both
 * tiers — too ambiguous (could be a status banner, could be a CSS state
 * class).
 */
const HEURISTIC_ALERT_VARIANTS: ReadonlySet<string> = new Set([
  "alert-error",
  "alert-danger",
  "alert-warning",
  "alert-success",
  "alert-info",
]);

/**
 * Id-suffix tokens that mark an element as a *candidate* error-message
 * surface — heuristic detection, severity `info`. Matches camelCase
 * authoring style (`id="contactError"`, `id="contactSuccess"`,
 * `id="formMessage"`) where the suffix is the final token in a
 * camelCase identifier — i.e. the suffix is preceded by an uppercase
 * letter or is the entire id. The static signal is not strong enough
 * to assert (an id named `contactSuccess` could be a confirmation
 * banner rather than a per-field message), so emission stays at `info`.
 */
const HEURISTIC_ID_SUFFIXES: readonly string[] = ["Error", "Success", "Message"];

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
      "An error-message element adjacent to a form control must be referenced via aria-describedby on that control, or screen-reader users never hear the error. Canonical containers (.invalid-feedback / .error-message / [role=alert]) emit at error severity; older Bootstrap .alert.alert-{danger,error,warning,success,info} variants and id-suffix patterns (*Error / *Success / *Message) emit at info because the static signal is not strong enough to assert.",
    rationale:
      'SC 3.3.1 requires the item in error to be identified AND the error described in text that reaches the user. "Reaches the user" is the load-bearing clause for assistive-tech consumers: a `<div class="invalid-feedback">` next to an `<input>` shows a red error message to sighted users, but a screen-reader user tabbing into the field hears only the label and state — the error text is in the DOM but not wired to the control. `aria-describedby` is the association mechanism; without it the text is invisible to the accessibility tree. SC 3.3.3 then piles on for the correction-suggestion case — an error message that says "enter a valid email" is a suggestion that must also be announced with the control. The fix is one attribute (`aria-describedby="<error-id>"`) plus, if missing, an `id` on the error element. Static analysis can prove the link is broken cheaply for canonical containers; for heuristic-tier containers (older Bootstrap `.alert.alert-{variant}` family, camelCase id suffixes like `*Error` / `*Success` / `*Message`) the predicate "this is a per-field error message" is itself heuristic — could be a page-level banner — so the rule surfaces the candidate at info severity with reason text that names what is uncertain, per the AI-first consumer rule on heuristic emission.',
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

type EmittedSeverity = "error" | "info";

type Emit = (v: {
  severity: EmittedSeverity;
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
    const match = classifyHtmlContainer(el);
    if (match === null) continue;
    const parent = parentOf.get(el);
    if (!parent) continue;
    const control = findHtmlSiblingControl(parent, el);
    if (!control) continue;
    const errorId = getHtmlAttribute(el, "id");
    const describedBy = getHtmlAttribute(control, "aria-describedby");
    if (errorId !== null && errorId !== "" && describedByIncludes(describedBy, errorId)) continue;
    emit(buildHtmlViolation(el, control, errorId, describedBy, match));
  }
}

function classifyHtmlContainer(el: HtmlElement): ContainerMatch | null {
  return classifyContainerByAttributes({
    role: getHtmlAttribute(el, "role"),
    classValue: getHtmlAttribute(el, "class"),
    idValue: getHtmlAttribute(el, "id"),
  });
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
    const match = classifyJsxContainer(el);
    if (match === null) continue;
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
    emit(buildJsxViolation(el, control, errorId, describedBy, match));
  }
}

function classifyJsxContainer(el: JsxElement): ContainerMatch | null {
  return classifyContainerByAttributes({
    role: getJsxAttributeString(el, "role"),
    classValue: getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class"),
    idValue: getJsxAttributeString(el, "id"),
  });
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

/**
 * AST-agnostic container-classification entry point. Both
 * `classifyHtmlContainer` and `classifyJsxContainer` extract the three
 * attribute values they care about (`role`, class, id) and delegate
 * here, which keeps the matching order auditable in one place and
 * keeps each AST-shaped wrapper trivial enough that the lint
 * complexity budget binds on the *rule* logic, not on the
 * boilerplate.
 */
function classifyContainerByAttributes(attrs: {
  readonly role: string | null;
  readonly classValue: string | null;
  readonly idValue: string | null;
}): ContainerMatch | null {
  if (attrs.role !== null && attrs.role.trim().toLowerCase() === "alert") {
    return { kind: "role-alert", tier: "canonical" };
  }
  if (attrs.classValue !== null) {
    const classMatch = classifyByClassTokens(attrs.classValue.split(/\s+/u));
    if (classMatch !== null) return classMatch;
  }
  if (attrs.idValue !== null && attrs.idValue !== "") {
    const suffix = matchHeuristicIdSuffix(attrs.idValue);
    if (suffix !== null) return { kind: "id-suffix", tier: "heuristic", suffix };
  }
  return null;
}

/**
 * Class-token branch of {@link classifyContainerByAttributes}. Order
 * matters: canonical tokens win over heuristic ones, so a container
 * carrying both `.invalid-feedback` AND `.alert.alert-danger` lands at
 * the canonical tier (severity `error`) rather than the heuristic one.
 */
function classifyByClassTokens(tokens: readonly string[]): ContainerMatch | null {
  if (tokens.includes("invalid-feedback")) return { kind: "invalid-feedback", tier: "canonical" };
  if (tokens.includes("error-message")) return { kind: "error-message", tier: "canonical" };
  if (!tokens.includes("alert")) return null;
  const variant = tokens.find((t) => HEURISTIC_ALERT_VARIANTS.has(t));
  if (variant === undefined) return null;
  return { kind: "alert-variant", tier: "heuristic", variant };
}

/**
 * Discriminated union describing which container pattern matched. The
 * `tier` controls emission severity (`canonical` → `error`, `heuristic`
 * → `info`); the `kind` and per-tier extras drive the message and
 * suggestion text so the agent sees what was matched and why.
 */
type ContainerMatch =
  | { readonly kind: "invalid-feedback"; readonly tier: "canonical" }
  | { readonly kind: "error-message"; readonly tier: "canonical" }
  | { readonly kind: "role-alert"; readonly tier: "canonical" }
  | { readonly kind: "alert-variant"; readonly tier: "heuristic"; readonly variant: string }
  | { readonly kind: "id-suffix"; readonly tier: "heuristic"; readonly suffix: string };

/**
 * Returns the matching suffix from {@link HEURISTIC_ID_SUFFIXES} when
 * `id` ends with one in camelCase position (preceded by a lowercase or
 * digit character, or comprising the entire id), or null otherwise.
 *
 * Example matches: `contactError`, `formMessage`, `signupSuccess`,
 * `Error` (whole-id), `Message` (whole-id).
 *
 * Example non-matches: `errors` (suffix not at end), `successful`
 * (Suffix-not-final), `MESSAGE_BANNER` (suffix is part of an
 * underscore-delimited screaming-snake-case identifier — different
 * convention), `summary-error` (kebab-case; not the camelCase
 * convention the backlog item names — kebab-case error containers
 * typically pair with `class="error-message"` already).
 */
function matchHeuristicIdSuffix(id: string): string | null {
  for (const suffix of HEURISTIC_ID_SUFFIXES) {
    if (!id.endsWith(suffix)) continue;
    if (id.length === suffix.length) return suffix;
    const preceding = id.charAt(id.length - suffix.length - 1);
    // camelCase suffix: the boundary must be lower→upper or digit→upper.
    // Reject the all-uppercase / SCREAMING_SNAKE / kebab-case shapes by
    // requiring a lowercase or digit character immediately before the
    // suffix's leading uppercase.
    if (/[a-z0-9]/u.test(preceding)) return suffix;
  }
  return null;
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
  readonly match: ContainerMatch;
  readonly controlTag: string;
  readonly controlType: string | null;
  readonly errorId: string | null;
  readonly describedBy: string | null;
  readonly location: { readonly line: number; readonly column: number };
}

function buildHtmlViolation(
  errorEl: HtmlElement,
  control: HtmlElement,
  errorId: string | null,
  describedBy: string | null,
  match: ContainerMatch,
): {
  severity: EmittedSeverity;
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return buildViolation({
    match,
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
  match: ContainerMatch,
): {
  severity: EmittedSeverity;
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return buildViolation({
    match,
    controlTag: control.tagName.toLowerCase(),
    controlType: getJsxAttributeString(control, "type"),
    errorId,
    describedBy,
    location: { line: errorEl.loc.start.line, column: errorEl.loc.start.column },
  });
}

function buildViolation(input: ViolationInput): {
  severity: EmittedSeverity;
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const errorDescriptor = describeErrorElement(input.match);
  const controlDescriptor = describeControl(input.controlTag, input.controlType);
  const severity: EmittedSeverity = input.match.tier === "canonical" ? "error" : "info";
  return {
    severity,
    location: { filePath: "", line: input.location.line, column: input.location.column },
    message: buildMessage(input.match, errorDescriptor, controlDescriptor, input.describedBy),
    suggestion: buildSuggestion(
      input.match,
      errorDescriptor,
      controlDescriptor,
      input.errorId,
      input.describedBy,
    ),
  };
}

function describeErrorElement(match: ContainerMatch): string {
  if (match.kind === "role-alert") return 'this [role="alert"] element';
  if (match.kind === "invalid-feedback") return 'this <div class="invalid-feedback">';
  if (match.kind === "error-message") return "this .error-message element";
  if (match.kind === "alert-variant") return `this <div class="alert ${match.variant}">`;
  return `this <div id="…${match.suffix}">`;
}

function describeControl(tag: string, type: string | null): string {
  if (tag === "input" && type !== null && type !== "") return `the sibling <input type="${type}">`;
  return `the sibling <${tag}>`;
}

/**
 * Returns the heuristic-tier framing prefix for a `message` /
 * `suggestion` pair when the container classification is itself a
 * candidate (not a deterministic match). Per the AI-first consumer rule
 * on heuristic emission, severity-`info` findings whose predicate is
 * "this looks like an error container" must surface the uncertainty in
 * the reason text — agents read severity first, but the framing must
 * agree with severity (per the "reason text and severity must agree"
 * rule). For canonical matches (severity `error`) the framing prefix is
 * empty — the predicate is provable from the markup.
 */
function heuristicFraming(match: ContainerMatch): string {
  if (match.tier === "canonical") return "";
  if (match.kind === "alert-variant") {
    return `Heuristic match: \`alert ${match.variant}\` adjacent to a form control reads as a candidate per-field error message, but it could also be a page-level banner that intentionally announces independently — verify the surrounding markup. If it is per-field: `;
  }
  // id-suffix
  return `Heuristic match: an id ending in "${match.suffix}" adjacent to a form control reads as a candidate per-field message, but the id naming convention alone is not proof — verify the surrounding markup. If it is per-field: `;
}

function buildMessage(
  match: ContainerMatch,
  errorDescriptor: string,
  controlDescriptor: string,
  describedBy: string | null,
): string {
  const framing = heuristicFraming(match);
  if (describedBy !== null && describedBy.length > 0) {
    return `${framing}${errorDescriptor} is adjacent to a form control but ${controlDescriptor} has aria-describedby="${describedBy}" which does not reference this error element's id — screen-reader users tabbing into the field will not hear the error text.`;
  }
  return `${framing}${errorDescriptor} is adjacent to a form control but ${controlDescriptor} has no aria-describedby — screen-reader users tabbing into the field will not hear the error text.`;
}

function buildSuggestion(
  _match: ContainerMatch,
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
