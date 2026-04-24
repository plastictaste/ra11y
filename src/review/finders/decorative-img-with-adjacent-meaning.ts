/**
 * Candidate finder: review/decorative-img-with-adjacent-meaning
 * Criteria: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * Surfaces `<img alt="">` elements whose surrounding markup suggests
 * the image is actually content, not decoration. Two complementary
 * detection paths:
 *
 *   1. **Adjacent-meaning-word path** — sole `<img alt="">` whose
 *      parent holds a short (≤3-word) adjacent text sibling naming
 *      an affect/status/value term from a hand-curated dictionary.
 *      Example:
 *        <div><img alt="" src="unhappy.svg"><small>Unhappy</small></div>
 *      Here the `<small>` text names what the decorative image
 *      depicts.
 *
 *   2. **Content-card-container path** — `<img alt="">` lives inside
 *      a content-card-shaped container (`<li>`, `<figure>`, or
 *      `<div>`/`<section>`/`<article>` with a class token containing
 *      `slide`/`card`) whose descendants include a heading
 *      (`<h1>`-`<h6>`) or `<p>` with substantive text (≥4 words OR
 *      ≥20 chars). Example (hero-slider hero pattern):
 *        <li>
 *          <img alt="" src="img/slides/1.jpg" />
 *          <strong>Online Education</strong>
 *          <p>The best educational template</p>
 *        </li>
 *      The image is the visible content of the slide; marking it
 *      decorative is almost certainly wrong.
 *
 * Either way the image is genuinely redundant (the text already
 * conveys the meaning and the image is a presentation-layer
 * duplicate — OK), or the image carries semantic content and
 * `alt=""` hides it from AT users. A reviewer confirms; the scanner
 * cannot.
 *
 * Distinct from 1.4.5 (Images of Text): that finder asks whether the
 * image is text-baked-in-raster. This one asks whether an `alt=""`
 * decorative image is actually semantic, with the surrounding markup
 * (adjacent dictionary text or content-card structure) as the
 * dismissal/verification signal.
 *
 * Review finder — biased toward false positives. Output is a
 * checklist of places to verify, not a list of failures. Per the
 * AI-first consumer model, the matched dictionary word OR
 * container-shape signal is echoed in the `reason` so the agent can
 * triage in one read.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
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

/**
 * Affect/status/value dictionary — hand-curated, intentionally small.
 *
 * Chosen on the basis that the word, used as a short (≤3-word)
 * standalone label adjacent to a decorative image, is overwhelmingly
 * likely to be naming the image's semantic meaning (affect/status
 * badge patterns). Per the AI-first consumer model we surface —
 * never fuzz-match, never heuristic-expand. If field reports bring a
 * missing term, extend this list; don't reach for morphology.
 *
 * Kept case-insensitive at the match site.
 */
const MEANING_WORDS: ReadonlySet<string> = new Set([
  // affect
  "happy",
  "sad",
  "unhappy",
  "angry",
  "confused",
  "surprised",
  "worried",
  "excited",
  "neutral",
  "frustrated",
  "disappointed",
  // status
  "success",
  "successful",
  "warning",
  "error",
  "info",
  "loading",
  "failed",
  "fail",
  "passed",
  "pass",
  "pending",
  "completed",
  "complete",
  "done",
  "active",
  "inactive",
  "online",
  "offline",
  "ready",
  "blocked",
  "approved",
  "rejected",
  // value / polarity
  "positive",
  "negative",
  "good",
  "bad",
  "yes",
  "no",
  "on",
  "off",
]);

const MAX_TEXT_WORDS = 3;

export const finder = defineCandidateFinder({
  id: "review/decorative-img-with-adjacent-meaning",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <img alt=''> elements whose parent contains a short adjacent text node naming an affect/status/value term — the image is marked decorative but the neighbor labels its meaning.",
    reviewPrompt:
      "Verify that the decorative image is genuinely redundant with the adjacent text. If the image carries the affect or status (e.g. an emoji face named 'Unhappy'), the empty alt hides that meaning from AT users — populate alt= with the affect/status or move the meaning into the adjacent text. If the image is a true presentation-layer duplicate of the live text, the empty alt is correct.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html",
      "https://www.w3.org/WAI/tutorials/images/decorative/",
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
  // Track image locations already surfaced so the dictionary path
  // and the content-card path don't double-fire on the same <img>.
  const seen = new Set<string>();
  for (const element of walkHtmlElements(root)) {
    const soleImg = soleEmptyAltImgHtml(element);
    if (!soleImg) continue;
    const matchedWord = matchAdjacentMeaningHtml(element, soleImg);
    if (!matchedWord) continue;
    const key = locationKey(soleImg.loc.start.line, soleImg.loc.start.column);
    if (seen.has(key)) continue;
    seen.add(key);
    pushCandidates(
      candidates,
      filePath,
      soleImg.loc.start.line,
      soleImg.loc.start.column,
      reasonForDictionaryWord(matchedWord),
    );
  }
  // Content-card-container path: `<img alt="">` inside a content
  // card with a heading or substantive paragraph descendant.
  for (const container of walkHtmlElements(root)) {
    if (!isContentCardContainerHtml(container)) continue;
    const imgs = collectEmptyAltImgsHtml(container);
    if (imgs.length === 0) continue;
    const textSignal = substantiveTextSignalHtml(container);
    if (!textSignal) continue;
    for (const img of imgs) {
      const key = locationKey(img.loc.start.line, img.loc.start.column);
      if (seen.has(key)) continue;
      seen.add(key);
      pushCandidates(
        candidates,
        filePath,
        img.loc.start.line,
        img.loc.start.column,
        reasonForContentCard(container.tagName.toLowerCase(), textSignal),
      );
    }
  }
}

/**
 * Returns the one direct-child `<img>` element IFF the element has
 * exactly one `<img>` child AND that `<img>` has `alt=""` (explicit
 * empty string). Returns null otherwise — zero imgs, multiple imgs,
 * missing alt, or non-empty alt all fail the pattern.
 */
function soleEmptyAltImgHtml(parent: HtmlElement): HtmlElement | null {
  let found: HtmlElement | null = null;
  for (const child of parent.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "img") continue;
    if (found !== null) return null; // second img → not "sole"
    found = child;
  }
  if (!found) return null;
  const alt = getHtmlAttribute(found, "alt");
  // Explicit empty string. `null` means alt is absent — that's a
  // different defect (1.1.1 missing-alt rule handles it) and not
  // the "marked decorative" pattern this finder looks for.
  if (alt !== "") return null;
  return found;
}

/**
 * Walks the parent's direct children other than the image, collects
 * short text from text nodes and simple inline text elements, and
 * returns the first dictionary word matched (null otherwise).
 */
function matchAdjacentMeaningHtml(parent: HtmlElement, img: HtmlElement): string | null {
  for (const child of parent.children) {
    if (child === img) continue;
    const text = extractShortTextHtml(child);
    if (text === null) continue;
    const matched = matchMeaningWord(text);
    if (matched) return matched;
  }
  return null;
}

/**
 * Returns the text content of `node` IF it is a text node or a
 * simple inline-text element whose visible text is ≤ MAX_TEXT_WORDS
 * words after normalization. Returns null for comments, doctypes,
 * whitespace-only text, or elements whose aggregate text exceeds the
 * word cap. The narrow element allowlist deliberately covers the
 * affect/status badge patterns real-world UIs use; widening it
 * without evidence risks matching long-form prose that happens to
 * contain a dictionary word.
 */
function extractShortTextHtml(node: HtmlNode): string | null {
  if (node.kind === "HtmlText") {
    const stripped = stripTemplateDirectives(node.value).value;
    const collapsed = collapseWhitespace(stripped);
    if (!collapsed) return null;
    return collapsed;
  }
  if (node.kind !== "HtmlElement") return null;
  if (!TEXT_BEARING_HTML_TAGS.has(node.tagName.toLowerCase())) return null;
  const aggregate = htmlDescendantText(node);
  const collapsed = collapseWhitespace(aggregate);
  return collapsed;
}

function htmlDescendantText(element: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      chunks.push(stripTemplateDirectives(node.value).value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  const seen = new Set<string>();
  for (const element of root.jsxElements) {
    walkJsxParents(element, filePath, candidates, seen);
  }
  for (const element of root.jsxElements) {
    walkJsxContainers(element, filePath, candidates, seen);
  }
}

function walkJsxParents(
  element: JsxElement,
  filePath: string,
  candidates: ReviewCandidate[],
  seen: Set<string>,
): void {
  const soleImg = soleEmptyAltImgJsx(element);
  if (soleImg) {
    const matchedWord = matchAdjacentMeaningJsx(element, soleImg);
    if (matchedWord) {
      const key = locationKey(soleImg.loc.start.line, soleImg.loc.start.column);
      if (!seen.has(key)) {
        seen.add(key);
        pushCandidates(
          candidates,
          filePath,
          soleImg.loc.start.line,
          soleImg.loc.start.column,
          reasonForDictionaryWord(matchedWord),
        );
      }
    }
  }
  for (const child of element.children) {
    if (child.kind === "JsxElement") walkJsxParents(child, filePath, candidates, seen);
  }
}

function walkJsxContainers(
  element: JsxElement,
  filePath: string,
  candidates: ReviewCandidate[],
  seen: Set<string>,
): void {
  if (isContentCardContainerJsx(element)) {
    const imgs = collectEmptyAltImgsJsx(element);
    if (imgs.length > 0) {
      const textSignal = substantiveTextSignalJsx(element);
      if (textSignal) {
        for (const img of imgs) {
          const key = locationKey(img.loc.start.line, img.loc.start.column);
          if (seen.has(key)) continue;
          seen.add(key);
          pushCandidates(
            candidates,
            filePath,
            img.loc.start.line,
            img.loc.start.column,
            reasonForContentCard(element.tagName, textSignal),
          );
        }
      }
    }
  }
  for (const child of element.children) {
    if (child.kind === "JsxElement") walkJsxContainers(child, filePath, candidates, seen);
  }
}

function soleEmptyAltImgJsx(parent: JsxElement): JsxElement | null {
  let found: JsxElement | null = null;
  for (const child of parent.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName !== "img") continue;
    if (found !== null) return null;
    found = child;
  }
  if (!found) return null;
  const alt = literalJsxAttribute(found, "alt");
  if (alt !== "") return null;
  return found;
}

function matchAdjacentMeaningJsx(parent: JsxElement, img: JsxElement): string | null {
  for (const child of parent.children) {
    if (child === img) continue;
    const text = extractShortTextJsx(child);
    if (text === null) continue;
    const matched = matchMeaningWord(text);
    if (matched) return matched;
  }
  return null;
}

function extractShortTextJsx(node: JsxNode): string | null {
  if (node.kind === "JsxText") {
    const stripped = stripTemplateDirectives(node.value).value;
    const collapsed = collapseWhitespace(stripped);
    if (!collapsed) return null;
    return collapsed;
  }
  if (node.kind !== "JsxElement") return null;
  if (!TEXT_BEARING_JSX_TAGS.has(node.tagName)) return null;
  const aggregate = jsxDescendantText(node);
  const collapsed = collapseWhitespace(aggregate);
  return collapsed;
}

function jsxDescendantText(element: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      chunks.push(stripTemplateDirectives(node.value).value);
      return;
    }
    if (node.kind !== "JsxElement") return;
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Tag names whose content is short visible text in the affect/status
 * badge patterns we target. Lowercase for HTML matching; the JSX set
 * uses the same lowercase native-element tag names (JSX component
 * wrappers stay opaque — see the carousel-pattern finder for the
 * same policy).
 */
const TEXT_BEARING_TAGS: readonly string[] = [
  "small",
  "span",
  "p",
  "label",
  "b",
  "strong",
  "em",
  "i",
  "figcaption",
  "caption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
];

const TEXT_BEARING_HTML_TAGS: ReadonlySet<string> = new Set(TEXT_BEARING_TAGS);
const TEXT_BEARING_JSX_TAGS: ReadonlySet<string> = new Set(TEXT_BEARING_TAGS);

function matchMeaningWord(text: string): string | null {
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length < 1 || words.length > MAX_TEXT_WORDS) return null;
  for (const word of words) {
    if (MEANING_WORDS.has(word)) return word;
  }
  return null;
}

function collapseWhitespace(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeForMatch(value: string): string | null {
  const collapsed = collapseWhitespace(value);
  if (!collapsed) return null;
  const normalized = collapsed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": narrow static signal (single-img parent +
    // empty alt + short dictionary-matched sibling text, OR
    // empty-alt img inside a content-card container with a
    // substantive heading/paragraph descendant). The agent's one
    // file read confirms whether the image carries affect/content
    // or is a presentation duplicate. Per AI-first: surface, don't
    // suppress; the matched word or container-shape signal is
    // echoed so triage happens without opening the file.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "low",
    });
  }
}

function reasonForDictionaryWord(matchedWord: string): string {
  return `image marked decorative but an adjacent sibling names its meaning ('${matchedWord}'); verify the image is truly redundant or populate alt= with the affect/status.`;
}

function reasonForContentCard(containerTag: string, textSignal: string): string {
  return `image marked decorative but lives inside a content-card container (<${containerTag}>) with a heading/paragraph sibling ('${textSignal}'); the image likely IS the slide/card content — verify or populate alt= to describe the image.`;
}

function locationKey(line: number, column: number): string {
  return `${line}:${column}`;
}

/**
 * Literal-JSX-attribute resolver — same shape as the local helpers in
 * `images-of-text.ts` and `images-of-text-sr-only.ts`. Dynamic
 * expression values return null, which for `alt` means "we can't tell
 * it's empty" and the finder correctly skips — agents investigate
 * dynamic alt values themselves.
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

// ---------------------------------------------------------------------------
// Content-card-container helpers
// ---------------------------------------------------------------------------

/**
 * Tags whose semantic role is "card-shaped content slot" by HTML
 * convention (no class needed): `<li>` for slider/carousel slide
 * lists, `<figure>` for figure-with-caption shapes. A `<figure>`
 * with `<figcaption>` and a decorative-marked `<img>` is paradoxical
 * — the figcaption captions an image that supposedly carries no
 * meaning. WCAG 2.4.6 / authoring practice says the figure's image
 * should have alt text describing the image; review-finder territory.
 */
const CARD_TAGS_BY_NAME: ReadonlySet<string> = new Set(["li", "figure"]);

/**
 * Tags that become "card-shaped content slots" when their class
 * contains the word `slide` or `card`. Class-token convention is the
 * de facto signal across template ecosystems (Bootstrap `card`,
 * jQuery slider `slide`, Tailwind `card`/`slide-*`). Restricted to
 * the structural division tags so we don't fire on `<a class="card">`
 * or `<button class="slide">` where the parent semantics already
 * differ.
 */
const CARD_TAGS_BY_CLASS: ReadonlySet<string> = new Set(["div", "section", "article"]);

/** Heading/paragraph tags whose substantive text we treat as the card's content signal. */
const CONTENT_TEXT_TAGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p"]);

/** Substantive-text thresholds: "≥4 words OR ≥20 chars after collapsing whitespace." */
const SUBSTANTIVE_MIN_WORDS = 4;
const SUBSTANTIVE_MIN_CHARS = 20;

/** Echo cap for the substantive-text snippet — keep `reason` agent-readable. */
const SUBSTANTIVE_ECHO_MAX = 60;

function isContentCardContainerHtml(element: HtmlElement): boolean {
  const tag = element.tagName.toLowerCase();
  if (CARD_TAGS_BY_NAME.has(tag)) return true;
  if (!CARD_TAGS_BY_CLASS.has(tag)) return false;
  const classAttr = getHtmlAttribute(element, "class");
  return classHasCardOrSlideToken(classAttr);
}

function isContentCardContainerJsx(element: JsxElement): boolean {
  const tag = element.tagName;
  if (CARD_TAGS_BY_NAME.has(tag)) return true;
  if (!CARD_TAGS_BY_CLASS.has(tag)) return false;
  const classAttr = getJsxAttributeString(element, "className");
  return classHasCardOrSlideToken(classAttr);
}

/**
 * Token-substring match: the class string contains a whitespace-
 * separated token whose lowercase form contains `slide` or `card`.
 * Real templates use `card`, `card-body`, `slide`, `slide-item`,
 * `carousel-slide` — substring on each token catches the family
 * without overmatching identifiers like `placard` (which would only
 * match if it appeared as its own token, an edge case the agent can
 * dismiss in one read).
 */
function classHasCardOrSlideToken(classAttr: string | null): boolean {
  if (!classAttr) return false;
  const tokens = classAttr.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    if (!token) continue;
    if (token.includes("slide") || token.includes("card")) return true;
  }
  return false;
}

/** Collects every descendant `<img alt="">` (explicit empty string). */
function collectEmptyAltImgsHtml(root: HtmlElement): readonly HtmlElement[] {
  const imgs: HtmlElement[] = [];
  for (const el of walkHtmlElements(root)) {
    if (el === root) continue;
    if (el.tagName.toLowerCase() !== "img") continue;
    if (getHtmlAttribute(el, "alt") !== "") continue;
    imgs.push(el);
  }
  return imgs;
}

function collectEmptyAltImgsJsx(root: JsxElement): readonly JsxElement[] {
  const imgs: JsxElement[] = [];
  const visit = (el: JsxElement): void => {
    if (el !== root && el.tagName === "img") {
      if (literalJsxAttribute(el, "alt") === "") imgs.push(el);
    }
    for (const child of el.children) {
      if (child.kind === "JsxElement") visit(child);
    }
  };
  visit(root);
  return imgs;
}

/**
 * Returns a short echo of the first descendant heading or `<p>`
 * whose collapsed text meets the substantive threshold. Returns
 * null if no such descendant exists. The echo is capped so the
 * candidate `reason` stays terse for the agent.
 */
function substantiveTextSignalHtml(root: HtmlElement): string | null {
  for (const el of walkHtmlElements(root)) {
    if (el === root) continue;
    if (!CONTENT_TEXT_TAGS.has(el.tagName.toLowerCase())) continue;
    const aggregate = collapseWhitespace(htmlDescendantText(el));
    if (!aggregate) continue;
    if (!isSubstantive(aggregate)) continue;
    return truncateEcho(aggregate);
  }
  return null;
}

function substantiveTextSignalJsx(root: JsxElement): string | null {
  let result: string | null = null;
  const visit = (el: JsxElement): boolean => {
    if (el !== root && CONTENT_TEXT_TAGS.has(el.tagName)) {
      const aggregate = collapseWhitespace(jsxDescendantText(el));
      if (aggregate && isSubstantive(aggregate)) {
        result = truncateEcho(aggregate);
        return true;
      }
    }
    for (const child of el.children) {
      if (child.kind === "JsxElement" && visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return result;
}

function isSubstantive(text: string): boolean {
  if (text.length >= SUBSTANTIVE_MIN_CHARS) return true;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount >= SUBSTANTIVE_MIN_WORDS;
}

function truncateEcho(text: string): string {
  if (text.length <= SUBSTANTIVE_ECHO_MAX) return text;
  return `${text.slice(0, SUBSTANTIVE_ECHO_MAX - 1).trimEnd()}…`;
}
