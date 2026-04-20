/**
 * Rule: media/alt-text-missing
 * Satisfies: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * > All non-text content that is presented to the user has a text
 * > alternative that serves the equivalent purpose, except for the
 * > situations listed below: controls, input, time-based media,
 * > tests, sensory, CAPTCHA, decoration/formatting/invisible.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * This rule flags non-text content that has neither a usable text
 * alternative nor a decorative marker. Covered element surfaces:
 *
 *   1. `<img>` (HTML + JSX) — accessible name from alt / aria-label /
 *      aria-labelledby / title.
 *   2. `<input type="image">` — same channels as `<img>`.
 *   3. SVG `<image>` inside `<svg>` — accessible name from aria-label /
 *      aria-labelledby / title attribute / child `<title>` element.
 *      WCAG treats SVG image references the same as raster `<img>`:
 *      they convey content and need a text alternative.
 *   4. Any element with `role="img"` (commonly `<div role="img">`,
 *      `<span role="img">`, `<svg role="img">`) — WAI-ARIA requires an
 *      accessible name from aria-label / aria-labelledby / title attr;
 *      for `<svg role="img">` a child `<title>` element also counts.
 *   5. `<canvas>` — WHATWG HTML treats `<canvas>` inner content as the
 *      fallback exposed to assistive tech. Flag canvases with no
 *      fallback content AND no aria-label / aria-labelledby / title.
 *
 * Decorative escape hatches work uniformly: `role="presentation"`,
 * `role="none"`, and `aria-hidden="true"` suppress the finding for any
 * of the surfaces above. Empty `alt=""` additionally suppresses for
 * `<img>` and `<input type="image">` where the attribute is meaningful.
 *
 * Fix suggestion strategy: inspect surrounding nodes to produce
 * context-aware text. If the image is inside a link or button, suggest
 * alt describing the destination/action. For SVG `<image>`, `role="img"`,
 * and `<canvas>`, the suggestion names the surface and the mechanism
 * appropriate to it (child `<title>`, aria-label, or canvas fallback
 * content).
 */

import { defineRule } from "../../api/plugin.ts";
import {
  directHtmlChildren,
  findHtmlElementsByTag,
  findJsxElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  isDecorativeHtmlElement,
  isDecorativeJsxElement,
  jsxTextContent,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/alt-text-missing",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"],
  severity: "error",
  scope: "node",
  fixClass: "mechanical",
  // Opt in: wrapper components declared as rendering `<img>` via the
  // object form of `nativeWrappers` (e.g. `{ Avatar: "img", NextImage:
  // "img" }`) get the same missing-alt check as a bare `<img>`. The
  // wrapper must still pass an `alt` prop to its inner `<img>` — the
  // rule surfaces when it doesn't.
  wrapperTreatsAsElement: "img",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Images, SVG <image>, elements with role="img", and <canvas> must have a text alternative — alt, aria-label, aria-labelledby, or (for canvas) fallback content. Decorative surfaces must be explicitly marked.',
    rationale:
      'Screen readers announce images by their accessible name. A non-text surface without a text alternative is announced as the file name, the generic word "image", or nothing at all, leaving non-sighted users unable to understand what the element communicates.',
    goodExample: `<img src="chart.png" alt="Quarterly revenue growth 2024–2026: $1.2M to $3.8M." />`,
    badExample: `<img src="chart.png" />`,
    normativeQuote:
      "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/tutorials/images/",
      "https://www.w3.org/TR/wai-aria-1.2/#img",
      "https://html.spec.whatwg.org/multipage/canvas.html#the-canvas-element",
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
      checkJsx(ctx.ast as TsxModule, ctx.wrappersForElement, (v) => ctx.emit(v));
    }
  },
});

type SurfaceKind = "img" | "input-image" | "svg-image" | "role-img" | "canvas";

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
  const seen = new Set<HtmlElement>();
  checkHtmlImgs(doc, seen, emit);
  checkHtmlInputImages(doc, seen, emit);
  checkHtmlSvgImages(doc, seen, emit);
  checkHtmlRoleImg(doc, seen, emit);
  checkHtmlCanvas(doc, seen, emit);
}

function checkHtmlImgs(doc: HtmlDocument, seen: Set<HtmlElement>, emit: Emit): void {
  for (const element of findHtmlElementsByTag(doc, "img")) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeHtmlElement(element)) continue;
    if (hasAccessibleNameHtml(element)) continue;
    emitHtmlViolation(element, "img", emit);
  }
}

function checkHtmlInputImages(doc: HtmlDocument, seen: Set<HtmlElement>, emit: Emit): void {
  for (const input of findHtmlElementsByTag(doc, "input")) {
    if (seen.has(input)) continue;
    const type = getHtmlAttribute(input, "type");
    if (type?.toLowerCase() !== "image") continue;
    seen.add(input);
    if (isDecorativeHtmlElement(input)) continue;
    if (hasAccessibleNameHtml(input)) continue;
    emitHtmlViolation(input, "input-image", emit);
  }
}

/**
 * SVG `<image>` — case-insensitive because the parser lowercases tag
 * names. Distinct from HTML `<img>`; typically self-closing with an
 * `href` / `xlink:href` pointing at a raster or vector asset. WCAG
 * treats it the same as `<img>`: content needs a text alternative.
 */
function checkHtmlSvgImages(doc: HtmlDocument, seen: Set<HtmlElement>, emit: Emit): void {
  for (const element of findHtmlElementsByTag(doc, "image")) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeHtmlElement(element)) continue;
    if (hasAccessibleNameHtml(element)) continue;
    if (hasHtmlTitleChild(element)) continue;
    emitHtmlViolation(element, "svg-image", emit);
  }
}

/**
 * `role="img"` on any element (most commonly `<div>`, `<span>`,
 * `<svg>`). WAI-ARIA requires an accessible name. We walk every tag
 * with the role attribute rather than a fixed list — authors put
 * role="img" on `<picture>`, `<figure>`, CSS-background-driven
 * wrappers, etc.
 */
function checkHtmlRoleImg(doc: HtmlDocument, seen: Set<HtmlElement>, emit: Emit): void {
  for (const element of findHtmlRoleImgElements(doc)) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeHtmlElement(element)) continue;
    if (hasAccessibleNameHtml(element)) continue;
    if (element.tagName.toLowerCase() === "svg" && hasHtmlTitleChild(element)) continue;
    emitHtmlViolation(element, "role-img", emit);
  }
}

/**
 * `<canvas>` — WHATWG HTML treats the element's child content as the
 * accessibility fallback exposed to AT. A canvas with neither
 * fallback content nor an aria-label / aria-labelledby / title
 * attribute is opaque to screen readers.
 */
function checkHtmlCanvas(doc: HtmlDocument, seen: Set<HtmlElement>, emit: Emit): void {
  for (const element of findHtmlElementsByTag(doc, "canvas")) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeHtmlElement(element)) continue;
    if (hasAccessibleNameHtml(element)) continue;
    if (htmlTextContent(element).length > 0) continue;
    if (hasHtmlNonTextChildren(element)) continue;
    emitHtmlViolation(element, "canvas", emit);
  }
}

function hasAccessibleNameHtml(element: HtmlElement): boolean {
  const alt = getHtmlAttribute(element, "alt");
  if (alt !== null && alt.trim().length > 0) return true;
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(element, "aria-labelledby")) return true;
  if (hasHtmlAttribute(element, "title")) {
    const title = getHtmlAttribute(element, "title");
    if (title !== null && title.trim().length > 0) return true;
  }
  return false;
}

/**
 * True when the element has a direct-child `<title>` element whose text
 * content is non-empty. SVG `<image>` and `<svg role="img">` treat this
 * child as the accessible name per the SVG 2 accessibility chapter.
 */
function hasHtmlTitleChild(element: HtmlElement): boolean {
  for (const child of directHtmlChildren(element)) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "title") continue;
    if (htmlTextContent(child).length > 0) return true;
  }
  return false;
}

/** Any HTML child element (non-text, non-comment) — used as a canvas-fallback proxy. */
function hasHtmlNonTextChildren(element: HtmlElement): boolean {
  for (const child of directHtmlChildren(element)) {
    if (child.kind === "HtmlElement") return true;
  }
  return false;
}

/**
 * Walks the document and returns every element carrying `role="img"`,
 * skipping `<img>` and `<input type="image">` — those are handled by
 * their dedicated branches and don't need re-flagging via the role
 * channel.
 */
function findHtmlRoleImgElements(doc: HtmlDocument): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  const visit = (node: HtmlElement): void => {
    const role = getHtmlAttribute(node, "role");
    if (role?.toLowerCase() === "img") {
      const tag = node.tagName.toLowerCase();
      const isImg = tag === "img";
      const isInputImage =
        tag === "input" && getHtmlAttribute(node, "type")?.toLowerCase() === "image";
      if (!(isImg || isInputImage)) out.push(node);
    }
    for (const child of node.children) {
      if (child.kind === "HtmlElement") visit(child);
    }
  };
  for (const child of doc.children) {
    if (child.kind === "HtmlElement") visit(child);
  }
  return out;
}

function emitHtmlViolation(element: HtmlElement, kind: SurfaceKind, emit: Emit): void {
  const src =
    getHtmlAttribute(element, "src") ??
    getHtmlAttribute(element, "href") ??
    getHtmlAttribute(element, "xlink:href");
  const message = buildMessage(kind, element.tagName, src);
  const suggestion = buildSuggestion(kind, element.tagName, src);
  emit({
    severity: "error",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message,
    suggestion,
  });
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, wrappersForImg: ReadonlySet<string>, emit: Emit): void {
  const seen = new Set<JsxElement>();
  checkJsxImgs(module, wrappersForImg, seen, emit);
  checkJsxInputImages(module, seen, emit);
  checkJsxSvgImages(module, seen, emit);
  checkJsxRoleImg(module, seen, emit);
  checkJsxCanvas(module, seen, emit);
}

/**
 * Three resolution channels feed the img-accessible-name check:
 *   1. bare `<img>` — the native tag channel.
 *   2. `wrappersForImg` — PascalCase wrappers the user declared as
 *      rendering `<img>` via `nativeWrappers` (Q2-WRAPMAP-RULES).
 *   3. polymorphic `as="img"` / `asChild` → `<img>` (Q2R2-POLYMORPHIC) —
 *      surfaced by `findJsxElementsForTag` once per matching element.
 * `findJsxElementsForTag` unifies all three; the wrapper's own attrs
 * are the call-site attrs that get forwarded to the inner `<img>`, so
 * the same `hasAccessibleNameJsx` check applies without modification.
 */
function checkJsxImgs(
  module: TsxModule,
  wrappersForImg: ReadonlySet<string>,
  seen: Set<JsxElement>,
  emit: Emit,
): void {
  for (const element of findJsxElementsForTag(module, "img", wrappersForImg)) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeJsxElement(element)) continue;
    if (hasAccessibleNameJsx(element)) continue;
    emitJsxViolation(element, "img", emit);
  }
}

/**
 * SVG `<image>` — JSX preserves case (the parser does not lowercase),
 * so `<image>` is distinct from `<Image>`. Match the lowercase form
 * only: PascalCase `Image` is almost always a wrapper component that
 * the user should map via `nativeWrappers` if they want img behavior.
 */
function checkJsxSvgImages(module: TsxModule, seen: Set<JsxElement>, emit: Emit): void {
  for (const element of findJsxElementsByTag(module, "image")) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeJsxElement(element)) continue;
    if (hasAccessibleNameJsx(element)) continue;
    if (hasJsxTitleChild(element)) continue;
    emitJsxViolation(element, "svg-image", emit);
  }
}

/** Walks every JSX element and matches `role="img"` regardless of tag. */
function checkJsxRoleImg(module: TsxModule, seen: Set<JsxElement>, emit: Emit): void {
  for (const element of walkJsxElements(module)) {
    if (seen.has(element)) continue;
    if (!isJsxRoleImgCandidate(element)) continue;
    seen.add(element);
    if (isDecorativeJsxElement(element)) continue;
    if (hasAccessibleNameJsx(element)) continue;
    if (element.tagName.toLowerCase() === "svg" && hasJsxTitleChild(element)) continue;
    emitJsxViolation(element, "role-img", emit);
  }
}

/**
 * True when a JSX element carries `role="img"` AND is not already
 * covered by the native `<img>` / `<input type="image">` branches.
 */
function isJsxRoleImgCandidate(element: JsxElement): boolean {
  const role = getJsxAttributeString(element, "role");
  if (role?.toLowerCase() !== "img") return false;
  const tag = element.tagName;
  if (tag === "img") return false;
  if (tag === "input" && getJsxAttributeString(element, "type")?.toLowerCase() === "image") {
    return false;
  }
  return true;
}

/**
 * `<canvas>` — same semantics as HTML: a canvas without fallback
 * content (text, expression, or child element) and without aria-label
 * / aria-labelledby / title is opaque to AT.
 */
function checkJsxCanvas(module: TsxModule, seen: Set<JsxElement>, emit: Emit): void {
  for (const element of findJsxElementsByTag(module, "canvas")) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isDecorativeJsxElement(element)) continue;
    if (hasAccessibleNameJsx(element)) continue;
    if (jsxHasCanvasFallback(element)) continue;
    emitJsxViolation(element, "canvas", emit);
  }
}

/** Flags `<input type="image">` without a usable accessible name. */
function checkJsxInputImages(module: TsxModule, seen: Set<JsxElement>, emit: Emit): void {
  for (const input of findJsxElementsByTag(module, "input")) {
    if (seen.has(input)) continue;
    const type = getJsxAttributeString(input, "type");
    if (type?.toLowerCase() !== "image") continue;
    seen.add(input);
    if (isDecorativeJsxElement(input)) continue;
    if (hasAccessibleNameJsx(input)) continue;
    emitJsxViolation(input, "input-image", emit);
  }
}

function hasAccessibleNameJsx(element: JsxElement): boolean {
  const altString = getJsxAttributeString(element, "alt");
  if (altString !== null && altString.trim().length > 0) return true;
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  const title = getJsxAttributeString(element, "title");
  if (title !== null && title.trim().length > 0) return true;
  // If `alt` / `aria-label` / `title` is an expression, we assume the
  // developer is computing a name at runtime. This is a false-negative
  // for static analysis but the alternative — flagging every runtime
  // expression — creates far more noise than signal. The
  // eslint-plugin-jsx-a11y rule makes the same tradeoff.
  const altAttr = getJsxAttribute(element, "alt");
  if (altAttr?.value?.kind === "Expression") return true;
  const labelAttr = getJsxAttribute(element, "aria-label");
  if (labelAttr?.value?.kind === "Expression") return true;
  const titleAttr = getJsxAttribute(element, "title");
  if (titleAttr?.value?.kind === "Expression") return true;
  return false;
}

/**
 * True when a JSX element has a direct-child `<title>` element whose
 * text or expression content is non-empty. Lowercase match only — a
 * PascalCase `<Title>` component is opaque to this rule.
 */
function hasJsxTitleChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName.toLowerCase() !== "title") continue;
    if (jsxTextContent(child).length > 0) return true;
    // Expression child (e.g. <title>{label}</title>) counts — same
    // false-negative-friendly tradeoff as the alt={expr} branch.
    for (const inner of child.children) {
      if (inner.kind === "JsxExpression") return true;
    }
  }
  return false;
}

/**
 * True when a `<canvas>` element has any fallback content that would
 * surface to assistive tech — literal text, an expression (runtime
 * children), or a nested element.
 */
function jsxHasCanvasFallback(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind === "JsxText" && child.value.trim().length > 0) return true;
    if (child.kind === "JsxExpression") return true;
    if (child.kind === "JsxElement") return true;
  }
  return false;
}

function emitJsxViolation(element: JsxElement, kind: SurfaceKind, emit: Emit): void {
  const src =
    getJsxAttributeString(element, "src") ??
    getJsxAttributeString(element, "href") ??
    getJsxAttributeString(element, "xlink:href");
  const message = buildMessage(kind, element.tagName, src);
  const suggestion = buildSuggestion(kind, element.tagName, src);
  emit({
    severity: "error",
    location: {
      filePath: "",
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message,
    suggestion,
  });
}

// ---------------------------------------------------------------------------
// Message / suggestion builders (per-surface)
// ---------------------------------------------------------------------------

function buildMessage(kind: SurfaceKind, tagName: string, src: string | null): string {
  if (kind === "svg-image") {
    if (src) {
      const name = filenameFromPath(src);
      return `SVG <image> referencing '${name}' is missing a text alternative — screen readers have no way to announce what the image represents.`;
    }
    return `SVG <image> has no text alternative — screen readers will announce nothing.`;
  }
  if (kind === "role-img") {
    return `<${tagName} role="img"> has no accessible name — screen readers will announce a generic "image" with no content.`;
  }
  if (kind === "canvas") {
    return `<canvas> has neither fallback content nor an accessible name — assistive technology cannot describe what is rendered.`;
  }
  if (src) {
    const name = filenameFromPath(src);
    return `<${tagName}> '${name}' is missing a text alternative — screen readers will announce the file name or nothing at all.`;
  }
  return `<${tagName}> has no text alternative — screen readers will announce nothing.`;
}

function buildSuggestion(kind: SurfaceKind, tagName: string, src: string | null): string {
  if (kind === "svg-image") {
    const subject = src ? guessSubject(filenameFromPath(src)) : "what the image shows";
    return `Add a <title> child with descriptive text (e.g., <title>${subject}</title>), or set aria-label / aria-labelledby on the <image>. If purely decorative, set role="presentation" or aria-hidden="true".`;
  }
  if (kind === "role-img") {
    return `This <${tagName}> has role="img" but no accessible name. Add aria-label describing the image, use aria-labelledby to point at visible text, or remove role="img" if the element is not actually conveying an image.`;
  }
  if (kind === "canvas") {
    return `Put descriptive fallback text inside the <canvas> element (assistive tech exposes canvas children when the bitmap is unreachable) and / or add aria-label describing what the canvas renders. If the canvas is purely decorative, mark it aria-hidden="true".`;
  }
  if (src) {
    const name = filenameFromPath(src);
    const subject = guessSubject(name);
    return `Add alt describing what the image communicates (e.g., alt="${subject}"). If the image is purely decorative — the surrounding text already conveys the same information — mark it with alt="" instead.`;
  }
  return `Add an alt attribute describing what the ${tagName} communicates. If the image is decorative, mark it with alt="" explicitly.`;
}

function filenameFromPath(src: string): string {
  const slash = Math.max(src.lastIndexOf("/"), src.lastIndexOf("\\"));
  return slash === -1 ? src : src.slice(slash + 1);
}

function guessSubject(filename: string): string {
  // Turn "chart-revenue-2026.png" into "chart revenue 2026" so the
  // suggestion reads like a sentence, not a file path.
  return filename
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}
