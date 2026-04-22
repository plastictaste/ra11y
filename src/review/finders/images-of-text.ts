/**
 * Candidate finder: review/images-of-text
 * Criteria: wcag22:1.4.5, wcag21:1.4.5, section508:1.4.5, en301549:9.1.4.5,
 *           wcag22:1.4.9, wcag21:1.4.9 (AAA — "Images of Text (No Exception)")
 * Spec: https://www.w3.org/TR/WCAG22/#images-of-text
 *       https://www.w3.org/TR/WCAG22/#images-of-text-no-exception
 *
 * Surfaces `<img>` elements that look like baked-in text:
 *   - short alt text (1-5 words) repeated in surrounding visible text
 *   - class/src names suggesting logo, banner, heading, title, or header art
 *
 * WCAG 1.4.5 permits images of text only when the presentation is
 * essential or customizable. A static finder cannot decide whether an
 * image is actually required, but it can highlight places where text
 * appears likely to be embedded in raster artwork.
 *
 * Review finder — biased toward false positives. Output is a checklist
 * of places to verify, not a list of failures.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { getHtmlAttribute, getJsxAttribute } from "../../engine/ast-helpers.ts";
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

const CRITERION_IDS = [
  "wcag22:1.4.5",
  "wcag21:1.4.5",
  "section508:1.4.5",
  "en301549:9.1.4.5",
  // 1.4.9 is the AAA "no exception" variant. Detection signal is
  // identical — the question "is this text baked into an image?" is the
  // same; only the permitted-exceptions answer-space differs. At AAA a
  // logotype is no longer an exception, so every candidate demands
  // review, not just ones that look non-logo.
  "wcag22:1.4.9",
  "wcag21:1.4.9",
] as const;

const IMAGE_OF_TEXT_HINT = /\b(logo|banner|heading|title|header)\b/;

export const finder = defineCandidateFinder({
  id: "review/images-of-text",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <img> elements whose short alt text is duplicated in surrounding text, or whose src/class names suggest logo/banner/heading/title/header artwork.",
    reviewPrompt:
      "Verify the highlighted image is not conveying text that should instead be real HTML text styled with CSS. If the image is a true logo, brand mark, or otherwise essential presentation, document that exception. Otherwise confirm equivalent live text is available and the image is not the only way the words are presented.",
    references: [
      "https://www.w3.org/TR/WCAG22/#images-of-text",
      "https://www.w3.org/WAI/WCAG22/Understanding/images-of-text.html",
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

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  scanHtmlChildren(root.children, null, filePath, candidates);
}

function scanHtmlChildren(
  children: readonly HtmlNode[],
  parentText: ParentText | null,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (child?.kind !== "HtmlElement") continue;
    emitHtmlImageCandidate(child, children, index, parentText, filePath, candidates);
    scanHtmlChildren(child.children, splitHtmlTextContent(child), filePath, candidates);
  }
}

function emitHtmlImageCandidate(
  element: HtmlElement,
  siblings: readonly HtmlNode[],
  index: number,
  parentText: ParentText | null,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  if (element.tagName.toLowerCase() !== "img") return;
  const alt = shortImageText(getHtmlAttribute(element, "alt"));
  const classVal = getHtmlAttribute(element, "class");
  const srcVal = getHtmlAttribute(element, "src");
  const signals = collectSignals(
    alt,
    parentText,
    adjacentHtmlText(siblings, index),
    keywordHint(classVal, srcVal),
  );
  if (signals.length === 0) return;
  pushForAllCriteria(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    renderReason(signals),
    logoLike(classVal, srcVal),
    svgDataUriTextFreeHint(srcVal),
  );
}

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
  const classVal =
    literalJsxAttribute(element, "className") ?? literalJsxAttribute(element, "class");
  const srcVal = literalJsxAttribute(element, "src");
  const signals = collectSignals(
    alt,
    parentText,
    adjacentJsxText(siblings, index),
    keywordHint(classVal, srcVal),
  );
  if (signals.length === 0) return;
  pushForAllCriteria(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    renderReason(signals),
    logoLike(classVal, srcVal),
    svgDataUriTextFreeHint(srcVal),
  );
}

function adjacentHtmlText(siblings: readonly HtmlNode[], index: number): readonly string[] {
  const out: string[] = [];
  const previous = siblings[index - 1];
  if (previous?.kind === "HtmlText") out.push(previous.value);
  const next = siblings[index + 1];
  if (next?.kind === "HtmlText") out.push(next.value);
  return out;
}

function adjacentJsxText(siblings: readonly JsxNode[] | null, index: number): readonly string[] {
  if (!siblings || index < 0) return [];
  const out: string[] = [];
  const previous = siblings[index - 1];
  if (previous?.kind === "JsxText") out.push(previous.value);
  const next = siblings[index + 1];
  if (next?.kind === "JsxText") out.push(next.value);
  return out;
}

function collectSignals(
  alt: ImageText | null,
  parentText: ParentText | null,
  siblingText: readonly string[],
  keywordSignal: string | null,
): readonly string[] {
  const signals: string[] = [];
  const repeatedText = repeatedTextSignal(alt, parentText, siblingText);
  if (repeatedText) signals.push(repeatedText);
  if (keywordSignal) signals.push(keywordSignal);
  return signals;
}

/**
 * Decide which "alt repeats nearby text" variant to emit, if any.
 *
 * The parent-text corpus is partitioned by {@link splitHtmlTextContent}
 * (and its JSX sibling) into `liveText` — text nodes outside any
 * descendant <svg> subtree — and `svgText` — text nodes inside
 * descendant <svg> subtrees. The partition matters because `<text>`
 * and `<tspan>` inside an `<svg>` are painted as glyphs, not rendered
 * as CSS-styled HTML text. When the `<img>`'s short alt attribute
 * appears only inside the `<svg>` corpus, claiming the alt is
 * "repeated in surrounding text" misleads the agent into believing
 * the page already has the equivalent styled HTML text that 1.4.5
 * would want as the remedy — it does not; the match is itself another
 * potential image-of-text surface.
 *
 * Match precedence mirrors how a human would read the snippet:
 *   1. Immediate-sibling HTML text nodes (closest visible text).
 *   2. Parent descendant live HTML text.
 *   3. Parent descendant text *only* inside a sibling <svg> subtree.
 *
 * The candidate is surfaced in every case — per the AI-first consumer
 * model ("Surface, don't suppress"). Only the reason phrasing
 * changes, so the agent can triage without the misleading "equivalent
 * styled text is already present" framing when the only match lives
 * inside an SVG.
 */
function repeatedTextSignal(
  alt: ImageText | null,
  parentText: ParentText | null,
  siblingText: readonly string[],
): string | null {
  if (!alt) return null;
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
    return `short alt text "${alt.raw}" appears inside a sibling <svg> element's descendant text (\`<text>\`/\`<tspan>\`) — that SVG may itself be an image of text; the match is not equivalent live HTML text`;
  }
  return null;
}

function keywordHint(classValue: string | null, srcValue: string | null): string | null {
  const classKeyword = keywordMatch(classValue);
  if (classKeyword) return `class suggests "${classKeyword}" artwork`;
  const srcKeyword = keywordMatch(fileNameFromPath(srcValue));
  if (srcKeyword) return `src filename suggests "${srcKeyword}" artwork`;
  return null;
}

function keywordMatch(value: string | null): string | null {
  const normalized = normalizeForMatch(value);
  if (!normalized) return null;
  const match = normalized.match(IMAGE_OF_TEXT_HINT);
  return match?.[1] ?? null;
}

function fileNameFromPath(value: string | null): string | null {
  if (value === null) return null;
  const path = value.split("?")[0]?.split("#")[0] ?? value;
  const parts = path.split("/");
  return parts[parts.length - 1] ?? null;
}

function containsWholePhrase(haystack: string, needle: string): boolean {
  const normalized = normalizeForMatch(haystack);
  if (!normalized) return false;
  return ` ${normalized} `.includes(` ${needle} `);
}

function shortImageText(value: string | null): ImageText | null {
  const raw = collapseWhitespace(value);
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

function renderReason(signals: readonly string[]): string {
  return `<img> ${signals.join("; ")} — verify text is not baked into the image when equivalent styled HTML text could be used`;
}

function pushForAllCriteria(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
  logoLikelyExempt: boolean,
  svgDataUriHint: string | null,
): void {
  for (const criterionId of CRITERION_IDS) {
    const withLogoHint =
      logoLikelyExempt && criterionAllowsLogotypeExemption(criterionId)
        ? `${reason} — if this is a logo or brand mark, WCAG 1.4.5 has a logotype exemption (essential presentation); the AAA "no exception" variant (1.4.9) still applies`
        : reason;
    const augmented = svgDataUriHint ? `${withLogoHint} ${svgDataUriHint}` : withLogoHint;
    // Confidence "low": alt/className/src pattern matching on
    // "logo"/"banner"/"heading" tokens and short-alt-duplicated-in-text
    // heuristics. Biased toward false positives by design (see
    // docstring); the finder is a prompt to confirm, not a failure
    // claim.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason: augmented,
      confidence: "low",
    });
  }
}

/**
 * True for criteria that carry the logotype exemption baked into their
 * normative text. 1.4.5 and its Section 508 / EN 301 549 equivalents
 * exempt "text that is part of a logo or brand name"; 1.4.9 is the AAA
 * "No Exception" variant and therefore does NOT exempt logos. Per
 * CLAUDE.md § 1 we never suppress based on this heuristic — the hint
 * is added to `reason` text so the agent can verify in one read.
 */
function criterionAllowsLogotypeExemption(criterionId: string): boolean {
  return criterionId !== "wcag22:1.4.9" && criterionId !== "wcag21:1.4.9";
}

/**
 * Returns true when the image's class or src filename contains a
 * word ra11y classifies as logo-like. Keeps the heuristic inline so
 * the caller can pass the boolean to `pushForAllCriteria` without
 * re-parsing the attributes. Other keywords we match on (banner,
 * heading, title, header) don't earn the exemption hint — a banner
 * with text is exactly the 1.4.5 failure pattern.
 */
function logoLike(classValue: string | null, srcValue: string | null): boolean {
  return (
    isLogoKeyword(keywordMatch(classValue)) ||
    isLogoKeyword(keywordMatch(fileNameFromPath(srcValue)))
  );
}

function isLogoKeyword(match: string | null): boolean {
  return match === "logo";
}

/**
 * When `src` is a `data:image/svg+xml,...` URI, decode the SVG payload
 * (percent-escapes only) and check whether it contains `<text` or
 * `<tspan` tokens. If neither appears, return an additive reason-text
 * suffix noting that the text-baked-in concern is provably lower on
 * deterministic evidence — path-only SVGs still *can* render text glyphs
 * via path data, so the suffix is guidance for the agent to verify in
 * one read, not a suppression signal. Per the AI-first consumer model
 * (docs/kb/architecture/ai-first-consumer.md) the candidate still emits
 * at the same confidence; only the reason text is enriched. Returns
 * null for non-SVG-data-URI sources, non-decodable payloads, or
 * payloads that do contain `<text>`/`<tspan>`.
 */
function svgDataUriTextFreeHint(srcValue: string | null): string | null {
  if (srcValue === null) return null;
  const trimmed = srcValue.trim();
  if (!/^data:image\/svg\+xml/i.test(trimmed)) return null;
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) return null;
  const header = trimmed.slice(0, commaIndex).toLowerCase();
  // Base64-encoded SVGs aren't in scope — only the percent-encoded
  // form the backlog item references (`data:image/svg+xml,...%3C...`)
  // is decoded here; we return null on base64 so no misleading claim
  // is made about a payload we didn't inspect.
  if (header.includes(";base64")) return null;
  const payload = trimmed.slice(commaIndex + 1);
  const decoded = percentDecode(payload);
  if (decoded === null) return null;
  if (/<text[\s/>]/i.test(decoded) || /<tspan[\s/>]/i.test(decoded)) return null;
  return "(note: `src` is a `data:image/svg+xml` URI with no `<text>`/`<tspan>` tokens in the payload — text-baked-in concern is provably lower, but verify the SVG isn't rendering text glyphs directly in path data)";
}

/**
 * Best-effort percent-decode. Returns the input with `%XX` escapes
 * replaced by their byte values (interpreted as UTF-8 via
 * decodeURIComponent). On malformed input (lone `%`, non-hex digits
 * that decodeURIComponent rejects) returns null rather than throwing —
 * the caller treats null as "couldn't inspect, don't annotate."
 */
function percentDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

interface ImageText {
  readonly raw: string;
  readonly normalized: string;
}

/**
 * Partitioned view of a parent element's descendant text. `liveText`
 * is the concatenation of text nodes outside any descendant `<svg>`
 * subtree — this is what CSS styles and what a sighted user reads as
 * page copy. `svgText` is the concatenation of text nodes inside
 * descendant `<svg>` subtrees — glyphs painted by the SVG renderer,
 * which from a 1.4.5 perspective are closer to an image-of-text than
 * to the "equivalent styled text" remedy.
 *
 * The split lets `repeatedTextSignal` emit a different reason variant
 * when an `<img>`'s short alt appears only in the `svgText` half — so
 * the agent isn't told live HTML text equivalence exists when it
 * doesn't. See docs/kb/architecture/ai-first-consumer.md ("Review
 * candidates, not assertions" + "Enrich reason with dismissal signal").
 */
interface ParentText {
  readonly liveText: string;
  readonly svgText: string;
}

/** Classifies a descendant `<svg>` by tag name (case-insensitive). */
function isSvgHtmlElement(element: HtmlElement): boolean {
  return element.tagName.toLowerCase() === "svg";
}

/** Classifies a descendant `<svg>` JSX element. Preserves case (JSX is XML-ish). */
function isSvgJsxElement(element: JsxElement): boolean {
  return element.tagName === "svg";
}

/**
 * Walk the element's descendants concatenating text nodes into two
 * buckets. A text node's bucket is determined by whether any ancestor
 * between it and `element` (exclusive) is an `<svg>` — if yes, the
 * text is classified as `svgText`; otherwise `liveText`. Matches the
 * contract of {@link htmlTextContent} (trimmed concatenation of
 * descendant text) but with the partitioning needed by the
 * images-of-text finder.
 */
function splitHtmlTextContent(element: HtmlElement): ParentText {
  const live: string[] = [];
  const svg: string[] = [];
  const visit = (node: HtmlNode, insideSvg: boolean): void => {
    if (node.kind === "HtmlText") {
      (insideSvg ? svg : live).push(node.value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    const nextInsideSvg = insideSvg || isSvgHtmlElement(node);
    for (const child of node.children) visit(child, nextInsideSvg);
  };
  for (const child of element.children) visit(child, false);
  return { liveText: live.join("").trim(), svgText: svg.join("").trim() };
}

/** JSX counterpart to {@link splitHtmlTextContent}. */
function splitJsxTextContent(element: JsxElement): ParentText {
  const live: string[] = [];
  const svg: string[] = [];
  const visit = (node: JsxNode, insideSvg: boolean): void => {
    if (node.kind === "JsxText") {
      (insideSvg ? svg : live).push(node.value);
      return;
    }
    if (node.kind !== "JsxElement") return;
    const nextInsideSvg = insideSvg || isSvgJsxElement(node);
    for (const child of node.children) visit(child, nextInsideSvg);
  };
  for (const child of element.children) visit(child, false);
  return { liveText: live.join("").trim(), svgText: svg.join("").trim() };
}
