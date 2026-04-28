/**
 * Rule: navigation/link-target-blank-announcement
 * Satisfies: wcag22:3.2.5
 * Spec: https://www.w3.org/TR/WCAG22/#change-on-request
 *
 * > Changes of context are initiated only by user request or a
 * > mechanism is available to turn off such changes.
 *
 * Source: https://www.w3.org/TR/WCAG22/#change-on-request
 *
 * Flags `<a target="_blank">` anchors (HTML and JSX `<a>` / `<Link>` /
 * `<NavLink>` / `<Anchor>`) that lack any signal telling the user the
 * link will open in a new window or tab. Opening a new window is a
 * change of context at activation time, and WCAG 3.2.5 requires the
 * user be informed before the change so activation is a conscious
 * request.
 *
 * Passes (any one is sufficient):
 *   - `aria-label` on the link whose value contains a new-window
 *     phrase ("new window", "new tab", "external", "opens in").
 *   - Visible link-text content contains a new-window phrase. This
 *     covers the common `<span class="sr-only">opens in new window</span>`
 *     pattern because visually-hidden descendants contribute to the
 *     link's rendered text — htmlTextContent / jsxTextContent already
 *     flatten descendants.
 *   - A descendant element carries an `aria-label` with a new-window
 *     phrase (the icon-child pattern:
 *     `<a target="_blank">Docs <ExternalIcon aria-label="opens in new window" /></a>`).
 *
 * Rule intentionally does not check `rel="noopener"` — that's a
 * security concern, not accessibility. Scope lock.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsForTag,
  getHtmlAttribute,
  getJsxAttributeString,
  htmlTextContent,
  jsxTextContent,
  truncateForEcho,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import { stripTemplateDirectives } from "../../input/parsers/html-template-directives.ts";
import type { HtmlDocument, HtmlElement, JsxElement, JsxNode, TsxModule } from "../../types/ast.ts";

/**
 * Phrases that, when present in link text / aria-label / descendant
 * aria-label, signal to the user that activating the link will open a
 * new window or tab. Matched case-insensitively as substrings so
 * variations like "(opens in a new tab)", "external link", "Opens in
 * new window" all pass.
 */
const ANNOUNCEMENT_PHRASES: readonly string[] = ["new window", "new tab", "external", "opens in"];

/** JSX tags that represent a link. Mirrors navigation/link-descriptive-text. */
const JSX_LINK_TAGS: ReadonlySet<string> = new Set(["a", "Link", "NavLink", "Anchor"]);

export const rule = defineRule({
  id: "navigation/link-target-blank-announcement",
  satisfies: ["wcag22:3.2.5"],
  severity: "warning",
  scope: "node",
  fixClass: "guidance",
  // Wrapper components declared as rendering `<a>` via `nativeWrappers`
  // receive the same check — a `<MyRouterLink target="_blank">` without
  // announcement is the same failure as a bare `<a target="_blank">`.
  wrapperTreatsAsElement: "a",
  appliesTo: {
    // Canonical-parser extensions only. The engine's `extensionMatches`
    // (src/utils/path.ts) aliases every other extension that routes through
    // the same parser into this list at filter time — so `.erb`, `.md`,
    // `.markdown`, `.mkdn`, `.xhtml`, `.svg`, `.astro` all match `.html`/`.htm`,
    // and `.mdx` matches `.tsx`/`.jsx`. Extending this list to spell out
    // every alias would be redundant; updating the alias table is the
    // single point of truth when a new extension joins the html or jsx
    // family.
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Links with target="_blank" must announce that they open in a new window or tab so users aren\'t disoriented by the unexpected context change.',
    rationale:
      'Opening a new window or tab is a change of context that happens at link activation. WCAG 3.2.5 (Change on Request, AAA) requires such changes to be initiated by user request — meaning the user is informed before they activate the control, not surprised by it after. Screen-reader users especially lose orientation when focus lands in a new tab they didn\'t expect. A visible "opens in new window" note, an `aria-label` including the phrase, or a visually-hidden span with the announcement all satisfy this.',
    goodExample: `<a href="/docs" target="_blank" aria-label="Docs (opens in new window)">Docs</a>`,
    badExample: `<a href="/docs" target="_blank">Docs</a>`,
    normativeQuote:
      "Changes of context are initiated only by user request or a mechanism is available to turn off such changes.",
    references: [
      "https://www.w3.org/TR/WCAG22/#change-on-request",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G201",
      "https://www.w3.org/WAI/WCAG22/Techniques/html/H83",
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
      checkJsx(ctx.ast as TsxModule, ctx.wrappersForElement, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error" | "warning" | "info";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  for (const a of findHtmlElementsByTag(doc, "a")) {
    const target = getHtmlAttribute(a, "target");
    if (target !== "_blank") continue;
    if (hasAnnouncementHtml(a)) continue;

    const visibleText = htmlTextContent(a);
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: a.loc.start.line,
        column: a.loc.start.column,
      },
      message: `<a target="_blank"> opens a new window but gives no warning — screen-reader and keyboard users activating this link will land in an unexpected new tab with no notice.`,
      suggestion: buildSuggestion(getHtmlAttribute(a, "href"), visibleText),
    });
  }
}

function checkJsx(module: TsxModule, wrappersForA: ReadonlySet<string>, emit: Emit): void {
  const seen = new Set<JsxElement>();
  const emitEl = (el: JsxElement): void => {
    if (seen.has(el)) return;
    seen.add(el);
    const target = getJsxAttributeString(el, "target");
    if (target !== "_blank") return;
    if (hasAnnouncementJsx(el)) return;
    const visibleText = jsxTextContent(el);
    emit({
      severity: "warning",
      location: {
        filePath: "",
        line: el.loc.start.line,
        column: el.loc.start.column,
      },
      message: `<${el.tagName} target="_blank"> opens a new window but gives no warning — screen-reader and keyboard users activating this link will land in an unexpected new tab with no notice.`,
      suggestion: buildSuggestion(
        getJsxAttributeString(el, "href") ?? getJsxAttributeString(el, "to"),
        visibleText,
      ),
    });
  };
  const wrappers = new Set<string>([...JSX_LINK_TAGS, ...wrappersForA]);
  wrappers.delete("a");
  for (const el of findJsxElementsForTag(module, "a", wrappers)) {
    emitEl(el);
  }
}

function hasAnnouncementHtml(a: HtmlElement): boolean {
  // Channel 1: aria-label on the link itself.
  const ariaLabel = getHtmlAttribute(a, "aria-label");
  if (ariaLabel !== null && containsPhrase(ariaLabel)) return true;

  // Channel 2: visible rendered text. htmlTextContent flattens every
  // descendant text node, so `<a><span class="sr-only">opens in new
  // window</span>Docs</a>` and `<a>Docs (external)</a>` both resolve to
  // text containing a phrase.
  if (containsPhrase(htmlTextContent(a))) return true;

  // Channel 3: descendant aria-label — covers the icon-child pattern
  // where the announcement lives on a child span/svg/i rather than the
  // link itself.
  for (const descendant of walkHtmlElements(a)) {
    const descLabel = getHtmlAttribute(descendant, "aria-label");
    if (descLabel !== null && containsPhrase(descLabel)) return true;
  }

  return false;
}

function hasAnnouncementJsx(el: JsxElement): boolean {
  // Channel 1: aria-label on the link itself (string-literal only —
  // expression-valued `aria-label` is opaque, and we don't want to
  // silently pass on an unknown expression).
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel !== null && containsPhrase(ariaLabel)) return true;

  // Channel 2: visible literal text. jsxTextContent flattens descendant
  // JsxText nodes, so a <span className="sr-only">opens in new
  // window</span> child contributes to the text just like visible text
  // does.
  if (containsPhrase(jsxTextContent(el))) return true;

  // Channel 3: descendant aria-label — icon-child pattern.
  for (const descendant of jsxDescendantElements(el)) {
    const descLabel = getJsxAttributeString(descendant, "aria-label");
    if (descLabel !== null && containsPhrase(descLabel)) return true;
  }

  return false;
}

function* jsxDescendantElements(el: JsxElement): Iterable<JsxElement> {
  for (const child of el.children) {
    if (isJsxElementNode(child)) {
      yield child;
      yield* jsxDescendantElements(child);
    }
  }
}

function isJsxElementNode(node: JsxNode): node is JsxElement {
  return node.kind === "JsxElement";
}

function containsPhrase(text: string): boolean {
  const normalized = text.toLowerCase();
  for (const phrase of ANNOUNCEMENT_PHRASES) {
    if (normalized.includes(phrase)) return true;
  }
  return false;
}

function buildSuggestion(href: string | null, visibleText: string): string {
  // Strip template directives before echo: the parser's text-node path
  // breaks on `<` (so `{% if a < b %}foo{% endif %}` leaks a raw `{%
  // if a <` token into HtmlText.value), and attribute-valued hrefs may
  // contain raw Liquid. Neither belongs in the suggestion body.
  const text = truncateForEcho(stripTemplateDirectives(visibleText).value.trim());
  const destination = href ? truncateForEcho(destinationHint(href)) : "";
  const labelSample = destination
    ? `aria-label="${text || destination} (opens in new window)"`
    : `aria-label="${text || "link"} (opens in new window)"`;
  if (text) {
    return `Add a new-window announcement to the link. Either include a visually-hidden span inside the link text (e.g. \`<span class="sr-only">(opens in new window)</span>\`), or set ${labelSample} on the link. Visible text alone ("${text}") doesn't tell screen-reader users the link opens a new tab.`;
  }
  return `Add a new-window announcement to the link — an aria-label ending in "(opens in new window)" or a visually-hidden "opens in new window" span inside the link text. Without it, users have no warning that activation changes context to a new tab.`;
}

function destinationHint(href: string): string {
  const cleaned =
    href
      .replace(/^https?:\/\/[^/]+/, "")
      .replace(/[?#].*$/, "")
      .replace(/^\//, "")
      .replace(/\.[a-zA-Z0-9]+$/, "")
      .split("/")
      .pop() ?? "";
  return cleaned.replace(/[-_]+/g, " ").trim();
}
