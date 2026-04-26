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
  truncateForEcho,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

export const rule = defineRule({
  id: "media/alt-text-missing",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"],
  severity: "error",
  scope: "node",
  // V1-FIX-LANG-AUTOCOMPLETE-ALT-MECHANICAL-DOWNGRADE: alt-text is
  // never a deterministic source transform — every surface (img, SVG
  // <image>, role="img", canvas) needs prose that describes what the
  // element communicates, which the static scanner cannot derive. Tagged
  // `verify-in-source` so `plan.fixesByClass` reflects honest "agent
  // reads adjacent code" expectation rather than the previous
  // `mechanical` lane that always fell through to `kind: "guidance"` in
  // `suggest_fix`. The `meta.mechanicalInPrinciple: true` annotation
  // still fires (verify-in-source is in MECHANICAL_IN_PRINCIPLE_LANES),
  // so agents reading the guidance still see "rule family supports a
  // source-edit path." See ADR 0007 for fixClass lane semantics and
  // docs/kb/architecture/ai-first-consumer.md "Composite headline counts
  // are dishonest" for the doctrine that motivated the re-tag.
  fixClass: "verify-in-source",
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
      // When the href is a placeholder-image URL (dimensions-only
      // basename like `700x400`, a known placeholder host, or an
      // extension-less mock path), quoting it as `'700x400'` reads
      // as if the dimension token were a meaningful identifier.
      // Drop the quoted identifier and surface the placeholder
      // signal as additive context so the agent can decide whether
      // the asset is real or stand-in.
      if (isPlaceholderImageSrc(src)) {
        return `SVG <image> is missing a text alternative — screen readers have no way to announce what the image represents (src looks like a placeholder image).`;
      }
      // `name` derives from a user-authored `src` URL/path — long
      // filenames (data URLs, signed URLs) would otherwise blow the
      // echo size; cap before interpolation.
      const name = truncateForEcho(filenameFromPath(src));
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
    // Same dimension-token-as-identifier concern as the SVG branch:
    // `<img src="http://placehold.it/700x400">` would otherwise
    // produce `<img> '700x400' is missing ...`, treating the
    // dimension blob as a meaningful name. Drop the quoted
    // identifier and surface the placeholder signal as additive
    // context.
    if (isPlaceholderImageSrc(src)) {
      return `<${tagName}> is missing a text alternative — screen readers will announce the file name or nothing at all (src looks like a placeholder image).`;
    }
    const name = truncateForEcho(filenameFromPath(src));
    return `<${tagName}> '${name}' is missing a text alternative — screen readers will announce the file name or nothing at all.`;
  }
  return `<${tagName}> has no text alternative — screen readers will announce nothing.`;
}

function buildSuggestion(kind: SurfaceKind, tagName: string, src: string | null): string {
  if (kind === "svg-image") {
    // `subject` is filename-derived and echoed inside an example
    // `<title>` value — same blow-up risk as above. Same dimensions-
    // as-alt antipattern guard as the `<img>` branch below: when the
    // basename is placeholder-shaped (`700x400.svg`, `placeholder.svg`,
    // `IMG_2026.svg`), echoing it back as a `<title>` example would
    // teach the very pattern `media/alt-text-placeholder` warns on.
    const placeholderShape = src ? isPlaceholderBasename(filenameFromPath(src)) : false;
    const subject =
      src && !placeholderShape
        ? truncateForEcho(guessSubject(filenameFromPath(src)))
        : "what the image shows";
    return `Add a <title> child with descriptive text (e.g., <title>${subject}</title>), or set aria-label / aria-labelledby on the <image>. If purely decorative, set role="presentation" or aria-hidden="true".`;
  }
  if (kind === "role-img") {
    return `This <${tagName}> has role="img" but no accessible name. Add aria-label describing the image, use aria-labelledby to point at visible text, or remove role="img" if the element is not actually conveying an image.`;
  }
  if (kind === "canvas") {
    return `Put descriptive fallback text inside the <canvas> element (assistive tech exposes canvas children when the bitmap is unreachable) and / or add aria-label describing what the canvas renders. If the canvas is purely decorative, mark it aria-hidden="true".`;
  }
  if (src) {
    // When the URL basename is itself placeholder-shaped (dimensions
    // like `700x400`, placehold filenames like `placeholder.png` /
    // `placehold.jpg`, bare numeric shapes like `1234` or
    // `IMG_2026.png`), the derived "subject" would round-trip into
    // `alt="700x400"` — the exact dimensions-as-alt antipattern that
    // ra11y's own `media/alt-text-placeholder` rule would flag.
    // Surface the generic prose form instead so we never teach a
    // pattern our own rules catch.
    const filename = filenameFromPath(src);
    if (isPlaceholderBasename(filename)) {
      return `Add alt describing what the image communicates — not the URL or its dimensions. If the image is purely decorative — the surrounding text already conveys the same information — mark it with alt="" instead.`;
    }
    const subject = truncateForEcho(guessSubject(filename));
    return `Add alt describing what the image communicates (e.g., alt="${subject}"). If the image is purely decorative — the surrounding text already conveys the same information — mark it with alt="" instead.`;
  }
  return `Add an alt attribute describing what the ${tagName} communicates. If the image is decorative, mark it with alt="" explicitly.`;
}

function filenameFromPath(src: string): string {
  // Strip query string + fragment so a URL like
  // `https://cdn.example.com/700x400?v=2#hero` resolves to `700x400`,
  // not `700x400?v=2#hero`. Both are URL grammar — the basename is
  // everything after the last path separator and before `?` / `#`.
  const noQuery = src.split(/[?#]/)[0] ?? src;
  const slash = Math.max(noQuery.lastIndexOf("/"), noQuery.lastIndexOf("\\"));
  return slash === -1 ? noQuery : noQuery.slice(slash + 1);
}

function guessSubject(filename: string): string {
  // Turn "chart-revenue-2026.png" into "chart revenue 2026" so the
  // suggestion reads like a sentence, not a file path.
  return filename
    .replace(/\.[a-zA-Z0-9]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/**
 * Sieves matching URL basenames whose derived "subject" would echo as
 * the dimensions-as-alt antipattern (`alt="700x400"`), the placeholder-
 * filename antipattern (`alt="placeholder"`), or a bare numeric blob
 * with no descriptive content (`alt="1234"`, `alt="IMG_2026"`).
 *
 * Patterns are evaluated against the basename WITH its extension
 * stripped — `placehold.it/700x400.png` → `700x400`. Each shape
 * documented inline.
 *
 * Doctrine: ra11y's own `media/alt-text-placeholder` rule warns on
 * `alt="placeholder"`, `alt="image"`, etc. — `suggest_fix` must not
 * teach an alt value its sibling rule would then flag. Generic
 * fallback prose ("describe what this image communicates") is the
 * honest answer; the agent reads the surrounding code to author the
 * real description.
 */
const PLACEHOLDER_BASENAME_PATTERNS: readonly RegExp[] = [
  // Dimensions: `700x400`, `1920X1080`, `48x48` — the canonical
  // placeholder-image-service shape (placehold.it, placeholder.com,
  // placehold.co, picsum.photos size suffixes). Whole-token match to
  // avoid catching subjects that happen to contain a dimension blob.
  /^\d+\s*[xX×]\s*\d+$/,
  // Placeholder-filename: `placeholder`, `placehold`, `placeholder1`,
  // `placehold-bg`. Word-prefix match — `placeholder-bg-blue` is
  // still placeholder filler regardless of suffix.
  /^placehold(?:er)?\b/i,
  // Bare numeric blob: `1234`, `2026`, `12-34`, `1234.56` — the
  // subject is just digits + light separators. `IMG_2026` and
  // `DSC04321` (camera-default filenames) match because the
  // descriptive payload is zero. The leading prefix is bounded to a
  // short alphabetic run so genuine names with embedded numbers
  // ("chart-2026") don't false-positive.
  /^(?:img|dsc|dscn|p|pic|photo|image|screenshot|screen|capture|untitled)?[\s_-]*\d{2,}[\s_.-]*\d*$/i,
  // Lorem-ipsum-shaped placeholders authored by mock data tools:
  // `lorem`, `ipsum`, `loremipsum`, `lorempixel-100x100`. Word-prefix
  // match.
  /^lorem(?:ipsum)?\b/i,
];

function isPlaceholderBasename(filename: string): boolean {
  const stripped = filename.replace(/\.[a-zA-Z0-9]+$/, "").trim();
  if (stripped.length === 0) return true;
  for (const pattern of PLACEHOLDER_BASENAME_PATTERNS) {
    if (pattern.test(stripped)) return true;
  }
  return false;
}

/**
 * Known placeholder-image hostnames. Hits any of these and the URL is
 * (by industry convention) a stand-in asset — no descriptive payload.
 * A subdomain match (`fastly.placehold.co`) counts; the suffix bound
 * keeps `myplacehold.it.example.com` from false-positiving.
 */
const PLACEHOLDER_IMAGE_HOSTS: readonly string[] = [
  "placehold.it",
  "placehold.co",
  "placeholder.com",
  "via.placeholder.com",
  "picsum.photos",
  "lorempixel.com",
  "loremflickr.com",
  "dummyimage.com",
  "unsplash.it",
];

/**
 * True when the `src` URL (or path) is shaped like a placeholder image
 * reference whose basename / host carries no descriptive payload.
 * Used by `buildMessage` to drop the quoted-identifier portion of the
 * reason text — quoting a dimension token like `'700x400'` as if it
 * named the asset misleads the agent reading the finding.
 *
 * Three triggers, evaluated in this order:
 *
 *   1. Known placeholder host (`placehold.it`, `via.placeholder.com`,
 *      `picsum.photos`, etc.) — the host alone is enough; path shape
 *      doesn't matter.
 *   2. Extension-less basename matching `/^\d+x\d+$/` — covers
 *      `placehold.it/700x400` and any CDN that serves a dimension-only
 *      path.
 *   3. Existing `isPlaceholderBasename` sieve — basename matches a
 *      placeholder-shaped pattern (dimensions with extension,
 *      `placeholder.png`, `IMG_2026.jpg`, lorem-ipsum filler, etc.).
 */
function isPlaceholderImageSrc(src: string): boolean {
  const host = hostFromUrl(src);
  if (host !== null) {
    for (const knownHost of PLACEHOLDER_IMAGE_HOSTS) {
      if (host === knownHost || host.endsWith(`.${knownHost}`)) return true;
    }
  }
  const filename = filenameFromPath(src);
  return isPlaceholderBasename(filename);
}

/**
 * Best-effort hostname extraction without `URL` (which would require
 * absolute URLs). Returns `null` for relative paths and anything that
 * doesn't look URL-shaped. Lowercase-normalized for host comparison.
 */
function hostFromUrl(src: string): string | null {
  // Accept `http://`, `https://`, and protocol-relative `//host/...`.
  const match = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^/?#]+)/.exec(src);
  if (match === null) return null;
  const host = match[1];
  if (host === undefined || host.length === 0) return null;
  // Strip user:pass@ and :port if present.
  const atIndex = host.lastIndexOf("@");
  const noAuth = atIndex === -1 ? host : host.slice(atIndex + 1);
  const colonIndex = noAuth.indexOf(":");
  const noPort = colonIndex === -1 ? noAuth : noAuth.slice(0, colonIndex);
  return noPort.toLowerCase();
}
