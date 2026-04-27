/**
 * Suggestion-text + placeholder-enrichment helpers shared between
 * `forms/labels-required` and the file-size guard. Keeping these out
 * of the rule body lets the rule stay under the 500-effective-line
 * limit while preserving the same finding text.
 *
 * Two-part design:
 *   - `buildSuggestion()` — the main `<label …>…</label>` /
 *     `aria-label=…` mechanical hint, with a placeholder-as-label-copy
 *     substitution when the authored placeholder reads like a noun
 *     phrase (per `isPlaceholderSuitableAsLabel`'s heuristic).
 *   - `getNonEmptyHtmlPlaceholder` / `getNonEmptyJsxPlaceholder` —
 *     read the visible placeholder text the rule passes to
 *     `buildSuggestion` as additive context.
 *
 * The placeholder-suitability heuristic is author-intent only — it
 * NEVER suppresses a finding, just decides whether the default edit's
 * label text comes from the placeholder or from a closed vocabulary
 * keyed off the input's `type`. Per AI-first doctrine ("don't
 * downgrade; surface and annotate"), the placeholder always surfaces
 * verbatim alongside.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

export function buildSuggestion(
  tagName: string,
  type: string | null,
  id: string | null,
  placeholder: string | null,
  adjacentLabelText: string | null = null,
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
  const placeholderTail =
    placeholder === null
      ? ""
      : ` Placeholder text \`"${truncateForEcho(placeholder)}"\` may carry the intent — verify it's accurate before using as label copy.`;
  // Additive context (per AI-first doctrine: "surface and annotate"):
  // when an unassociated `<label>` with usable text exists adjacent to
  // this control under the same parent, surface its visible text
  // verbatim and tell the agent the likely-correct fix is to associate
  // the EXISTING label rather than introducing a new one. We don't
  // substitute it into the base edit — the placement / direction
  // (label-before-input vs input-before-label) is a layout call the
  // agent reading the file is better positioned to make. The
  // immediate-PRECEDING-sibling case is owned by
  // `forms/label-adjacent-unassociated` (which suppresses this rule
  // and ships a mechanical pair); this enrichment fires on the cases
  // that rule doesn't cover (immediate-NEXT sibling, spread-bearing
  // JSX primitives, label with `for=` to a different/dangling id).
  const adjacentTail =
    adjacentLabelText === null
      ? ""
      : ` Note: an unassociated \`<label>${truncateForEcho(adjacentLabelText)}</label>\` exists adjacent to this control with no \`for=\`/\`htmlFor=\` association — if it's intended for this ${tagName}, prefer associating the existing label (add \`id="${idHint}"\` on the ${tagName} and \`for="${idHint}"\`/\`htmlFor="${idHint}"\` on that label) rather than introducing a new one.`;
  return `${base}${placeholderTail}${adjacentTail}`;
}

export function inferLabelFromType(type: string | null): string {
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

/**
 * Returns the non-empty placeholder string on an HTML control, or null
 * when no placeholder is authored / value is empty / whitespace-only.
 * Scope: only `<input>` and `<textarea>` render a visible placeholder;
 * `<select>` does not support the attribute, so we return null there.
 */
export function getNonEmptyHtmlPlaceholder(el: HtmlElement): string | null {
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
export function getNonEmptyJsxPlaceholder(el: JsxElement): string | null {
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

// ---------------------------------------------------------------------------
// Adjacent unassociated `<label>` text — additive context for buildSuggestion
// ---------------------------------------------------------------------------

/**
 * Maximum length to surface from a sibling `<label>`'s visible text.
 * Same ceiling as {@link isPlaceholderSuitableAsLabel} — anything past
 * this is unlikely to be a single descriptive label phrase, and we
 * don't want to flood the suggestion with paragraph-shaped prose.
 */
const ADJACENT_LABEL_TEXT_MAX = 80;

/**
 * Build a `Map<HtmlElement, string>` from each labelable HTML control
 * to the visible text of an unassociated sibling `<label>` under the
 * SAME parent — either the immediately-preceding or immediately-
 * following element sibling (skipping whitespace text and comments).
 *
 * Used by `forms/labels-required` to enrich its prose suggestion with
 * a "consider associating the existing label" note in the cases the
 * sibling rule {@link import("./_label-adjacency.ts")} doesn't already
 * own (immediate-PREV is owned by `forms/label-adjacent-unassociated`
 * via the suppression set; this enrichment fires on immediate-NEXT
 * siblings, on spread-bearing JSX primitives, and on labels with
 * `for=` to a different/dangling id).
 *
 * Excludes labels that already carry `for=` (their visible text isn't
 * the right copy for THIS control's edit — they belong to a different
 * id) and labels that wrap a labelable descendant (implicit-labeling
 * shape, owned by `forms/labels-required`'s own implicit-id channel).
 *
 * Returns the visible text trimmed and truncated to
 * {@link ADJACENT_LABEL_TEXT_MAX}; absent labels and labels with empty
 * text content are omitted from the map (the consumer treats absence
 * as null, per CLAUDE.md §1 "Ambiguous field shapes are dishonest").
 */
export function collectHtmlAdjacentUnassociatedLabelText(
  doc: HtmlDocument,
): ReadonlyMap<HtmlElement, string> {
  const out = new Map<HtmlElement, string>();
  visitHtmlChildrenForAdjacentText(doc.children, out);
  return out;
}

function visitHtmlChildrenForAdjacentText(
  children: readonly HtmlNode[],
  out: Map<HtmlElement, string>,
): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || child.kind !== "HtmlElement") continue;
    if (LABELABLE_TAGS_FOR_ADJ.has(child.tagName.toLowerCase())) {
      const text = findAdjacentHtmlLabelText(children, i);
      if (text !== null) out.set(child, text);
    }
    visitHtmlChildrenForAdjacentText(child.children, out);
  }
}

const LABELABLE_TAGS_FOR_ADJ: ReadonlySet<string> = new Set(["input", "select", "textarea"]);

/**
 * Walk siblings on either side of `index` (skipping whitespace text and
 * comments) and return the first unassociated `<label>`'s visible text,
 * or null when none is adjacent. We check the immediately-preceding
 * element first, then the immediately-following one — preceding siblings
 * are the conventional layout (label above input).
 */
function findAdjacentHtmlLabelText(children: readonly HtmlNode[], index: number): string | null {
  const prev = findHtmlAdjacentLabelInDirection(children, index, -1);
  if (prev !== null) return prev;
  return findHtmlAdjacentLabelInDirection(children, index, +1);
}

function findHtmlAdjacentLabelInDirection(
  children: readonly HtmlNode[],
  index: number,
  step: -1 | 1,
): string | null {
  for (let i = index + step; i >= 0 && i < children.length; i += step) {
    const sibling = children[i];
    if (!sibling) return null;
    const decision = inspectHtmlSibling(sibling);
    if (decision.kind === "stop") return null;
    if (decision.kind === "match") return decision.text;
    // decision.kind === "skip": comment / whitespace text — keep walking.
  }
  return null;
}

type SiblingDecision = { kind: "stop" } | { kind: "skip" } | { kind: "match"; text: string };

function inspectHtmlSibling(sibling: HtmlNode): SiblingDecision {
  if (sibling.kind === "HtmlElement") return inspectHtmlSiblingElement(sibling);
  if (sibling.kind === "HtmlText") {
    // Non-whitespace prose between control and label weakens the
    // visual association — same call `_label-adjacency.ts` makes.
    return sibling.value.trim().length > 0 ? { kind: "stop" } : { kind: "skip" };
  }
  // Comments and doctype nodes are render-invisible; keep walking.
  return { kind: "skip" };
}

function inspectHtmlSiblingElement(sibling: HtmlElement): SiblingDecision {
  if (sibling.tagName.toLowerCase() !== "label") return { kind: "stop" };
  // Skip labels that already carry `for=` — their text belongs to
  // a different control's id, not this one's. Skip labels that
  // wrap a labelable descendant — that's an implicit-labeling shape
  // and the wrapped control isn't this one.
  if (hasHtmlAttribute(sibling, "for")) return { kind: "stop" };
  if (htmlLabelWrapsLabelable(sibling)) return { kind: "stop" };
  const text = htmlTextContent(sibling);
  if (text.length === 0) return { kind: "stop" };
  const truncated =
    text.length > ADJACENT_LABEL_TEXT_MAX ? `${text.slice(0, ADJACENT_LABEL_TEXT_MAX)}…` : text;
  return { kind: "match", text: truncated };
}

function htmlLabelWrapsLabelable(label: HtmlElement): boolean {
  for (const descendant of walkHtmlElements(label)) {
    if (LABELABLE_TAGS_FOR_ADJ.has(descendant.tagName.toLowerCase())) return true;
  }
  return false;
}

/**
 * JSX equivalent of {@link collectHtmlAdjacentUnassociatedLabelText}.
 * See that helper for the contract; this one walks JSX nodes (treating
 * the module's top-level roots as a synthetic sibling array so a
 * fragment like `<><input/><label>X</label></>` still matches).
 */
export function collectJsxAdjacentUnassociatedLabelText(
  module: TsxModule,
): ReadonlyMap<JsxElement, string> {
  const out = new Map<JsxElement, string>();
  const roots = module.jsxElements;
  for (let i = 0; i < roots.length; i += 1) {
    const root = roots[i];
    if (!root) continue;
    if (LABELABLE_TAGS_FOR_ADJ.has(root.tagName.toLowerCase())) {
      const text = findAdjacentJsxLabelText(roots, i);
      if (text !== null) out.set(root, text);
    }
    visitJsxChildrenForAdjacentText(root.children, out);
  }
  return out;
}

function visitJsxChildrenForAdjacentText(
  children: readonly JsxNode[],
  out: Map<JsxElement, string>,
): void {
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || child.kind !== "JsxElement") continue;
    if (LABELABLE_TAGS_FOR_ADJ.has(child.tagName.toLowerCase())) {
      const text = findAdjacentJsxLabelText(children, i);
      if (text !== null) out.set(child, text);
    }
    visitJsxChildrenForAdjacentText(child.children, out);
  }
}

function findAdjacentJsxLabelText(children: readonly JsxNode[], index: number): string | null {
  const prev = findJsxAdjacentLabelInDirection(children, index, -1);
  if (prev !== null) return prev;
  return findJsxAdjacentLabelInDirection(children, index, +1);
}

function findJsxAdjacentLabelInDirection(
  children: readonly JsxNode[],
  index: number,
  step: -1 | 1,
): string | null {
  for (let i = index + step; i >= 0 && i < children.length; i += step) {
    const sibling = children[i];
    if (!sibling) return null;
    const decision = inspectJsxSibling(sibling);
    if (decision.kind === "stop") return null;
    if (decision.kind === "match") return decision.text;
  }
  return null;
}

function inspectJsxSibling(sibling: JsxNode): SiblingDecision {
  if (sibling.kind === "JsxElement") return inspectJsxSiblingElement(sibling);
  if (sibling.kind === "JsxText") {
    return sibling.value.trim().length > 0 ? { kind: "stop" } : { kind: "skip" };
  }
  // Opaque expression child — same call `_label-adjacency.ts` makes;
  // we can't prove what renders between input and label.
  return { kind: "stop" };
}

function inspectJsxSiblingElement(sibling: JsxElement): SiblingDecision {
  // Lowercase `<label>` only — `<Label>` is a wrapper component
  // whose render shape we can't see into. Same call
  // `_label-adjacency.ts` makes.
  if (sibling.tagName !== "label") return { kind: "stop" };
  if (hasJsxAttribute(sibling, "htmlFor") || hasJsxAttribute(sibling, "for")) {
    return { kind: "stop" };
  }
  if (jsxLabelWrapsLabelable(sibling)) return { kind: "stop" };
  const text = jsxTextContent(sibling);
  if (text.length === 0) return { kind: "stop" };
  const truncated =
    text.length > ADJACENT_LABEL_TEXT_MAX ? `${text.slice(0, ADJACENT_LABEL_TEXT_MAX)}…` : text;
  return { kind: "match", text: truncated };
}

function jsxLabelWrapsLabelable(label: JsxElement): boolean {
  for (const child of walkJsxElementsForAdjacent(label)) {
    if (LABELABLE_TAGS_FOR_ADJ.has(child.tagName.toLowerCase())) return true;
  }
  return false;
}

function* walkJsxElementsForAdjacent(root: JsxElement): Iterable<JsxElement> {
  for (const child of root.children) {
    if (child.kind === "JsxElement") {
      yield child;
      yield* walkJsxElementsForAdjacent(child);
    }
  }
}
