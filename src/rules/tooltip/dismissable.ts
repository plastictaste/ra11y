/**
 * Rule: tooltip/dismissable
 * Satisfies: wcag22:1.4.13, wcag21:1.4.13
 * Spec: https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus
 *
 * > Where receiving and then removing pointer hover or keyboard focus
 * > triggers additional content to become visible and then hidden, the
 * > following are true:
 * >  - Dismissible: A mechanism is available to dismiss the additional
 * >    content without moving pointer hover or keyboard focus, unless
 * >    the additional content communicates an input error or does not
 * >    obscure or replace other content;
 * >  - Hoverable: If pointer hover can trigger the additional content,
 * >    then the pointer can be moved over the additional content
 * >    without the additional content disappearing;
 * >  - Persistent: The additional content remains visible until the
 * >    hover or focus trigger is removed, the user dismisses it, or
 * >    its information is no longer valid.
 *
 * Source: https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus
 *
 * Static-analysis scope (v0.0.x): the native HTML `title` attribute on
 * interactive elements is the canonical 1.4.13 failure that's
 * detectable without runtime hover/focus simulation. Native browser
 * tooltips are:
 *   - NOT dismissible (no Esc support, no close affordance);
 *   - NOT hoverable (move the pointer toward them and they vanish);
 *   - NOT persistent (timeout-based).
 * They also fail to render at all on touch devices and to many AT
 * users. The presence of `title` on an interactive element therefore
 * strongly indicates a 1.4.13 failure.
 *
 * Out of scope for this rule: custom tooltip components (Tooltip,
 * Popover, Hint). Their compliance depends on runtime keyboard and
 * pointer behavior that static analysis cannot determine. Those need
 * a manual checklist entry.
 *
 * Exempt: `<abbr title="…">`, `<dfn title="…">`, and other purely
 * non-interactive elements where `title` is the canonical mechanism
 * for term expansion. The 1.4.13 failure is specifically about
 * interactive elements.
 *
 * JS-tooltip-enhancer signal (`couldBeWrongBecause` opt-in): when the
 * titled element also carries a sibling attribute that a known JS
 * tooltip library uses as a widget trigger — Bootstrap 5
 * (`data-bs-toggle="tooltip"|"popover"`), Bootstrap 4 legacy
 * (`data-toggle="tooltip"|"popover"`), or Tippy.js (`data-tippy-content`)
 * — the rule surfaces `tooltip_js_enhancer_present` and appends a short
 * enrichment clause to the message. Those libraries replace the native
 * `title` with a runtime ARIA-aware widget (`aria-describedby` +
 * `role="tooltip"` + keyboard dismiss), so the attribute-level evidence
 * is weaker than the agent's file-level evidence. The finding STAYS
 * LIVE at the same severity — this is reason-text enrichment, NOT
 * suppression or downgrade. The agent reads the cited file, verifies
 * the runtime widget is wired up, and dismisses with a
 * `<!-- ra11y-disable -->` pragma when confirmed. Per CLAUDE.md §1
 * "Surface, don't suppress" + "No heuristic suppression" and ADR 0009.
 *
 * Sole-name-source gate (deterministic, attribute-level): when the
 * titled element has NO additional accessible-name source beyond
 * `title` itself — no visible text content, no `aria-label`, no
 * `aria-labelledby`, and (for input[type=submit|button|reset]) no
 * `value` — the rule does NOT fire. The dismiss path the rule
 * recommends ("add aria-label") would land an aria-label that
 * competes with the native title for the same accessible-name slot,
 * leaving the element worse off than before; the contradictory
 * suggestion makes the finding misleading rather than helpful. The
 * gate is honest because every input is observable from the
 * attributes / descendant text alone (no guessed composition or
 * cross-file resolution), so the suppression is deterministic, not
 * heuristic — per `docs/kb/architecture/ai-first-consumer.md` the
 * test "would the gate be correct 100% of the time from the evidence
 * the scanner has" passes. When the gate fires, the underlying
 * accessibility issue is name-source absence rather than tooltip
 * dismissability; sibling rules (forms/asterisk-required-marker,
 * aria/labelledby-target-exists, etc.) are the right place to surface
 * it. Per CLAUDE.md §1 "Surface, don't suppress" the gate is narrow:
 * any additional name source — including descendant text or alt on a
 * descendant `<img>` — passes the gate and the rule fires as before.
 *
 * Title-equals-visible-text gate (deterministic, attribute-level):
 * when the titled element's trimmed lowercased visible text content
 * equals its trimmed lowercased `title` attribute value, the rule
 * does NOT fire. SC 1.4.13 governs "additional content" that appears
 * on hover or focus; when the title duplicates the visible label
 * exactly, no additional content is presented to a sighted user, and
 * the dismissability/hoverability/persistence tests of the success
 * criterion do not apply. The redundant `title` may still be a
 * best-practice nuisance (screen-readers may double-announce on some
 * AT/browser pairings), but that is a separate concern best surfaced
 * by a dedicated `parsing/redundant-title-attribute` rule rather
 * than as a 1.4.13 violation. The gate is deterministic from a
 * trimmed/lowercased string compare on attribute + descendant text —
 * no guessed composition — so it satisfies "would the gate be
 * correct 100% of the time from the evidence the scanner has." For
 * JSX, expression-valued `title={expr}` is opaque to static analysis
 * and must NOT take this branch; the rule fires on those as before.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  htmlTextContent,
  jsxTextContent,
  truncateForEcho,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";
import { isDomOriginExtension } from "../../utils/path.ts";

/** Native HTML tags whose default role is interactive for 1.4.13 purposes. */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

/** ARIA roles that make a non-interactive element interactive. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "checkbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
  "treeitem",
  "combobox",
  "slider",
  "spinbutton",
  "textbox",
  "searchbox",
]);

export const rule = defineRule({
  id: "tooltip/dismissable",
  satisfies: ["wcag22:1.4.13", "wcag21:1.4.13"],
  severity: "warning",
  scope: "node",
  fixClass: "runtime-only",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".vue", ".svelte"],
  },
  docs: {
    description:
      "Native title attributes on interactive elements produce browser tooltips that are not dismissable, hoverable, or persistent — failing WCAG 1.4.13.",
    rationale:
      "Browser-native tooltips (rendered from the title attribute) cannot be dismissed with the Escape key, disappear when the pointer approaches them, time out unpredictably, and are invisible to many touch and assistive-technology users. WCAG 1.4.13 requires content that appears on hover or focus to be dismissable, hoverable, and persistent — three properties native tooltips do not satisfy. The fix is to expose the information as an accessible visible label, an aria-label, or a custom tooltip with proper keyboard and pointer behavior. The rule fires only when the element already has another accessible-name source (visible text, aria-label, aria-labelledby, value on a button-input, or alt on a descendant img); when title is the sole name source the rule is silent because the suggested aria-label remediation would otherwise compete with the existing title for the same name slot.",
    goodExample: `<button aria-label="Save document">💾</button>`,
    badExample: `<button title="Save document">💾</button>`,
    normativeQuote:
      "Where receiving and then removing pointer hover or keyboard focus triggers additional content to become visible and then hidden, the following are true: Dismissible, Hoverable, Persistent.",
    references: [
      "https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus",
      "https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html",
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
      // Belt-and-braces DOM-origin gate: a `title="…"` attribute substring
      // inside a packed plugin or minified `.js` bundle is not a real
      // interactive element — the surrounding code may be a string-template
      // factory or a JS-API wrapper. Only act on JSX nodes parsed out of
      // `.tsx` / `.jsx` (and the JSX-bearing `.mdx` / `.astro` aliases).
      if (!isDomOriginExtension(ctx.filePath)) return;
      checkJsx(ctx.ast as TsxModule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause?: readonly string[];
}) => void;

/**
 * `couldBeWrongBecause` code surfaced when the titled element also
 * carries a JS-tooltip-library trigger attribute (Bootstrap's
 * `data-bs-toggle="tooltip"|"popover"`, BS4 legacy `data-toggle=…`, or
 * Tippy.js's `data-tippy-content`). Those libraries substitute an
 * ARIA-aware runtime widget for the native title; static analysis
 * cannot confirm the widget is actually wired up, so the rule stays
 * live and the agent reads the file to decide. Informational only —
 * never auto-suppresses. Per CLAUDE.md §1 and ADR 0009.
 */
export const TOOLTIP_JS_ENHANCER_PRESENT = "tooltip_js_enhancer_present";

/**
 * Enhancer-attribute match result: the trigger attribute the element
 * carried and its value (when value-sensitive). Sibling-only — this is
 * a single-element attribute check, no cross-file analysis.
 */
interface EnhancerSignal {
  readonly attribute: string;
  readonly value: string | null;
}

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const el of walkHtmlElements(doc)) {
    const title = getHtmlAttribute(el, "title");
    if (title === null) continue;
    if (title.trim().length === 0) continue;
    if (!isInteractiveHtml(el)) continue;
    if (!hasAdditionalNameSourceHtml(el)) continue;
    // Title-equals-visible-text gate: when the visible text already
    // exactly matches the title (trimmed, case-insensitive), no
    // additional content is presented on hover and SC 1.4.13 does not
    // apply. Suppress at the rule level rather than just trimming the
    // suggestion. Per the rule header gate contract.
    if (isTextEquivalentToTitle(htmlTextContent(el), title)) continue;
    const enhancer = detectHtmlEnhancer(el);
    emit(buildViolation(el.tagName.toLowerCase(), title, el.loc.start, enhancer));
  }
}

function isInteractiveHtml(element: HtmlElement): boolean {
  const role = getHtmlAttribute(element, "role");
  if (role !== null && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
  const tag = element.tagName.toLowerCase();
  if (!INTERACTIVE_TAGS.has(tag)) return false;
  // <input type="hidden"> is not interactive.
  if (tag === "input") {
    const type = getHtmlAttribute(element, "type");
    if (type !== null && type.toLowerCase() === "hidden") return false;
  }
  // <a> without href is not interactive.
  if (tag === "a") {
    const href = getHtmlAttribute(element, "href");
    if (href === null) return false;
  }
  return true;
}

function checkJsx(module: TsxModule, emit: Emit): void {
  for (const el of walkJsxElements(module)) {
    const titleAttr = getJsxAttribute(el, "title");
    if (titleAttr === null) continue;
    const titleString = getJsxAttributeString(el, "title");
    // For expression-valued title={expr}, treat as load-bearing only if
    // the element is interactive — same failure mode either way.
    if (titleString !== null && titleString.trim().length === 0) continue;
    if (!isInteractiveJsx(el)) continue;
    if (!hasAdditionalNameSourceJsx(el)) continue;
    // Title-equals-visible-text gate: only meaningful for string-literal
    // titles — an expression-valued `title={expr}` runtime value is
    // unknown to static analysis, so we cannot establish equivalence
    // and the rule fires as before. Per the rule header gate contract.
    if (titleString !== null && isTextEquivalentToTitle(jsxTextContent(el), titleString)) {
      continue;
    }
    const displayTitle = titleString ?? "<expression>";
    const enhancer = detectJsxEnhancer(el);
    emit(buildViolation(el.tagName, displayTitle, el.loc.start, enhancer));
  }
}

function isInteractiveJsx(element: JsxElement): boolean {
  const role = getJsxAttributeString(element, "role");
  if (role !== null && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
  const tag = element.tagName;
  // JSX intrinsic interactive tags are always lowercase.
  if (!INTERACTIVE_TAGS.has(tag)) return false;
  if (tag === "input") {
    const type = getJsxAttributeString(element, "type");
    if (type !== null && type.toLowerCase() === "hidden") return false;
  }
  if (tag === "a") {
    const hrefAttr = getJsxAttribute(element, "href");
    if (hrefAttr === null) return false;
  }
  return true;
}

/**
 * Input types whose `value` attribute IS the canonical accessible name
 * (button-flavored inputs render the value as their visible label). For
 * these inputs a non-empty `value` counts as an additional name source
 * beyond `title`. Text-flavored inputs (`text`, `email`, `password`,
 * etc.) use `value` to seed initial input — that is NOT a label, so
 * those are excluded from this set.
 */
const INPUT_VALUE_AS_NAME_TYPES: ReadonlySet<string> = new Set(["submit", "button", "reset"]);

/**
 * Sole-name-source gate (HTML): true when the titled element has any
 * accessible-name evidence beyond `title` itself. Predicates:
 *
 *   - non-empty `aria-label`
 *   - non-empty `aria-labelledby` (the rule does not resolve the
 *     reference; per CLAUDE.md §1 "Don't duplicate capability the agent
 *     already has," dangling-id verification belongs to
 *     aria/labelledby-target-exists)
 *   - non-empty descendant text content
 *   - any descendant `<img>` carrying a non-empty `alt` (decorative
 *     `alt=""` does not count — it is explicitly empty)
 *   - for `<input type="submit"|"button"|"reset">`: non-empty `value`
 *
 * When all are absent, `title` is the sole name source — the rule
 * suppresses, because suggesting `aria-label` would land it in
 * competition with the existing `title` for the same name slot. The
 * gate is deterministic from the attributes and direct descendants
 * alone; no guessed composition.
 */
function hasAdditionalNameSourceHtml(element: HtmlElement): boolean {
  const ariaLabel = getHtmlAttribute(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  const labelledby = getHtmlAttribute(element, "aria-labelledby");
  if (labelledby !== null && labelledby.trim().length > 0) return true;
  if (htmlTextContent(element).length > 0) return true;
  if (element.tagName.toLowerCase() === "input") {
    const type = getHtmlAttribute(element, "type");
    const normalized = type === null ? "" : type.toLowerCase();
    if (INPUT_VALUE_AS_NAME_TYPES.has(normalized)) {
      const value = getHtmlAttribute(element, "value");
      if (value !== null && value.trim().length > 0) return true;
    }
  }
  if (hasDescendantImgWithAltHtml(element)) return true;
  return false;
}

/**
 * Sole-name-source gate (JSX): mirrors the HTML predicate. Notes:
 *
 *   - `aria-labelledby` is treated as present-when-the-attribute-is —
 *     JSX expression values are opaque to static analysis, so any
 *     non-empty form (string literal or expression) is honored.
 *   - JSX text content is the literal text of descendant `JsxText`
 *     nodes only; expression children count as content because their
 *     runtime value is opaque, and treating them as a possible name
 *     source is the conservative ("surface, don't suppress") move on
 *     the rule-firing side of the gate.
 */
function hasAdditionalNameSourceJsx(element: JsxElement): boolean {
  if (hasJsxAriaNameAttr(element)) return true;
  if (jsxTextContent(element).length > 0) return true;
  if (hasJsxExpressionChild(element)) return true;
  if (hasJsxInputValueName(element)) return true;
  if (hasDescendantImgWithAltJsx(element)) return true;
  return false;
}

/**
 * `aria-label` non-empty OR `aria-labelledby` present (expression
 * values opaque → treated as present per "surface, don't suppress" on
 * the rule-firing side of the gate).
 */
function hasJsxAriaNameAttr(element: JsxElement): boolean {
  const ariaLabel = getJsxAttributeString(element, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  const labelledbyAttr = getJsxAttribute(element, "aria-labelledby");
  if (labelledbyAttr === null) return false;
  const labelledbyString = getJsxAttributeString(element, "aria-labelledby");
  return labelledbyString === null || labelledbyString.trim().length > 0;
}

/** Any JSX expression child like `{label}` — opaque content. */
function hasJsxExpressionChild(element: JsxElement): boolean {
  for (const child of element.children) {
    if (child.kind === "JsxExpression") return true;
  }
  return false;
}

/**
 * `<input type="submit"|"button"|"reset" value="…">` — value renders
 * as the visible label and counts as the accessible name. Expression
 * `value={expr}` is opaque → treated as present.
 */
function hasJsxInputValueName(element: JsxElement): boolean {
  if (element.tagName !== "input") return false;
  const type = getJsxAttributeString(element, "type");
  const normalized = type === null ? "" : type.toLowerCase();
  if (!INPUT_VALUE_AS_NAME_TYPES.has(normalized)) return false;
  const valueAttr = getJsxAttribute(element, "value");
  if (valueAttr === null) return false;
  const valueString = getJsxAttributeString(element, "value");
  return valueString === null || valueString.trim().length > 0;
}

/**
 * Direct-descendant scan for `<img>` (or component named `img`) with a
 * non-empty `alt`. `alt=""` is explicitly decorative — does not count
 * as a name source. Walks all descendants because a button often wraps
 * the image in an inner `<span>` for layout.
 */
function hasDescendantImgWithAltHtml(element: HtmlElement): boolean {
  for (const descendant of walkHtmlElements(element)) {
    if (descendant.tagName.toLowerCase() !== "img") continue;
    const alt = getHtmlAttribute(descendant, "alt");
    if (alt !== null && alt.trim().length > 0) return true;
  }
  return false;
}

function hasDescendantImgWithAltJsx(element: JsxElement): boolean {
  const stack: JsxElement[] = [
    ...element.children.flatMap((c) => (c.kind === "JsxElement" ? [c] : [])),
  ];
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: stack length checked above
    const current = stack.pop()!;
    if (current.tagName === "img") {
      const alt = getJsxAttributeString(current, "alt");
      if (alt !== null && alt.trim().length > 0) return true;
    }
    for (const child of current.children) {
      if (child.kind === "JsxElement") stack.push(child);
    }
  }
  return false;
}

function buildViolation(
  tag: string,
  title: string,
  loc: { line: number; column: number },
  enhancer: EnhancerSignal | null,
): {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
  couldBeWrongBecause?: readonly string[];
} {
  // Tighter cap (40) than the helper default because `display` is
  // echoed multiple times in the suggestion below and the tooltip label
  // itself is usually short; a long value is almost certainly a bug.
  const display = truncateForEcho(title, 40);
  const baseMessage = `<${tag}> has title="${display}" — native browser tooltips are not dismissable with the keyboard, disappear on pointer approach, and are invisible to touch and many assistive-technology users, failing WCAG 1.4.13 (Content on Hover or Focus).`;
  // Reason-text gate citation: this finding fires only because the
  // element already carries another accessible-name source (visible
  // text, aria-label, aria-labelledby, alt on a descendant <img>, or
  // value= on a button-flavored input), so the title is supplementary
  // — and therefore the dismissability failure is the only WCAG 1.4.13
  // issue at this site. Telling the agent the gate fired keeps the
  // suggestion's "add aria-label" alternative from looking like it
  // would land alongside no existing name source. Per the backlog
  // gate contract.
  const gateClause =
    " The element already has another name source beyond title (visible text, aria-label, aria-labelledby, value on a button-input, or alt on a descendant <img>); the title is supplementary, not the sole accessible name.";
  const enrichmentClause =
    enhancer === null
      ? ""
      : ` Note: a JS tooltip library appears to enhance this element (sibling attribute ${describeEnhancerAttr(enhancer)}); the native title may be an input to a runtime ARIA-aware widget. Verify the runtime behavior at the call site before fixing.`;
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `${baseMessage}${gateClause}${enrichmentClause}`,
    suggestion: buildSuggestion(tag, display),
    // Conditional spread — `couldBeWrongBecause: []` would be a dishonest
    // empty-vs-unpopulated sentinel per CLAUDE.md §1.
    ...(enhancer === null ? {} : { couldBeWrongBecause: [TOOLTIP_JS_ENHANCER_PRESENT] }),
  };
}

/**
 * Visible-text vs. title equivalence: trimmed, case-insensitive
 * comparison. When equal, the title duplicates the visible label
 * exactly — no additional content is presented on hover, so the
 * SC 1.4.13 dismissability/hoverability/persistence tests do not apply.
 * The rule suppresses on this branch (rule-level skip in
 * `checkHtml` / `checkJsx`); a separate `parsing/redundant-title-attribute`
 * concern may surface that as a best-practice nudge in the future.
 *
 * Empty `text` → false: there is no visible text to *be* equivalent,
 * so the rule fires as before.
 */
function isTextEquivalentToTitle(text: string, title: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return t.toLowerCase() === title.trim().toLowerCase();
}

/**
 * Compose the three-alternative fix suggestion: visible text label,
 * aria-label, or a custom tooltip component. The agent picks whichever
 * fits the call site. The title-equals-visible-text branch is handled
 * upstream (rule-level suppression in `checkHtml` / `checkJsx`), so
 * by the time `buildSuggestion` is called the visible text definitely
 * does not already convey the title content.
 */
function buildSuggestion(tag: string, display: string): string {
  // Anchor-specific path: for <a> elements the title tooltip is almost
  // always a redundant label (markdown link title syntax, CMS-generated
  // href+title pairs) rather than a genuine tooltip widget. The fix
  // direction is removal rather than widget replacement — the link text
  // already provides the accessible name; adding a custom tooltip or an
  // aria-label would double-narrate the destination. Deterministic on tag
  // identity alone (no guessed markdown origin); only fires when the
  // sole-name-source and title-equals-visible-text gates passed, so the
  // link text IS present and IS already non-empty.
  if (tag === "a") {
    return `Remove the title="${display}" attribute from this <a> — anchor tooltips almost never add information beyond the link text itself, and the dismissability/hoverability requirements of WCAG 1.4.13 make any supplementary title a compliance burden. If the title conveys something the link text doesn't (e.g., a destination warning), incorporate it into the visible link text or a visually-hidden <span> inside the link.`;
  }
  return `Replace title="${display}" on this <${tag}> with one of: (a) a visible text label inside the element, (b) aria-label="${display}" if a visible label is impractical, or (c) a custom tooltip component that supports Escape-to-dismiss, hover-bridging, and stays visible until the trigger loses focus. The native title attribute remains acceptable on non-interactive elements like <abbr> for term expansion.`;
}

/**
 * Human-readable attribute citation for the enrichment clause. Keeps
 * the quoted value for `data-bs-toggle` / `data-toggle` (value-sensitive
 * triggers) and omits it for `data-tippy-content` (attribute presence
 * alone is the signal regardless of value).
 */
function describeEnhancerAttr(enhancer: EnhancerSignal): string {
  if (enhancer.value === null) return `\`${enhancer.attribute}\``;
  return `\`${enhancer.attribute}="${enhancer.value}"\``;
}

/**
 * Attribute-name/value pairs that name a known JS tooltip library's
 * trigger. Attribute names are matched case-insensitively via the
 * existing `getHtmlAttribute` / `getJsxAttributeString` helpers; values
 * are compared case-insensitively (Bootstrap examples in the wild
 * normalize to lowercase but the HTML spec permits mixed case).
 *
 * Three families:
 *   - Bootstrap 5: `data-bs-toggle="tooltip"|"popover"`
 *   - Bootstrap 4 (legacy): `data-toggle="tooltip"|"popover"`
 *   - Tippy.js: `data-tippy-content` (any non-empty value)
 *
 * If the ecosystem grows (e.g. a new widget library picks up
 * `data-*-tooltip`), extend this table rather than the detection logic.
 */
const VALUE_SENSITIVE_ENHANCERS: ReadonlyArray<{
  readonly attribute: string;
  readonly values: ReadonlySet<string>;
}> = [
  { attribute: "data-bs-toggle", values: new Set(["tooltip", "popover"]) },
  { attribute: "data-toggle", values: new Set(["tooltip", "popover"]) },
];

/** Attribute names whose mere presence is the enhancer signal. */
const PRESENCE_ONLY_ENHANCERS: readonly string[] = ["data-tippy-content"];

function detectHtmlEnhancer(element: HtmlElement): EnhancerSignal | null {
  for (const { attribute, values } of VALUE_SENSITIVE_ENHANCERS) {
    const raw = getHtmlAttribute(element, attribute);
    if (raw === null) continue;
    if (values.has(raw.trim().toLowerCase())) {
      return { attribute, value: raw.trim().toLowerCase() };
    }
  }
  for (const attribute of PRESENCE_ONLY_ENHANCERS) {
    const raw = getHtmlAttribute(element, attribute);
    // `data-tippy-content=""` / whitespace-only is not a wired trigger —
    // Tippy requires a non-empty content string to render anything. Per
    // CLAUDE.md §1, we avoid false-signal enrichment when the attribute
    // is structurally inert; normal finding still fires.
    if (raw !== null && raw.trim().length > 0) {
      return { attribute, value: null };
    }
  }
  return null;
}

function detectJsxEnhancer(element: JsxElement): EnhancerSignal | null {
  for (const { attribute, values } of VALUE_SENSITIVE_ENHANCERS) {
    const raw = getJsxAttributeString(element, attribute);
    if (raw === null) continue;
    if (values.has(raw.trim().toLowerCase())) {
      return { attribute, value: raw.trim().toLowerCase() };
    }
  }
  for (const attribute of PRESENCE_ONLY_ENHANCERS) {
    const raw = getJsxAttributeString(element, attribute);
    if (raw !== null && raw.trim().length > 0) {
      return { attribute, value: null };
    }
  }
  return null;
}
