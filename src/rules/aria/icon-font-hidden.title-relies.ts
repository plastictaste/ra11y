/**
 * Sibling pass for `aria/icon-font-hidden`: detects the social-icon-row
 * anti-pattern `<a href="#" title="X"><i class="fa fa-…"></i></a>`.
 *
 * The main rule deliberately drops `title` from accessible-name
 * computation — see `accessibleNameHtml` / `accessibleNameJsx` JSDoc for
 * why (VoiceOver iOS ignores title for links, several SR/browser pairs
 * surface it as a tooltip only, WAI-ARIA APG warns against title as the
 * sole name source). That removal would silently miss the social-icon
 * row entirely, so this module emits a separate finding kind
 * (`variantKey: "relies-on-title"`) that points the agent at the real
 * fix: promote `title` → `aria-label` on the ancestor THEN add
 * `aria-hidden="true"` to the icon. Doctrine: surface the anti-pattern;
 * do not propagate the regression by teaching the original
 * "add aria-hidden to the icon" guidance on this row.
 *
 * Lives in a sibling file rather than inline because the icon-font-host
 * detection helpers + message construction would push the main rule
 * file over the limits-guard ceiling. The split is by-concern (the
 * second pass is its own diagnostic kind), not by ritual.
 */

import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type { HtmlElement, HtmlNode, JsxElement, JsxNode } from "../../types/ast.ts";
import {
  accessibleNameHtml,
  accessibleNameJsx,
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
// HTML
// ---------------------------------------------------------------------------

/**
 * Predicate: would this element be considered interactive at all,
 * irrespective of whether it has an accessible name? Mirrors the
 * "interactive" half of the labeled-interactive check in the main rule;
 * broken out here so the second pass can ask "interactive but unlabeled"
 * without threading a tristate through the predicate.
 */
function isHtmlInteractive(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  const role = (getHtmlAttribute(el, "role") ?? "").toLowerCase();
  return (
    INTERACTIVE_TAGS.has(tag) ||
    (tag === "a" && hasHtmlAttribute(el, "href")) ||
    INTERACTIVE_ROLES.has(role)
  );
}

interface HtmlIconHit {
  readonly host: HtmlElement;
  readonly match: IconFontMatch;
  readonly classValue: string | null;
}

/**
 * Walk the element subtree and return the first icon-font host found,
 * stopping at any nested interactive (the outer scan handles those).
 */
function findHtmlIconDescendant(root: HtmlElement): HtmlIconHit | null {
  for (const child of root.children) {
    const hit = findHtmlIconInNode(child);
    if (hit !== null) return hit;
  }
  return null;
}

function findHtmlIconInNode(node: HtmlNode): HtmlIconHit | null {
  if (node.kind !== "HtmlElement") return null;
  if (isHtmlInteractive(node)) return null;
  const classValue = getHtmlAttribute(node, "class");
  const match = detectIconFont(node.tagName, classValue);
  if (match !== null && !isHtmlIconHidden(node)) {
    return { host: node, match, classValue };
  }
  for (const child of node.children) {
    const hit = findHtmlIconInNode(child);
    if (hit !== null) return hit;
  }
  return null;
}

export function checkHtmlTitleOnlyIconRow(ancestor: HtmlElement, emit: Emit): void {
  if (!isHtmlInteractive(ancestor)) return;
  const title = getHtmlAttribute(ancestor, "title");
  if (title === null || title.trim().length === 0) return;
  // accessibleNameHtml already excludes title — null means no other
  // name source exists. That's the anti-pattern signal.
  if (accessibleNameHtml(ancestor) !== null) return;
  const icon = findHtmlIconDescendant(ancestor);
  if (icon === null) return;
  emit({
    severity: "info",
    location: {
      filePath: "",
      line: ancestor.loc.start.line,
      column: ancestor.loc.start.column,
    },
    message: buildTitleOnlyMessage(ancestor.tagName, title.trim(), icon.match),
    suggestion: buildTitleOnlySuggestion(ancestor.tagName, title.trim(), icon.match),
    variantKey: "relies-on-title",
    ...(icon.classValue !== null && icon.classValue.length > 0
      ? { classEvidence: icon.classValue }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

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

interface JsxIconHit {
  readonly host: JsxElement;
  readonly match: IconFontMatch;
  readonly classValue: string | null;
}

function findJsxIconDescendant(root: JsxElement): JsxIconHit | null {
  for (const child of root.children) {
    const hit = findJsxIconInNode(child);
    if (hit !== null) return hit;
  }
  return null;
}

function findJsxIconInNode(node: JsxNode): JsxIconHit | null {
  if (node.kind !== "JsxElement") return null;
  if (isJsxInteractive(node)) return null;
  const classValue =
    getJsxAttributeString(node, "className") ?? getJsxAttributeString(node, "class");
  const match = detectIconFont(node.tagName, classValue);
  if (match !== null && !isJsxIconHidden(node)) {
    return { host: node, match, classValue };
  }
  for (const child of node.children) {
    const hit = findJsxIconInNode(child);
    if (hit !== null) return hit;
  }
  return null;
}

export function checkJsxTitleOnlyIconRow(ancestor: JsxElement, emit: Emit): void {
  if (!isJsxInteractive(ancestor)) return;
  const title = getJsxAttributeString(ancestor, "title");
  if (title === null || title.trim().length === 0) return;
  if (accessibleNameJsx(ancestor) !== null) return;
  const icon = findJsxIconDescendant(ancestor);
  if (icon === null) return;
  emit({
    severity: "info",
    location: {
      filePath: "",
      line: ancestor.loc.start.line,
      column: ancestor.loc.start.column,
    },
    message: buildTitleOnlyMessage(ancestor.tagName, title.trim(), icon.match),
    suggestion: buildTitleOnlySuggestion(ancestor.tagName, title.trim(), icon.match),
    variantKey: "relies-on-title",
    ...(icon.classValue !== null && icon.classValue.length > 0
      ? { classEvidence: icon.classValue }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Message + suggestion construction
// ---------------------------------------------------------------------------

/**
 * Capped echo of the `title` attribute value into the message so the
 * agent sees what the author actually wrote without inflating
 * pathological 1 KB titles. Cap mirrors `truncateName` in the main rule.
 */
function truncateTitle(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

function buildTitleOnlyMessage(
  ancestorTag: string,
  titleValue: string,
  match: IconFontMatch,
): string {
  return (
    `<${ancestorTag} title="${truncateTitle(titleValue)}"> contains a ` +
    `${familyName(match.family)} glyph (<… class="${match.token}">) and has no other ` +
    `accessible-name source — relying on title is unreliable: VoiceOver iOS ignores ` +
    `title for links, several SR/browser pairs surface it only as a tooltip, and ` +
    `WAI-ARIA APG warns against title as the sole accessible name.`
  );
}

function buildTitleOnlySuggestion(
  ancestorTag: string,
  titleValue: string,
  match: IconFontMatch,
): string {
  const safe = truncateTitle(titleValue);
  return (
    `Replace title with aria-label on the <${ancestorTag}>: ` +
    `aria-label="${safe}" carries the name reliably across screen readers, where ` +
    `title="${safe}" does not. Then add aria-hidden="true" (or role="presentation") ` +
    `to the <… class="${match.token}"> so the ${familyName(match.family)} glyph is ` +
    `not double-announced. Keeping title as a visual tooltip in addition to ` +
    `aria-label is fine; using it as the only accessible name is the anti-pattern. ` +
    `Do NOT just add aria-hidden to the icon while leaving title as the only name — ` +
    `that regresses the link to no announced name on iOS.`
  );
}
