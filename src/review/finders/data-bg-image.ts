/**
 * Candidate finder: review/data-bg-image
 * Criteria: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * Surfaces elements that bind a background image at runtime via a
 * `data-*` attribute whose value resolves to an image extension —
 * `<div data-src="path/to/hero.jpg">`, `<span data-bg="banner.png">`,
 * `<section data-background-image="cover.webp">`. The pattern is the
 * standard handoff between server-rendered markup and a client-side
 * lazy-loader (`yall.js`, `lazysizes`, hand-rolled IntersectionObserver
 * helpers, jQuery plugins) that reads the data attribute on hydration
 * and assigns `style.backgroundImage = url(...)` or sets the `<img>`
 * src after first paint.
 *
 * From the static scan's seat, the resulting CSS background image is
 * indistinguishable from any other CSS background — the rendered image
 * carries content semantics (the slide hero, the article cover, the
 * card thumbnail) but no `<img alt>` and no in-page accessible name
 * naming what the image depicts. WCAG 1.1.1 (Non-text Content) requires
 * a text alternative; the agent reading the cited file is the only
 * arbiter of whether `aria-label`, sibling text, or a visually-hidden
 * caption already supplies that alternative.
 *
 * Why a review candidate, not a hard rule:
 *
 *   - Static analysis cannot verify the runtime `<script>` actually
 *     consumes the `data-*` attribute (the lazy-loader may have been
 *     removed in a refactor and the attribute is now dead markup).
 *   - The accessible-name lookup we'd need is cross-element / cross-
 *     file (sibling `<h2>`, `aria-labelledby`, parent `<figure>` with
 *     `<figcaption>`). Per AI-first doctrine "Don't duplicate capability
 *     the agent already has," the finder points at the location and
 *     frames the question; the agent does the cross-context read.
 *
 * The matched data-attribute name and resolved image extension are
 * echoed in the `reason` so the agent can triage in one read.
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { walkHtmlElements, walkJsxElements } from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  JsxAttribute,
  JsxElement,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:1.1.1", "wcag21:1.1.1"] as const;

/**
 * Lowercase data-attribute names commonly used to bind a background
 * image at runtime. Matched case-insensitively at the call site.
 *
 * Chosen on the basis that each is a recognized convention — `data-src`
 * (yall.js, lazysizes, jQuery Lazy), `data-bg` / `data-background` /
 * `data-bg-image` / `data-background-image` (Bootstrap-flavored
 * components, hero-slider plugins, hand-rolled IntersectionObserver
 * helpers). Per AI-first doctrine "Surface, don't suppress" we surface
 * — never fuzz-match the attribute name. If a field report brings a
 * missing convention, extend this list; don't reach for prefixes.
 */
const DATA_ATTR_NAMES: ReadonlySet<string> = new Set([
  "data-src",
  "data-bg",
  "data-background",
  "data-bg-image",
  "data-background-image",
]);

/**
 * File extensions whose presence in the data-attribute value commits
 * us to "this is a background image, not an arbitrary URL." Matched
 * case-insensitively against the trailing path segment after stripping
 * a query / fragment.
 *
 * Conservative — we deliberately do NOT match `.css`, `.js`, `.html`,
 * or `.json` (which can also appear in `data-src=` for unrelated
 * deferred-load patterns). The agent reading a `data-src=` whose value
 * is a JSON manifest has the right next read, but it isn't this rule.
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
]);

/**
 * Element tags this finder considers candidates. Restricted to neutral
 * structural containers — `<div>`, `<span>`, `<section>`, `<article>`,
 * `<li>`, `<figure>`, `<a>`, `<button>` — because runtime background-
 * image binding fires almost exclusively on these shapes. Skipping
 * `<img>` is intentional: a `<img data-src>` is the standard lazy-load
 * pattern for actual images, where the eventual `src` attribute carries
 * a separate alt-text question handled by the existing 1.1.1 rules.
 */
const CANDIDATE_TAGS: ReadonlySet<string> = new Set([
  "div",
  "span",
  "section",
  "article",
  "li",
  "figure",
  "a",
  "button",
  "header",
  "aside",
  "main",
  "nav",
]);

export const finder = defineCandidateFinder({
  id: "review/data-bg-image",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds elements (e.g. <div>, <span>) whose data-* attributes (data-src, data-bg, data-background-image) resolve to an image extension — runtime-bound background images that have no static alt text or accessible name from the parser's view.",
    reviewPrompt:
      "The element's data-* attribute names a background image bound at runtime by a lazy-loader. Verify the rendered image carries an accessible text alternative — either an aria-label / aria-labelledby on this element, sibling text (e.g. an <h2> heading or visually-hidden caption) that names the image content, or a wrapping <figure> with a <figcaption>. If the image is purely decorative, mark it explicitly (role='presentation' or empty aria-label).",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
      "https://www.w3.org/WAI/tutorials/images/decision-tree/",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
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
  for (const element of walkHtmlElements(root)) {
    const tag = element.tagName.toLowerCase();
    if (!CANDIDATE_TAGS.has(tag)) continue;
    const match = matchDataImageAttributeHtml(element);
    if (!match) continue;
    const { line, column } = element.loc.start;
    pushCandidates(candidates, filePath, line, column, reason(tag, match.attrName, match.ext));
  }
}

interface AttributeMatch {
  readonly attrName: string;
  readonly ext: string;
}

function matchDataImageAttributeHtml(element: HtmlElement): AttributeMatch | null {
  for (const attr of element.attributes) {
    const lowered = attr.name.toLowerCase();
    if (!DATA_ATTR_NAMES.has(lowered)) continue;
    const ext = imageExtension(attr.value);
    if (!ext) continue;
    return { attrName: lowered, ext };
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const element of walkJsxElements(root)) {
    const tag = element.tagName;
    if (!CANDIDATE_TAGS.has(tag)) continue;
    const match = matchDataImageAttributeJsx(element);
    if (!match) continue;
    const { line, column } = element.loc.start;
    pushCandidates(candidates, filePath, line, column, reason(tag, match.attrName, match.ext));
  }
}

function matchDataImageAttributeJsx(element: JsxElement): AttributeMatch | null {
  for (const attr of element.attributes) {
    const lowered = attr.name.toLowerCase();
    if (!DATA_ATTR_NAMES.has(lowered)) continue;
    const literal = jsxAttributeLiteral(attr);
    if (literal === null) continue;
    const ext = imageExtension(literal);
    if (!ext) continue;
    return { attrName: lowered, ext };
  }
  return null;
}

/**
 * Resolves the literal string value of a JSX attribute. Returns null
 * for shorthand attributes and for expression values whose runtime
 * shape the parser cannot inspect — the agent reading a
 * `data-src={dynamicPath}` has the right next read, but the finder's
 * static evidence is too weak to commit on.
 */
function jsxAttributeLiteral(attr: JsxAttribute): string | null {
  if (!attr.value) return null;
  if (attr.value.kind === "StringLiteral") return attr.value.value;
  // `{"path/to/foo.jpg"}` and `{'path/to/foo.jpg'}` are common in JSX
  // when a project's lint rules require curly-brace attribute values;
  // they're still literal strings semantically.
  const trimmed = attr.value.raw.trim();
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Returns the lowercase image extension (with dot) when `value`
 * resolves to a path whose final segment ends in a known image
 * extension. Strips query / fragment first so a CDN URL with a
 * `?v=2` cache-buster still matches. Returns null otherwise.
 */
function imageExtension(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Strip query + fragment.
  const base = trimmed.split(/[?#]/, 1)[0] ?? "";
  // Trailing path segment.
  const lastSlash = base.lastIndexOf("/");
  const segment = lastSlash >= 0 ? base.slice(lastSlash + 1) : base;
  const lastDot = segment.lastIndexOf(".");
  if (lastDot < 0) return null;
  const ext = segment.slice(lastDot).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reasonText: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": the static signal (recognized data-attribute
    // name + image-extension value on a structural container) is tight
    // for the binding shape, but the criterion question is about the
    // accessible name, which lives elsewhere in the document or a
    // sibling file. The agent's one Read confirms whether aria-label /
    // sibling text / a wrapping figcaption supplies the alternative.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason: reasonText,
      confidence: "low",
    });
  }
}

function reason(tag: string, attrName: string, ext: string): string {
  return `<${tag} ${attrName}="…${ext}"> binds a background image at runtime — verify aria-label, sibling text, or a wrapping <figure>/<figcaption> describes the image content (or mark it presentation if purely decorative).`;
}
