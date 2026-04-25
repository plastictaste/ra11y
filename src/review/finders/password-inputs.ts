/**
 * Candidate finder: review/password-inputs
 * Criteria: wcag22:3.3.8
 * Spec: https://www.w3.org/TR/WCAG22/#accessible-authentication-minimum
 *
 * Surfaces every `<input type="password">` in the source tree as a review
 * candidate for WCAG 3.3.8 Accessible Authentication (Minimum).
 *
 * WCAG 3.3.8 requires that authentication steps do not rely solely on a
 * cognitive function test — meaning a password field by itself is a yellow
 * flag: the form must offer at least one accessible authentication
 * alternative (passkey / WebAuthn, magic link, copy-paste enabled, biometric
 * bridge, email OTP) or the password field itself must support copy-paste
 * so the user is not forced to memorise or transcribe a sequence of
 * characters.
 *
 * What the finder emits:
 *   - The location of the `<input type="password">` element.
 *   - The field's `id` and `name` attributes (when present) so the agent
 *     can correlate across form elements.
 *   - The names of any sibling `<input>` elements in the same form (both
 *     HTML and JSX), giving the agent the visible auth field set at a glance
 *     without requiring a separate file read.
 *
 * What the agent must verify:
 *   - Whether the form or surrounding page offers an alternative
 *     authentication method that is not a cognitive function test.
 *   - Whether `autocomplete="current-password"` / `autocomplete="new-password"`
 *     is present (enables browser / password-manager autofill — the primary
 *     WCAG 3.3.8 mitigation for pure-password flows).
 *   - Whether the input has `autocomplete="off"` or an OS/UA attribute that
 *     blocks copy-paste, since blocking paste forces transcription.
 *   - Whether a passkey or social-login alternative is rendered on the same
 *     screen or as a clearly signposted option.
 *
 * Per the AI-first consumer model (docs/kb/architecture/ai-first-consumer.md):
 * the scanner points; the agent investigates. We do not suppress on the basis
 * of whether a passkey button "looks present" in the JSX — the agent reads the
 * full file and the auth flow and decides. The reason text carries enough
 * context (sibling input names, autocomplete value if set) for a one-read
 * dismissal when the form is clearly compliant.
 *
 * Confidence: "high". The predicate is deterministic — `type="password"` is a
 * literal attribute value with one semantic. Whether the form satisfies 3.3.8
 * is not deterministic from a static scan; that is what the review obligation
 * exists for.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, HtmlNode, JsxElement, JsxNode, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:3.3.8"] as const;

export const finder = defineCandidateFinder({
  id: "review/password-inputs",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <input type=\"password\"> elements — every password field is a review location for WCAG 3.3.8 Accessible Authentication (Minimum), which forbids sole reliance on a cognitive function test unless an accessible alternative is provided.",
    reviewPrompt:
      "At each candidate, verify that the authentication form offers at least one accessible alternative that does not require a cognitive function test: (1) passkey / WebAuthn button on the same screen or clearly linked; (2) magic-link or OTP option; (3) social login bridged to a non-cognitive authenticator; OR (4) the password field enables copy-paste and has autocomplete=\"current-password\" or \"new-password\" so a password manager can fill it without memorisation. Also check that `autocomplete` is not set to \"off\" and that no JavaScript blocks paste events on the field.",
    references: [
      "https://www.w3.org/TR/WCAG22/#accessible-authentication-minimum",
      "https://www.w3.org/WAI/WCAG22/Understanding/accessible-authentication-minimum.html",
      "https://html.spec.whatwg.org/multipage/form-elements.html#autofill",
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
  // Two-pass approach:
  //   Pass 1: walk the full tree and collect all <form> elements and the
  //           <input> elements within them.
  //   Pass 2: for each <input type="password">, look up its form, emit
  //           a candidate with sibling names.
  const formInputs = new Map<HtmlElement, HtmlElement[]>();
  const inputToForm = new Map<HtmlElement, HtmlElement>();

  collectHtmlFormRelationships(root.children, null, formInputs, inputToForm);

  for (const [inputEl, formEl] of inputToForm) {
    const type = getHtmlAttribute(inputEl, "type");
    if (type?.toLowerCase() !== "password") continue;

    const siblings = collectSiblingNames(inputEl, formInputs.get(formEl) ?? []);
    emitHtmlCandidate(inputEl, filePath, siblings, candidates);
  }

  // Password inputs that are NOT inside any <form> element.
  for (const el of walkHtmlElements(root)) {
    if (el.tagName.toLowerCase() !== "input") continue;
    const type = getHtmlAttribute(el, "type");
    if (type?.toLowerCase() !== "password") continue;
    if (inputToForm.has(el)) continue; // already covered above

    emitHtmlCandidate(el, filePath, [], candidates);
  }
}

function emitHtmlCandidate(
  el: HtmlElement,
  filePath: string,
  siblings: readonly string[],
  candidates: ReviewCandidate[],
): void {
  const fieldId = getHtmlAttribute(el, "id");
  const fieldName = getHtmlAttribute(el, "name");
  const autocomplete = getHtmlAttribute(el, "autocomplete");
  const reason = buildReason(fieldId, fieldName, autocomplete, siblings);

  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
      reason,
      confidence: "high",
    });
  }
}

/**
 * Recursively walks `nodes`, tracking the nearest ancestor `<form>` element.
 * Populates `formInputs` (form → [inputs]) and `inputToForm` (input → form).
 * Nested `<form>` elements (invalid HTML but parseable) are treated as
 * independent form scopes.
 */
function collectHtmlFormRelationships(
  nodes: readonly HtmlNode[],
  currentForm: HtmlElement | null,
  formInputs: Map<HtmlElement, HtmlElement[]>,
  inputToForm: Map<HtmlElement, HtmlElement>,
): void {
  for (const node of nodes) {
    if (node.kind !== "HtmlElement") continue;
    const el = node as HtmlElement;
    const tag = el.tagName.toLowerCase();

    if (tag === "form") {
      // New form scope.
      formInputs.set(el, []);
      collectHtmlFormRelationships(el.children, el, formInputs, inputToForm);
    } else {
      if (tag === "input" && currentForm) {
        const list = formInputs.get(currentForm);
        if (list) list.push(el);
        inputToForm.set(el, currentForm);
      }
      collectHtmlFormRelationships(el.children, currentForm, formInputs, inputToForm);
    }
  }
}

function collectSiblingNames(
  self: HtmlElement,
  allInputs: readonly HtmlElement[],
): readonly string[] {
  const names: string[] = [];
  for (const sibling of allInputs) {
    if (sibling === self) continue;
    const val = getHtmlAttribute(sibling, "name") ?? getHtmlAttribute(sibling, "id");
    if (val) names.push(val);
  }
  return names;
}

// ---------------------------------------------------------------------------
// JSX branch
// ---------------------------------------------------------------------------

function findJsxCandidates(
  root: TsxModule,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  // Build sibling maps for JSX <form> elements.
  const formInputs = new Map<JsxElement, JsxElement[]>();
  const inputToForm = new Map<JsxElement, JsxElement>();

  collectJsxFormRelationships(root.jsxElements, null, formInputs, inputToForm);

  // Emit for password inputs inside a form.
  for (const [inputEl, formEl] of inputToForm) {
    if (!isPasswordType(inputEl)) continue;
    const siblings = collectJsxSiblingNames(inputEl, formInputs.get(formEl) ?? []);
    emitJsxCandidate(inputEl, filePath, siblings, candidates);
  }

  // Password inputs not inside any JSX <form>.
  for (const el of walkJsxElements(root)) {
    if (el.tagName !== "input") continue;
    if (!isPasswordType(el)) continue;
    if (inputToForm.has(el)) continue;
    emitJsxCandidate(el, filePath, [], candidates);
  }
}

function emitJsxCandidate(
  el: JsxElement,
  filePath: string,
  siblings: readonly string[],
  candidates: ReviewCandidate[],
): void {
  const fieldId = getJsxAttributeString(el, "id");
  const fieldName = getJsxAttributeString(el, "name");
  const autocompleteAttr = getJsxAttribute(el, "autocomplete");
  const autocomplete =
    autocompleteAttr?.value?.kind === "StringLiteral"
      ? (autocompleteAttr.value.value ?? null)
      : null;

  const reason = buildReason(fieldId, fieldName, autocomplete, siblings);

  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line: el.loc.start.line, column: el.loc.start.column },
      reason,
      confidence: "high",
    });
  }
}

function isPasswordType(el: JsxElement): boolean {
  const attr = getJsxAttribute(el, "type");
  if (!attr?.value) return false;
  if (attr.value.kind === "StringLiteral") {
    return (attr.value.value ?? "").toLowerCase() === "password";
  }
  if (attr.value.kind === "Expression" && attr.value.raw) {
    const raw = attr.value.raw.trim();
    const inner = raw.startsWith("{") && raw.endsWith("}") ? raw.slice(1, -1).trim() : raw;
    if (
      (inner.startsWith('"') && inner.endsWith('"')) ||
      (inner.startsWith("'") && inner.endsWith("'"))
    ) {
      return inner.slice(1, -1).toLowerCase() === "password";
    }
  }
  return false;
}

/**
 * Recursively walks JSX nodes, tracking the nearest ancestor `<form>` JSX
 * element. Populates `formInputs` (form → [inputs]) and
 * `inputToForm` (input → form).
 *
 * Only intrinsic lowercase elements are considered — PascalCase wrappers
 * hide their resolved props and are skipped.
 */
function collectJsxFormRelationships(
  nodes: readonly JsxNode[],
  currentForm: JsxElement | null,
  formInputs: Map<JsxElement, JsxElement[]>,
  inputToForm: Map<JsxElement, JsxElement>,
): void {
  for (const node of nodes) {
    if (node.kind !== "JsxElement") continue;
    const el = node as JsxElement;
    const tag = el.tagName;

    if (tag === "form") {
      formInputs.set(el, []);
      collectJsxFormRelationships(el.children, el, formInputs, inputToForm);
    } else {
      if (tag === "input" && currentForm) {
        const list = formInputs.get(currentForm);
        if (list) list.push(el);
        inputToForm.set(el, currentForm);
      }
      collectJsxFormRelationships(el.children, currentForm, formInputs, inputToForm);
    }
  }
}

function collectJsxSiblingNames(
  self: JsxElement,
  allInputs: readonly JsxElement[],
): readonly string[] {
  const names: string[] = [];
  for (const sibling of allInputs) {
    if (sibling === self) continue;
    const val =
      getJsxAttributeString(sibling, "name") ?? getJsxAttributeString(sibling, "id");
    if (val) names.push(val);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Builds the reason text for a password input candidate.
 * Encodes:
 *   - The field id/name so the agent can identify it without re-reading.
 *   - The autocomplete value if set, flagging obvious issues.
 *   - The names of sibling inputs in the same form, so the agent can see
 *     the full auth field set at a glance (e.g. a sibling "username" or
 *     "webauthn-assertion" input signals the form shape).
 */
function buildReason(
  fieldId: string | null,
  fieldName: string | null,
  autocomplete: string | null,
  siblings: readonly string[],
): string {
  const parts: string[] = [];

  // Field identity.
  const identity = fieldId ? `id="${fieldId}"` : fieldName ? `name="${fieldName}"` : null;
  parts.push(
    identity
      ? `<input type="password" ${identity}>`
      : "<input type=\"password\">",
  );

  // Autocomplete note — flag if missing or off.
  if (autocomplete) {
    if (autocomplete === "off") {
      parts.push(
        `autocomplete="off" is set — this blocks password-manager autofill and may force the user to memorise credentials`,
      );
    } else {
      parts.push(`autocomplete="${autocomplete}"`);
    }
  } else {
    parts.push(
      "no autocomplete attribute — consider autocomplete=\"current-password\" or \"new-password\" to enable password-manager autofill",
    );
  }

  // Sibling inputs give the agent a quick view of the auth field set.
  if (siblings.length > 0) {
    const sibList = siblings.map((s) => `"${s}"`).join(", ");
    parts.push(`sibling inputs in the same form: ${sibList}`);
  }

  parts.push(
    "verify that the authentication step does not rely solely on a cognitive function test: offer a passkey / WebAuthn alternative, magic link, or ensure copy-paste is not blocked (WCAG 3.3.8)",
  );

  return parts.join(" — ");
}
