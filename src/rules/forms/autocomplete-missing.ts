/**
 * Rule: forms/autocomplete-missing
 * Satisfies: wcag22:1.3.5, wcag21:1.3.5
 * Spec: https://www.w3.org/TR/WCAG22/#identify-input-purpose
 *
 * > The purpose of each input field collecting information about the
 * > user can be programmatically determined when:
 * >   - The input field serves a purpose identified in the Input
 * >     Purposes for User Interface Components section; and
 * >   - The content is implemented using technologies with support
 * >     for identifying the expected meaning for form input data.
 *
 * Source: https://www.w3.org/TR/WCAG22/#identify-input-purpose
 *
 * Flags inputs whose `type` or `name`/`id` strongly imply a WCAG 2.1
 * input purpose but that lack an `autocomplete` attribute. Autocomplete
 * values like `email`, `tel`, `name`, `street-address`, `postal-code`
 * let password managers, autofill, and symbol-based input aids do
 * their job — which helps users with cognitive disabilities massively.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Maps a lowercase input `type` to the autocomplete token we expect.
 * Non-personal types (checkbox, button, submit, hidden, etc.) are
 * omitted — autocomplete doesn't apply to them.
 */
const EXPECTED_BY_TYPE: ReadonlyMap<string, string> = new Map([
  ["email", "email"],
  ["tel", "tel"],
  ["url", "url"],
  ["password", "current-password"],
]);

/**
 * Tokens (post-normalization — lowercased, camelCase split, non-letters
 * collapsed to delimiters) that identify a free-form site-search input.
 * WCAG 1.3.5 Input Purposes enumerates 53 autocomplete tokens and
 * "search" is not one of them: a site-search box is out of scope for
 * the criterion, so the rule must not fire on it. This is
 * spec-correctness, not heuristic suppression — see
 * docs/kb/architecture/ai-first-consumer.md ("No heuristic suppression"
 * applies when the criterion DOES apply and evidence is thin; here the
 * criterion does not apply at all).
 */
const SEARCH_TOKENS: ReadonlySet<string> = new Set(["search", "searchbox", "query", "q"]);

/**
 * Fallback: when `type` is text/empty, infer purpose from the name or
 * id attribute. Matched as a contains check against lowercase.
 */
const NAME_HEURISTICS: readonly { readonly needle: string; readonly token: string }[] = [
  { needle: "firstname", token: "given-name" },
  { needle: "first_name", token: "given-name" },
  { needle: "lastname", token: "family-name" },
  { needle: "last_name", token: "family-name" },
  { needle: "fullname", token: "name" },
  { needle: "full_name", token: "name" },
  { needle: "username", token: "username" },
  { needle: "email", token: "email" },
  { needle: "phone", token: "tel" },
  { needle: "mobile", token: "tel" },
  { needle: "postalcode", token: "postal-code" },
  { needle: "postal_code", token: "postal-code" },
  { needle: "zipcode", token: "postal-code" },
  { needle: "zip_code", token: "postal-code" },
  { needle: "country", token: "country-name" },
  { needle: "city", token: "address-level2" },
  { needle: "street", token: "street-address" },
  { needle: "address", token: "street-address" },
];

export const rule = defineRule({
  id: "forms/autocomplete-missing",
  satisfies: ["wcag22:1.3.5", "wcag21:1.3.5"],
  severity: "warning",
  scope: "node",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Input fields collecting information about the user must declare an autocomplete value drawn from WCAG's 53 input-purpose tokens so the field's purpose can be programmatically determined (WCAG 2.2 SC 1.3.5, Level AA).",
    rationale:
      'SC 1.3.5 Identify Input Purpose is Level AA and conformance-mandatory for every input field collecting information about the user. The normative requirement is that the purpose can be programmatically determined via the `autocomplete` attribute, using one of the 53 tokens enumerated in the WCAG 2.1 Input Purposes for User Interface Components section (`name`, `given-name`, `family-name`, `email`, `tel`, `street-address`, `postal-code`, `country`, `bday`, `current-password`, and so on). Password managers, symbol-based input aids, and browser autofill all depend on these tokens to identify a field — users with cognitive disabilities rely on those aids heavily, so an unlabelled email field turns a one-tap autofill into a manual re-entry. "Should" understates the normative weight: if a field collects a purpose on the SC 1.3.5 list, the `autocomplete` attribute is required.',
    goodExample: `<input type="email" name="email" autocomplete="email">`,
    badExample: `<input type="email" name="email">`,
    normativeQuote:
      "The purpose of each input field collecting information about the user can be programmatically determined when: (1) The input field serves a purpose identified in the Input Purposes for User Interface Components section; and (2) The content is implemented using technologies with support for identifying the expected meaning for form input data.",
    references: [
      "https://www.w3.org/TR/WCAG22/#identify-input-purpose",
      "https://www.w3.org/TR/WCAG21/#input-purposes",
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

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const input of findHtmlElementsByTag(doc, "input")) {
    if (hasHtmlAttribute(input, "autocomplete")) continue;
    const type = (getHtmlAttribute(input, "type") ?? "text").toLowerCase();
    const nameAttr = getHtmlAttribute(input, "name");
    const idAttr = getHtmlAttribute(input, "id");
    const roleAttr = getHtmlAttribute(input, "role");
    const ariaLabel = getHtmlAttribute(input, "aria-label");
    if (isSearchInput(type, roleAttr, nameAttr, idAttr, ariaLabel)) continue;
    const match = matchPurpose(type, nameAttr, idAttr);
    if (!match) continue;
    emit(buildViolation("input", match, input.loc.start));
  }
}

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const input of findJsxElementsByTag(module, "input")) {
    checkJsxInput(input, emit);
  }
}

function checkJsxInput(input: JsxElement, emit: Emit): void {
  if (hasJsxAttribute(input, "autoComplete") || hasJsxAttribute(input, "autocomplete")) return;
  const type = (getJsxAttributeString(input, "type") ?? "text").toLowerCase();
  const nameAttr = getJsxAttributeString(input, "name");
  const idAttr = getJsxAttributeString(input, "id");
  const roleAttr = getJsxAttributeString(input, "role");
  const ariaLabel = getJsxAttributeString(input, "aria-label");
  if (isSearchInput(type, roleAttr, nameAttr, idAttr, ariaLabel)) return;
  const match = matchPurpose(type, nameAttr, idAttr);
  if (!match) return;
  emit(buildViolation("input", match, input.loc.start));
}

/**
 * Result of deciding an input needs autocomplete — carries the
 * expected token plus the specific evidence (trigger attribute +
 * value) that fired. The trigger is surfaced verbatim in the
 * violation message so consumers can dismiss fixture-shaped inputs
 * (e.g. `name="floatingInput"`) without cracking the rule open.
 */
interface PurposeMatch {
  readonly expected: string;
  readonly trigger: TriggerEvidence;
}

type TriggerEvidence =
  | { readonly kind: "type"; readonly value: string }
  | { readonly kind: "name" | "id"; readonly attrValue: string; readonly matchedToken: string };

function matchPurpose(
  type: string,
  nameAttr: string | null | undefined,
  idAttr: string | null | undefined,
): PurposeMatch | null {
  // Type is the more concrete signal — prefer it when both fire.
  const fromType = EXPECTED_BY_TYPE.get(type);
  if (fromType) {
    return { expected: fromType, trigger: { kind: "type", value: type } };
  }
  // type="search" is handled earlier by isSearchInput; only text-typed
  // (or type-omitted) inputs reach the name/id heuristics below.
  if (type !== "text" && type !== "") return null;
  const fromName = matchNameHeuristic(nameAttr);
  if (fromName) {
    return {
      expected: fromName.token,
      trigger: { kind: "name", attrValue: nameAttr ?? "", matchedToken: fromName.needle },
    };
  }
  const fromId = matchNameHeuristic(idAttr);
  if (fromId) {
    return {
      expected: fromId.token,
      trigger: { kind: "id", attrValue: idAttr ?? "", matchedToken: fromId.needle },
    };
  }
  return null;
}

function matchNameHeuristic(
  value: string | null | undefined,
): { readonly needle: string; readonly token: string } | null {
  if (!value) return null;
  const lowered = value.toLowerCase().replace(/[^a-z_]/g, "");
  for (const heuristic of NAME_HEURISTICS) {
    if (lowered.includes(heuristic.needle)) return heuristic;
  }
  return null;
}

/**
 * Returns true when the input declares itself as a free-form site-
 * search control. Any of the following signals is sufficient:
 *
 *   - `type="search"` (the native search type; WCAG Input Purposes
 *     has no "search" token so the criterion does not apply)
 *   - `role="searchbox"` (ARIA-declared search semantics)
 *   - `name`, `id`, or `aria-label` normalizes to a token set
 *     containing `search`, `searchbox`, `query`, or `q`
 *
 * Token matching uses `tokenizeIdentifier` so camelCase
 * (`searchInput`), kebab-case (`search-input`), snake_case
 * (`search_input`), and space-separated labels (`aria-label="Search
 * users"`) all split cleanly. The standalone `q` branch catches the
 * canonical `<input name="q">` search shape without matching every
 * identifier that happens to contain the letter q — per the
 * Q5-POINTER-GESTURES-SUBSTRING-FALSE-POSITIVE doctrine on
 * word-boundary identifier matching.
 */
function isSearchInput(
  type: string,
  role: string | null | undefined,
  nameAttr: string | null | undefined,
  idAttr: string | null | undefined,
  ariaLabel: string | null | undefined,
): boolean {
  if (type === "search") return true;
  if (role !== null && role !== undefined && role.trim().toLowerCase() === "searchbox") return true;
  if (containsSearchToken(nameAttr)) return true;
  if (containsSearchToken(idAttr)) return true;
  if (containsSearchToken(ariaLabel)) return true;
  return false;
}

function containsSearchToken(value: string | null | undefined): boolean {
  if (!value) return false;
  for (const token of tokenizeIdentifier(value)) {
    if (SEARCH_TOKENS.has(token)) return true;
  }
  return false;
}

/**
 * Splits `value` into lowercased alphabetic tokens, treating camelCase
 * transitions (`searchBox` → `search`, `box`), non-letters
 * (`search-input`, `search_input`, `search input`), and digits as
 * token boundaries. The output never contains empty tokens.
 */
function tokenizeIdentifier(value: string): readonly string[] {
  const camelSplit = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return camelSplit
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((tok) => tok.length > 0);
}

function describeTrigger(trigger: TriggerEvidence): string {
  if (trigger.kind === "type") {
    return `type="${trigger.value}" triggered the personal-info heuristic`;
  }
  return `${trigger.kind} "${trigger.attrValue}" matched the personal-info heuristic on token "${trigger.matchedToken}"`;
}

function buildViolation(
  tagName: string,
  match: PurposeMatch,
  loc: { line: number; column: number },
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<${tagName}> appears to collect information about the user but has no autocomplete attribute — ${describeTrigger(match.trigger)}. WCAG 2.2 SC 1.3.5 (AA) requires an autocomplete value drawn from the 53 input-purpose tokens so the field's purpose can be programmatically determined.`,
    suggestion: `Add autocomplete="${match.expected}" so the field's purpose is programmatically determinable per SC 1.3.5. See https://www.w3.org/TR/WCAG21/#input-purposes for the full list of 53 tokens.`,
  };
}
