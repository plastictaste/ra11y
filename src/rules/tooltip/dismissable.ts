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
 */

import { defineRule } from "../../api/plugin.ts";
import {
  getHtmlAttribute,
  getJsxAttribute,
  getJsxAttributeString,
  truncateForEcho,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement, JsxElement, TsxModule } from "../../types/ast.ts";

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
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Native title attributes on interactive elements produce browser tooltips that are not dismissable, hoverable, or persistent — failing WCAG 1.4.13.",
    rationale:
      "Browser-native tooltips (rendered from the title attribute) cannot be dismissed with the Escape key, disappear when the pointer approaches them, time out unpredictably, and are invisible to many touch and assistive-technology users. WCAG 1.4.13 requires content that appears on hover or focus to be dismissable, hoverable, and persistent — three properties native tooltips do not satisfy. The fix is to expose the information as an accessible visible label, an aria-label, or a custom tooltip with proper keyboard and pointer behavior.",
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
  // echoed three times in the suggestion below and the tooltip label
  // itself is usually short; a long value is almost certainly a bug.
  const display = truncateForEcho(title, 40);
  const baseMessage = `<${tag}> has title="${display}" — native browser tooltips are not dismissable with the keyboard, disappear on pointer approach, and are invisible to touch and many assistive-technology users, failing WCAG 1.4.13 (Content on Hover or Focus).`;
  const enrichmentClause =
    enhancer === null
      ? ""
      : ` Note: a JS tooltip library appears to enhance this element (sibling attribute ${describeEnhancerAttr(enhancer)}); the native title may be an input to a runtime ARIA-aware widget. Verify the runtime behavior at the call site before fixing.`;
  return {
    severity: "warning",
    location: { filePath: "", line: loc.line, column: loc.column },
    message: `${baseMessage}${enrichmentClause}`,
    suggestion: `Replace title="${display}" on this <${tag}> with one of: (a) a visible text label inside the element, (b) aria-label="${display}" if a visible label is impractical, or (c) a custom tooltip component that supports Escape-to-dismiss, hover-bridging, and stays visible until the trigger loses focus. The native title attribute remains acceptable on non-interactive elements like <abbr> for term expansion.`,
    // Conditional spread — `couldBeWrongBecause: []` would be a dishonest
    // empty-vs-unpopulated sentinel per CLAUDE.md §1.
    ...(enhancer === null ? {} : { couldBeWrongBecause: [TOOLTIP_JS_ENHANCER_PRESENT] }),
  };
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
