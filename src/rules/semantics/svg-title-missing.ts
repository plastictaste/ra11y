/**
 * Rule: semantics/svg-title-missing
 * Satisfies: wcag22:1.1.1, wcag21:1.1.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * > All non-text content that is presented to the user has a text
 * > alternative that serves the equivalent purpose, except for the
 * > situations listed below: controls, input, time-based media,
 * > tests, sensory, CAPTCHA, decoration/formatting/invisible.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-content
 * Related: https://www.w3.org/TR/WCAG22/#name-role-value (SC 4.1.2)
 * SVG 2 accessibility: https://www.w3.org/TR/SVG2/struct.html#DescriptionAndTitleElements
 *
 * Scope: standalone `.svg` files. A file with a `.svg` extension is
 * an image asset — something an author links to via `<img src="…svg">`
 * or loads directly as a page resource. WCAG 1.1.1 requires every
 * image convey its meaning textually to assistive tech; the SVG 2
 * accessibility chapter specifies the `<title>` child of the root
 * `<svg>` as the canonical accessible name for a standalone SVG.
 *
 * Why not inline `<svg>` in HTML/JSX? The sibling rule
 * `media/alt-text-missing` already covers inline `<svg role="img">`
 * inside `.html` / `.tsx` / `.jsx` — firing on any element with
 * `role="img"` that lacks an accessible name. Extending this rule to
 * those surfaces would double-flag the same element. Standalone
 * `.svg` files are the gap: the root `<svg>` is inherently an image
 * by virtue of the file extension, regardless of explicit
 * `role="img"`, and no other rule fires.
 *
 * Accessible-name sources accepted (any one suppresses the finding):
 *   - A direct-child `<title>` element with non-empty text. SVG 2
 *     treats this as the primary accessible name.
 *   - `aria-label` with a non-empty value on the root `<svg>`.
 *   - `aria-labelledby` on the root `<svg>` (target existence is
 *     out of scope — `aria/labelledby-target-exists` covers that).
 *
 * Decorative escape hatches:
 *   - `aria-hidden="true"` on the root `<svg>` marks the asset as
 *     presentational and suppresses the finding. Authors using
 *     `.svg` files as CSS-background replacements or icon-font
 *     substitutes often set this.
 *   - `role="presentation"` / `role="none"` on the root `<svg>`
 *     similarly suppresses — same semantics as HTML.
 *
 * Fix suggestion: inline a `<title>` child (the SVG 2 preferred
 * form — works without aria attributes and renders as a tooltip in
 * most browsers) or add `aria-label` / `aria-labelledby` when the
 * name comes from external text.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  directHtmlChildren,
  findHtmlElementsByTag,
  getHtmlAttribute,
  hasHtmlAttribute,
  htmlTextContent,
  isDecorativeHtmlElement,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";

export const rule = defineRule({
  id: "semantics/svg-title-missing",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "mechanical",
  appliesTo: {
    fileExtensions: [".svg"],
  },
  docs: {
    description:
      "Standalone SVG assets must expose an accessible name via a <title> child, aria-label, or aria-labelledby — otherwise screen readers announce nothing for the image.",
    rationale:
      'A standalone `.svg` file is an image asset. When referenced via `<img src="…svg">` or loaded directly, the root `<svg>` element is what assistive tech presents to the user. Without a `<title>` child (the SVG 2 accessibility primary name source), `aria-label`, or `aria-labelledby`, the image is silently opaque — screen readers announce the file name at best or nothing at all. Static detection is load-bearing because authors routinely forget the `<title>` child when exporting from design tools (Figma, Illustrator, Sketch) — every export defaults to omitting it.',
    goodExample: `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <title>Search</title>
  <path d="M10 10L20 20" />
</svg>`,
    badExample: `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M10 10L20 20" />
</svg>`,
    normativeQuote:
      "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for the situations listed below: controls, input, time-based media, tests, sensory, CAPTCHA, decoration/formatting/invisible.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/TR/SVG2/struct.html#DescriptionAndTitleElements",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G94",
    ],
  },
  check(ctx) {
    // Scope: standalone `.svg` files only. Inline `<svg role="img">`
    // inside `.html` / `.tsx` / `.jsx` is handled by `media/alt-text-
    // missing` — double-flagging the same element would inflate the
    // finding count without adding signal.
    if (!ctx.filePath.toLowerCase().endsWith(".svg")) return [];
    if (ctx.language !== "html") return [];
    const doc = ctx.ast as HtmlDocument;
    for (const svg of findRootSvgElements(doc)) {
      if (isDecorativeHtmlElement(svg)) continue;
      if (hasAccessibleNameSvg(svg)) continue;
      ctx.emit({
        severity: "error",
        location: {
          filePath: ctx.filePath,
          line: svg.loc.start.line,
          column: svg.loc.start.column,
        },
        message: buildMessage(ctx.filePath),
        suggestion: buildSuggestion(svg, ctx.filePath),
      });
    }
    return [];
  },
});

/**
 * Root-level `<svg>` elements in the document — the ones that are
 * themselves the standalone asset. Nested `<svg>` inside another
 * `<svg>` (uncommon but legal) is skipped: the outer one is the
 * asset-level element, and its accessible name covers both. Walking
 * only direct children of the document handles the XML-prolog +
 * DOCTYPE case cleanly — both parse as sibling nodes of the root
 * `<svg>`, not ancestors.
 */
function findRootSvgElements(doc: HtmlDocument): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  for (const child of doc.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "svg") continue;
    out.push(child);
  }
  // Fallback for sources where the `<svg>` is wrapped in stray
  // whitespace or a malformed parent — search by tag as a backstop.
  // `findHtmlElementsByTag` skips nested `<svg>` inside another
  // `<svg>` only at the caller level; we dedupe against `out` here.
  if (out.length === 0) {
    for (const svg of findHtmlElementsByTag(doc, "svg")) {
      if (!isNestedSvg(svg, doc)) out.push(svg);
    }
  }
  return out;
}

/**
 * True when `svg` has another `<svg>` ancestor inside the document.
 * The document root is not an element, so any first-encountered
 * `<svg>` is automatically non-nested. We walk explicitly rather
 * than using parent pointers because the HTML AST does not carry
 * them.
 */
function isNestedSvg(svg: HtmlElement, doc: HtmlDocument): boolean {
  for (const candidate of findHtmlElementsByTag(doc, "svg")) {
    if (candidate === svg) continue;
    if (isDescendant(candidate, svg)) return true;
  }
  return false;
}

/** True when `needle` appears anywhere within `haystack`'s subtree. */
function isDescendant(haystack: HtmlElement, needle: HtmlElement): boolean {
  for (const child of haystack.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child === needle) return true;
    if (isDescendant(child, needle)) return true;
  }
  return false;
}

/**
 * True when the `<svg>` exposes an accessible name via any of the
 * SVG-accessibility-chapter-sanctioned channels. Matches the
 * resolution order `media/alt-text-missing` uses for `<svg role=
 * "img">` so behavior is consistent whether the SVG is inline or
 * standalone.
 */
function hasAccessibleNameSvg(svg: HtmlElement): boolean {
  if (hasHtmlTitleChild(svg)) return true;
  const ariaLabel = getHtmlAttribute(svg, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(svg, "aria-labelledby")) return true;
  return false;
}

/**
 * True when the element has a direct-child `<title>` element whose
 * text content is non-empty. SVG 2 accessibility chapter specifies
 * this as the primary accessible-name source for `<svg>`.
 */
function hasHtmlTitleChild(element: HtmlElement): boolean {
  for (const child of directHtmlChildren(element)) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "title") continue;
    if (htmlTextContent(child).length > 0) return true;
  }
  return false;
}

function buildMessage(filePath: string): string {
  const name = filePathBasename(filePath);
  return `Standalone SVG '${name}' has no accessible name — screen readers will announce the file name or nothing at all when this image is rendered.`;
}

function buildSuggestion(svg: HtmlElement, filePath: string): string {
  const derived = deriveAccessibleNameFromFilename(filePath);
  const hint = derived
    ? `"${derived}"`
    : "the one-line description of what this image communicates";
  // Mention the viewBox if present — helps the agent confirm this is
  // the asset-level `<svg>` rather than a glyph reference. The hint
  // is additive context per AI-first consumer doctrine.
  const viewBox = getHtmlAttribute(svg, "viewBox");
  const locationHint = viewBox ? ` (viewBox="${viewBox}" — the outer asset element)` : "";
  return `Add a <title> child as the first element of this <svg>${locationHint}: <title>${hint}</title>. SVG 2 treats this as the primary accessible name. If the name is already present as visible text elsewhere, use aria-labelledby pointing at that element's id. If the SVG is purely decorative (CSS-background replacement, icon-font substitute), add aria-hidden="true" on the <svg> instead.`;
}

/** Returns the basename (filename + extension) from a path. */
function filePathBasename(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSep === -1 ? filePath : filePath.slice(lastSep + 1);
}

/**
 * Guess a human-readable name from the file basename. `search.svg` →
 * "Search", `icons/trash-bin.svg` → "Trash bin", `chart_01.svg` →
 * "Chart 01". Mirrors the filename-derivation heuristic in
 * `src/rules/semantics/button-name.ts` so suggestion text is
 * consistent across rules. Returns empty string when no alpha
 * characters remain after stripping the extension.
 */
function deriveAccessibleNameFromFilename(filePath: string): string {
  const base = filePathBasename(filePath).replace(/\.svg$/i, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  if (words.length === 0) return "";
  if (!/[a-z]/i.test(words)) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
