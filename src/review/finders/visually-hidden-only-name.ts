/**
 * Candidate finder: review/visually-hidden-only-name
 * Criteria: wcag22:2.4.4, wcag21:2.4.4
 * Spec: https://www.w3.org/TR/WCAG22/#link-purpose-in-context
 *
 * Surfaces interactive elements whose ONLY accessible-name source is a
 * `.visually-hidden` / `.sr-only` text node alongside an
 * `aria-hidden="true"` icon sibling. Canonical real-world shape (a
 * carousel previous / next control):
 *
 *     <a href="#prev">
 *       <span class="visually-hidden">Previous</span>
 *       <span aria-hidden="true" class="icon-prev"></span>
 *     </a>
 *
 * Sighted users see only the icon glyph (no text); assistive-tech users
 * hear only "Previous" — by design, the visually-hidden text IS the
 * accessible name. The pattern is legitimate WCAG-wise: the link has a
 * non-empty accessible name and screen readers will announce it.
 *
 * The reason this surfaces as a review candidate rather than passing
 * silently is the *cross-channel mismatch* between what sighted users
 * see (an icon glyph alone) and what AT users hear (a hidden word):
 *
 *   - The visible icon must be unambiguous on its own. A chevron
 *     pointing left + the hidden word "Previous" is fine; a generic
 *     diamond / cog / circle glyph + the hidden word "Edit" is not —
 *     sighted users are forced to guess.
 *   - The hidden text must match the action the icon represents. A
 *     hidden "Previous" alongside an icon class named `icon-next` is a
 *     copy-paste regression that shipping markup commonly carries.
 *   - The criterion-2.4.4 question (link purpose in context) turns on
 *     whether a sighted user can infer the destination — the icon
 *     affordance, the surrounding pagination / carousel widget, the
 *     visible page state.
 *
 * Per AI-first doctrine "Surface, don't suppress" the candidate frames
 * the question rather than asserts a violation. The agent reading the
 * file confirms whether the icon glyph reads as "previous", whether
 * the hidden text matches, and whether the surrounding widget already
 * makes the destination clear.
 *
 * Distinct from sibling finders:
 *
 *   - `review/pagination-glyph-accessible-name` fires when the SOLE
 *     visible text is a chevron / guillemet glyph (« » ‹ ›) and there
 *     is NO accessible name override at all (no aria-label, no
 *     visually-hidden child). That finder targets the "no name"
 *     failure; this finder targets the "name exists but only
 *     visually-hidden, alongside an aria-hidden icon" review case.
 *   - `aria/icon-child-missing-aria-hidden` fires the opposite way —
 *     icon-font children of an interactive element whose icon was NOT
 *     marked aria-hidden. The combination this finder targets is the
 *     well-formed one (text + icon both correctly partitioned), where
 *     the question is about the unobservable cross-channel match.
 *
 * Predicate (conservative):
 *   - Interactive element is `<a href>`, `<button>`, or
 *     `<input type="submit"|"button"|"image">`.
 *   - Element has no aria-label / aria-labelledby / title on the
 *     element itself (those would be the accessible name override and
 *     the visually-hidden child would be redundant — different
 *     question).
 *   - Element contains at least one descendant element with class
 *     containing one of {`sr-only`, `visually-hidden`, `visuallyhidden`,
 *     `screen-reader-only`, `screen-reader-text`, `screenreader-text`,
 *     `u-sr-only`, `u-visually-hidden`} carrying non-empty trimmed
 *     text — this is the "hidden accessible-name source."
 *   - Element contains at least one OTHER descendant element with
 *     `aria-hidden="true"` — this is the "visible icon."
 *   - The element's flat visible text (after excluding visually-hidden
 *     and aria-hidden subtrees) is empty — i.e. the visually-hidden
 *     text is the SOLE accessible-name source for sighted-vs-AT
 *     comparison purposes.
 *
 * Confidence `medium`: the static signal is concrete (interactive tag,
 * visually-hidden descendant with text, sibling aria-hidden descendant,
 * no accessible-name override), but the criterion question depends on
 * whether the icon affordance is unambiguous and whether the hidden
 * text matches the icon's intent — the agent's one Read of the
 * surrounding markup is the arbiter.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:2.4.4", "wcag21:2.4.4"] as const;

/**
 * Class tokens that mark an element as visually-hidden (present to AT,
 * absent to sighted users). Mirrors the shared convention used by
 * `pagination-glyph-accessible-name`, `images-of-text-sr-only`, and
 * `color/meaning-by-color-only`. Conservative — the sr-only-focusable
 * variants are included since they're functionally the same naming
 * channel during reading (the focusable variants un-hide on focus).
 */
const SR_ONLY_TOKENS: ReadonlySet<string> = new Set([
  "sr-only",
  "sr-only-focusable",
  "visually-hidden",
  "visually-hidden-focusable",
  "visuallyhidden",
  "screen-reader-only",
  "screen-reader-text",
  "screenreader-text",
  "screenreader-only",
  "u-sr-only",
  "u-visually-hidden",
]);

/** JSX tags treated as native `<a>` wrappers for cross-library coverage. */
const JSX_LINK_TAGS: ReadonlySet<string> = new Set(["a", "Link", "NavLink", "Anchor"]);

/** JSX tags treated as native `<button>` wrappers for cross-library coverage. */
const JSX_BUTTON_TAGS: ReadonlySet<string> = new Set(["button", "Button"]);

/** Input types that render as buttons (interactive without label children). */
const BUTTONLIKE_INPUT_TYPES: ReadonlySet<string> = new Set(["submit", "button", "image"]);

export const finder = defineCandidateFinder({
  id: "review/visually-hidden-only-name",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds interactive elements (a href, button, input type=submit/button/image) whose only accessible-name source is a visually-hidden / sr-only text node alongside an aria-hidden='true' icon sibling. Canonical shape: carousel previous / next controls — <a href='#prev'><span class='visually-hidden'>Previous</span><span aria-hidden='true' class='icon-prev'></span></a>.",
    reviewPrompt:
      "Verify that (a) the visible icon affordance is unambiguous on its own — a chevron pointing left reads 'previous'; a generic glyph (cog, diamond, circle) does not. And (b) the visually-hidden text matches the icon's intent — copy-paste regressions where the hidden text reads 'Previous' but the icon class names 'next' are common in shipped markup. The criterion-2.4.4 question turns on whether the link purpose is conveyed by the link text or its programmatically determined context — the surrounding widget (numbered pagination, carousel slides, visible page state) may already make the destination clear; if not, swap the icon for a labeled glyph or add a visible direction word alongside the icon.",
    references: [
      "https://www.w3.org/TR/WCAG22/#link-purpose-in-context",
      "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA8",
    ],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];
    if (ctx.language === "html") {
      findHtmlCandidates(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      findJsxCandidates(ctx.ast as TsxModule, ctx.filePath, ctx.wrappersForElement, candidates);
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
  for (const a of findHtmlElementsByTag(root, "a")) {
    if (!hasHtmlAttribute(a, "href")) continue;
    inspectHtmlInteractive(a, filePath, candidates);
  }
  for (const button of findHtmlElementsByTag(root, "button")) {
    inspectHtmlInteractive(button, filePath, candidates);
  }
  for (const input of findHtmlElementsByTag(root, "input")) {
    const type = (getHtmlAttribute(input, "type") ?? "").trim().toLowerCase();
    if (!BUTTONLIKE_INPUT_TYPES.has(type)) continue;
    // <input> has no children — its accessible name comes from value /
    // alt / aria-label, not from descendants. The visually-hidden +
    // aria-hidden combination this finder targets cannot exist on an
    // empty-element tag, so the loop body is intentionally skipped.
    // Kept here so the predicate set reads explicitly and a future
    // extension to `<input type="image">` icon variants stays local.
    void input;
  }
}

function inspectHtmlInteractive(
  element: HtmlElement,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  if (hasAccessibleNameOverrideHtml(element)) return;
  const hiddenText = visuallyHiddenTextHtml(element);
  if (!hiddenText) return;
  if (!hasAriaHiddenIconHtml(element)) return;
  if (visibleNonHiddenTextHtml(element).length > 0) return;
  pushCandidates(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    element.tagName.toLowerCase(),
    hiddenText,
  );
}

function hasAccessibleNameOverrideHtml(element: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(element, "aria-labelledby")) return true;
  const title = getHtmlAttribute(element, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

function visuallyHiddenTextHtml(element: HtmlElement): string | null {
  let found: string | null = null;
  const visit = (node: HtmlNode): void => {
    if (found !== null) return;
    if (node.kind !== "HtmlElement") return;
    if (isSrOnlyHtml(node)) {
      const text = htmlAllText(node).replace(/\s+/gu, " ").trim();
      if (text.length > 0) {
        found = text;
        return;
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return found;
}

function hasAriaHiddenIconHtml(element: HtmlElement): boolean {
  const visit = (node: HtmlNode): boolean => {
    if (node.kind !== "HtmlElement") return false;
    if (getHtmlAttribute(node, "aria-hidden") === "true") return true;
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  for (const child of element.children) {
    if (visit(child)) return true;
  }
  return false;
}

/**
 * Concatenates text-node descendants of `element`, EXCLUDING any
 * subtree whose root carries a visually-hidden class token OR
 * `aria-hidden="true"`. The result is the text a sighted user without
 * AT would actually see — the cross-channel comparison the criterion
 * question turns on.
 */
function visibleNonHiddenTextHtml(element: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") {
      chunks.push(node.value);
      return;
    }
    if (node.kind !== "HtmlElement") return;
    if (isSrOnlyHtml(node)) return;
    if (getHtmlAttribute(node, "aria-hidden") === "true") return;
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return chunks.join("").trim();
}

function htmlAllText(element: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") chunks.push(node.value);
    else if (node.kind === "HtmlElement") for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return chunks.join("");
}

function isSrOnlyHtml(element: HtmlElement): boolean {
  const classAttr = getHtmlAttribute(element, "class");
  if (!classAttr) return false;
  for (const tok of classAttr.split(/\s+/u)) {
    if (SR_ONLY_TOKENS.has(tok.toLowerCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function findJsxCandidates(
  module: TsxModule,
  filePath: string,
  wrappersForElement: ReadonlySet<string>,
  candidates: ReviewCandidate[],
): void {
  const linkWrappers = new Set<string>([...JSX_LINK_TAGS, ...wrappersForElement]);
  linkWrappers.delete("a");
  for (const a of findJsxElementsForTag(module, "a", linkWrappers)) {
    if (!(hasJsxAttribute(a, "href") || hasJsxAttribute(a, "to"))) continue;
    inspectJsxInteractive(a, filePath, candidates);
  }
  const buttonWrappers = new Set<string>([...JSX_BUTTON_TAGS, ...wrappersForElement]);
  buttonWrappers.delete("button");
  for (const button of findJsxElementsForTag(module, "button", buttonWrappers)) {
    inspectJsxInteractive(button, filePath, candidates);
  }
}

function inspectJsxInteractive(
  element: JsxElement,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  if (hasAccessibleNameOverrideJsx(element)) return;
  // A JSX expression child (`<a>{label}</a>`) makes the visible / hidden
  // partition opaque — we can't statically claim "only visually-hidden
  // text is present." Skip per the AI-first doctrine principle that
  // confidence-medium emissions need concrete static evidence.
  if (hasOpaqueExpressionChild(element)) return;
  const hiddenText = visuallyHiddenTextJsx(element);
  if (!hiddenText) return;
  if (!hasAriaHiddenIconJsx(element)) return;
  if (visibleNonHiddenTextJsx(element).length > 0) return;
  pushCandidates(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    element.tagName.toLowerCase(),
    hiddenText,
  );
}

function hasAccessibleNameOverrideJsx(element: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  const title = getJsxAttributeString(element, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

function hasOpaqueExpressionChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind === "JsxExpression") return true;
  }
  return false;
}

function visuallyHiddenTextJsx(element: JsxElement): string | null {
  let found: string | null = null;
  const visit = (node: JsxNode): void => {
    if (found !== null) return;
    if (node.kind !== "JsxElement") return;
    if (isSrOnlyJsx(node)) {
      const text = jsxAllText(node).replace(/\s+/gu, " ").trim();
      if (text.length > 0) {
        found = text;
        return;
      }
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return found;
}

function hasAriaHiddenIconJsx(element: JsxElement): boolean {
  const visit = (node: JsxNode): boolean => {
    if (node.kind !== "JsxElement") return false;
    if (getJsxAttributeString(node, "aria-hidden") === "true") return true;
    for (const child of node.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  for (const child of element.children) {
    if (visit(child)) return true;
  }
  return false;
}

function visibleNonHiddenTextJsx(element: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") {
      chunks.push(node.value);
      return;
    }
    if (node.kind !== "JsxElement") return;
    if (isSrOnlyJsx(node)) return;
    if (getJsxAttributeString(node, "aria-hidden") === "true") return;
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return chunks.join("").trim();
}

function jsxAllText(element: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") chunks.push(node.value);
    else if (node.kind === "JsxElement") for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return chunks.join("");
}

function isSrOnlyJsx(element: JsxElement): boolean {
  const classValue =
    getJsxAttributeString(element, "className") ?? getJsxAttributeString(element, "class");
  if (!classValue) return false;
  for (const tok of classValue.split(/\s+/u)) {
    if (SR_ONLY_TOKENS.has(tok.toLowerCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  tagName: string,
  hiddenText: string,
): void {
  const truncated = hiddenText.length <= 80 ? hiddenText : `${hiddenText.slice(0, 80)}…`;
  const reason =
    `<${tagName}> — visually-hidden text "${truncated}" is the only accessible name, ` +
    `paired with an aria-hidden="true" icon sibling. Verify that the visible icon affordance is ` +
    `unambiguous on its own (a directional chevron reads "previous"; a generic glyph does not), ` +
    `that the hidden text matches the icon's intent (copy-paste regressions where the hidden ` +
    `text says "Previous" but the icon class names "next" are common), and that the surrounding ` +
    `widget context already conveys the link purpose. If any of those fail, swap the icon for a ` +
    `labeled glyph or add a visible direction word alongside the icon.`;
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "medium",
    });
  }
}
