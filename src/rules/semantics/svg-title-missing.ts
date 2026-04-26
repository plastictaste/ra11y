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
 * Scope: every `<svg>` element where the asset is rendered to the
 * user — standalone `.svg` files (linked via `<img src="…svg">` or
 * loaded as a page resource) AND inline `<svg>` embedded in HTML or
 * JSX markup. WCAG 1.1.1 requires every image convey its meaning
 * textually to assistive tech; the SVG 2 accessibility chapter
 * specifies the `<title>` child of `<svg>` as the canonical accessible
 * name. Inline `<svg>` without a `<title>`, an aria-label, an
 * aria-labelledby, or a decorative marker is silently opaque — most
 * screen readers announce nothing or read a generic "graphic" with no
 * content.
 *
 * Surfaces covered:
 *   1. Standalone `.svg` files — root `<svg>` element. Authors
 *      exporting from Figma / Illustrator / Sketch routinely forget
 *      the `<title>` child; every export defaults to omitting it.
 *   2. Inline `<svg>` in HTML-family extensions (`.html`, `.htm`,
 *      `.astro`, `.md`, `.markdown`, `.erb`) — every `<svg>` element
 *      anywhere in the document.
 *   3. Inline `<svg>` in JSX-family extensions (`.tsx`, `.jsx`,
 *      `.mdx`, plus `.ts`/`.js` aliasing) — every `<svg>` JSX element.
 *
 * Dedup with `media/alt-text-missing`: that rule covers any element
 * with `role="img"` (including `<svg role="img">`) on the inline
 * surfaces. To avoid double-flagging the same element, this rule
 * skips inline `<svg>` that already carry `role="img"` — letting
 * `alt-text-missing` own that channel. Standalone `.svg` files are
 * not in `alt-text-missing`'s scope, so the root `<svg>` of a `.svg`
 * file is always handled here regardless of `role`.
 *
 * Accessible-name sources accepted (any one suppresses the finding):
 *   - A direct-child `<title>` element with non-empty text. SVG 2
 *     treats this as the primary accessible name.
 *   - `aria-label` with a non-empty value on the `<svg>`.
 *   - `aria-labelledby` on the `<svg>` (target existence is out of
 *     scope — `aria/labelledby-target-exists` covers that).
 *
 * Decorative escape hatches:
 *   - `aria-hidden="true"` on the `<svg>` marks the asset as
 *     presentational and suppresses the finding. Authors using
 *     SVG icons next to descriptive visible text often set this.
 *   - `role="presentation"` / `role="none"` on the `<svg>` similarly
 *     suppresses.
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
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  isDecorativeHtmlElement,
  isDecorativeJsxElement,
  jsxTextContent,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "semantics/svg-title-missing",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "mechanical",
  // Standalone `.svg` files plus the markup-bearing extensions that
  // can embed inline `<svg>`. The HTML-family entries (`.html`, `.htm`)
  // alias-cover `.astro`, `.md`, `.markdown`, `.erb` via the parser
  // registry's EXTENSION_ALIASES table; `.tsx`/`.jsx` cover `.mdx` and
  // the JS/TS family the same way. `.vue` and `.svelte` have no parser
  // dispatch today (forward-compat — when the registry adds them, this
  // rule picks them up via the same alias mechanism without churn).
  appliesTo: {
    fileExtensions: [".svg", ".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Every <svg> rendered to the user — standalone .svg file or inline in HTML / JSX — must expose an accessible name via a <title> child, aria-label, or aria-labelledby; otherwise mark it decorative with aria-hidden / role=presentation.",
    rationale:
      'Whether a `<svg>` is a standalone `.svg` asset or inline markup inside an HTML page or JSX component, screen readers need a text alternative to announce what the graphic communicates. Without a `<title>` child (the SVG 2 accessibility primary name source), `aria-label`, or `aria-labelledby`, most assistive tech announces the file name at best or nothing at all. Inline `<svg>` is the routine miss: authors drop icons into buttons, links, and standalone graphics straight from a design tool (Figma, Illustrator, Sketch) — every export omits the `<title>`. Static detection is load-bearing because the runtime element is opaque without it.',
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
    const isStandaloneSvgFile = ctx.filePath.toLowerCase().endsWith(".svg");
    if (ctx.language === "html") {
      const doc = ctx.ast as HtmlDocument;
      // Standalone `.svg`: only inspect root-level `<svg>` (the asset
      // element). Inline HTML markup: every non-nested `<svg>` in the
      // document is a candidate.
      const candidates = isStandaloneSvgFile
        ? findRootSvgElements(doc)
        : findInlineHtmlSvgElements(doc);
      for (const svg of candidates) {
        if (isDecorativeHtmlElement(svg)) continue;
        if (hasAccessibleNameSvg(svg)) continue;
        // Inline-only dedup: `<svg role="img">` is already covered by
        // `media/alt-text-missing` on inline surfaces. Standalone
        // `.svg` files are not in that rule's scope, so we always
        // handle the root `<svg>` of a `.svg` file regardless of role.
        if (!isStandaloneSvgFile && hasHtmlRoleImg(svg)) continue;
        ctx.emit({
          severity: "error",
          location: {
            filePath: ctx.filePath,
            line: svg.loc.start.line,
            column: svg.loc.start.column,
          },
          message: buildMessage(ctx.filePath, isStandaloneSvgFile),
          suggestion: buildSuggestion(svg, ctx.filePath, isStandaloneSvgFile),
        });
      }
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      const module = ctx.ast as TsxModule;
      for (const svg of findInlineJsxSvgElements(module)) {
        if (isDecorativeJsxElement(svg)) continue;
        if (hasAccessibleNameSvgJsx(svg)) continue;
        // Same dedup with `media/alt-text-missing` as the HTML branch.
        if (hasJsxRoleImg(svg)) continue;
        ctx.emit({
          severity: "error",
          location: {
            filePath: ctx.filePath,
            line: svg.loc.start.line,
            column: svg.loc.start.column,
          },
          message: buildMessage(ctx.filePath, false),
          suggestion: buildSuggestionJsx(svg),
        });
      }
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
 * Inline `<svg>` candidates inside an HTML-family document. Every
 * non-nested `<svg>` is a candidate — the rule then runs the same
 * accessible-name + decorative checks the standalone path uses.
 * Nested `<svg>` inside another `<svg>` is skipped: the outer one is
 * the asset-level element whose accessible name covers both.
 */
function findInlineHtmlSvgElements(doc: HtmlDocument): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  for (const svg of findHtmlElementsByTag(doc, "svg")) {
    if (!isNestedSvg(svg, doc)) out.push(svg);
  }
  return out;
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

/** True when `<svg role="img">` is set (case-insensitive). */
function hasHtmlRoleImg(svg: HtmlElement): boolean {
  return getHtmlAttribute(svg, "role")?.toLowerCase() === "img";
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

function buildMessage(filePath: string, isStandalone: boolean): string {
  if (isStandalone) {
    const name = filePathBasename(filePath);
    return `Standalone SVG '${name}' has no accessible name — screen readers will announce the file name or nothing at all when this image is rendered.`;
  }
  return `Inline <svg> has no accessible name — without a <title> child, aria-label, or aria-labelledby (and not marked aria-hidden="true"), most screen readers announce nothing for this graphic.`;
}

function buildSuggestion(
  svg: HtmlElement,
  filePath: string,
  isStandalone: boolean,
): string {
  if (isStandalone) {
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
  // Inline path: no filename to derive from. Surface the viewBox as
  // additive disambiguation context when present.
  const viewBox = getHtmlAttribute(svg, "viewBox");
  const locationHint = viewBox ? ` (viewBox="${viewBox}")` : "";
  return `Add a <title> child as the first element of this inline <svg>${locationHint}: <title>One-line description of what this graphic communicates</title>. SVG 2 treats this as the primary accessible name. If the name is already present as visible text nearby, use aria-labelledby pointing at that element's id, or set aria-label directly. If the SVG is purely decorative — the surrounding text already conveys the meaning — add aria-hidden="true" on the <svg> instead.`;
}

// ---------------------------------------------------------------------------
// JSX helpers (inline SVG in .tsx / .jsx / .mdx and their JS/TS aliases)
// ---------------------------------------------------------------------------

/**
 * Inline `<svg>` JSX elements. Lowercase match only — a PascalCase
 * `<Svg>` component is opaque to the static rule (the wrapper might
 * render `<svg>` or something else; the agent reading the source is
 * the right arbiter, and `media/alt-text-missing`'s `nativeWrappers`
 * channel already exists for opted-in mappings). Nested `<svg>`
 * inside another `<svg>` is skipped — same rationale as the HTML
 * branch.
 */
function findInlineJsxSvgElements(module: TsxModule): readonly JsxElement[] {
  const all = findJsxElementsByTag(module, "svg");
  const out: JsxElement[] = [];
  for (const svg of all) {
    if (!isJsxSvgNested(svg, all)) out.push(svg);
  }
  return out;
}

/**
 * True when `svg` is a descendant of another element in `all`. The
 * JSX AST has no parent pointers, so we walk subtrees of every
 * sibling candidate. List-by-tag is the only candidate set we need
 * to check (only `<svg>` ancestors trigger the nested-skip rule).
 */
function isJsxSvgNested(svg: JsxElement, all: readonly JsxElement[]): boolean {
  for (const candidate of all) {
    if (candidate === svg) continue;
    if (isJsxDescendant(candidate, svg)) return true;
  }
  return false;
}

/** True when `needle` appears anywhere within `haystack`'s JSX subtree. */
function isJsxDescendant(haystack: JsxElement, needle: JsxElement): boolean {
  for (const child of haystack.children) {
    if (child.kind !== "JsxElement") continue;
    if (child === needle) return true;
    if (isJsxDescendant(child, needle)) return true;
  }
  return false;
}

/**
 * True when the inline JSX `<svg>` exposes an accessible name via the
 * same channels the HTML branch accepts. Mirrors `hasAccessibleName
 * Jsx` in `media/alt-text-missing` so the two rules stay consistent.
 */
function hasAccessibleNameSvgJsx(svg: JsxElement): boolean {
  if (hasJsxTitleChild(svg)) return true;
  const ariaLabel = getJsxAttributeString(svg, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(svg, "aria-labelledby")) return true;
  return false;
}

/** True when `<svg role="img">` is set on the JSX element. */
function hasJsxRoleImg(svg: JsxElement): boolean {
  return getJsxAttributeString(svg, "role")?.toLowerCase() === "img";
}

/**
 * True when the JSX element has a direct-child `<title>` element
 * whose text or expression content is non-empty. Lowercase match
 * only — a PascalCase `<Title>` component is opaque to this rule
 * (same tradeoff as `media/alt-text-missing`).
 */
function hasJsxTitleChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName.toLowerCase() !== "title") continue;
    if (jsxTextContent(child).length > 0) return true;
    // Expression child (e.g. <title>{label}</title>) counts — same
    // false-negative-friendly tradeoff as alt-text-missing's branch.
    for (const inner of child.children) {
      if (inner.kind === "JsxExpression") return true;
    }
  }
  return false;
}

function buildSuggestionJsx(svg: JsxElement): string {
  const viewBox = getJsxAttributeString(svg, "viewBox");
  const locationHint = viewBox ? ` (viewBox="${viewBox}")` : "";
  return `Add a <title> child as the first element of this inline <svg>${locationHint}: <title>One-line description of what this graphic communicates</title>. SVG 2 treats this as the primary accessible name. If the name is already present as visible text nearby, use aria-labelledby pointing at that element's id, or set aria-label directly. If the SVG is purely decorative — the surrounding text already conveys the meaning — add aria-hidden="true" on the <svg> instead.`;
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
