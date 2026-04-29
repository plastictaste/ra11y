/**
 * Candidate finder: review/alt-duplicates-sibling-text
 * Criteria: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * Surfaces `<img alt="X">` elements that are descendants of an interactive
 * ancestor — `<button>`, `<a href>`, or `<a role="link">` — when a sibling
 * text node within that same interactive ancestor contains a case-
 * insensitive whitespace-trimmed match of `X`. The canonical real-world
 * shape:
 *
 *   <button class="choose-insect-btn">
 *     <p>Fly</p>
 *     <img alt="fly">
 *   </button>
 *
 * The button's accessible name is computed by concatenating descendant
 * text and the image's alt attribute — assistive tech announces "fly Fly,
 * button" (the alt repeats the visible label). The recommended fix is
 * `alt=""` so the image is treated as decorative and the button's
 * accessible name is the sibling text alone.
 *
 * Distinct from `review/redundant-alt-text`:
 *   - `redundant-alt-text` deliberately drops the block-sibling-only case
 *     (the labeled-photo / icon-with-block-label pattern) because outside
 *     an interactive ancestor the alt may carry meaning the visible block
 *     text doesn't. Inside `<button>` / `<a>` the calculus inverts — the
 *     interactive element's accessible name double-counts both.
 *   - This finder is the targeted complement: only fires when the
 *     duplicate-text predicate AND the interactive-ancestor predicate
 *     both hold.
 *
 * Why a review candidate, not a hard rule:
 *
 *   - Static analysis cannot verify the surrounding context — a
 *     `<button><p>Fly</p><img alt="fly"></button>` looks identical to
 *     `<button><span class="sr-only">Choose:</span> <p>Fly</p><img alt="fly"></button>`
 *     where `alt="fly"` actually carries the assistive-tech label and the
 *     visible "Fly" is decorative typography. The agent reading the cited
 *     file is the only correct arbiter.
 *   - Per AI-first doctrine "Heuristic emission is the symmetric twin of
 *     heuristic suppression," the predicate is provable from the AST
 *     (interactive ancestor + duplicate text) but the *fix recommendation*
 *     ("set alt=''") depends on whether the visible text is the intended
 *     accessible name — a question the candidate frames rather than
 *     decides.
 *
 * Predicate (conservative):
 *   - Element is `<img>` with a non-empty literal `alt` attribute.
 *   - The alt is short (≤5 normalized words) and not a generic placeholder
 *     ("image", "photo", "picture", etc. — those have their own rule).
 *   - Some ancestor in the chain is `<button>`, `<a href="…">`, or
 *     `<a role="link">`.
 *   - That interactive ancestor has descendant text content (excluding
 *     the `<img>` itself and any `aria-hidden="true"` subtrees) that
 *     contains a case-insensitive whitespace-collapsed match of the alt.
 *
 * The matched alt text and ancestor tag are echoed in the `reason` so the
 * agent can triage in one read.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
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
 * Generic medium / placeholder words. When the alt is one of these the
 * candidate is silenced — the `media/alt-text-placeholder` rule already
 * surfaces those at higher confidence as a deterministic finding. Per
 * AI-first doctrine "Surface, don't suppress" we don't double-emit on
 * the same predicate; the targeted finder is the right surface.
 *
 * The list mirrors the medium-word and authoring-placeholder fingerprints
 * in `src/rules/media/alt-text-placeholder.ts` (kept local to avoid
 * coupling — finders are pure data, not cross-imports of rule internals).
 */
const PLACEHOLDER_ALTS: ReadonlySet<string> = new Set([
  "image",
  "picture",
  "photo",
  "pic",
  "img",
  "screenshot",
  "graphic",
  "icon",
  "logo",
  "placeholder",
  "todo",
  "fixme",
  "alt",
  "alt text",
  "description",
]);

/**
 * Maximum word count for an alt that the finder considers. Beyond this
 * the alt is a sentence / phrase and the substring-in-sibling-text
 * predicate would over-fire (a long alt naturally shares words with
 * surrounding copy without the duplication question being live).
 */
const ALT_MAX_WORDS = 5;

export const finder = defineCandidateFinder({
  id: "review/alt-duplicates-sibling-text",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds <img alt='X'> descendants of <button>, <a href>, or <a role='link'> where a sibling text node within the same interactive ancestor contains a case-insensitive match of X — the interactive element's accessible name double-counts the alt.",
    reviewPrompt:
      "Verify whether the visible sibling text is the intended accessible name for the interactive element. If yes, set alt='' on the <img> so the image is treated as decorative and assistive tech announces only the visible label once. If the alt actually carries information the sibling text doesn't, rewrite it to describe the image (and consider whether the visible text is decorative).",
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
// HTML walker
// ---------------------------------------------------------------------------

/**
 * Tracks the nearest interactive ancestor on the walk down. Carries the
 * tag for the reason text and the ancestor element so the descendant-
 * text gather can run from a single root.
 */
interface InteractiveAncestor {
  readonly tag: string;
  readonly element: HtmlElement | JsxElement;
}

function findHtmlCandidates(
  root: HtmlDocument,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  walkHtml(root.children, null, filePath, candidates);
}

function walkHtml(
  children: readonly HtmlNode[],
  ancestor: InteractiveAncestor | null,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  for (const child of children) {
    if (child.kind !== "HtmlElement") continue;
    const tag = child.tagName.toLowerCase();
    // Image candidate emission — only when nested inside an interactive
    // ancestor.
    if (tag === "img" && ancestor) {
      emitHtmlCandidate(child, ancestor, filePath, candidates);
    }
    // Update ancestor for descendants. An inner interactive shadows an
    // outer one (the ARIA name calculation associates the image with
    // the closest enclosing interactive element).
    const nextAncestor = htmlInteractiveTag(child) ?? ancestor;
    walkHtml(child.children, nextAncestor, filePath, candidates);
  }
}

function htmlInteractiveTag(element: HtmlElement): InteractiveAncestor | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return { tag: "button", element };
  if (tag === "a") {
    if (hasHtmlAttribute(element, "href")) return { tag: "a", element };
    const role = getHtmlAttribute(element, "role");
    if (role !== null && role.trim().toLowerCase() === "link") {
      return { tag: "a", element };
    }
  }
  return null;
}

function emitHtmlCandidate(
  img: HtmlElement,
  ancestor: InteractiveAncestor,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  const alt = shortAltText(getHtmlAttribute(img, "alt"));
  if (!alt) return;
  if (PLACEHOLDER_ALTS.has(alt.normalized)) return;
  const siblingText = collectHtmlAncestorText(ancestor.element as HtmlElement, img);
  if (!textContainsAlt(siblingText, alt.normalized)) return;
  candidatePush(
    candidates,
    filePath,
    img.loc.start.line,
    img.loc.start.column,
    reason(ancestor.tag, alt.raw),
  );
}

/**
 * Concatenates descendant text of `ancestor` while skipping (a) the
 * cited `<img>` itself and (b) any subtree rooted at an element with
 * `aria-hidden="true"` (those nodes are silenced for assistive tech, so
 * their text doesn't participate in the accessible name calculation).
 */
function collectHtmlAncestorText(ancestor: HtmlElement, exclude: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      chunks.push(stripTemplateDirectives(node.value).value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    if (node === exclude) return;
    const ariaHidden = getHtmlAttribute(node, "aria-hidden");
    if (ariaHidden !== null && ariaHidden.trim().toLowerCase() === "true") return;
    for (const child of node.children) visit(child);
  };
  for (const child of ancestor.children) visit(child);
  return chunks.join(" ");
}

// ---------------------------------------------------------------------------
// JSX walker
// ---------------------------------------------------------------------------

function findJsxCandidates(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const element of root.jsxElements) {
    walkJsx(element, null, filePath, candidates);
  }
}

function walkJsx(
  element: JsxElement,
  ancestor: InteractiveAncestor | null,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  if (element.tagName === "img" && ancestor) {
    emitJsxCandidate(element, ancestor, filePath, candidates);
  }
  const nextAncestor = jsxInteractiveTag(element) ?? ancestor;
  for (const child of element.children) {
    if (child.kind === "JsxElement") {
      walkJsx(child, nextAncestor, filePath, candidates);
    }
  }
}

function jsxInteractiveTag(element: JsxElement): InteractiveAncestor | null {
  if (element.tagName === "button") return { tag: "button", element };
  if (element.tagName === "a") {
    if (hasJsxAttribute(element, "href")) return { tag: "a", element };
    const role = getJsxAttributeString(element, "role");
    if (role !== null && role.trim().toLowerCase() === "link") {
      return { tag: "a", element };
    }
  }
  return null;
}

function emitJsxCandidate(
  img: JsxElement,
  ancestor: InteractiveAncestor,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  const alt = shortAltText(literalJsxAttribute(img, "alt"));
  if (!alt) return;
  if (PLACEHOLDER_ALTS.has(alt.normalized)) return;
  const siblingText = collectJsxAncestorText(ancestor.element as JsxElement, img);
  if (!textContainsAlt(siblingText, alt.normalized)) return;
  candidatePush(
    candidates,
    filePath,
    img.loc.start.line,
    img.loc.start.column,
    reason(ancestor.tag, alt.raw),
  );
}

function collectJsxAncestorText(ancestor: JsxElement, exclude: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      chunks.push(stripTemplateDirectives(node.value).value);
      return;
    }
    if (node.kind !== "JsxElement") return;
    if (node === exclude) return;
    const ariaHidden = getJsxAttributeString(node, "aria-hidden");
    if (ariaHidden !== null && ariaHidden.trim().toLowerCase() === "true") return;
    for (const child of node.children) visit(child);
  };
  for (const child of ancestor.children) visit(child);
  return chunks.join(" ");
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface AltText {
  readonly raw: string;
  readonly normalized: string;
}

/**
 * Resolves the short, normalized alt text from a literal attribute value.
 * Returns null when the alt is empty (already correct), all-whitespace,
 * or longer than {@link ALT_MAX_WORDS} after collapsing whitespace.
 */
function shortAltText(value: string | null): AltText | null {
  if (value === null) return null;
  const stripped = stripTemplateDirectives(value).value;
  const raw = stripped.replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const normalized = normalizeForMatch(raw);
  if (!normalized) return null;
  const words = normalized.split(" ");
  if (words.length === 0 || words.length > ALT_MAX_WORDS) return null;
  return { raw, normalized };
}

function literalJsxAttribute(element: JsxElement, name: string): string | null {
  const attr = getJsxAttribute(element, name);
  if (!attr?.value) return null;
  return jsxLiteralString(attr.value);
}

function jsxLiteralString(value: JsxAttributeValue): string | null {
  if (value.kind === "StringLiteral") return value.value;
  // `{"foo"}` / `{'foo'}` — literal-via-curlies remains a literal
  // semantically. Any other expression shape (identifier, member access,
  // template literal, function call) is unverifiable and silenced per
  // the backlog's "skip alt={...} JSX expression" rule.
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

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when the normalized ancestor-text contains the normalized alt as
 * a whole-word run (not embedded inside a larger token).
 */
function textContainsAlt(haystack: string, needle: string): boolean {
  const normalized = normalizeForMatch(haystack);
  if (!normalized) return false;
  return ` ${normalized} `.includes(` ${needle} `);
}

function reason(ancestorTag: string, alt: string): string {
  return (
    `<img alt="${alt}"> is a descendant of <${ancestorTag}> and the alt text is repeated by sibling text inside the same interactive ancestor. ` +
    `The interactive element's accessible name concatenates the alt and the visible text — assistive tech announces the label twice. ` +
    `If the visible text is the intended accessible name, set alt="" so the image is treated as decorative. ` +
    `If the alt carries information the visible text doesn't, rewrite it to describe the image (and consider whether the visible text should be aria-hidden or removed).`
  );
}

function candidatePush(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reasonText: string,
): void {
  // Confidence "medium": the static signal is concrete (interactive
  // ancestor + literal alt + whole-word match in sibling text), but the
  // recommended fix turns on whether the visible text is the intended
  // accessible name — a question the agent's one Read confirms. Per the
  // AI-first consumer model, the candidate frames the question rather
  // than asserts the violation.
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason: reasonText,
      confidence: "medium",
    });
  }
}
