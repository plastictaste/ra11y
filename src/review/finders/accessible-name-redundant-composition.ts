/**
 * Candidate finder: review/accessible-name-redundant-composition
 * Criteria: wcag22:2.4.6, wcag21:2.4.6, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#headings-and-labels
 *       https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * Surfaces interactive elements (anchors, buttons) whose accessible
 * name is composed by concatenating a visually-hidden text node
 * (`.sr-only`, `.visually-hidden`, related tokens) with an `<img>`'s
 * `alt` attribute, where the resulting concatenation is redundant in
 * one of two provable ways:
 *
 *   1. A case-insensitive token appears more than once across the
 *      concatenated name. Canonical shape (the captured real-world
 *      logo-link case):
 *
 *          <a href="/">
 *            <span class="sr-only">Brand</span>
 *            <img src="logo.png" alt="Brand Logo">
 *          </a>
 *
 *      The accessible-name concatenation is "Brand Brand Logo" — the
 *      "Brand" token repeats, screen readers announce the duplicate.
 *
 *   2. The image's alt ends in a role-suffix word ("logo", "image",
 *      "icon", "button", "link") that AT announces automatically from
 *      the element's role. Adding "Logo" to an already-named brand
 *      mark, or "Image" to a thumbnail inside an `<a>`, is verbose
 *      noise — the role announcement covers the affordance.
 *
 * Why this surfaces as a review candidate (not an assertion): the
 * finder cannot know whether the duplicate-token concatenation is
 * intentional (e.g. SR-pronunciation preference, or the visible
 * `<span>` is a stylized-glyph fallback that's hidden in some media
 * queries) or wasteful. Per AI-first doctrine "Surface, don't
 * suppress" the candidate frames the question; the agent reading the
 * surrounding markup confirms whether the redundancy ships to
 * end-users or is a markup vestige.
 *
 * The finder deliberately does NOT compute the full WAI-ARIA
 * accessible-name algorithm — per "Don't duplicate capability the
 * agent already has", a simple visit-order concatenation of
 * sr-only-text + img-alt covers the canonical case (captured shape),
 * and the agent reads the file to verify the rest. Specifically:
 *
 *   - `aria-label` / `aria-labelledby` on the anchor/button OVERRIDES
 *     descendant-text computation. We skip the candidate when an
 *     accessible-name override is present — the override is the name,
 *     not the descendant concatenation.
 *   - `aria-hidden="true"` HIDES a subtree from AT entirely. Text
 *     inside an aria-hidden subtree is NOT part of the accessible
 *     name, so we ignore those subtrees during concatenation. (This
 *     is structurally why aria-hidden is not in the visually-hidden
 *     class-token set used here — the two patterns hide for different
 *     channels.)
 *   - Multiple sr-only siblings or multiple `<img>` children
 *     concatenate in document order; we tokenize and deduplicate
 *     across the concatenation before checking.
 *
 * Distinct from sibling finders:
 *
 *   - `review/visually-hidden-only-name` fires when sr-only text is
 *     the SOLE accessible-name source paired with `aria-hidden`
 *     icon — the cross-channel mismatch question (sighted users see
 *     icon-only; AT users hear hidden text). This finder asks the
 *     opposite: both an sr-only text AND a non-hidden `<img alt>`
 *     contribute to the name, and the concatenation is redundant.
 *   - `review/redundant-alt-text` fires on `<img>` whose short alt
 *     repeats text in adjacent SIBLING / parent live text. This
 *     finder fires on the specific composition where one half of the
 *     duplication is the visually-hidden text node and the other half
 *     is the same element's own alt — a different reading pattern.
 *
 * Confidence `medium`: the static signal is concrete (anchor/button,
 * sr-only descendant with text, img with alt, no override, no
 * aria-hidden on the contributing nodes). The criterion question
 * (whether the redundancy is intentional vs. vestigial) depends on
 * the agent's read of the surrounding markup.
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
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:2.4.6", "wcag21:2.4.6", "wcag22:4.1.2", "wcag21:4.1.2"] as const;

/**
 * Class tokens that mark an element as visually-hidden. Mirrors the
 * shared convention used by `visually-hidden-only-name`,
 * `pagination-glyph-accessible-name`, and `images-of-text-sr-only`.
 * The focusable variants are included since they're functionally the
 * same naming channel during reading.
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

/**
 * Trailing words on an `<img alt>` that AT already announces from the
 * element's surrounding role. A brand mark inside `<a href="/">` is
 * already announced as a link; appending "Logo" is verbose noise. An
 * icon inside a `<button>` is already announced as a button; appending
 * "Icon" or "Button" is verbose noise. Match is on the LAST whitespace-
 * separated token, case-insensitive — `"Brand Logo"` matches; `"Logo
 * Design"` does not.
 */
const ROLE_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  "logo",
  "image",
  "icon",
  "button",
  "link",
]);

/** JSX tags treated as native `<a>` wrappers for cross-library coverage. */
const JSX_LINK_TAGS: ReadonlySet<string> = new Set(["a", "Link", "NavLink", "Anchor"]);

/** JSX tags treated as native `<button>` wrappers for cross-library coverage. */
const JSX_BUTTON_TAGS: ReadonlySet<string> = new Set(["button", "Button"]);

export const finder = defineCandidateFinder({
  id: "review/accessible-name-redundant-composition",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx"] },
  docs: {
    description:
      "Finds anchors and buttons whose accessible name is composed by concatenating a visually-hidden / sr-only text node with an <img alt='…'> child, where the concatenation contains a case-insensitive duplicate token (canonical shape: <a><span class='sr-only'>Brand</span><img alt='Brand Logo'></a> → 'Brand Brand Logo') OR the alt ends in a role-suffix word (logo, image, icon, button, link) that AT already announces from the element's role.",
    reviewPrompt:
      "Verify whether the redundant token in the concatenated accessible name is intentional. If the visible <span> exists for a fallback / stylized rendering and the AT-announced duplicate is a vestige, drop the alt to '' for the decorative <img>, or rewrite the alt to describe content the sr-only text doesn't already carry. If the alt ends in a role-suffix (logo / image / icon / button / link), strip the suffix — AT announces the role automatically from the surrounding <a> / <button>.",
    references: [
      "https://www.w3.org/TR/WCAG22/#headings-and-labels",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html",
      "https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html",
      "https://www.w3.org/TR/accname-1.2/",
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
// HTML walker
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
}

function inspectHtmlInteractive(
  element: HtmlElement,
  filePath: string,
  candidates: ReviewCandidate[],
): void {
  if (hasAccessibleNameOverrideHtml(element)) return;
  const hidden = collectHtmlSrOnlyText(element);
  if (hidden.length === 0) return;
  const altTexts = collectHtmlImageAlts(element);
  if (altTexts.length === 0) return;
  const signal = redundancySignal(hidden, altTexts);
  if (signal === null) return;
  pushCandidates(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    element.tagName.toLowerCase(),
    signal,
  );
}

function hasAccessibleNameOverrideHtml(element: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasHtmlAttribute(element, "aria-labelledby")) return true;
  return false;
}

/**
 * Walks the descendant tree collecting trimmed text from elements
 * carrying an sr-only / visually-hidden class token. Skips any
 * subtree rooted at an `aria-hidden="true"` element — text inside
 * aria-hidden is not part of the accessible name. Returns one entry
 * per sr-only descendant in document order.
 */
function collectHtmlSrOnlyText(element: HtmlElement): readonly string[] {
  const out: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    if (getHtmlAttribute(node, "aria-hidden") === "true") return;
    if (isSrOnlyHtml(node)) {
      const text = htmlAllText(node).replace(/\s+/gu, " ").trim();
      if (text.length > 0) out.push(text);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return out;
}

/**
 * Walks the descendant tree collecting trimmed alt-text from `<img>`
 * elements. Skips any subtree rooted at an `aria-hidden="true"`
 * element. Returns one entry per qualifying image in document order.
 */
function collectHtmlImageAlts(element: HtmlElement): readonly string[] {
  const out: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    if (getHtmlAttribute(node, "aria-hidden") === "true") return;
    if (node.tagName.toLowerCase() === "img") {
      const rawAlt = getHtmlAttribute(node, "alt");
      if (rawAlt !== null) {
        const stripped = stripTemplateDirectives(rawAlt).value;
        const trimmed = stripped.replace(/\s+/gu, " ").trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return out;
}

function htmlAllText(element: HtmlElement): string {
  const chunks: string[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind === "HtmlText") chunks.push(stripTemplateDirectives(node.value).value);
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
// JSX walker
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
  const hidden = collectJsxSrOnlyText(element);
  if (hidden.length === 0) return;
  const altTexts = collectJsxImageAlts(element);
  if (altTexts.length === 0) return;
  const signal = redundancySignal(hidden, altTexts);
  if (signal === null) return;
  pushCandidates(
    candidates,
    filePath,
    element.loc.start.line,
    element.loc.start.column,
    element.tagName.toLowerCase(),
    signal,
  );
}

function hasAccessibleNameOverrideJsx(element: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (hasJsxAttribute(element, "aria-labelledby")) return true;
  return false;
}

function collectJsxSrOnlyText(element: JsxElement): readonly string[] {
  const out: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    if (getJsxAttributeString(node, "aria-hidden") === "true") return;
    if (isSrOnlyJsx(node)) {
      const text = jsxAllText(node).replace(/\s+/gu, " ").trim();
      if (text.length > 0) out.push(text);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return out;
}

function collectJsxImageAlts(element: JsxElement): readonly string[] {
  const out: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    if (getJsxAttributeString(node, "aria-hidden") === "true") return;
    if (node.tagName === "img") {
      const rawAlt = getJsxAttributeString(node, "alt");
      if (rawAlt !== null) {
        const stripped = stripTemplateDirectives(rawAlt).value;
        const trimmed = stripped.replace(/\s+/gu, " ").trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of element.children) visit(child);
  return out;
}

function jsxAllText(element: JsxElement): string {
  const chunks: string[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === "JsxText") chunks.push(stripTemplateDirectives(node.value).value);
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
// Redundancy predicate
// ---------------------------------------------------------------------------

interface RedundancySignal {
  readonly kind: "duplicate-token" | "role-suffix";
  readonly accessibleName: string;
  readonly evidence: string;
}

/**
 * Compute the concatenated accessible name (sr-only text + img alts in
 * document order) and decide whether it is redundant.
 *
 * Two predicates fire, checked in this precedence:
 *
 *   1. duplicate-token: case-insensitive whole-word duplication across
 *      the concatenated tokens. Punctuation and hyphenation are
 *      collapsed during normalization. Single-char and pure-digit
 *      tokens (`"a"`, `"1"`) are excluded so `"Page 1 of 1"` doesn't
 *      false-positive on the digit.
 *   2. role-suffix: the LAST sr-only-or-img token (i.e. the last word
 *      of the last alt) is one of {logo, image, icon, button, link}.
 *      AT announces the role from the surrounding `<a>` / `<button>`,
 *      so the suffix is verbose noise.
 *
 * Returns `null` when neither predicate fires — the candidate is not
 * surfaced. Per the AI-first floor, "almost-redundant" cases (the alt
 * shares zero tokens with sr-only text and doesn't end in a
 * role-suffix word) drop to silence rather than emit a low-evidence
 * candidate.
 */
function redundancySignal(
  hidden: readonly string[],
  altTexts: readonly string[],
): RedundancySignal | null {
  const concatenated = [...hidden, ...altTexts].join(" ");
  const accessibleName = concatenated.replace(/\s+/gu, " ").trim();
  if (accessibleName.length === 0) return null;

  const tokens = tokenizeForMatch(accessibleName);
  const duplicate = firstDuplicateToken(tokens);
  if (duplicate !== null) {
    return {
      kind: "duplicate-token",
      accessibleName,
      evidence: duplicate,
    };
  }

  const lastAlt = altTexts[altTexts.length - 1];
  if (lastAlt) {
    const altTokens = tokenizeForMatch(lastAlt);
    const last = altTokens[altTokens.length - 1];
    if (last && ROLE_SUFFIX_TOKENS.has(last)) {
      return {
        kind: "role-suffix",
        accessibleName,
        evidence: last,
      };
    }
  }

  return null;
}

/**
 * Lowercase the input, replace any non-alphanumeric run with a single
 * space, split on whitespace, drop single-character and pure-digit
 * tokens. Returns the surviving tokens in order.
 */
function tokenizeForMatch(value: string): readonly string[] {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  if (normalized.length === 0) return [];
  const out: string[] = [];
  for (const tok of normalized.split(" ")) {
    if (tok.length < 2) continue;
    if (/^[0-9]+$/.test(tok)) continue;
    out.push(tok);
  }
  return out;
}

function firstDuplicateToken(tokens: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (seen.has(tok)) return tok;
    seen.add(tok);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  tagName: string,
  signal: RedundancySignal,
): void {
  const truncated =
    signal.accessibleName.length <= 80
      ? signal.accessibleName
      : `${signal.accessibleName.slice(0, 80)}…`;
  const reason = renderReason(tagName, truncated, signal);
  for (const criterionId of CRITERION_IDS) {
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "medium",
    });
  }
}

function renderReason(tagName: string, accessibleName: string, signal: RedundancySignal): string {
  if (signal.kind === "duplicate-token") {
    return (
      `<${tagName}> — composed accessible name "${accessibleName}" repeats the token ` +
      `"${signal.evidence}" across a visually-hidden child and an <img alt="…">. ` +
      `Verify whether the duplicate is intentional (sometimes the visible <span> is a ` +
      `stylized fallback hidden in alternate media queries) or vestigial. If vestigial, ` +
      `set the <img>'s alt to '' for decorative, OR rewrite alt to describe content the ` +
      `sr-only text doesn't already carry.`
    );
  }
  return (
    `<${tagName}> — composed accessible name "${accessibleName}" ends in the role-suffix ` +
    `word "${signal.evidence}". Assistive tech announces the surrounding <${tagName}>'s role ` +
    `automatically (link / button), so appending "${signal.evidence}" duplicates the role ` +
    `announcement. Strip the trailing word from the <img>'s alt, OR set alt='' if the ` +
    `sr-only text already names the destination.`
  );
}
