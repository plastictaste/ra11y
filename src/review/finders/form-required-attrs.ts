/**
 * Candidate finder: review/form-required-attrs
 * Criteria: wcag22:3.3.1, wcag21:3.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#error-identification
 *
 * Surfaces native form controls carrying validation constraints that
 * deterministically signal WCAG 3.3.1 review territory. WCAG 3.3.1
 * requires that when an input error is automatically detected, the item
 * is identified and described to the user in text.
 *
 * The finder checks for these constraint attributes on intrinsic form
 * controls (input, select, textarea):
 *   - `required` — form will not submit without a value; must name the
 *     missing-field error to the user
 *   - `pattern` — invalid input must be explained in error text
 *   - `minlength` / `maxlength` — length violations must be named
 *   - `min` / `max` — range violations must be named
 *   - `aria-invalid` — author has explicitly marked the field invalid;
 *     the companion error description wiring is the review question
 *
 * Each of these attributes is deterministically present in source — the
 * finder is "high" confidence because the evidence is a literal attribute
 * presence check on a native element, not a heuristic. The agent must
 * still verify that the error message (a) exists, (b) is meaningful, and
 * (c) reaches the user (aria-describedby / live region / adjacent text).
 *
 * Per the AI-first consumer model (docs/kb/architecture/ai-first-consumer.md):
 * candidates are not suppressed or filtered by context the scanner cannot
 * see (presence of an associated error node, presence of a submit handler,
 * etc.). The agent reads the page and decides. The reason text encodes the
 * dismissal signal — named attribute + field id if any — so dismissal is
 * one read away.
 *
 * Pairs with review/error-identification (which targets the post-error
 * state: `aria-invalid="true"` + missing describedby/errormessage). This
 * finder is the up-front constraint-presence pass: if you have validation
 * constraints, you need error identification wiring.
 *
 * Skips `<input type="hidden">` and `<input type="submit">` /
 * `<input type="button">` / `<input type="reset">` — these are not
 * user-facing field inputs.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:3.3.1", "wcag21:3.3.1"] as const;

/** Intrinsic form control tag names relevant to constraint-based error identification. */
const CONSTRAINT_FORM_TAGS: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

/**
 * Constraint attributes that imply a validation rule the user could violate.
 * Order is declaration-priority: the first one that matches drives the reason
 * text. Required is first because it is the most universal constraint.
 */
const CONSTRAINT_ATTRS: readonly string[] = [
  "required",
  "aria-invalid",
  "pattern",
  "minlength",
  "maxlength",
  "min",
  "max",
] as const;

/**
 * `<input type>` values whose purpose is not user-text entry —
 * constraints on these don't create a 3.3.1 review obligation.
 */
const NON_FIELD_INPUT_TYPES: ReadonlySet<string> = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
]);

export const finder = defineCandidateFinder({
  id: "review/form-required-attrs",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds native form controls (input, select, textarea) with validation-constraint attributes — required, pattern, minlength, maxlength, min, max, or aria-invalid — that deterministically signal WCAG 3.3.1 review territory.",
    reviewPrompt:
      "At each candidate, verify that any error triggered by this constraint is: (1) announced to the user in text — not just a color or icon change; (2) programmatically associated with the field via aria-describedby pointing at a live error node, or aria-errormessage; (3) announced at an appropriate time (on submit or on blur, not aggressively on every keystroke). If the error message lives in a component wrapper (react-hook-form, formik, shadcn FormMessage), confirm it resolves to a DOM text node at runtime.",
    references: [
      "https://www.w3.org/TR/WCAG22/#error-identification",
      "https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html",
      "https://www.w3.org/TR/wai-aria-1.2/#aria-errormessage",
      "https://html.spec.whatwg.org/multipage/form-elements.html#the-constraint-validation-api",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// HTML branch
// ---------------------------------------------------------------------------

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const el of walkHtmlElements(root)) {
    if (!CONSTRAINT_FORM_TAGS.has(el.tagName.toLowerCase())) continue;
    if (isNonFieldHtmlInput(el)) continue;

    const triggeredAttr = firstPresentHtmlAttr(el, CONSTRAINT_ATTRS);
    if (triggeredAttr === null) continue;

    const fieldId = getHtmlAttribute(el, "id");
    const reason = buildReason(el.tagName.toLowerCase(), triggeredAttr, fieldId);
    pushForAllCriteria(candidates, filePath, el.loc.start.line, el.loc.start.column, reason);
  }
}

function isNonFieldHtmlInput(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  const type = getHtmlAttribute(el, "type");
  if (type === null) return false;
  return NON_FIELD_INPUT_TYPES.has(type.toLowerCase());
}

/**
 * Returns the first attribute from `attrs` that is present on the element,
 * or null if none are present.
 */
function firstPresentHtmlAttr(el: HtmlElement, attrs: readonly string[]): string | null {
  for (const attr of attrs) {
    if (hasHtmlAttribute(el, attr)) return attr;
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    // JSX convention: lowercase intrinsic names are native HTML elements.
    // PascalCase components hide their resolved props — we skip those.
    if (!CONSTRAINT_FORM_TAGS.has(el.tagName)) continue;
    if (isNonFieldJsxInput(el)) continue;

    const triggeredAttr = firstPresentJsxAttr(el, CONSTRAINT_ATTRS);
    if (triggeredAttr === null) continue;

    const fieldId = getJsxAttributeString(el, "id");
    const reason = buildReason(el.tagName, triggeredAttr, fieldId);
    pushForAllCriteria(candidates, filePath, el.loc.start.line, el.loc.start.column, reason);
  }
}

function isNonFieldJsxInput(el: JsxElement): boolean {
  if (el.tagName !== "input") return false;
  // Accept both string-literal and expression attribute values for type.
  // For type we only skip when we have a definitive literal — an
  // expression-typed `type={someVar}` is unknown and we keep the candidate.
  const attr = getJsxAttribute(el, "type");
  if (!attr?.value) return false;
  if (attr.value.kind === "StringLiteral") {
    return NON_FIELD_INPUT_TYPES.has((attr.value.value ?? "").toLowerCase());
  }
  // Expression value: strip outer braces and check if it's a plain string
  // literal wrapped in braces like `type={"hidden"}`.
  if (attr.value.kind === "Expression" && attr.value.raw) {
    const raw = attr.value.raw.trim();
    const inner = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1).trim() : raw;
    if (
      (inner.startsWith('"') && inner.endsWith('"')) ||
      (inner.startsWith("'") && inner.endsWith("'"))
    ) {
      return NON_FIELD_INPUT_TYPES.has(inner.slice(1, -1).toLowerCase());
    }
  }
  return false;
}

/**
 * Returns the first attribute from `attrs` that is present on the JSX element,
 * or null if none are present.
 */
function firstPresentJsxAttr(el: JsxElement, attrs: readonly string[]): string | null {
  for (const attr of attrs) {
    if (hasJsxAttribute(el, attr)) return attr;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildReason(tagName: string, triggeredAttr: string, fieldId: string | null): string {
  const idSuffix = fieldId ? ` (id="${fieldId}")` : "";
  const attrNote = constraintAttrNote(triggeredAttr);
  return (
    `<${tagName}>${idSuffix} has ${attrNote} — verify that any validation error is ` +
    "identified in text and programmatically associated with this field " +
    "(aria-describedby pointing at a live error node, or aria-errormessage)"
  );
}

/**
 * Returns a human-readable note about the constraint attribute, naming
 * the attribute and adding a one-phrase framing of the WCAG obligation.
 */
function constraintAttrNote(attr: string): string {
  switch (attr) {
    case "required":
      return "`required` (field must not be empty; missing-field error must be described in text)";
    case "aria-invalid":
      return "`aria-invalid` (author-marked invalid; error description must be programmatically associated)";
    case "pattern":
      return "`pattern` (format constraint; format error must be described in text)";
    case "minlength":
      return "`minlength` (minimum length constraint; length error must be described in text)";
    case "maxlength":
      return "`maxlength` (maximum length constraint; length error must be described in text)";
    case "min":
      return "`min` (minimum value constraint; range error must be described in text)";
    case "max":
      return "`max` (maximum value constraint; range error must be described in text)";
    default:
      return `\`${attr}\` (validation constraint; error must be described in text)`;
  }
}

function pushForAllCriteria(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      // Confidence "high": deterministic attribute check on a native
      // intrinsic element — literal attribute presence, not a heuristic.
      // The agent still verifies the error-message wiring, but the field
      // itself is unambiguously flagged.
      confidence: "high",
    });
  }
}
