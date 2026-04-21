/**
 * Rule: semantics/heading-class-on-nonheading
 * Satisfies: wcag22:1.3.1, wcag21:1.3.1
 * Spec: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * > Information, structure, and relationships conveyed through
 * > presentation can be programmatically determined or are available in
 * > text. (SC 1.3.1)
 *
 * Source: https://www.w3.org/TR/WCAG22/#info-and-relationships
 *
 * Flags non-heading elements styled with a heading-visual utility class
 * (e.g. Bootstrap's `.h1`-`.h6` and `.display-1`-`.display-6`). These
 * classes apply heading-scale typography without changing the element's
 * programmatic role, so screen readers announce the text as a plain
 * `<p>` / `<div>` / `<span>` — the heading *relationship* the class
 * communicates visually is never exposed in the accessibility tree.
 *
 * The canonical Bootstrap pattern this catches:
 *
 *   <div class="h1">Page Title</div>
 *   <p class="display-4">Marketing Headline</p>
 *
 * A well-formed document resolves the gap one of two ways:
 *   1. Change the tag to the matching heading element (`<h1>`–`<h6>`)
 *      so the heading role comes for free.
 *   2. If the element must remain a non-heading for layout reasons,
 *      add `role="heading"` plus `aria-level="<n>"` so the role is
 *      programmatically exposed.
 *
 * The class-trigger set is narrow on purpose: only classes whose
 * *semantic intent* is "this is a visual heading." That means
 * Bootstrap's `.h1`-`.h6` and `.display-1`-`.display-6`. Generic
 * typography utilities like `.lead`, `.small`, `.fs-1`, `.text-muted`
 * style text but do not imply heading structure and are skipped —
 * flagging them would be overreach.
 *
 * Heading elements (`<h1>`-`<h6>`) with any of these classes pass: the
 * class is a legitimate visual override on an element that already
 * carries the heading role. Likewise an element that declares
 * `role="heading"` with an `aria-level` passes regardless of tag.
 *
 * Out of scope:
 *   - Font-size utilities (`.fs-1`-`.fs-6`) — pure typography with no
 *     heading implication.
 *   - Elements that look heading-like because of inline CSS (`style="font-size:2rem"`)
 *     rather than a recognised class — too noisy to flag statically.
 *   - CSS `@extend` / utility generators — we match author-visible
 *     class tokens, not computed styles.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Bootstrap `.h1`-`.h6`. These are documented as "heading classes" —
 * they apply the same font-size/line-height as the matching `<h1>`-`<h6>`
 * tag but without the semantics. Match is case-sensitive (Bootstrap's
 * docs are lowercase) and whole-token (so `.heading` and `.h10` don't hit).
 */
const HEADING_CLASSES: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Bootstrap `.display-1`-`.display-6`. "Display headings" in Bootstrap's
 * typography docs — larger, more opinionated than `.h1`. Semantically
 * identical story: visual-only, no role.
 */
const DISPLAY_CLASSES: ReadonlySet<string> = new Set([
  "display-1",
  "display-2",
  "display-3",
  "display-4",
  "display-5",
  "display-6",
]);

/** Elements that are already headings — classes are fine as visual overrides. */
const HEADING_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const rule = defineRule({
  id: "semantics/heading-class-on-nonheading",
  satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"],
  severity: "warning",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".tsx", ".jsx", ".html", ".htm"],
  },
  docs: {
    description:
      'Non-heading elements styled with Bootstrap heading classes (.h1-.h6 or .display-1-.display-6) look like headings visually but expose no heading role — change the tag to <h1>-<h6> or add role="heading" with aria-level.',
    rationale:
      "Bootstrap's `.h1`-`.h6` and `.display-1`-`.display-6` classes ship the heading *typography* (font size, weight, line height) without the heading *role*. Applied to a `<div>` or `<p>`, they produce text that looks like a heading to sighted users but is announced as plain prose by assistive tech — the structural relationship WCAG 1.3.1 requires is conveyed through presentation only. Heading navigation commands (screen-reader H-key, shortcuts that enumerate the heading outline) skip the element entirely, so the document's structure is silently incomplete. The fix is either structural (use the matching `<h1>`-`<h6>` tag, which carries the role natively) or compensatory (`role=\"heading\"` + `aria-level` on the non-heading element).",
    goodExample: `<h1 class="display-4">Marketing Headline</h1>
<div class="h2" role="heading" aria-level="2">Section Title</div>`,
    badExample: `<div class="h1">Main Title</div>
<p class="display-4">Marketing Headline</p>`,
    normativeQuote:
      "Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.",
    references: [
      "https://www.w3.org/TR/WCAG22/#info-and-relationships",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F2",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA12",
      "https://getbootstrap.com/docs/5.3/content/typography/#headings",
      "https://getbootstrap.com/docs/5.3/content/typography/#display-headings",
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

type Loc = { readonly line: number; readonly column: number };

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const el of walkHtmlElements(doc)) {
    if (isHeadingTag(el.tagName)) continue;
    const classAttr = getHtmlAttribute(el, "class");
    if (classAttr === null) continue;
    const hit = firstHeadingLikeToken(classAttr);
    if (hit === null) continue;
    if (hasHeadingRole(getHtmlAttribute(el, "role"), getHtmlAttribute(el, "aria-level"))) continue;
    emit(buildViolation(el.tagName, el.loc.start, hit, htmlTextPreview(el)));
  }
}

function htmlTextPreview(el: HtmlElement): string {
  // Same approach as htmlTextContent but inlined to keep the preview
  // deterministic across child element boundaries.
  const chunks: string[] = [];
  const visit = (node: import("../../types/ast.ts").HtmlNode): void => {
    if (node.kind === "HtmlText") chunks.push(node.value);
    else if (node.kind === "HtmlElement") for (const c of node.children) visit(c);
  };
  for (const child of el.children) visit(child);
  return chunks.join("").trim();
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    if (isComponent(el.tagName)) continue;
    if (isHeadingTag(el.tagName)) continue;
    const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    if (classAttr === null) continue;
    const hit = firstHeadingLikeToken(classAttr);
    if (hit === null) continue;
    const role = getJsxAttributeString(el, "role");
    const ariaLevel = getJsxAttributeString(el, "aria-level");
    if (hasHeadingRole(role, ariaLevel)) continue;
    emit(buildViolation(el.tagName, el.loc.start, hit, jsxTextPreview(el)));
  }
}

function jsxTextPreview(el: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: import("../../types/ast.ts").JsxNode): void => {
    if (node.kind === "JsxText") chunks.push(node.value);
    else if (node.kind === "JsxElement") for (const c of node.children) visit(c);
  };
  for (const child of el.children) visit(child);
  return chunks.join("").trim();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isHeadingTag(tagName: string): boolean {
  return HEADING_TAGS.has(tagName.toLowerCase());
}

function isComponent(tagName: string): boolean {
  const first = tagName[0];
  return first !== undefined && first >= "A" && first <= "Z";
}

/**
 * Returns the first class token in `classValue` that matches one of the
 * heading-visual class sets. Match is case-sensitive (Bootstrap is
 * lowercase) and whole-token (split on whitespace). Returns `null` if no
 * match. Preserves the original token so the violation message can echo
 * what the author wrote.
 */
function firstHeadingLikeToken(classValue: string): string | null {
  for (const tok of classValue.split(/\s+/u)) {
    if (tok.length === 0) continue;
    if (HEADING_CLASSES.has(tok)) return tok;
    if (DISPLAY_CLASSES.has(tok)) return tok;
  }
  return null;
}

/**
 * True if the element already declares `role="heading"` with a
 * non-empty `aria-level`. Both are required — `role="heading"` without
 * `aria-level` is an invalid ARIA heading and doesn't satisfy 1.3.1,
 * but the right rule to catch that is an ARIA validity check, not this
 * one. We only use the combination as a pass signal; we don't flag the
 * partial case here (see out-of-scope note in the file header).
 */
function hasHeadingRole(role: string | null, ariaLevel: string | null): boolean {
  if (role === null || ariaLevel === null) return false;
  const tokens = role.trim().split(/\s+/u);
  for (const t of tokens) if (t.toLowerCase() === "heading") return ariaLevel.trim().length > 0;
  return false;
}

/** Extracts the heading level (1-6) implied by a class token like `h3` or `display-4`. */
function levelFromClass(cls: string): string {
  const match = /^(?:h|display-)(\d)$/u.exec(cls);
  return match?.[1] ?? "1";
}

function buildViolation(
  tagName: string,
  loc: Loc,
  hit: string,
  text: string,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const level = levelFromClass(hit);
  const textPreview = previewText(text);
  const textPhrase = textPreview === null ? "" : ` "${textPreview}"`;
  const classSource = DISPLAY_CLASSES.has(hit)
    ? "Bootstrap's display-heading"
    : "Bootstrap's heading";
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `<${tagName} class="${hit}">${textPhrase}</${tagName}> uses ${classSource} class .${hit} on a non-heading element — assistive tech announces it as a plain <${tagName}> and screen-reader heading-navigation skips it.`,
    suggestion: `Either change the tag to <h${level}> so the heading role comes natively (e.g. <h${level} class="${hit}">${textPreview ?? "…"}</h${level}>), or — if this element must stay a <${tagName}> — add role="heading" and aria-level="${level}" so the heading relationship is programmatically exposed. Styling alone is invisible to assistive tech.`,
  };
}

function previewText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}
