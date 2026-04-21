/**
 * Rule: color/meaning-by-color-only
 * Satisfies: wcag22:1.4.1, wcag21:1.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#use-of-color
 *
 * > Color is not used as the only visual means of conveying information,
 * > indicating an action, prompting a response, or distinguishing a
 * > visual element.
 *
 * Source: https://www.w3.org/TR/WCAG22/#use-of-color
 *
 * Flags elements that carry a status-semantic color utility class —
 * `text-danger`, `text-success`, `text-warning`, `text-error`,
 * `text-info` (and the `-emphasis` variants, `bg-*` / `alert-*` / `btn-*`
 * equivalents) — as the ONLY signal for the status they're painting.
 * Bootstrap's own accessibility docs admit the gap in prose ("assistive
 * technologies will not convey information that is denoted purely with
 * color"); this rule substantiates or falsifies the claim on user code.
 *
 * The class token is semantically-loaded: `.text-danger` means "this is
 * red because it is an error," not "this is decorative red text." That
 * distinguishes it from `.text-primary` / `.text-secondary` / `.text-
 * muted` / `.text-body`, which we DO NOT flag — those are theme tokens,
 * not status channels. The scope is conservative on purpose: when the
 * class name itself names a status (danger/success/warning/error/info),
 * the authorial intent is clear enough for static detection.
 *
 * Pass conditions (any satisfies the rule — a second channel is present):
 *   1. An icon sibling/descendant — `<i>`, `<svg>`, `<use>`, `<img>`,
 *      or an element whose class token looks like an icon (`fa-*`,
 *      `bi-*`, `bi bi-*`, ends with `-icon`, contains `icon-` token).
 *   2. A screen-reader-only label inside the subtree — descendant with a
 *      class token `visually-hidden`, `sr-only`, `visuallyhidden`, or
 *      `screen-reader-only` that carries any non-empty text.
 *   3. A prose status-name prefix in the element's visible text — the
 *      rendered text starts with "Error:", "Success:", "Warning:",
 *      "Danger:", "Info:", case-insensitive, followed by a colon or a
 *      whitespace+word boundary.
 *   4. `aria-label` / `aria-labelledby` / `title` with non-empty value —
 *      the author is supplying an accessible name that can carry the
 *      status word even if the visible text doesn't.
 *   5. `role="alert"` or `role="status"` on the element — the ARIA live-
 *      region role already exposes the message as a status message
 *      (WCAG 4.1.3), so the color is no longer the only channel.
 *
 * Flag conditions (all must be true):
 *   - The element has a class attribute containing a status-color token
 *     from the list above.
 *   - The element has visible text content (textContent.trim().length > 0).
 *     Empty elements are decorative / background-only — a different
 *     shape of check and out of scope here (see backlog item
 *     Q3-TEXT-SUCCESS-CANDIDATE-IGNORES-TEXTCONTENT).
 *   - None of the pass conditions above match.
 *
 * Out of scope (deliberate):
 *   - `.text-primary`, `.text-secondary`, `.text-muted`, `.text-body` —
 *     these are theme tokens, not status indicators. `text-muted` has
 *     been used to weaken secondary text, but the token itself doesn't
 *     name a status.
 *   - Inline-style `color: red` / `color: #dc3545`. A numeric-threshold /
 *     color-distance heuristic is the suppression pattern we reject; the
 *     authorial intent is clearer from class names than from hex codes.
 *   - `.is-invalid` error styling on form controls — `forms/aria-invalid-
 *     missing` already covers that case with a tighter fix.
 *   - Color contrast issues — `contrast/minimum` covers those.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttributeString,
  hasHtmlAttribute,
  hasJsxAttribute,
  htmlTextContent,
  jsxTextContent,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

/**
 * Status-color class tokens that fire the rule. Matching is whole-token
 * (split on whitespace, then exact compare) so `text-danger` matches
 * and `text-danger-foo` does not. The `-emphasis` variants ship in
 * Bootstrap 5.3+ and paint the same semantic status in a darker shade.
 */
const STATUS_COLOR_TOKENS: ReadonlySet<string> = new Set([
  // Text color utilities (Bootstrap + common framework echoes)
  "text-danger",
  "text-danger-emphasis",
  "text-success",
  "text-success-emphasis",
  "text-warning",
  "text-warning-emphasis",
  "text-error",
  "text-info",
  "text-info-emphasis",
  // Background-as-status utilities — the background paints the status
  "bg-danger",
  "bg-danger-subtle",
  "bg-success",
  "bg-success-subtle",
  "bg-warning",
  "bg-warning-subtle",
  "bg-error",
  "bg-info",
  "bg-info-subtle",
  // Alert contextual classes — the whole alert's semantics is the color
  "alert-danger",
  "alert-success",
  "alert-warning",
  "alert-error",
  "alert-info",
  // Button contextual classes — semantic status coloring on buttons
  "btn-danger",
  "btn-success",
  "btn-warning",
  "btn-error",
  "btn-info",
  "btn-outline-danger",
  "btn-outline-success",
  "btn-outline-warning",
  "btn-outline-error",
  "btn-outline-info",
]);

/** Elements that, when present in the subtree, satisfy the "icon second channel" condition. */
const ICON_TAGS: ReadonlySet<string> = new Set(["i", "svg", "use", "img"]);

/** SR-only class tokens — an element with these + text satisfies the label condition. */
const SR_ONLY_TOKENS: ReadonlySet<string> = new Set([
  "visually-hidden",
  "sr-only",
  "visuallyhidden",
  "screen-reader-only",
  "screenreader-only",
  "visually-hidden-focusable",
  "sr-only-focusable",
]);

/** Status words that, when they open the visible text, satisfy the prose-prefix condition. */
const STATUS_PREFIX_WORDS: readonly string[] = [
  "error",
  "success",
  "warning",
  "danger",
  "info",
  "failed",
  "failure",
  "passed",
  "alert",
  "caution",
  "note",
  "notice",
];

/**
 * Regex: starts (after leading whitespace) with a status word, followed
 * by `:` or whitespace. Case-insensitive. Anchored at string start so
 * "The success of the mission…" does NOT match.
 */
const STATUS_PREFIX_RE = new RegExp(`^\\s*(${STATUS_PREFIX_WORDS.join("|")})\\b[:\\s]`, "iu");

export const rule = defineRule({
  id: "color/meaning-by-color-only",
  satisfies: ["wcag22:1.4.1", "wcag21:1.4.1"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".tsx", ".jsx", ".html"],
  },
  docs: {
    description:
      "Elements that rely on a status-semantic color utility class (text-danger, alert-success, btn-warning, etc.) must also convey the status via an icon, a screen-reader-only label, a prose status prefix, an ARIA live role, or an accessible name — color alone fails WCAG 1.4.1.",
    rationale:
      'Bootstrap\'s `.text-danger` / `.alert-success` / `.btn-warning` family carries semantic status — red means error, green means success. A sighted user sees the color and understands the meaning; a screen-reader user, a colorblind user, or anyone reading under a color-inverted theme gets nothing unless the status is also conveyed through another channel. Bootstrap\'s own accessibility docs admit this: "assistive technologies will not convey information that is denoted purely with color" — the class ships the color, the author supplies the second channel. The fix is cheap: an icon + an `.visually-hidden` label, or a prose prefix ("Error: invalid email"), or `role="alert"` on a live region. The rule only fires when the class token itself names a status (`-danger`/`-success`/`-warning`/`-error`/`-info`) — theme tokens like `.text-primary` / `.text-muted` do not trigger, because they are not status channels.',
    goodExample: `<span class="text-danger"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span class="visually-hidden">Error:</span> Invalid email</span>`,
    badExample: `<span class="text-danger">Access denied</span>`,
    normativeQuote:
      "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.",
    references: [
      "https://www.w3.org/TR/WCAG22/#use-of-color",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G14",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G111",
      "https://getbootstrap.com/docs/5.3/getting-started/accessibility/#color-contrast",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const el of walkHtmlElements(doc)) {
    const classAttr = getHtmlAttribute(el, "class");
    if (classAttr === null) continue;
    const token = firstStatusToken(classAttr);
    if (token === null) continue;
    if (htmlHasSecondChannel(el)) continue;
    const text = htmlTextContent(el);
    if (text.length === 0) continue;
    emit(buildViolation("html", el.tagName.toLowerCase(), classAttr, token, text, el.loc.start));
  }
}

function htmlHasSecondChannel(el: HtmlElement): boolean {
  if (htmlHasAccessibleName(el)) return true;
  if (htmlHasStatusRole(el)) return true;
  if (htmlHasStatusTextPrefix(el)) return true;
  for (const descendant of walkHtmlElements(el)) {
    if (isHtmlIcon(descendant)) return true;
    if (isHtmlSrOnlyWithText(descendant)) return true;
  }
  return false;
}

function htmlHasAccessibleName(el: HtmlElement): boolean {
  const label = getHtmlAttribute(el, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  if (hasHtmlAttribute(el, "aria-labelledby")) {
    const ref = getHtmlAttribute(el, "aria-labelledby");
    if (ref !== null && ref.trim().length > 0) return true;
  }
  const title = getHtmlAttribute(el, "title");
  if (title !== null && title.trim().length > 0) return true;
  return false;
}

function htmlHasStatusRole(el: HtmlElement): boolean {
  const role = getHtmlAttribute(el, "role");
  if (role === "alert" || role === "status") return true;
  const live = getHtmlAttribute(el, "aria-live");
  if (live !== null && live.trim().length > 0 && live !== "off") return true;
  return false;
}

function htmlHasStatusTextPrefix(el: HtmlElement): boolean {
  return STATUS_PREFIX_RE.test(htmlTextContent(el));
}

function isHtmlIcon(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (ICON_TAGS.has(tag)) return true;
  const classAttr = getHtmlAttribute(el, "class");
  if (classAttr === null) return false;
  return classLooksLikeIcon(classAttr);
}

function isHtmlSrOnlyWithText(el: HtmlElement): boolean {
  const classAttr = getHtmlAttribute(el, "class");
  if (classAttr === null) return false;
  if (!hasAnyToken(classAttr, SR_ONLY_TOKENS)) return false;
  return htmlTextContent(el).length > 0;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    if (classAttr === null) continue;
    const token = firstStatusToken(classAttr);
    if (token === null) continue;
    if (jsxHasSecondChannel(el)) continue;
    const text = jsxTextContent(el);
    if (text.length === 0) continue;
    emit(buildViolation("jsx", el.tagName, classAttr, token, text, el.loc.start));
  }
}

function jsxHasSecondChannel(el: JsxElement): boolean {
  if (jsxHasAccessibleName(el)) return true;
  if (jsxHasStatusRole(el)) return true;
  if (jsxHasStatusTextPrefix(el)) return true;
  for (const descendant of walkJsxDescendants(el)) {
    if (isJsxIcon(descendant)) return true;
    if (isJsxSrOnlyWithText(descendant)) return true;
  }
  return false;
}

function jsxHasAccessibleName(el: JsxElement): boolean {
  const label = getJsxAttributeString(el, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
  const title = getJsxAttributeString(el, "title");
  if (title !== null && title.trim().length > 0) return true;
  // Expression-valued aria-label — trust the developer (same tradeoff
  // other rules make for runtime-valued attributes).
  if (hasJsxAttribute(el, "aria-label")) return true;
  return false;
}

function jsxHasStatusRole(el: JsxElement): boolean {
  const role = getJsxAttributeString(el, "role");
  if (role === "alert" || role === "status") return true;
  const live = getJsxAttributeString(el, "aria-live");
  if (live !== null && live.trim().length > 0 && live !== "off") return true;
  return false;
}

function jsxHasStatusTextPrefix(el: JsxElement): boolean {
  return STATUS_PREFIX_RE.test(jsxTextContent(el));
}

function isJsxIcon(el: JsxElement): boolean {
  // JSX tag names preserve case; native icon tags are lowercase.
  const lower = el.tagName.toLowerCase();
  if (ICON_TAGS.has(lower)) return true;
  // PascalCase component named like an icon: `<Icon>`, `<CheckIcon>`,
  // `<FaCheck>`. Components whose name ends in "Icon" or starts with
  // "Icon" are near-universally icons in practice; the risk of a false
  // accept is low, and the cost of a false reject (flagging a real
  // violation when the icon IS there) is the silent-miss failure mode
  // the doctrine warns against.
  if (el.tagName.endsWith("Icon") || el.tagName.startsWith("Icon")) return true;
  const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classAttr === null) return false;
  return classLooksLikeIcon(classAttr);
}

function isJsxSrOnlyWithText(el: JsxElement): boolean {
  const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
  if (classAttr === null) return false;
  if (!hasAnyToken(classAttr, SR_ONLY_TOKENS)) return false;
  return jsxTextContent(el).length > 0;
}

function* walkJsxDescendants(element: JsxElement): Iterable<JsxElement> {
  for (const child of element.children) {
    if (child.kind === "JsxElement") {
      yield child;
      yield* walkJsxDescendants(child);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Returns the first status-color token found in `classValue`, or `null`
 * when none is present. Whole-token match (whitespace-delimited).
 */
function firstStatusToken(classValue: string): string | null {
  for (const t of classValue.split(/\s+/u)) {
    if (STATUS_COLOR_TOKENS.has(t)) return t;
  }
  return null;
}

/** True when any whitespace-delimited token in `classValue` is in `tokens`. */
function hasAnyToken(classValue: string, tokens: ReadonlySet<string>): boolean {
  for (const t of classValue.split(/\s+/u)) {
    if (tokens.has(t)) return true;
  }
  return false;
}

/** Whole-token icon-font family markers (exact token match). */
const ICON_FAMILY_TOKENS: ReadonlySet<string> = new Set([
  "fa",
  "fas",
  "far",
  "fab",
  "fal",
  "fad",
  "bi",
  "icon",
  "material-icons",
]);

/** Prefixes that, when a token starts with them, identify the token as an icon class. */
const ICON_PREFIXES: readonly string[] = ["fa-", "bi-", "icon-", "material-symbols"];

/**
 * Heuristic: does `classValue` look like it paints an icon? Matches the
 * common icon-font / icon-library naming conventions:
 *
 *   - Font Awesome: `fa`, `fas`, `far`, `fab`, `fa-<glyph>`
 *   - Bootstrap Icons: `bi`, `bi-<glyph>`
 *   - Material Icons: `material-icons`, `material-symbols-*`
 *   - Generic: `icon`, `icon-*`, `*-icon`
 */
function classLooksLikeIcon(classValue: string): boolean {
  for (const t of classValue.split(/\s+/u)) {
    if (tokenLooksLikeIcon(t)) return true;
  }
  return false;
}

function tokenLooksLikeIcon(t: string): boolean {
  if (ICON_FAMILY_TOKENS.has(t)) return true;
  if (t.endsWith("-icon")) return true;
  for (const prefix of ICON_PREFIXES) {
    if (t.startsWith(prefix)) return true;
  }
  return false;
}

interface Loc {
  readonly line: number;
  readonly column: number;
}

function buildViolation(
  lang: "html" | "jsx",
  tagName: string,
  classValue: string,
  token: string,
  text: string,
  loc: Loc,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  const descriptor = buildDescriptor(lang, tagName, classValue);
  const statusWord = statusWordForToken(token);
  const message = buildMessage(descriptor, token, statusWord, text);
  const suggestion = buildSuggestion(descriptor, token, statusWord);
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message,
    suggestion,
  };
}

function buildDescriptor(lang: "html" | "jsx", tagName: string, classValue: string): string {
  const tag = lang === "html" ? tagName.toLowerCase() : tagName;
  const classAttrName = lang === "jsx" ? "className" : "class";
  return `<${tag} ${classAttrName}="${classValue}">`;
}

/**
 * Derives the status word from the matched class token for use in the
 * fix suggestion's worked example. `text-danger-emphasis` → `danger`;
 * `alert-success` → `success`; `btn-outline-warning` → `warning`.
 */
function statusWordForToken(token: string): string {
  // Strip known prefixes, then strip known suffixes.
  const withoutPrefix = token
    .replace(/^text-/, "")
    .replace(/^bg-/, "")
    .replace(/^alert-/, "")
    .replace(/^btn-outline-/, "")
    .replace(/^btn-/, "");
  return withoutPrefix.replace(/-emphasis$/, "").replace(/-subtle$/, "");
}

function buildMessage(descriptor: string, token: string, statusWord: string, text: string): string {
  const textSample = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `${descriptor} conveys "${statusWord}" status via the ${token} class alone — text content "${textSample}" carries no status word, no icon sibling, no sr-only label, and no ARIA live role. Screen-reader users, colorblind users, and anyone under a color-inverted theme receive the ${statusWord} text as plain prose with no indication that it is a status.`;
}

function buildSuggestion(descriptor: string, token: string, statusWord: string): string {
  const titleWord = statusWord.charAt(0).toUpperCase() + statusWord.slice(1);
  return `Add a second channel for the "${statusWord}" status conveyed by ${token} on ${descriptor}. Any of: (1) prefix the visible text with the status word — e.g., "${titleWord}: <your text>" — so assistive tech reads the status as prose; (2) add an icon + sr-only label inside the element — \`<i class="bi bi-exclamation-circle" aria-hidden="true"></i><span class="visually-hidden">${titleWord}:</span>\`; (3) if this message appears dynamically, wrap with \`role="alert"\` (errors) or \`role="status"\` (success/info) so the status is announced via a live region; (4) set \`aria-label="${titleWord}: <your text>"\` on the element. Pick the one that matches how the message reaches the page.`;
}
