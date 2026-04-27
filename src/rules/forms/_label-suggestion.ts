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
  truncateForEcho,
} from "../../engine/ast-helpers.ts";
import type { HtmlElement, JsxElement } from "../../types/ast.ts";

export function buildSuggestion(
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
