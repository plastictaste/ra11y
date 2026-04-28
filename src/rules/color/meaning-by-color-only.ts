/**
 * Rule: color/meaning-by-color-only
 * Satisfies: wcag22:1.4.1, wcag21:1.4.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#use-of-color
 * Spec: https://www.w3.org/TR/WCAG22/#name-role-value
 *
 * > Color is not used as the only visual means of conveying information,
 * > indicating an action, prompting a response, or distinguishing a
 * > visual element.
 *
 * > For all user interface components, the name and role can be
 * > programmatically determined; states, properties, and values that can
 * > be set by the user can be programmatically set.
 *
 * Source: https://www.w3.org/TR/WCAG22/#use-of-color
 * Source: https://www.w3.org/TR/WCAG22/#name-role-value
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
 *   3. A prose status word anywhere in the element's visible text as a
 *      whole-word match — "Error", "Success", "Warning", "Danger",
 *      "Info", "failed", "alert", "caution", "notice" etc., case-
 *      insensitive. The prose channel carries the status, so color is
 *      not the only signal.
 *   4. `aria-label` / `aria-labelledby` / `title` with non-empty value —
 *      the author is supplying an accessible name that can carry the
 *      status word even if the visible text doesn't.
 *   5. `role="alert"` or `role="status"` (or `aria-live` non-`off`) on
 *      the element OR any ancestor element — the ARIA live-region role
 *      already exposes the message as a status message (WCAG 4.1.3), so
 *      the color is no longer the only channel. Walking ancestors is
 *      essential because the canonical Bootstrap shape wraps the colored
 *      element in a parent live-region: `<div role="alert" class="alert
 *      alert-danger"><button class="btn btn-danger">Take this action
 *      </button></div>` — the parent's `role="alert"` carries the
 *      announcement, so the inner button's `btn-danger` is not the sole
 *      cue. Without the ancestor walk the rule would emit at `error` on
 *      every nested colored child of an alert region, contradicting its
 *      own evidence (the announcement is provably present).
 *
 * Closure path: suppress emission on the "text already carries a
 * status word" branch rather than emit-with-enriched-reason. The text-
 * content whole-word match is deterministic evidence the parser already
 * has; when it fires, color is provably NOT the sole channel — the prose
 * itself names the status. Per the AI-first consumer doctrine on "Reason
 * text and severity must agree", a non-emission decision grounded in
 * deterministic evidence is consistent with surface-don't-suppress (the
 * predicate's conditions for non-emission are provable from the code,
 * not heuristic). Trade-off accepted: false negatives on coincidental
 * keywords ("The success of the mission depended on…" inside a `text-
 * success` element) — the whole-word regex picks them up but the
 * authorial intent there is prose, not status. The agent reading the
 * file can still flag those via `<!-- ra11y-disable -->` is unnecessary
 * here because the rule simply does not fire; if we later observe field
 * reports of true status messages mis-suppressed by accidental keyword
 * presence, the durable answer is to tighten this gate (e.g., position
 * within the text, surrounding punctuation), not to flip back to
 * emit-with-enriched-reason.
 *
 * Flag conditions (all must be true):
 *   - The element has a class attribute containing a status-color token
 *     from the list above.
 *   - The element has visible text content (textContent.trim().length > 0).
 *     Empty elements are decorative / background-only — a different
 *     shape of check and out of scope here (see backlog item
 *).
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
 *
 * Second predicate — state-class without programmatic state:
 *
 * In addition to the status-color predicate above, the rule also surfaces
 * a `warning`-severity review candidate when an element carries a
 * toggled-state class (`.active`, `.selected`, `.checked`, plus the
 * `is-active` / `is-selected` / `is-checked` variants) AND does not
 * supply a programmatic state channel. Class-name idioms in this family
 * are how real-world tabs, segmented controls, list items, and toggle
 * buttons style their on/off state, and `.active { background-color:
 * blue; }` against `.tab { background-color: gray; }` is the canonical
 * 1.4.1 + 4.1.2 failure shape — the rendered state difference reaches
 * sighted full-color users only, with no announcement to assistive tech.
 *
 * Pass conditions for the state-class predicate (any satisfies — second
 * channel is present):
 *   1. The element carries one of the state ARIA attributes:
 *      `aria-pressed`, `aria-selected`, `aria-checked`, `aria-current`,
 *      `aria-expanded` (any non-empty value). The attribute itself is
 *      the programmatic state channel.
 *   2. The element carries the native HTML state attribute corresponding
 *      to the class name — `checked` (on `<input>` / `<option>`),
 *      `selected` (on `<option>`), `disabled` (on form controls). The
 *      browser exposes these directly to assistive tech.
 *   3. The visible text contains a state word as a whole-word match —
 *      "active", "selected", "current", "checked", "pressed". Same prose-
 *      as-second-channel logic the status-color predicate uses.
 *   4. `aria-label` / `aria-labelledby` / `title` with a non-empty value —
 *      the accessible name carries the state.
 *   5. `role="alert"` / `role="status"` (or non-`off` `aria-live`) on the
 *      element OR any ancestor — the live region announces the state.
 *
 * Severity is `warning` (not `error`) because the static predicate cannot
 * prove the consumer site lacks a programmatic state channel — an
 * `aria-pressed` set at runtime, a sibling `<input>` whose `checked`
 * attribute is the truth source, an icon swap driven by JSX state. The
 * agent reading the consumer site is the correct arbiter; the rule's job
 * is to point at the class shape that risks color-only differentiation,
 * not to assert the violation. Per the AI-first doctrine on "Reason text
 * and severity must agree" + "Heuristic emission is the symmetric twin
 * of heuristic suppression", the message frames the question and the
 * `couldBeWrongBecause: ["state_class_may_have_text_or_aria_sibling"]`
 * code makes the uncertainty machine-readable.
 *
 * Pairs with `color/state-class-color-only` (CSS-side). That rule fires
 * on the stylesheet shape ("the .active rule body declares only color");
 * this predicate fires on the consumer-site shape ("the element has
 * .active but no programmatic state attribute"). The two are independent
 * evidence — a stylesheet may declare a non-color cue while the consumer
 * site fails to expose the state programmatically, or vice versa.
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
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  JsxNode,
  TsxModule,
} from "../../types/ast.ts";

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

/**
 * Status words that, when present anywhere in the visible text as a
 * whole-word match, satisfy the "prose carries the status" condition
 * and pass the rule.
 */
const STATUS_WORDS: readonly string[] = [
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
 * Regex: whole-word match of any status word anywhere in the text. The
 * pass-condition gate — when the visible text contains a status keyword
 * (e.g., the real-world `<button class="btn btn-danger">Danger</button>`
 * or `<div class="alert-danger">Upload failed</div>`), the prose itself
 * carries the status, so color is provably NOT the sole channel and the
 * rule does not fire. Whole-word match (`\b` boundaries) keeps
 * "warningly" from matching "warning" and "successor" from matching
 * "success".
 */
const STATUS_ANYWHERE_RE = new RegExp(`\\b(${STATUS_WORDS.join("|")})\\b`, "iu");

/**
 * True when the element's visible text contains a status word anywhere
 * as a whole-word match (case-insensitive). Used as a pass condition:
 * when this matches, the prose IS the second channel and the rule does
 * not fire.
 */
function textContainsStatusWord(text: string): boolean {
  return STATUS_ANYWHERE_RE.test(text);
}

export const rule = defineRule({
  id: "color/meaning-by-color-only",
  satisfies: ["wcag22:1.4.1", "wcag21:1.4.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".tsx", ".jsx", ".html"],
  },
  docs: {
    description:
      "Elements that rely on a status-semantic color utility class (text-danger, alert-success, btn-warning, etc.) must also convey the status via an icon, a screen-reader-only label, a prose status prefix, an ARIA live role, or an accessible name — color alone fails WCAG 1.4.1. Also surfaces a review candidate (severity warning) when an element carries a toggled-state class (.active / .selected / .checked) without an aria-pressed / aria-selected / aria-checked / aria-current / aria-expanded attribute, native checked/selected attribute, or text/label channel — class-name-driven state without a programmatic channel risks 1.4.1 + 4.1.2.",
    rationale:
      'Bootstrap\'s `.text-danger` / `.alert-success` / `.btn-warning` family carries semantic status — red means error, green means success. A sighted user sees the color and understands the meaning; a screen-reader user, a colorblind user, or anyone reading under a color-inverted theme gets nothing unless the status is also conveyed through another channel. Bootstrap\'s own accessibility docs admit this: "assistive technologies will not convey information that is denoted purely with color" — the class ships the color, the author supplies the second channel. The fix is cheap: an icon + an `.visually-hidden` label, or a prose prefix ("Error: invalid email"), or `role="alert"` on a live region. The rule only fires when the class token itself names a status (`-danger`/`-success`/`-warning`/`-error`/`-info`) — theme tokens like `.text-primary` / `.text-muted` do not trigger, because they are not status channels.',
    goodExample: `<span class="text-danger"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span class="visually-hidden">Error:</span> Invalid email</span>`,
    badExample: `<span class="text-danger">Access denied</span>`,
    normativeQuote:
      "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.",
    references: [
      "https://www.w3.org/TR/WCAG22/#use-of-color",
      "https://www.w3.org/TR/WCAG22/#name-role-value",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G14",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G111",
      "https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA10",
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
  couldBeWrongBecause?: readonly string[];
}) => void;

/**
 * `couldBeWrongBecause` code surfaced on the state-class predicate path.
 * The static rule cannot prove the consumer site lacks a programmatic
 * state channel — an `aria-pressed` set at runtime, a sibling element
 * whose `checked` attribute is the truth source, an icon swap driven by
 * JSX state. The agent reading the consumer site is the correct arbiter;
 * this code marks the uncertainty so the agent's per-finding triage can
 * key on it. Per the AI-first doctrine on "Heuristic emission is the
 * symmetric twin of heuristic suppression": low-confidence evidence
 * lives at `severity: warning` paired with a machine-readable reason.
 */
export const STATE_CLASS_MAY_HAVE_TEXT_OR_ARIA_SIBLING =
  "state_class_may_have_text_or_aria_sibling";

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  const parentOf = buildHtmlParentMap(doc);
  for (const el of walkHtmlElements(doc)) {
    const classAttr = getHtmlAttribute(el, "class");
    if (classAttr === null) continue;

    // Predicate 1: status-color utility class with no second channel.
    const token = firstStatusToken(classAttr);
    if (token !== null) {
      if (!htmlHasSecondChannel(el, parentOf)) {
        const text = htmlTextContent(el);
        if (text.length > 0) {
          emit(
            buildViolation("html", el.tagName.toLowerCase(), classAttr, token, text, el.loc.start),
          );
          // Status-color and state-class predicates are mutually
          // exclusive on the same element — the status-color emission
          // already names the color-only failure; firing both would
          // double-count the same evidence.
          continue;
        }
      }
    }

    // Predicate 2: toggled-state class without a programmatic state
    // channel. Fires on `.active` / `.selected` / `.checked` (and the
    // `is-*` variants) when the element supplies neither an aria-state
    // attribute, a native HTML state attribute, an accessible name, a
    // text-state word, nor a live-region ancestor.
    const stateToken = firstStateToken(classAttr);
    if (stateToken === null) continue;
    if (htmlHasStateChannel(el, parentOf)) continue;
    const text = htmlTextContent(el);
    if (text.length === 0) continue;
    emit(
      buildStateClassViolation(
        "html",
        el.tagName.toLowerCase(),
        classAttr,
        stateToken,
        text,
        el.loc.start,
      ),
    );
  }
}

function htmlHasSecondChannel(
  el: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): boolean {
  if (htmlHasAccessibleName(el)) return true;
  if (htmlHasStatusRole(el)) return true;
  if (htmlAncestorHasStatusRole(el, parentOf)) return true;
  if (textContainsStatusWord(htmlTextContent(el))) return true;
  for (const descendant of walkHtmlElements(el)) {
    if (isHtmlIcon(descendant)) return true;
    if (isHtmlSrOnlyWithText(descendant)) return true;
  }
  return false;
}

/**
 * True when any ancestor of `el` carries a status-conveying ARIA role
 * (`role="alert"` / `role="status"`) or a non-`off` `aria-live` value.
 * The canonical real-world shape this gates on is a Bootstrap alert
 * region containing colored buttons:
 *
 *   `<div role="alert" class="alert alert-danger">
 *      <button class="btn btn-danger">Take this action</button>
 *    </div>`
 *
 * The parent's announcement carries the danger context; the inner
 * button's `btn-danger` is not the sole cue.
 */
function htmlAncestorHasStatusRole(
  el: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): boolean {
  let ancestor = parentOf.get(el);
  while (ancestor) {
    if (htmlHasStatusRole(ancestor)) return true;
    ancestor = parentOf.get(ancestor);
  }
  return false;
}

function buildHtmlParentMap(doc: HtmlDocument): Map<HtmlElement, HtmlElement> {
  const parentOf = new Map<HtmlElement, HtmlElement>();
  const visit = (node: HtmlNode, parent: HtmlElement | null): void => {
    if (node.kind !== "HtmlElement") return;
    if (parent) parentOf.set(node, parent);
    for (const child of node.children) visit(child, node);
  };
  for (const top of doc.children) visit(top, null);
  return parentOf;
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
  const parentOf = buildJsxParentMap(module);
  for (const el of walkJsxElements(module)) {
    const classAttr = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    if (classAttr === null) continue;

    // Predicate 1: status-color utility class with no second channel.
    const token = firstStatusToken(classAttr);
    if (token !== null) {
      if (!jsxHasSecondChannel(el, parentOf)) {
        const text = jsxTextContent(el);
        if (text.length > 0) {
          emit(buildViolation("jsx", el.tagName, classAttr, token, text, el.loc.start));
          continue;
        }
      }
    }

    // Predicate 2: toggled-state class without a programmatic state
    // channel. JSX analogue of the HTML branch above.
    const stateToken = firstStateToken(classAttr);
    if (stateToken === null) continue;
    if (jsxHasStateChannel(el, parentOf)) continue;
    const text = jsxTextContent(el);
    if (text.length === 0) continue;
    emit(
      buildStateClassViolation("jsx", el.tagName, classAttr, stateToken, text, el.loc.start),
    );
  }
}

function jsxHasSecondChannel(
  el: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): boolean {
  if (jsxHasAccessibleName(el)) return true;
  if (jsxHasStatusRole(el)) return true;
  if (jsxAncestorHasStatusRole(el, parentOf)) return true;
  if (textContainsStatusWord(jsxTextContent(el))) return true;
  for (const descendant of walkJsxDescendants(el)) {
    if (isJsxIcon(descendant)) return true;
    if (isJsxSrOnlyWithText(descendant)) return true;
  }
  return false;
}

/**
 * True when any ancestor of `el` carries `role="alert"` / `role="status"`
 * or a non-`off` `aria-live` value. JSX analogue of
 * `htmlAncestorHasStatusRole` — same canonical Bootstrap-alert shape.
 */
function jsxAncestorHasStatusRole(
  el: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): boolean {
  let ancestor = parentOf.get(el);
  while (ancestor) {
    if (jsxHasStatusRole(ancestor)) return true;
    ancestor = parentOf.get(ancestor);
  }
  return false;
}

function buildJsxParentMap(module: TsxModule): Map<JsxElement, JsxElement> {
  const parentOf = new Map<JsxElement, JsxElement>();
  const visit = (node: JsxNode, parent: JsxElement | null): void => {
    if (node.kind !== "JsxElement") return;
    if (parent) parentOf.set(node, parent);
    for (const child of node.children) visit(child, node);
  };
  for (const top of module.jsxElements) visit(top, null);
  return parentOf;
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

// ---------------------------------------------------------------------------
// State-class predicate (toggled state without programmatic channel)
// ---------------------------------------------------------------------------

/**
 * Class tokens whose presence on an element signals toggled state. The
 * `is-*` variants ship in BEM / SUIT / Bootstrap-flavored class naming;
 * the bare forms ship across the same plus jQuery-era idioms. Whole-
 * token match (whitespace-delimited).
 */
const STATE_CLASS_TOKENS: ReadonlySet<string> = new Set([
  "active",
  "selected",
  "checked",
  "is-active",
  "is-selected",
  "is-checked",
]);

/**
 * State words that, when present anywhere in the element's visible text
 * as a whole-word match, satisfy the prose-channel pass condition for
 * the state-class predicate. Distinct from STATUS_WORDS (above) — those
 * are status-message words ("error" / "success"); these are state words
 * ("active" / "selected"). Some overlap is fine — both sets are
 * conservative.
 */
const STATE_WORDS: readonly string[] = [
  "active",
  "selected",
  "current",
  "checked",
  "pressed",
  "expanded",
  "collapsed",
];

const STATE_ANYWHERE_RE = new RegExp(`\\b(${STATE_WORDS.join("|")})\\b`, "iu");

/**
 * ARIA state attributes. When any of these is present (any non-empty
 * value), the element supplies a programmatic state channel and the
 * state-class predicate does NOT fire.
 */
const ARIA_STATE_ATTRS: readonly string[] = [
  "aria-pressed",
  "aria-selected",
  "aria-checked",
  "aria-current",
  "aria-expanded",
];

/**
 * Native HTML state attributes paired with the class token they would
 * mirror. When the class is `.checked` and the element is `<input
 * checked>`, the browser exposes the checked state directly to AT — no
 * aria-* needed.
 */
const NATIVE_STATE_ATTRS: readonly string[] = ["checked", "selected", "disabled"];

/**
 * Returns the first state-class token found in `classValue`, or `null`
 * when none is present. Whole-token match (whitespace-delimited).
 */
function firstStateToken(classValue: string): string | null {
  for (const t of classValue.split(/\s+/u)) {
    if (STATE_CLASS_TOKENS.has(t)) return t;
  }
  return null;
}

function textContainsStateWord(text: string): boolean {
  return STATE_ANYWHERE_RE.test(text);
}

/**
 * True when the element supplies a programmatic state channel: an aria-
 * state attribute, a native HTML state attribute, an accessible name, a
 * text-state word, a status role / live region (self or ancestor), or a
 * sr-only descendant carrying state text.
 */
function htmlHasStateChannel(
  el: HtmlElement,
  parentOf: ReadonlyMap<HtmlElement, HtmlElement>,
): boolean {
  if (htmlHasAnyAriaStateAttr(el)) return true;
  if (htmlHasAnyNativeStateAttr(el)) return true;
  if (htmlHasAccessibleName(el)) return true;
  if (htmlHasStatusRole(el)) return true;
  if (htmlAncestorHasStatusRole(el, parentOf)) return true;
  if (textContainsStateWord(htmlTextContent(el))) return true;
  for (const descendant of walkHtmlElements(el)) {
    if (isHtmlSrOnlyWithText(descendant)) return true;
  }
  return false;
}

function htmlHasAnyAriaStateAttr(el: HtmlElement): boolean {
  for (const attr of ARIA_STATE_ATTRS) {
    const v = getHtmlAttribute(el, attr);
    if (v !== null && v.trim().length > 0) return true;
    // Boolean-attribute form (`<button aria-pressed>`) — `hasAttribute`
    // alone is enough; the value-check above caught the value-bearing
    // case. Both shapes count as a programmatic channel.
    if (hasHtmlAttribute(el, attr)) return true;
  }
  return false;
}

function htmlHasAnyNativeStateAttr(el: HtmlElement): boolean {
  for (const attr of NATIVE_STATE_ATTRS) {
    if (hasHtmlAttribute(el, attr)) return true;
  }
  return false;
}

function jsxHasStateChannel(
  el: JsxElement,
  parentOf: ReadonlyMap<JsxElement, JsxElement>,
): boolean {
  if (jsxHasAnyAriaStateAttr(el)) return true;
  if (jsxHasAnyNativeStateAttr(el)) return true;
  if (jsxHasAccessibleName(el)) return true;
  if (jsxHasStatusRole(el)) return true;
  if (jsxAncestorHasStatusRole(el, parentOf)) return true;
  if (textContainsStateWord(jsxTextContent(el))) return true;
  for (const descendant of walkJsxDescendants(el)) {
    if (isJsxSrOnlyWithText(descendant)) return true;
  }
  return false;
}

function jsxHasAnyAriaStateAttr(el: JsxElement): boolean {
  for (const attr of ARIA_STATE_ATTRS) {
    if (hasJsxAttribute(el, attr)) return true;
  }
  return false;
}

function jsxHasAnyNativeStateAttr(el: JsxElement): boolean {
  for (const attr of NATIVE_STATE_ATTRS) {
    if (hasJsxAttribute(el, attr)) return true;
  }
  return false;
}

function buildStateClassViolation(
  lang: "html" | "jsx",
  tagName: string,
  classValue: string,
  stateToken: string,
  text: string,
  loc: Loc,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause: readonly string[];
} {
  const descriptor = buildDescriptor(lang, tagName, classValue);
  const ariaAttr = ariaAttrForStateToken(stateToken);
  const message = buildStateClassMessage(descriptor, stateToken, ariaAttr, text);
  const suggestion = buildStateClassSuggestion(descriptor, stateToken, ariaAttr);
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message,
    suggestion,
    couldBeWrongBecause: [STATE_CLASS_MAY_HAVE_TEXT_OR_ARIA_SIBLING],
  };
}

/**
 * Maps a state-class token to the ARIA state attribute that would expose
 * the same state programmatically. `.active` → `aria-pressed` (toggle
 * button) or `aria-current` (navigation), `.selected` → `aria-selected`
 * (listbox / tab), `.checked` → `aria-checked` (custom checkbox /
 * radio). The suggestion lists both candidates for `.active` since both
 * are valid depending on the widget shape — the agent picks based on
 * the element's role.
 */
function ariaAttrForStateToken(token: string): string {
  const stripped = token.replace(/^is-/, "");
  if (stripped === "selected") return "aria-selected";
  if (stripped === "checked") return "aria-checked";
  // `.active` is ambiguous between toggle (aria-pressed) and navigation
  // (aria-current) — the suggestion text names both.
  return "aria-pressed";
}

function buildStateClassMessage(
  descriptor: string,
  stateToken: string,
  ariaAttr: string,
  text: string,
): string {
  const textSample = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `${descriptor} carries the state class "${stateToken}" but exposes no programmatic state channel — no ${ariaAttr} / aria-current / aria-expanded attribute, no native checked/selected attribute, no accessible name, and the visible text "${textSample}" carries no state word. If the class drives only a color difference between this element and its base, sighted full-color users see the state but screen-reader users, colorblind users, and users under color-inverted themes receive no signal that the element is in a different state. Verify the consumer site exposes the state through an aria-* attribute or a non-color visual cue.`;
}

function buildStateClassSuggestion(
  descriptor: string,
  stateToken: string,
  ariaAttr: string,
): string {
  const stripped = stateToken.replace(/^is-/, "");
  return `Expose the "${stripped}" state programmatically on ${descriptor}. Any of: (1) add ${ariaAttr}="true" (or aria-current="page" / aria-current="true" if this is a navigation/wayfinding cue) so assistive tech announces the state; (2) if the class drives only a color shift, add a non-color visual cue in CSS (\`font-weight: 600\`, \`text-decoration: underline\`, \`border-bottom: 2px solid …\`) so the state reaches users who can't perceive color; (3) include the state in the accessible name — \`aria-label="<label> (${stripped})"\` or a \`.visually-hidden\` span carrying " (${stripped})" — so the prose names the state. Pick the channel that matches how the widget exposes its state at runtime.`;
}
