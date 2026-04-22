/**
 * Reason-text enrichment helpers for `review/images-of-text` — detects
 * the "visually-hidden text sibling" and "parent aria-label" dismissal
 * signals. Lives in its own module so the main finder stays under the
 * file-line budget.
 *
 * Per the AI-first consumer model
 * (docs/kb/architecture/ai-first-consumer.md — "Enrich reason with
 * dismissal signal; keep candidate in the primary list"), these hints
 * are additive reason-text suffixes only. No suppression, no
 * confidence change, no bucket move — the candidate still surfaces for
 * every criterion in the 1.4.5 / 1.4.9 family, and the agent reads the
 * file to confirm whether the sibling genuinely carries the textual
 * equivalent.
 */

import { getHtmlAttribute, getJsxAttribute } from "../../engine/ast-helpers.ts";
import type {
  HtmlElement,
  HtmlNode,
  JsxAttributeValue,
  JsxElement,
  JsxNode,
} from "../../types/ast.ts";

/**
 * Class tokens AT / screen-reader conventions use to mark a
 * visually-hidden textual equivalent. When the flagged `<img>` shares
 * a parent (typically an `<a>`) with an element carrying one of these
 * tokens, the repo is carrying the rendered text as a genuine SR-only
 * equivalent alongside the baked-in image — the documented logotype
 * pattern (Bootstrap's `.visually-hidden`, Tailwind's `.sr-only`).
 * The token is NOT evidence the image isn't an image-of-text; it's
 * evidence a text equivalent already exists, which is a dismissal
 * signal the agent uses to triage. Per doctrine, the candidate still
 * surfaces at the same confidence; only the reason text is enriched.
 */
const SR_ONLY_CLASS_TOKENS: readonly string[] = [
  "sr-only",
  "visually-hidden",
  "visuallyhidden",
  "screen-reader-only",
  "screen-reader-text",
  "screenreader-text",
  "u-sr-only",
  "u-visually-hidden",
];

interface SrOnlyEvidence {
  // Mutable-by-design: the collector populates both fields as it walks
  // the sibling tree; the formatter reads the final shape. Keeping
  // them mutable avoids per-sibling array reallocation without
  // widening the type beyond the collect+format pair of call-sites.
  classTokens: string[];
  parentAriaLabel: boolean;
}

/**
 * Builds the reason-text hint for HTML images whose parent element
 * carries `aria-label`, or whose sibling list includes an element (or
 * a descendant of a sibling) with a visually-hidden class token.
 *
 * Returns null when no dismissal evidence is present, so the caller
 * can skip the suffix entirely (present-when-meaningful per doctrine).
 */
export function htmlSrOnlySiblingHint(
  siblings: readonly HtmlNode[],
  index: number,
  parentElement: HtmlElement | null,
): string | null {
  const evidence: SrOnlyEvidence = { classTokens: [], parentAriaLabel: false };
  for (let cursor = 0; cursor < siblings.length; cursor++) {
    if (cursor === index) continue;
    const sibling = siblings[cursor];
    if (sibling?.kind !== "HtmlElement") continue;
    const token = findSrOnlyClassTokenInHtmlTree(sibling);
    if (token) addClassToken(evidence.classTokens, token);
  }
  if (parentElement && getHtmlAttribute(parentElement, "aria-label") !== null) {
    evidence.parentAriaLabel = true;
  }
  return formatSrOnlyHint(evidence);
}

/**
 * JSX counterpart to {@link htmlSrOnlySiblingHint}. Only inspects JSX
 * attributes that resolve to a literal string; dynamic-expression
 * class bindings (`className={cx("sr-only", x)}`) are not recognized
 * on purpose — reaching for more than literals here duplicates the
 * capability the consuming agent already has (read the file, see the
 * binding). Per doctrine we point; the agent investigates.
 */
export function jsxSrOnlySiblingHint(
  siblings: readonly JsxNode[] | null,
  index: number,
  parentElement: JsxElement | null,
): string | null {
  const evidence: SrOnlyEvidence = { classTokens: [], parentAriaLabel: false };
  if (siblings && index >= 0) {
    for (let cursor = 0; cursor < siblings.length; cursor++) {
      if (cursor === index) continue;
      const sibling = siblings[cursor];
      if (sibling?.kind !== "JsxElement") continue;
      const token = findSrOnlyClassTokenInJsxTree(sibling);
      if (token) addClassToken(evidence.classTokens, token);
    }
  }
  if (parentElement && literalJsxAttribute(parentElement, "aria-label") !== null) {
    evidence.parentAriaLabel = true;
  }
  return formatSrOnlyHint(evidence);
}

function findSrOnlyClassTokenInHtmlTree(element: HtmlElement): string | null {
  const self = matchSrOnlyClassToken(getHtmlAttribute(element, "class"));
  if (self) return self;
  for (const child of element.children) {
    if (child.kind !== "HtmlElement") continue;
    const nested = findSrOnlyClassTokenInHtmlTree(child);
    if (nested) return nested;
  }
  return null;
}

function findSrOnlyClassTokenInJsxTree(element: JsxElement): string | null {
  const raw = literalJsxAttribute(element, "className") ?? literalJsxAttribute(element, "class");
  const self = matchSrOnlyClassToken(raw);
  if (self) return self;
  for (const child of element.children) {
    if (child.kind !== "JsxElement") continue;
    const nested = findSrOnlyClassTokenInJsxTree(child);
    if (nested) return nested;
  }
  return null;
}

function matchSrOnlyClassToken(classValue: string | null): string | null {
  if (classValue === null) return null;
  const tokens = classValue.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    if (SR_ONLY_CLASS_TOKENS.includes(token)) return token;
  }
  return null;
}

function addClassToken(list: string[], token: string): void {
  if (!list.includes(token)) list.push(token);
}

function formatSrOnlyHint(evidence: SrOnlyEvidence): string | null {
  const classFragment = formatClassTokenFragment(evidence.classTokens);
  if (!(classFragment || evidence.parentAriaLabel)) return null;
  const parts: string[] = [];
  if (classFragment) {
    parts.push(`a visually-hidden text sibling (${classFragment}) is present in the same parent`);
  }
  if (evidence.parentAriaLabel) {
    parts.push("the parent element carries an `aria-label` attribute");
  }
  return `(note: ${parts.join(" and ")} — if the image is the textual logotype and the sibling is the SR-accessible equivalent, this is the documented logotype pattern; verify and, if genuinely exempt, disable at the source with a \`ra11y-disable wcag22:1.4.5\` pragma.)`;
}

function formatClassTokenFragment(tokens: readonly string[]): string | null {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `\`.${t}\``).join(" / ");
}

/**
 * Local copy of the literal-JSX-attribute resolver used by several
 * review finders. Matches the shape of the same helper in
 * `images-of-text.ts`, `redundant-entry.ts`, `server-error-untied.ts`,
 * and `error-suggestion.ts` — the finders intentionally avoid pulling
 * a shared helper module for such a small primitive. See those files
 * for the pattern.
 */
function literalJsxAttribute(element: JsxElement, name: string): string | null {
  const attr = getJsxAttribute(element, name);
  if (!attr?.value) return null;
  return jsxLiteralString(attr.value);
}

function jsxLiteralString(value: JsxAttributeValue): string | null {
  if (value.kind === "StringLiteral") return value.value;
  const trimmed = value.raw.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (
    (inner.startsWith('"') && inner.endsWith('"')) ||
    (inner.startsWith("'") && inner.endsWith("'"))
  ) {
    return inner.slice(1, -1);
  }
  return null;
}
