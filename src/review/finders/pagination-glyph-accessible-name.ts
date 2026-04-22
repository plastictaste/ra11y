/**
 * Candidate finder: review/pagination-glyph-accessible-name
 * Criteria: wcag22:2.4.4, wcag21:2.4.4, wcag22:4.1.2, wcag21:4.1.2
 * Spec (Link Purpose In Context): https://www.w3.org/TR/WCAG22/#link-purpose-in-context
 * Spec (Name, Role, Value):        https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * Flags pagination-style anchors whose sole visible text is one of the
 * four chevron/guillemet glyphs used to indicate previous/next navigation:
 *
 *   «  (U+00AB)   — left-pointing double angle quote      (also &laquo;)
 *   »  (U+00BB)   — right-pointing double angle quote     (also &raquo;)
 *   ‹  (U+2039)   — single left-pointing angle quote      (also &lsaquo;)
 *   ›  (U+203A)   — single right-pointing angle quote     (also &rsaquo;)
 *
 * When these appear inside an `<a>` with no `aria-label`,
 * `aria-labelledby`, `title`, or visually-hidden child expanding the
 * direction into words (e.g. "Previous page"), screen readers either
 * announce the glyph as punctuation ("left-pointing double angle
 * quotation mark") or skip it entirely — in both cases the link carries
 * no accessible name identifying its destination.
 *
 * Example (Jekyll's `_docs/pagination.md`):
 *   <a href="page-1.html">«</a>   <!-- needs aria-label="Previous page" -->
 *   <a href="page-3.html">»</a>   <!-- needs aria-label="Next page" -->
 *
 * Distinct from `navigation/link-descriptive-text`:
 *   - The generic-phrase path of that rule catches text like "Click
 *     here" / "Read more"; a single glyph isn't in that dictionary
 *     (and adding it would over-match non-pagination uses — a `«` in
 *     running prose isn't a failing link).
 *   - The icon-only path of that rule fires when every child is
 *     presentational (icon-font span, decorative <img>,
 *     `aria-hidden` subtree). A bare glyph character is a plain text
 *     node, so the icon-only check — which looks for empty stripped
 *     text — sees the glyph and passes.
 * The pagination-glyph case sits in the gap: visible text exists, but
 * the text is a punctuation glyph that assistive tech cannot use as a
 * destination name. A reviewer confirms whether the context (visible
 * pagination widget, ordered list of page links) carries the meaning
 * or whether an `aria-label` is missing.
 *
 * Review finder — the four-glyph set is conservative on purpose. Per
 * the AI-first consumer model, the matched glyph is echoed in the
 * `reason` so the agent can triage in one read.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:2.4.4", "wcag21:2.4.4", "wcag22:4.1.2", "wcag21:4.1.2"] as const;

/**
 * Decoded pagination glyphs. Raw characters and decimal/hex numeric
 * entities (`&#187;`, `&#xBB;`) are decoded by the HTML parser at
 * read time, so text nodes arrive here as the literal codepoint. The
 * named entities (`&laquo;` / `&raquo;` / `&lsaquo;` / `&rsaquo;`)
 * are NOT in the parser's named-entity table, so they survive as
 * literal `&laquo;`-style strings — see `NAMED_ENTITY_MAP` below.
 */
const GLYPHS: ReadonlySet<string> = new Set(["«", "»", "‹", "›"]);

/**
 * Named-entity shorthands for the four glyphs we care about. We do
 * not extend the HTML parser's global named-entity table here: that
 * would affect every text-consuming rule on the project, and the
 * tight four-glyph scope of this finder doesn't warrant a cross-
 * cutting change. Local decoding only.
 */
const NAMED_ENTITY_MAP: Readonly<Record<string, string>> = {
  "&laquo;": "«",
  "&raquo;": "»",
  "&lsaquo;": "‹",
  "&rsaquo;": "›",
};

/** JSX tags that represent a link. Mirrors the set used by `link-descriptive-text`. */
const JSX_LINK_TAGS: ReadonlySet<string> = new Set(["a", "Link", "NavLink", "Anchor"]);

/**
 * Class tokens that mark a descendant as visually hidden but present
 * to AT. If such a descendant carries any text, the anchor has an
 * accessible name that expands the glyph's meaning — the finder stays
 * silent. Mirrors `SR_ONLY_TOKENS` in `color/meaning-by-color-only.ts`.
 */
const SR_ONLY_TOKENS: ReadonlySet<string> = new Set([
  "sr-only",
  "visually-hidden",
  "visuallyhidden",
  "screen-reader-only",
  "screenreader-only",
  "sr-only-focusable",
  "visually-hidden-focusable",
]);

export const finder = defineCandidateFinder({
  id: "review/pagination-glyph-accessible-name",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <a> anchors whose sole visible text is a pagination glyph (« / » / ‹ / ›) without aria-label, aria-labelledby, title, or a visually-hidden descendant expanding the direction into words.",
    reviewPrompt:
      'Verify that the link\'s destination is conveyed by something other than the glyph itself. Screen readers announce « / » / ‹ / › as punctuation (or skip them) — if the anchor is a previous/next pagination control, add aria-label="Previous page" / aria-label="Next page" (or aria-label="Previous"/"Next" if that reads better) or include a visually-hidden span inside the link expanding the glyph into words. If the surrounding context (numbered pagination list, visible "Page N of M" label) already names the destination, that alternative name must be programmatically associated (aria-labelledby) — a sighted-only convention isn\'t enough.',
    references: [
      "https://www.w3.org/TR/WCAG22/#link-purpose-in-context",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA7",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA8",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, ctx.wrappersForElement, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const a of findHtmlElementsByTag(root, "a")) {
    if (hasAccessibleNameOverrideHtml(a)) continue;
    const glyph = soleGlyphTextHtml(a);
    if (!glyph) continue;
    if (hasSrOnlyDescendantWithTextHtml(a)) continue;
    pushCandidates(candidates, filePath, a.loc.start.line, a.loc.start.column, glyph);
  }
}

/**
 * Returns the matched glyph IFF the anchor's visible text (collapsed,
 * with our four named entities locally decoded) is exactly one
 * pagination glyph. Returns null when text is empty, longer than a
 * single glyph, or not one of the four.
 */
function soleGlyphTextHtml(a: HtmlElement): string | null {
  const text = htmlVisibleTextFlat(a);
  return matchGlyph(text);
}

function htmlVisibleTextFlat(a: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      chunks.push(node.value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    // A visually-hidden descendant with any text contributes a real
    // accessible name; the anchor is NOT a bare glyph. We don't add
    // its text here — the `hasSrOnlyDescendantWithTextHtml` gate below
    // is the canonical exclusion path — but we do skip walking into
    // it so an `sr-only` span holding, say, "«" itself doesn't
    // contribute a second glyph that breaks the sole-glyph test.
    if (isSrOnlyHtml(node)) return;
    for (const child of node.children) visit(child);
  };
  for (const child of a.children) visit(child);
  return chunks.join("");
}

function hasSrOnlyDescendantWithTextHtml(a: HtmlElement): boolean {
  const visit = (node: HtmlNode): boolean => {
    if (node.kind !== "HtmlElement") return false;
    if (isSrOnlyHtml(node) && htmlAnyText(node).length > 0) return true;
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  for (const child of a.children) {
    if (visit(child)) return true;
  }
  return false;
}

function htmlAnyText(el: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") chunks.push(node.value);
    else if (node.kind === "HtmlElement") for (const child of node.children) visit(child);
  };
  for (const child of el.children) visit(child);
  return chunks.join("").trim();
}

function isSrOnlyHtml(el: HtmlElement): boolean {
  const classAttr = getHtmlAttribute(el, "class");
  if (!classAttr) return false;
  for (const tok of classAttr.split(/\s+/u)) {
    if (SR_ONLY_TOKENS.has(tok.toLowerCase())) return true;
  }
  return false;
}

function hasAccessibleNameOverrideHtml(a: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(a, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(a, "aria-labelledby")) return true;
  const title = getHtmlAttribute(a, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(
  module: TsxModule,
  filePath: string,
  wrappersForA: ReadonlySet<string>,
  candidates: ReviewCandidate[],
): void {
  const wrappers = new Set<string>([...JSX_LINK_TAGS, ...wrappersForA]);
  wrappers.delete("a");
  for (const el of findJsxElementsForTag(module, "a", wrappers)) {
    if (hasAccessibleNameOverrideJsx(el)) continue;
    // Runtime expression children (`<a>{glyph}</a>`) may carry any
    // text — we can't claim sole-glyph on opaque evidence. Skip.
    if (el.children.some((c) => c.kind === "JsxExpression")) continue;
    const glyph = soleGlyphTextJsx(el);
    if (!glyph) continue;
    if (hasSrOnlyDescendantWithTextJsx(el)) continue;
    pushCandidates(candidates, filePath, el.loc.start.line, el.loc.start.column, glyph);
  }
}

function soleGlyphTextJsx(a: JsxElement): string | null {
  const text = jsxVisibleTextFlat(a);
  return matchGlyph(text);
}

function jsxVisibleTextFlat(a: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      chunks.push(node.value);
      return;
    }
    if (node.kind !== "JsxElement") return;
    if (isSrOnlyJsx(node)) return;
    for (const child of node.children) visit(child);
  };
  for (const child of a.children) visit(child);
  return chunks.join("");
}

function hasSrOnlyDescendantWithTextJsx(a: JsxElement): boolean {
  const visit = (node: JsxNode): boolean => {
    if (node.kind !== "JsxElement") return false;
    if (isSrOnlyJsx(node) && jsxAnyText(node).length > 0) return true;
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  for (const child of a.children) {
    if (visit(child)) return true;
  }
  return false;
}

function jsxAnyText(el: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") chunks.push(node.value);
    else if (node.kind === "JsxElement") for (const child of node.children) visit(child);
  };
  for (const child of el.children) visit(child);
  return chunks.join("").trim();
}

function isSrOnlyJsx(el: JsxElement): boolean {
  const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (!classValue) return false;
  for (const tok of classValue.split(/\s+/u)) {
    if (SR_ONLY_TOKENS.has(tok.toLowerCase())) return true;
  }
  return false;
}

function hasAccessibleNameOverrideJsx(a: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(a, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(a, "aria-labelledby")) return true;
  const title = getJsxAttributeString(a, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Locally decodes the four named entities (not in the parser's table),
 * collapses whitespace, and returns the matched glyph IFF the result
 * is exactly one of the four pagination glyphs. Returns null for any
 * other shape — no text, multiple characters, a non-matching glyph,
 * or punctuation next to a glyph (e.g. `« Prev`).
 */
function matchGlyph(text: string): string | null {
  let normalized = text;
  for (const [entity, decoded] of Object.entries(NAMED_ENTITY_MAP)) {
    if (normalized.includes(entity)) {
      normalized = normalized.split(entity).join(decoded);
    }
  }
  const trimmed = normalized.replace(/\s+/gu, "").trim();
  if (trimmed.length === 0) return null;
  // One-codepoint check. `«` / `»` are single BMP chars (length 1);
  // `‹` / `›` are also BMP (length 1). A `length === 1` string test
  // is sufficient and keeps the check honest: any adornment
  // (punctuation, digit, extra glyph) pushes the length above 1 and
  // the anchor falls out of this finder's scope.
  if (trimmed.length !== 1) return null;
  return GLYPHS.has(trimmed) ? trimmed : null;
}

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  glyph: string,
): void {
  const reason =
    `anchor text is a pagination glyph ('${glyph}') with no accessible name alternative ` +
    `(no aria-label, aria-labelledby, title, or visually-hidden child) — screen readers announce ` +
    `the glyph as punctuation or skip it; add aria-label or an sr-only span naming the direction ` +
    `(e.g. "Previous page" / "Next page").`;
  for (const criterionId of CRITERION_IDS) {
    // Confidence "medium": the static signal is deterministic
    // (anchor, sole visible text one of four glyphs, no label
    // override, no sr-only descendant). The remaining ambiguity is
    // whether the surrounding context (a numbered pagination list
    // visible next to the glyph, an aria-labelledby cascade the
    // finder didn't resolve) already supplies a name. The agent's
    // one file read confirms; the finder points honestly.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "medium",
    });
  }
}
