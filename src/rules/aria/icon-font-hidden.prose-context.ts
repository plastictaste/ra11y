/**
 * Sibling pass for `aria/icon-font-hidden`: detects icon-font glyphs
 * sitting inside non-interactive prose containers (h1..h6, p, li, dt,
 * dd, em, strong, blockquote, figcaption, caption, td, th, and the
 * Bootstrap `<span class="text-…">` utility class) without
 * `aria-hidden="true"`, an `aria-label`, or an adjacent sr-only
 * sibling that would carry the meaning to assistive tech.
 *
 * Real-world failure mode:
 *
 *   <h3>Double click on the image to <i class="fas fa-heart"></i> it</h3>
 *
 * Sighted users see the heart and read "Double click on the image to
 * [heart] it" — the icon IS the verb. Screen-reader users hear "Double
 * click on the image to it" (silent glyph, since `<i>` is empty), or in
 * some browser+SR pairs the private-use-area codepoint, which is worse.
 * Either way the meaning is lost. The fix is one of:
 *
 *   1. Add `aria-hidden="true"` to the icon AND inline an sr-only
 *      sibling that spells the verb ("like", "favorite", …).
 *   2. Add `aria-label="like"` to the icon (or a wrapper around it).
 *   3. Replace the icon-font with a real image carrying alt text.
 *
 * The original `aria/icon-font-hidden` pass only fired when the icon
 * sat inside an accessibly-named INTERACTIVE ancestor (button, link,
 * role=button, etc.). The "non-interactive prose" case fell through
 * silently — no finding for h1..h6, p, li containers — so the verb-icon
 * pattern above never reached the agent.
 *
 * This pass mirrors `icon-font-hidden.title-relies.ts` in shape:
 * separate file (keeps each module under the 500-line cap), separate
 * `variantKey: "prose-context"` so the engine's findingId hash keeps
 * the diagnostic kind separable from the double-announce and
 * relies-on-title kinds. Doctrine: surface the missed semantic; do not
 * silently drop icons whose meaning the surrounding text doesn't
 * already carry.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlElement, HtmlNode, JsxElement, JsxNode } from "../../types/ast.ts";
import {
  detectIconFont,
  type Emit,
  familyName,
  type IconFontMatch,
  INTERACTIVE_ROLES,
  INTERACTIVE_TAGS,
  isHtmlIconHidden,
  isJsxIconHidden,
} from "./icon-font-hidden.shared.ts";

// ---------------------------------------------------------------------------
// Prose-container predicate
// ---------------------------------------------------------------------------

/**
 * Tags whose contents are user-visible prose. An icon glyph dropped
 * into one of these without aria-hidden / accessible name is meaning
 * the screen reader cannot recover.
 *
 * `<span>` is intentionally NOT in this set — span is too broad and
 * fires on every layout-only `<span>` in the document. The Bootstrap
 * `<span class="text-…">` utility-class case is handled separately by
 * `hasBootstrapTextClass`.
 */
const PROSE_TAGS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "dt",
  "dd",
  "em",
  "strong",
  "blockquote",
  "figcaption",
  "caption",
  "td",
  "th",
]);

/**
 * Class-token presence check for the Bootstrap-style `text-*` utility
 * (`text-danger`, `text-muted`, `text-primary`, …) — a stable signal
 * that a `<span>` is being used as inline prose. Anything looser than
 * the `text-` prefix (e.g. matching any class containing "text") would
 * eat unrelated tokens like "context" and "pretext"; the prefix
 * variant is the surer signal.
 */
function hasBootstrapTextClass(classValue: string | null): boolean {
  if (classValue === null) return false;
  for (const raw of classValue.split(/\s+/u)) {
    const tok = raw.toLowerCase();
    if (tok.startsWith("text-")) return true;
  }
  return false;
}

function isHtmlProseContainer(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (PROSE_TAGS.has(tag)) return true;
  if (tag === "span") return hasBootstrapTextClass(getHtmlAttribute(el, "class"));
  return false;
}

function isJsxProseContainer(el: JsxElement): boolean {
  const tag = el.tagName;
  // PascalCase components are opaque — we don't know whether the
  // rendered output is prose or layout chrome. Skip them; the agent
  // reading the file decides.
  if (tag.length > 0 && (tag[0] ?? "") >= "A" && (tag[0] ?? "") <= "Z") return false;
  if (PROSE_TAGS.has(tag)) return true;
  if (tag === "span") {
    const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    return hasBootstrapTextClass(classValue);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Interactive predicate (mirrors title-relies; lifted here to break the
// otherwise-circular import shape)
// ---------------------------------------------------------------------------

function isHtmlInteractive(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  const role = (getHtmlAttribute(el, "role") ?? "").toLowerCase();
  return (
    INTERACTIVE_TAGS.has(tag) ||
    (tag === "a" && hasHtmlAttribute(el, "href")) ||
    INTERACTIVE_ROLES.has(role)
  );
}

function isJsxInteractive(el: JsxElement): boolean {
  const tag = el.tagName;
  if (tag.length > 0 && (tag[0] ?? "") >= "A" && (tag[0] ?? "") <= "Z") return false;
  const role = (getJsxAttributeString(el, "role") ?? "").toLowerCase();
  return (
    INTERACTIVE_TAGS.has(tag) ||
    (tag === "a" && hasJsxAttribute(el, "href")) ||
    INTERACTIVE_ROLES.has(role)
  );
}

// ---------------------------------------------------------------------------
// Sr-only / labeled-icon exemption
// ---------------------------------------------------------------------------

/**
 * Class tokens conventionally used for visually-hidden screen-reader-
 * only text. Bootstrap, USWDS, Tailwind, WordPress, and Material UI
 * each ship one or more under different names. Keeping the set
 * conservative — these tokens are documented, stable, and present
 * specifically to make the surrounding glyph announceable.
 */
const SR_ONLY_CLASSES: ReadonlySet<string> = new Set([
  "sr-only",
  "visually-hidden",
  "visuallyhidden",
  "screen-reader-text",
  "screen-reader-only",
  "usa-sr-only",
  "u-srOnly",
  "u-sr-only",
  "a11y-hidden",
]);

function classListContainsSrOnly(classValue: string | null): boolean {
  if (classValue === null) return false;
  for (const raw of classValue.split(/\s+/u)) {
    if (SR_ONLY_CLASSES.has(raw)) return true;
    // Case-insensitive fallback for the rarer camelCase entries.
    if (SR_ONLY_CLASSES.has(raw.toLowerCase())) return true;
  }
  return false;
}

function htmlElementIsSrOnlyText(el: HtmlElement): boolean {
  if (classListContainsSrOnly(getHtmlAttribute(el, "class"))) return true;
  // Some authors hide the SR-text via `aria-hidden="false"` + inline
  // CSS; we can't see the CSS here, but the explicit `aria-label` on
  // an empty wrapper is the same signal.
  const label = getHtmlAttribute(el, "aria-label");
  return label !== null && label.trim().length > 0;
}

function jsxElementIsSrOnlyText(el: JsxElement): boolean {
  const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classListContainsSrOnly(classValue)) return true;
  const label = getJsxAttributeString(el, "aria-label");
  return label !== null && label.trim().length > 0;
}

/**
 * True when an icon-font host is exempt from the prose-context finding
 * because its own attributes or a sibling element supplies an
 * accessible name. The check is:
 *
 *   1. Icon itself carries `aria-label` or `aria-labelledby` →
 *      exempt (icon is its own name source).
 *   2. Icon's direct parent carries `aria-label` or `aria-labelledby`
 *      → exempt (parent wraps the icon as a single named region).
 *   3. Any sibling of the icon (under the same parent) is an sr-only
 *      text element → exempt (sibling carries the meaning).
 *
 * If none of the above hold, the icon is presenting meaning that AT
 * cannot recover, and the rule fires.
 */
function htmlIconHasAccessibleNameOrSibling(icon: HtmlElement, parent: HtmlElement): boolean {
  if (hasHtmlAttribute(icon, "aria-label") || hasHtmlAttribute(icon, "aria-labelledby")) {
    return true;
  }
  if (hasHtmlAttribute(parent, "aria-label") || hasHtmlAttribute(parent, "aria-labelledby")) {
    return true;
  }
  for (const sibling of parent.children) {
    if (sibling === icon) continue;
    if (sibling.kind !== "HtmlElement") continue;
    if (htmlElementIsSrOnlyText(sibling)) return true;
  }
  return false;
}

function jsxIconHasAccessibleNameOrSibling(icon: JsxElement, parent: JsxElement): boolean {
  if (hasJsxAttribute(icon, "aria-label") || hasJsxAttribute(icon, "aria-labelledby")) {
    return true;
  }
  if (hasJsxAttribute(parent, "aria-label") || hasJsxAttribute(parent, "aria-labelledby")) {
    return true;
  }
  for (const sibling of parent.children) {
    if (sibling === icon) continue;
    if (sibling.kind !== "JsxElement") continue;
    if (jsxElementIsSrOnlyText(sibling)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTML driver
// ---------------------------------------------------------------------------

interface HtmlIconHit {
  readonly icon: HtmlElement;
  readonly parent: HtmlElement;
  readonly match: IconFontMatch;
  readonly classValue: string | null;
}

function collectHtmlIconHits(parent: HtmlElement, out: HtmlIconHit[]): void {
  for (const child of parent.children) {
    collectHtmlIconHitsInNode(child, parent, out);
  }
}

function collectHtmlIconHitsInNode(node: HtmlNode, parent: HtmlElement, out: HtmlIconHit[]): void {
  if (node.kind !== "HtmlElement") return;
  // Stop at nested interactives — the main labeled-interactive /
  // title-relies passes own those subtrees.
  if (isHtmlInteractive(node)) return;
  // Stop at nested prose containers — the outer walker will visit
  // them as their own ancestor and the per-prose recursion will
  // re-examine their descendants. Recursing here would emit each
  // icon twice on `<li><p>…<i/>…</p></li>`.
  if (isHtmlProseContainer(node)) return;
  const classValue = getHtmlAttribute(node, "class");
  const match = detectIconFont(node.tagName, classValue);
  if (match !== null && !isHtmlIconHidden(node)) {
    out.push({ icon: node, parent, match, classValue });
    // Don't descend into the icon — icon-font hosts have no
    // meaningful child elements to scan.
    return;
  }
  for (const child of node.children) collectHtmlIconHitsInNode(child, node, out);
}

export function checkHtmlProseContextIcon(
  ancestor: HtmlElement,
  emit: Emit,
  alreadyEmitted: ReadonlySet<HtmlElement>,
): void {
  if (isHtmlInteractive(ancestor)) return;
  if (!isHtmlProseContainer(ancestor)) return;
  const hits: HtmlIconHit[] = [];
  collectHtmlIconHits(ancestor, hits);
  for (const hit of hits) {
    // The labeled-interactive pass owns icons inside its subtree; if
    // a prose container nests inside a labeled-interactive ancestor
    // we'd otherwise double-emit on the same icon node.
    if (alreadyEmitted.has(hit.icon)) continue;
    if (htmlIconHasAccessibleNameOrSibling(hit.icon, hit.parent)) continue;
    emit(buildHtmlProseEmission(ancestor, hit));
  }
}

function buildHtmlProseEmission(ancestor: HtmlElement, hit: HtmlIconHit): Parameters<Emit>[0] {
  return {
    severity: "info",
    location: {
      filePath: "",
      line: hit.icon.loc.start.line,
      column: hit.icon.loc.start.column,
    },
    message: buildProseMessage(hit.icon.tagName, hit.match, ancestor.tagName),
    suggestion: buildProseSuggestion(hit.icon.tagName, hit.match, ancestor.tagName),
    variantKey: "prose-context",
    ...(hit.classValue !== null && hit.classValue.length > 0
      ? { classEvidence: hit.classValue }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// JSX driver
// ---------------------------------------------------------------------------

interface JsxIconHit {
  readonly icon: JsxElement;
  readonly parent: JsxElement;
  readonly match: IconFontMatch;
  readonly classValue: string | null;
}

function collectJsxIconHits(parent: JsxElement, out: JsxIconHit[]): void {
  for (const child of parent.children) {
    collectJsxIconHitsInNode(child, parent, out);
  }
}

function collectJsxIconHitsInNode(node: JsxNode, parent: JsxElement, out: JsxIconHit[]): void {
  if (node.kind !== "JsxElement") return;
  if (isJsxInteractive(node)) return;
  if (isJsxProseContainer(node)) return;
  const classValue =
    getJsxAttributeString(node, "className") ?? getJsxAttributeString(node, "class");
  const match = detectIconFont(node.tagName, classValue);
  if (match !== null && !isJsxIconHidden(node)) {
    out.push({ icon: node, parent, match, classValue });
    return;
  }
  for (const child of node.children) collectJsxIconHitsInNode(child, node, out);
}

export function checkJsxProseContextIcon(
  ancestor: JsxElement,
  emit: Emit,
  alreadyEmitted: ReadonlySet<JsxElement>,
): void {
  if (isJsxInteractive(ancestor)) return;
  if (!isJsxProseContainer(ancestor)) return;
  const hits: JsxIconHit[] = [];
  collectJsxIconHits(ancestor, hits);
  for (const hit of hits) {
    if (alreadyEmitted.has(hit.icon)) continue;
    if (jsxIconHasAccessibleNameOrSibling(hit.icon, hit.parent)) continue;
    emit(buildJsxProseEmission(ancestor, hit));
  }
}

function buildJsxProseEmission(ancestor: JsxElement, hit: JsxIconHit): Parameters<Emit>[0] {
  return {
    severity: "info",
    location: {
      filePath: "",
      line: hit.icon.loc.start.line,
      column: hit.icon.loc.start.column,
    },
    message: buildProseMessage(hit.icon.tagName, hit.match, ancestor.tagName),
    suggestion: buildProseSuggestion(hit.icon.tagName, hit.match, ancestor.tagName),
    variantKey: "prose-context",
    ...(hit.classValue !== null && hit.classValue.length > 0
      ? { classEvidence: hit.classValue }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Message + suggestion construction
// ---------------------------------------------------------------------------

function buildProseMessage(iconTag: string, match: IconFontMatch, ancestorTag: string): string {
  return (
    `<${iconTag} class="${match.token}"> is a ${familyName(match.family)} glyph inside ` +
    `non-interactive prose <${ancestorTag}> with no aria-hidden, no aria-label, and no ` +
    `sr-only sibling — the surrounding text does not name the icon, so the meaning the ` +
    `glyph carries is invisible to screen readers (the <${iconTag}> is empty; AT either ` +
    `announces nothing or reads the private-use-area codepoint).`
  );
}

function buildProseSuggestion(iconTag: string, match: IconFontMatch, ancestorTag: string): string {
  const familyLabel = familyName(match.family);
  return (
    `Decide whether the ${familyLabel} glyph is decorative or load-bearing in the ` +
    `<${ancestorTag}> prose. If decorative (the surrounding text is self-sufficient), ` +
    `add aria-hidden="true" to the <${iconTag} class="${match.token}">. If load-bearing ` +
    `(the glyph IS a verb or noun the prose relies on, e.g. "click the [heart] to like"), ` +
    `EITHER add aria-label="…" to the <${iconTag}> naming the concept the glyph carries, ` +
    `OR add aria-hidden="true" to the icon AND a sr-only sibling spelling the word ` +
    `(<span class="sr-only">like</span>). Replacing the icon-font with an <img alt="…"> ` +
    `or inline <svg><title>…</title></svg> is the most robust fix for content the prose ` +
    `genuinely relies on.`
  );
}
