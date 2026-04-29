/**
 * Candidate finder: review/redundant-alt-text
 * Criteria: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * Surfaces `<img>` elements whose short alt text repeats text already
 * present in the surrounding markup (an immediate sibling text node, a
 * descendant live text node of the parent, or a sibling `<svg>`'s
 * `<text>`/`<tspan>` glyphs). The image's alt text is therefore
 * redundant with the visible page copy: a screen-reader user hears the
 * same words twice, and the alt is either decorative-by-intent (and
 * should be empty) or naming the image's visible content (and should
 * describe the image, not echo the label).
 *
 * Distinct from 1.4.5 (Images of Text): that finder asks whether the
 * image's pixels render text as glyphs (raster text). This finder asks
 * a 1.1.1 (Non-text Content) question — whether the alt-text alternative
 * is itself redundant or mis-aligned with the live text alongside it.
 * The two predicates were historically bundled under 1.4.5 in
 * `images-of-text.ts`; the 1.4.5 SC is about pixel-text, so the
 * alt-repeats-prose evidence migrated here under 1.1.1.
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { getHtmlAttribute, getJsxAttribute } from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxAttributeValue,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:1.1.1", "wcag21:1.1.1"] as const;

export const finder = defineCandidateFinder({
  id: "review/redundant-alt-text",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <img> elements whose short alt text is duplicated in adjacent live text — a redundant text alternative under WCAG 1.1.1 Non-text Content.",
    reviewPrompt:
      "Verify whether the image's alt text is genuinely redundant with adjacent live text. If the image is purely decorative and the visible text already conveys the meaning, replace alt= with the empty string (alt=''). If the image carries content the live text doesn't, rewrite alt= to describe the image rather than echo the surrounding label.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
      "https://www.w3.org/WAI/tutorials/images/decision-tree/",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    const isMarkdown = isMarkdownFilePath(ctx.filePath);
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, isMarkdown, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, candidates);
    }
    return candidates;
  },
});

// ---------------------------------------------------------------------------
// Markdown carve-out
// ---------------------------------------------------------------------------

/**
 * True when the file is routed through `parseMarkdown` (ADR 0025).
 * `.mdx` files don't qualify — they go through the TSX pipeline and
 * don't carry markdown link residue around `<img>` elements.
 */
function isMarkdownFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * After `parseMarkdown` rewrites `![alt](url)` to `<img>`, an outer
 * markdown link wrapping the image — `[![alt](src)](href)` — leaves
 * residue text `[<img>](href)` in the HTML stream. The marker `](`
 * (close-bracket + open-paren) is unambiguous markdown link syntax
 * and rare in plain prose; when an `<img>`'s adjacent sibling text
 * carries that marker the text is link residue, not page copy.
 * Captured case: jekyll README.markdown sponsor rows where each row's
 * URL slug (`/sponsor-N`) normalized to "sponsor N" and matched the
 * next `<img>`'s alt "Sponsor N+1" via the immediate-sibling
 * predicate.
 */
function containsMarkdownLinkSyntax(text: string): boolean {
  return text.includes("](");
}

// ---------------------------------------------------------------------------
// Block-level tag set (parent-text partition)
// ---------------------------------------------------------------------------

/**
 * HTML block-level tags whose descendant text the finder treats as
 * "labeled-photo pattern" rather than as redundant-alt evidence. See
 * {@link ParentText} for the full rationale. Inline tags (`<span>`,
 * `<a>`, `<em>`, `<strong>`, …) are deliberately NOT in this set: a
 * span next to an img sharing alt text is the canonical
 * "icon + label" / redundant-alt pattern, and we keep the signal
 * firing for that case (surface-don't-suppress floor).
 */
const HTML_BLOCK_LEVEL_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "caption",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "legend",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function isHtmlBlockLevelTag(tagName: string): boolean {
  return HTML_BLOCK_LEVEL_TAGS.has(tagName.toLowerCase());
}

function isJsxBlockLevelTag(tagName: string): boolean {
  // JSX preserves case; intrinsic HTML elements use lowercase tag
  // names. Custom components (e.g. `<Section>`) aren't block-level
  // for this predicate — component bodies are opaque to a static
  // walker, so treating them as inline preserves the surface-don't-
  // suppress floor.
  return HTML_BLOCK_LEVEL_TAGS.has(tagName);
}

/** Classifies a descendant `<svg>` by tag name (case-insensitive). */
function isSvgHtmlElement(element: HtmlElement): boolean {
  return element.tagName.toLowerCase() === "svg";
}

/** Classifies a descendant `<svg>` JSX element. Preserves case (JSX is XML-ish). */
function isSvgJsxElement(element: JsxElement): boolean {
  return element.tagName === "svg";
}

// ---------------------------------------------------------------------------
// HTML walker
// ---------------------------------------------------------------------------

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  isMarkdown: boolean,
  candidates: ReviewCandidate[],
): void {
  scanHtmlChildren(root.children, null, filePath, isMarkdown, candidates);
}

function scanHtmlChildren(
  children: readonly HtmlNode[],
  parentText: ParentText | null,
  filePath: string,
  isMarkdown: boolean,
  candidates: ReviewCandidate[],
): void {
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child?.kind !== "HtmlElement") continue;
    emitHtmlImageCandidate(child, children, index, parentText, filePath, isMarkdown, candidates);
    scanHtmlChildren(child.children, splitHtmlTextContent(child), filePath, isMarkdown, candidates);
  }
}

function emitHtmlImageCandidate(
  element: HtmlElement,
  siblings: readonly HtmlNode[],
  index: number,
  parentText: ParentText | null,
  filePath: string,
  isMarkdown: boolean,
  candidates: ReviewCandidate[],
): void {
  if (element.tagName.toLowerCase() !== "img") return;
  const alt = shortImageText(getHtmlAttribute(element, "alt"));
  if (!alt) return;
  const signal = repeatedTextSignal(alt, parentText, adjacentHtmlText(siblings, index, isMarkdown));
  if (signal === null) return;
  pushForAllCriteria(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    renderReason(signal),
  );
}

function adjacentHtmlText(
  siblings: readonly HtmlNode[],
  index: number,
  isMarkdown: boolean,
): readonly string[] {
  // `HtmlText.value` is already template-directive-stripped at parse
  // time; the defensive re-strip keeps the invariant local in case the
  // parser changes.
  //
  // Markdown carve-out: in `.md`/`.markdown` files (ADR 0025), an
  // outer markdown link wrapping an image — `[![alt](src)](href)` —
  // leaves residue text "[" / "](href)" adjacent to the synthesized
  // `<img>`. The slug isn't page copy, so a match against the alt
  // is not redundant-alt evidence — drop sibling text carrying the
  // `](` marker.
  const out: string[] = [];
  const previous = siblings[index - 1];
  if (previous?.kind === "HtmlText") {
    const text = stripTemplateDirectives(previous.value).value;
    if (!(isMarkdown && containsMarkdownLinkSyntax(text))) out.push(text);
  }
  const next = siblings[index + 1];
  if (next?.kind === "HtmlText") {
    const text = stripTemplateDirectives(next.value).value;
    if (!(isMarkdown && containsMarkdownLinkSyntax(text))) out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSX walker
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const element of root.jsxElements) {
    scanJsxElement(element, null, -1, null, filePath, candidates);
  }
}

function scanJsxElement(
  element: JsxElement,
  siblings: readonly JsxNode[] | null,
  index: number,
  parentText: ParentText | null,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  emitJsxImageCandidate(element, siblings, index, parentText, filePath, candidates);
  const currentText = splitJsxTextContent(element);
  for (let childIndex = 0; childIndex < element.children.length; childIndex++) {
    const child = element.children[childIndex];
    if (child?.kind !== "JsxElement") continue;
    scanJsxElement(child, element.children, childIndex, currentText, filePath, candidates);
  }
}

function emitJsxImageCandidate(
  element: JsxElement,
  siblings: readonly JsxNode[] | null,
  index: number,
  parentText: ParentText | null,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  if (element.tagName !== "img") return;
  const alt = shortImageText(literalJsxAttribute(element, "alt"));
  if (!alt) return;
  const signal = repeatedTextSignal(alt, parentText, adjacentJsxText(siblings, index));
  if (signal === null) return;
  pushForAllCriteria(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    renderReason(signal),
  );
}

function adjacentJsxText(siblings: readonly JsxNode[] | null, index: number): readonly string[] {
  if (!siblings || index < 0) return [];
  // JSX text-node values are NOT parser-stripped — the JSX tokenizer
  // breaks on `{`, which shears `{{ … }}` into fragments but leaves
  // ERB-style `<% … %>` intact (the `<` starts an element). Strip
  // defensively so no surviving directive reaches the match path.
  const out: string[] = [];
  const previous = siblings[index - 1];
  if (previous?.kind === "JsxText") out.push(stripTemplateDirectives(previous.value).value);
  const next = siblings[index + 1];
  if (next?.kind === "JsxText") out.push(stripTemplateDirectives(next.value).value);
  return out;
}

// ---------------------------------------------------------------------------
// Repeated-text predicate
// ---------------------------------------------------------------------------

/**
 * Decide which "alt repeats nearby text" variant to emit, if any.
 *
 * The parent-text corpus is partitioned by {@link splitHtmlTextContent}
 * (and its JSX sibling) into `liveText` — text inside an inline
 * descendant or a direct text child of the parent — `blockSiblingText`
 * — text inside a block-level descendant — and `svgText` — text inside
 * descendant `<svg>` subtrees.
 *
 * Match precedence mirrors how a human would read the snippet:
 *   1. Immediate-sibling HTML text nodes (closest visible text).
 *   2. Parent descendant live HTML text (inline-wrapped or direct).
 *   3. Parent descendant text *only* inside a sibling <svg> subtree.
 *
 * A match limited to `blockSiblingText` is the labeled-photo /
 * icon-with-block-label pattern — for the redundant-alt question it
 * still matters (the labeled-photo `<img alt="fly"><p>Fly</p>` IS
 * redundant alt vs. label), but the captured-case fix at
 * `<button class="choose-insect-btn"><img alt="fly"><p>Fly</p></button>`
 * shows the agent triages this differently from the inline-sibling
 * shape — the image is the button's representation, the `<p>` is its
 * caption, and replacing alt with the empty string would hide the
 * button's meaning. We keep the per-bucket precedence the
 * `images-of-text.ts` finder used historically (block-only matches
 * drop) so the migration is behavior-preserving relative to the
 * pre-existing rule shape.
 */
function repeatedTextSignal(
  alt: ImageText,
  parentText: ParentText | null,
  siblingText: readonly string[],
): string | null {
  for (const text of siblingText) {
    if (containsWholePhrase(text, alt.normalized)) {
      return `short alt text "${alt.raw}" is repeated in an immediate sibling text node`;
    }
  }
  if (!parentText) return null;
  if (containsWholePhrase(parentText.liveText, alt.normalized)) {
    return `short alt text "${alt.raw}" is repeated in surrounding text`;
  }
  if (containsWholePhrase(parentText.svgText, alt.normalized)) {
    return `short alt text "${alt.raw}" appears inside a sibling <svg> element's descendant text (\`<text>\`/\`<tspan>\`) — the alt text duplicates glyphs already painted by the SVG`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parent-text partition (HTML + JSX)
// ---------------------------------------------------------------------------

/**
 * Partitioned view of a parent element's descendant text:
 *   - `liveText` — direct text children of the parent OR text inside
 *     an inline (non-block-level) descendant. What CSS styles and a
 *     sighted user reads as page copy adjacent to the `<img>`.
 *   - `blockSiblingText` — text inside a descendant whose first
 *     ancestor-element back to the parent is block-level (`<p>`,
 *     `<h1-6>`, `<figcaption>`, `<div>`, `<section>`, …). The
 *     labeled-photo / icon-with-block-label pattern. Emission against
 *     this bucket is suppressed to mirror the historical behavior of
 *     the predicate when it lived under 1.4.5 — see captured case
 *     `<button><img alt="fly"><p>Fly</p></button>`.
 *   - `svgText` — text inside descendant `<svg>` subtrees. Glyphs
 *     painted by the SVG renderer, redundant with alt-text under 1.1.1.
 *
 * Per the AI-first consumer model the partition is provable from the
 * AST (block-level tag set is fixed; ancestry is deterministic).
 */
interface ParentText {
  readonly liveText: string;
  readonly blockSiblingText: string;
  readonly svgText: string;
}

interface ImageText {
  readonly raw: string;
  readonly normalized: string;
}

function splitHtmlTextContent(element: HtmlElement): ParentText {
  const live: string[] = [];
  const block: string[] = [];
  const svg: string[] = [];
  type Bucket = "live" | "block" | "svg";
  const sink = (bucket: Bucket): string[] =>
    bucket === "svg" ? svg : bucket === "block" ? block : live;
  const visit = (node: HtmlNode, bucket: Bucket): void => {
    if (node.kind === "HtmlText") {
      sink(bucket).push(stripTemplateDirectives(node.value).value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    const nextBucket: Bucket = bucket === "svg" || isSvgHtmlElement(node) ? "svg" : bucket;
    for (const child of node.children) visit(child, nextBucket);
  };
  for (const child of element.children) {
    if (child.kind === "HtmlText") {
      live.push(stripTemplateDirectives(child.value).value);
      continue;
    }
    if (child.kind !== "HtmlElement") continue;
    const startBucket: Bucket = isSvgHtmlElement(child)
      ? "svg"
      : isHtmlBlockLevelTag(child.tagName)
        ? "block"
        : "live";
    for (const grand of child.children) visit(grand, startBucket);
  }
  return {
    liveText: live.join("").trim(),
    blockSiblingText: block.join("").trim(),
    svgText: svg.join("").trim(),
  };
}

function splitJsxTextContent(element: JsxElement): ParentText {
  const live: string[] = [];
  const block: string[] = [];
  const svg: string[] = [];
  type Bucket = "live" | "block" | "svg";
  const sink = (bucket: Bucket): string[] =>
    bucket === "svg" ? svg : bucket === "block" ? block : live;
  const visit = (node: JsxNode, bucket: Bucket): void => {
    if (node.kind === "JsxText") {
      sink(bucket).push(stripTemplateDirectives(node.value).value);
      return;
    }
    if (node.kind !== "JsxElement") return;
    const nextBucket: Bucket = bucket === "svg" || isSvgJsxElement(node) ? "svg" : bucket;
    for (const child of node.children) visit(child, nextBucket);
  };
  for (const child of element.children) {
    if (child.kind === "JsxText") {
      live.push(stripTemplateDirectives(child.value).value);
      continue;
    }
    if (child.kind !== "JsxElement") continue;
    const startBucket: Bucket = isSvgJsxElement(child)
      ? "svg"
      : isJsxBlockLevelTag(child.tagName)
        ? "block"
        : "live";
    for (const grand of child.children) visit(grand, startBucket);
  }
  return {
    liveText: live.join("").trim(),
    blockSiblingText: block.join("").trim(),
    svgText: svg.join("").trim(),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Attribute values (`alt`, `aria-label`, `title`) are NOT stripped by
 * the parser — only text-node content is. So `<img alt="{{ entry.name }}">`
 * arrives here with the raw Liquid token intact, and if we echoed the
 * unstripped `raw` into the candidate's reason it would quote the
 * template expression at the agent. Run `stripTemplateDirectives` on
 * the attribute value first so the reason shows the rendered-text
 * shape, and so the normalized form used for matching isn't polluted
 * by directive tokens either.
 */
function shortImageText(value: string | null): ImageText | null {
  const stripped = value === null ? null : stripTemplateDirectives(value).value;
  const raw = collapseWhitespace(stripped);
  if (!raw) return null;
  const normalized = normalizeForMatch(raw);
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length < 1 || words.length > 5) return null;
  return { raw, normalized };
}

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

function collapseWhitespace(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeForMatch(value: string | null): string | null {
  const collapsed = collapseWhitespace(value);
  if (!collapsed) return null;
  const normalized = collapsed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function containsWholePhrase(haystack: string, needle: string): boolean {
  const normalized = normalizeForMatch(haystack);
  if (!normalized) return false;
  return ` ${normalized} `.includes(` ${needle} `);
}

function renderReason(signal: string): string {
  return `<img> ${signal} — verify the alt text is not redundant with adjacent live text; if it is, set alt='' for decorative or rewrite alt to describe the image.`;
}

function pushForAllCriteria(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
): void {
  // Confidence "low": pattern matching on short alt text repeated in
  // sibling/parent text. Biased toward false positives by design — the
  // finder is a prompt to confirm, not a failure claim. Per the AI-first
  // consumer model the candidate surfaces uniformly across the criterion
  // family so the agent ranks by criterion + reason.
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "low",
    });
  }
}
