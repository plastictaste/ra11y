/**
 * Candidate finder: review/decorative-img-with-adjacent-meaning
 * Criteria: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * Surfaces `<img alt="">` elements whose parent holds a short
 * (≤3-word) adjacent text sibling naming an affect/status/value
 * term from a hand-curated dictionary. The image is marked decorative
 * (alt=""), but an adjacent sibling names the image's meaning —
 * suggesting the visual conveys semantic content that `alt=""`
 * erases.
 *
 * Example:
 *   <div><img alt="" src="unhappy.svg"><small>Unhappy</small></div>
 *
 * Here the `<small>` text names what the decorative image depicts.
 * Either the image is genuinely redundant (the text already conveys
 * the meaning and the image is a presentation-layer duplicate — OK),
 * or the image carries the affect and `alt=""` hides it from AT
 * users. A reviewer confirms; the scanner cannot.
 *
 * Distinct from 1.4.5 (Images of Text): that finder asks whether the
 * image is text-baked-in-raster. This one asks whether an `alt=""`
 * decorative image is actually semantic, with the adjacent text as
 * the dismissal/verification signal.
 *
 * Review finder — biased toward false positives. Output is a
 * checklist of places to verify, not a list of failures. Per the
 * AI-first consumer model, the matched dictionary word is echoed in
 * the `reason` so the agent can triage in one read.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import { getHtmlAttribute, getJsxAttribute, walkHtmlElements } from "../../engine/ast-helpers.ts";
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
  for (const element of walkHtmlElements(root)) {
    const soleImg = soleEmptyAltImgHtml(element);
    if (!soleImg) continue;
    const matchedWord = matchAdjacentMeaningHtml(element, soleImg);
    if (!matchedWord) continue;
    pushCandidates(
      candidates,
      filePath,
      soleImg.loc.start.line,
      soleImg.loc.start.column,
      matchedWord,
    );
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
  for (const element of root.jsxElements) {
    walkJsxParents(element, filePath, candidates);
  }
}

function walkJsxParents(
  element: JsxElement,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  const soleImg = soleEmptyAltImgJsx(element);
  if (soleImg) {
    const matchedWord = matchAdjacentMeaningJsx(element, soleImg);
    if (matchedWord) {
      pushCandidates(
        candidates,
        filePath,
        soleImg.loc.start.line,
        soleImg.loc.start.column,
        matchedWord,
      );
    }
  }
  for (const child of element.children) {
    if (child.kind === "JsxElement") walkJsxParents(child, filePath, candidates);
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
  matchedWord: string,
): void {
  const reason = `image marked decorative but an adjacent sibling names its meaning ('${matchedWord}'); verify the image is truly redundant or populate alt= with the affect/status.`;
  for (const criterionId of CRITERION_IDS) {
    // Confidence "low": narrow static signal (single-img parent +
    // empty alt + short dictionary-matched sibling text). The
    // agent's one file read confirms whether the image carries
    // affect or is a presentation duplicate. Per AI-first: surface,
    // don't suppress; the dictionary word is echoed so triage
    // happens without opening the file.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "low",
    });
  }
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
