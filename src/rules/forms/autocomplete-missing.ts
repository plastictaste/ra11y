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
  htmlTextContent,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import type { FixPaths } from "../../types/violation.ts";
import {
  collectFailingHtmlControls,
  computeHtmlCollapseDecisions,
  computeJsxCollapseDecisions,
  type SiblingInstance,
} from "./_label-sibling-collapse.ts";

/**
 * Tags this rule emits on. Only `<input>` — `<select>` / `<textarea>`
 * carry their own purpose semantics (Input Purposes 1.3.5 enumerates
 * input-typed values); the rule does not flag those today, so the
 * sibling-collapse helper is restricted to the same surface.
 */
const COLLAPSIBLE_TAGS: ReadonlySet<string> = new Set(["input"]);

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
      checkHtml(ctx.ast as HtmlDocument, ctx.source, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, ctx.source, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  fixPaths: FixPaths;
  siblingInstances?: readonly SiblingInstance[];
}) => void;

function checkHtml(doc: HtmlDocument, source: string, emit: Emit): void {
  // Sibling-collapse: when ≥3 direct-child `<input>` siblings under one
  // parent share the same `(tagName, attributes-modulo-id)` fingerprint
  // AND all fail the purpose-vs-autocomplete predicate, emit ONE
  // canonical finding carrying `siblingInstances` instead of N near-
  // identical findings. Mirrors `forms/labels-required` /
  // `forms/placeholder-as-label` so a sign-up form with six
  // `<input type="email">` siblings reads as one row instead of six
  // entries colliding under one `findingId` (the line-text-keyed id
  // recipe collapses bytes-identical line text by design — collapse at
  // emit time keeps the per-cluster id unique and surfaces the per-
  // sibling trail).
  const isFailingHtml = (el: HtmlElement): boolean => htmlInputViolates(el);
  const failingByParent = collectFailingHtmlControls(
    doc,
    COLLAPSIBLE_TAGS,
    isFailingHtml,
    walkHtmlElements,
  );
  const { primary, consumed } = computeHtmlCollapseDecisions(failingByParent);

  for (const input of findHtmlElementsByTag(doc, "input")) {
    if (!htmlInputViolates(input)) continue;
    if (consumed.has(input)) continue;
    // Re-derive the trigger + edit + label at emit time. Cheap on
    // realistic forms (one regex slice + one descendant scan per input)
    // and keeps the predicate path bytes-identical to the emit path.
    const type = (getHtmlAttribute(input, "type") ?? "text").toLowerCase();
    const nameAttr = getHtmlAttribute(input, "name");
    const idAttr = getHtmlAttribute(input, "id");
    const match = matchPurpose(type, nameAttr, idAttr);
    if (!match) continue;
    const edit = buildAutocompleteInsertEditHtml(input, match.expected, source);
    const label = resolveHtmlInputLabel(doc, input);
    emit(buildViolation("input", match, input.loc.start, edit, label, primary.get(input)));
  }
}

/**
 * Predicate the sibling-collapse helper consumes: would the rule emit a
 * finding on this HTML `<input>`? Mirrors the per-element gating in
 * {@link checkHtml} exactly so the collapse pass and the emit pass agree
 * on which inputs are "failing."
 */
function htmlInputViolates(el: HtmlElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  if (hasHtmlAttribute(el, "autocomplete")) return false;
  const type = (getHtmlAttribute(el, "type") ?? "text").toLowerCase();
  const nameAttr = getHtmlAttribute(el, "name");
  const idAttr = getHtmlAttribute(el, "id");
  const roleAttr = getHtmlAttribute(el, "role");
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (isSearchInput(type, roleAttr, nameAttr, idAttr, ariaLabel)) return false;
  return matchPurpose(type, nameAttr, idAttr) !== null;
}

function checkJsx(module: TsxModule, source: string, emit: Emit): void {
  // Sibling-collapse: same shape as the HTML branch — when ≥3 direct-
  // child intrinsic `<input>` siblings share a `(tagName, attributes-
  // modulo-id)` fingerprint AND all fail the purpose-vs-autocomplete
  // predicate, emit ONE canonical finding carrying `siblingInstances`
  // instead of N. Wrappers and polymorphic `<Tag as="input">`
  // resolutions stay out of collapse (the helper opts them out —
  // clusters of those are rare and the fingerprint is less stable
  // across the resolution boundary; per-element emit on those is the
  // safer default).
  const { primary, consumed } = computeJsxCollapseDecisions(module, COLLAPSIBLE_TAGS, (el) =>
    jsxInputViolates(el),
  );

  for (const input of findJsxElementsByTag(module, "input")) {
    if (consumed.has(input)) continue;
    checkJsxInput(input, source, primary.get(input), emit);
  }
}

function checkJsxInput(
  input: JsxElement,
  source: string,
  siblings: readonly SiblingInstance[] | undefined,
  emit: Emit,
): void {
  if (!jsxInputViolates(input)) return;
  const type = (getJsxAttributeString(input, "type") ?? "text").toLowerCase();
  const nameAttr = getJsxAttributeString(input, "name");
  const idAttr = getJsxAttributeString(input, "id");
  const match = matchPurpose(type, nameAttr, idAttr);
  if (!match) return;
  const edit = buildAutocompleteInsertEditJsx(input, match.expected, source);
  const label = resolveJsxInputLabel(input);
  emit(buildViolation("input", match, input.loc.start, edit, label, siblings));
}

/**
 * Predicate the sibling-collapse helper consumes: would the rule emit a
 * finding on this JSX `<input>`? Mirrors {@link htmlInputViolates} on the
 * JSX attribute shape (camelCase `autoComplete` accepted alongside the
 * HTML-spec lowercase `autocomplete`).
 */
function jsxInputViolates(el: JsxElement): boolean {
  if (el.tagName.toLowerCase() !== "input") return false;
  if (hasJsxAttribute(el, "autoComplete") || hasJsxAttribute(el, "autocomplete")) return false;
  const type = (getJsxAttributeString(el, "type") ?? "text").toLowerCase();
  const nameAttr = getJsxAttributeString(el, "name");
  const idAttr = getJsxAttributeString(el, "id");
  const roleAttr = getJsxAttributeString(el, "role");
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (isSearchInput(type, roleAttr, nameAttr, idAttr, ariaLabel)) return false;
  return matchPurpose(type, nameAttr, idAttr) !== null;
}

/**
 * Deterministic mechanical edit: insert `autocomplete="<expected>"`
 * into the input's open tag. The expected value is drawn from
 * {@link EXPECTED_BY_TYPE} / {@link NAME_HEURISTICS} — a closed token
 * set the rule has already resolved before emit, so the edit is
 * strictly "insert one attribute with a known value."
 *
 * The `<tag...>` open-tag regex covers the canonical shapes
 * (`<input type="email" name="email">`, `<input class="…" />`) and
 * refuses any `>` inside attribute quotes. Exotic shapes (HTML
 * conditional comments, attributes with embedded `>` via entities)
 * fall through to `null` and the rule ships guidance — never an edit
 * the find-and-replace could silently apply to the wrong site. See
 */
function buildAutocompleteInsertEditHtml(
  input: HtmlElement,
  expected: string,
  source: string,
): { readonly oldText: string; readonly newText: string } | null {
  return buildOpenTagInsertEdit(input.range.start, input.range.end, source, {
    attrName: "autocomplete",
    attrValue: expected,
    dialect: "html",
  });
}

function buildAutocompleteInsertEditJsx(
  input: JsxElement,
  expected: string,
  source: string,
): { readonly oldText: string; readonly newText: string } | null {
  // JSX opening tags use the same `<tag attrs />` shape as HTML for
  // the literal attribute values this rule cares about; we reuse the
  // same regex-based splitter. When the JSX tag carries
  // `{...spread}` or other non-literal attribute shapes the regex
  // rejects them and the rule ships guidance — correct by
  // construction.
  //
  // The attribute name on React is `autoComplete` (camelCase), not
  // the HTML-spec `autocomplete` — React's DOM property layer expects
  // that casing. We emit camelCase here; the native-HTML parser's
  // `hasJsxAttribute("autocomplete")` check above stays
  // case-insensitive so pre-existing lowercase attributes still
  // suppress the finding.
  return buildOpenTagInsertEdit(input.range.start, input.range.end, source, {
    attrName: "autoComplete",
    attrValue: expected,
    dialect: "jsx",
  });
}

/**
 * Literal open-tag boundary finder used by both HTML and JSX branches.
 * Rather than splitting the tag on a regex (which greedily confused
 * self-closing `/` with attribute whitespace), we walk the raw slice
 * to locate the end of the tag name, then the closing `>`, then insert
 * the new attribute at the boundary *before* any optional `/` and
 * before the `>`.
 *
 * Returns null on quoting shapes we can't safely handle (unbalanced
 * quotes, embedded `>` inside a `{…}` expression that itself contains
 * a template literal with `{` / `}`, etc.). The caller falls through
 * to guidance when null is returned — never emits a wrong edit.
 */
function buildOpenTagInsertEdit(
  startOffset: number,
  endOffset: number,
  source: string,
  params: {
    readonly attrName: string;
    readonly attrValue: string;
    readonly dialect: "html" | "jsx";
  },
): { readonly oldText: string; readonly newText: string } | null {
  const raw = source.slice(startOffset, endOffset);
  const afterTagName = scanTagName(raw);
  if (afterTagName === -1) return null;
  const gtIndex = scanToOpenTagEnd(raw, afterTagName, params.dialect);
  if (gtIndex === -1) return null;
  const insertAt = computeInsertPoint(raw, gtIndex);
  const beforeInsert = raw.slice(0, insertAt);
  const afterInsert = raw.slice(insertAt);
  const attrLiteral = ` ${params.attrName}="${params.attrValue}"`;
  return { oldText: raw, newText: `${beforeInsert}${attrLiteral}${afterInsert}` };
}

/**
 * Returns the byte offset AFTER the tag name in `raw`, assuming raw
 * starts with `<`. Returns -1 when the input does not start with a
 * valid HTML/JSX tag name.
 */
function scanTagName(raw: string): number {
  if (raw.charCodeAt(0) !== 0x3c /* < */) return -1;
  if (raw.length < 2) return -1;
  const firstCh = raw.charCodeAt(1);
  const isAlphaFirst = (firstCh >= 0x41 && firstCh <= 0x5a) || (firstCh >= 0x61 && firstCh <= 0x7a);
  if (!isAlphaFirst) return -1;
  let i = 2;
  while (i < raw.length) {
    const ch = raw.charCodeAt(i);
    const isAlpha = (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a);
    const isDigit = ch >= 0x30 && ch <= 0x39;
    if (!(isAlpha || isDigit)) return i;
    i += 1;
  }
  return -1;
}

/**
 * Walks from `startIndex` through the attribute list until the open-
 * tag's closing `>`, respecting quote and (JSX) brace nesting.
 * Returns the byte offset of the `>` or -1 if we run out of input
 * without finding it / leave a quote or brace unclosed.
 *
 * Keeps the step-by-step logic in {@link advanceOpenTagScanner} so
 * this loop stays trivial.
 */
function scanToOpenTagEnd(raw: string, startIndex: number, dialect: "html" | "jsx"): number {
  const state: OpenTagScanState = {
    index: startIndex,
    inSingle: false,
    inDouble: false,
    braceDepth: 0,
    foundAt: -1,
  };
  while (state.index < raw.length && state.foundAt === -1) {
    advanceOpenTagScanner(raw.charCodeAt(state.index), state, dialect);
    state.index += 1;
  }
  if (state.foundAt === -1) return -1;
  if (state.inSingle || state.inDouble || state.braceDepth > 0) return -1;
  return state.foundAt;
}

interface OpenTagScanState {
  index: number;
  inSingle: boolean;
  inDouble: boolean;
  braceDepth: number;
  foundAt: number;
}

function advanceOpenTagScanner(ch: number, state: OpenTagScanState, dialect: "html" | "jsx"): void {
  if (state.inSingle) {
    if (ch === 0x27) state.inSingle = false;
    return;
  }
  if (state.inDouble) {
    if (ch === 0x22) state.inDouble = false;
    return;
  }
  if (state.braceDepth > 0) {
    state.braceDepth = updateBraceDepth(ch, state.braceDepth, dialect);
    return;
  }
  const next = classifyOpenTagByte(ch, dialect);
  if (next.kind === "gt") state.foundAt = state.index;
  else if (next.kind === "single") state.inSingle = true;
  else if (next.kind === "double") state.inDouble = true;
  else if (next.kind === "brace") state.braceDepth = 1;
}

function updateBraceDepth(ch: number, depth: number, dialect: "html" | "jsx"): number {
  if (dialect !== "jsx") return depth;
  if (ch === 0x7b /* { */) return depth + 1;
  if (ch === 0x7d /* } */) return depth - 1;
  return depth;
}

function classifyOpenTagByte(
  ch: number,
  dialect: "html" | "jsx",
): { readonly kind: "gt" | "single" | "double" | "brace" | "other" } {
  if (ch === 0x3e) return { kind: "gt" };
  if (ch === 0x27) return { kind: "single" };
  if (ch === 0x22) return { kind: "double" };
  if (dialect === "jsx" && ch === 0x7b) return { kind: "brace" };
  return { kind: "other" };
}

/**
 * Insertion point for the new attribute: immediately *after* the last
 * non-whitespace, non-slash byte of the open tag. This lets us place
 * the new attribute before any author-supplied whitespace and before
 * the `/` of a self-closing tag, avoiding doubled spaces on
 * `<input />`-style inputs.
 */
function computeInsertPoint(raw: string, gtIndex: number): number {
  let insertAt = gtIndex;
  if (raw.charCodeAt(insertAt - 1) === 0x2f /* / */) insertAt -= 1;
  while (insertAt > 0 && isAsciiWhitespace(raw.charCodeAt(insertAt - 1))) {
    insertAt -= 1;
  }
  return insertAt;
}

function isAsciiWhitespace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
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
 * doctrine on
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

/**
 * Resolved accessible-name evidence for the input. The agent reads
 * `text` to decide whether the autocomplete token applies — e.g. an
 * input labeled "Recipient email" almost certainly does NOT take
 * `autocomplete="email"` (that token names the user's *own* email,
 * which a recipient field collects from someone else). The `source`
 * field documents WHERE the text came from so the agent can weight
 * its trust accordingly:
 *   - `aria-label`  : explicit author intent, highest trust
 *   - `label-for`   : `<label for="<id>">` matching this input's id
 *   - `wrapping-label` : input is wrapped inside `<label>…</label>`
 *   - `placeholder` : weakest signal (often a format hint, not a name)
 *
 * Per AI-first doctrine ("the tool's job is to point; the agent's
 * job is to investigate"), we don't try to *decide* whether an
 * autocomplete is wrong from the label — we surface the label
 * verbatim so the agent's one-read dismissal is grounded.
 */
interface InputLabelEvidence {
  readonly source: "aria-label" | "label-for" | "wrapping-label" | "placeholder";
  readonly text: string;
}

function resolveHtmlInputLabel(doc: HtmlDocument, input: HtmlElement): InputLabelEvidence | null {
  const fromAria = labelFromAriaLabel(input);
  if (fromAria) return fromAria;
  const fromForAttr = labelFromForAttr(doc, input);
  if (fromForAttr) return fromForAttr;
  const fromWrapping = labelFromWrapping(doc, input);
  if (fromWrapping) return fromWrapping;
  return labelFromPlaceholder(input);
}

function labelFromAriaLabel(input: HtmlElement): InputLabelEvidence | null {
  const value = getHtmlAttribute(input, "aria-label");
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { source: "aria-label", text: trimmed } : null;
}

function labelFromForAttr(doc: HtmlDocument, input: HtmlElement): InputLabelEvidence | null {
  const id = getHtmlAttribute(input, "id");
  if (!id || id.length === 0) return null;
  for (const label of findHtmlElementsByTag(doc, "label")) {
    if (getHtmlAttribute(label, "for") !== id) continue;
    const text = htmlTextContent(label);
    if (text.length > 0) return { source: "label-for", text };
  }
  return null;
}

// Wrapping <label>: walk doc, find any label that has this input as a
// descendant. Cheap on realistic forms — labels are leaf-y and few.
function labelFromWrapping(doc: HtmlDocument, input: HtmlElement): InputLabelEvidence | null {
  for (const label of findHtmlElementsByTag(doc, "label")) {
    if (!containsHtmlElement(label, input)) continue;
    const text = htmlTextContent(label);
    if (text.length > 0) return { source: "wrapping-label", text };
  }
  return null;
}

function labelFromPlaceholder(input: HtmlElement): InputLabelEvidence | null {
  const value = getHtmlAttribute(input, "placeholder");
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? { source: "placeholder", text: trimmed } : null;
}

function containsHtmlElement(root: HtmlElement, target: HtmlElement): boolean {
  for (const descendant of walkHtmlElements(root)) {
    if (descendant === target) return true;
  }
  return false;
}

function resolveJsxInputLabel(input: JsxElement): InputLabelEvidence | null {
  // JSX cross-element label resolution (htmlFor/id matching) requires
  // module-level state — checkJsx already iterates the module, but
  // routing the label-fors set down to here would force a wider
  // signature for a marginal precision gain. The two channels we DO
  // surface (aria-label literal, placeholder literal) are the
  // self-contained ones the agent reads first; the agent cracking the
  // file open recovers the cross-element <label> in one read.
  const ariaLabel = getJsxAttributeString(input, "aria-label");
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return { source: "aria-label", text: ariaLabel.trim() };
  }
  const placeholder = getJsxAttributeString(input, "placeholder");
  if (placeholder && placeholder.trim().length > 0) {
    return { source: "placeholder", text: placeholder.trim() };
  }
  return null;
}

function describeLabel(label: InputLabelEvidence): string {
  const text = truncateForEcho(label.text);
  if (label.source === "aria-label") return `aria-label="${text}"`;
  if (label.source === "label-for") return `labelled "${text}" via <label for=…>`;
  if (label.source === "wrapping-label") return `wrapped by <label>${text}</label>`;
  return `placeholder="${text}"`;
}

function buildViolation(
  tagName: string,
  match: PurposeMatch,
  loc: { line: number; column: number },
  edit: { readonly oldText: string; readonly newText: string } | null,
  label: InputLabelEvidence | null,
  siblings: readonly SiblingInstance[] | undefined,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  fixPaths: FixPaths;
  siblingInstances?: readonly SiblingInstance[];
} {
  // emit `fixPaths.primary.edit`
  // whenever the open-tag regex resolved cleanly so `suggest_fix`
  // returns `kind: "edit"` with a concrete oldText/newText pair. The
  // expected autocomplete token is fully resolved at this point (see
  // `matchPurpose`), so the edit is deterministic. The edit targets the
  // canonical (anchor) sibling on a collapsed finding; the per-sibling
  // line trail on `siblingInstances` tells the agent the same edit
  // shape applies to every other sibling in the cluster.
  const fixPaths: FixPaths = {
    primary: {
      label: `add autocomplete="${match.expected}" to <${tagName}>`,
      ...(edit === null ? {} : { edit }),
    },
    alternatives: [],
  };
  // Interpolate the resolved label so the agent can dismiss in one
  // read: a `type="email"` input labelled "Recipient email" is
  // collecting the recipient's email (not the user's own), so
  // `autocomplete="email"` is the wrong token (likely "off" or a
  // domain-specific value); a `type="email"` input labelled "Your
  // email" is the canonical SC 1.3.5 case where the suggestion
  // applies. Surface the label verbatim per AI-first doctrine — the
  // tool points, the agent decides.
  const labelClause = label ? ` (input ${describeLabel(label)})` : "";
  const recipientHint =
    match.trigger.kind === "type" && match.trigger.value === "email"
      ? ` autocomplete="${match.expected}" applies if this collects the user's own email; if it collects someone else's (e.g. a recipient address), use autocomplete="off" instead.`
      : "";
  const message =
    siblings === undefined
      ? `<${tagName}> appears to collect information about the user but has no autocomplete attribute — ${describeTrigger(match.trigger)}${labelClause}. WCAG 2.2 SC 1.3.5 (AA) requires an autocomplete value drawn from the 53 input-purpose tokens so the field's purpose can be programmatically determined.`
      : buildAutocompleteSiblingCollapsedMessage(tagName, match, siblings.length);
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message,
    suggestion: `Add autocomplete="${match.expected}" so the field's purpose is programmatically determinable per SC 1.3.5.${recipientHint} See https://www.w3.org/TR/WCAG21/#input-purposes for the full list of 53 tokens.`,
    fixPaths,
    ...(siblings === undefined ? {} : { siblingInstances: siblings }),
  };
}

/**
 * Message for the canonical sibling-rollup finding when ≥3 direct-
 * child `<input>` siblings under one parent share a fingerprint and
 * all fail the purpose-vs-autocomplete predicate. Names the cluster
 * shape and the rollup count so an agent reading the message alone
 * knows it is one finding standing in for N siblings — and knows to
 * read `siblingInstances` for the per-sibling line/id trail.
 *
 * The shared `_label-sibling-collapse.ts` helper ships its own
 * collapsed-message builder for `forms/labels-required` (the "no
 * accessible name" framing); this one is rule-specific because the
 * autocomplete antipattern names the resolved purpose token and
 * concedes that the same per-input edit applies to every sibling
 * (unlike labels-required, where a single group-level `<fieldset>` /
 * `role="group"` sometimes covers the whole cluster — autocomplete
 * tokens are always per-input).
 */
function buildAutocompleteSiblingCollapsedMessage(
  tagName: string,
  match: PurposeMatch,
  count: number,
): string {
  const others = count - 1;
  return (
    `<${tagName}> appears to collect information about the user but has no autocomplete attribute` +
    ` — ${describeTrigger(match.trigger)} — and ${others} adjacent sibling ${tagName}` +
    ` element${others === 1 ? "" : "s"} sharing the same parent and the same` +
    ` (tag, attributes-modulo-id) shape are also missing autocomplete (collapsed into one` +
    ` finding; see siblingInstances for the per-sibling line/id trail). WCAG 2.2 SC 1.3.5 (AA)` +
    ` requires an autocomplete value drawn from the 53 input-purpose tokens on every input` +
    ` collecting user information; the same per-input edit (autocomplete="${match.expected}")` +
    ` applies to every sibling in the cluster.`
  );
}
