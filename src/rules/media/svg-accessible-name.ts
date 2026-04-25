/**
 * Rule: media/svg-accessible-name
 * Satisfies: wcag22:1.1.1, wcag21:1.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-content
 *
 * > All non-text content that is presented to the user has a text
 * > alternative that serves the equivalent purpose, except for the
 * > situations listed below: controls, input, time-based media,
 * > tests, sensory, CAPTCHA, decoration/formatting/invisible.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-content
 * SVG 2 accessibility: https://www.w3.org/TR/SVG2/struct.html#DescriptionAndTitleElements
 *
 * Scope: inline `<svg>` in `.html` / `.htm` / `.tsx` / `.jsx` files
 * whose contextual role is "this element conveys content" — i.e. the
 * SVG is a child of a labeled-or-unlabeled interactive ancestor (a
 * `<button>`, `<a href>`, `<summary>`, or any element carrying an
 * interactive ARIA role) and is therefore the visual carrier of that
 * control's meaning. Inline `<svg role="img">` is already covered by
 * `media/alt-text-missing` (which fires when the explicit `role="img"`
 * is set without an accessible name); this rule is the complement,
 * targeting bare `<svg>` (no `role="img"`) inside interactive contexts
 * where authors typically forget the `<title>`.
 *
 * Why interactive-ancestor-only? An inline `<svg>` floating in prose is
 * ambiguous — it might be a decorative flourish (no fix needed) or a
 * load-bearing diagram (needs a `<title>`). Static analysis cannot
 * discriminate. Inside a `<button>` / `<a>` the answer is unambiguous:
 * the SVG IS the visual representation of the control, and assistive
 * tech needs an accessible name to announce it. We deliberately stay
 * narrow rather than guess at prose decoration.
 *
 * Fire condition (all of):
 *   1. Inline `<svg>` element in HTML or JSX.
 *   2. Has an interactive ancestor: `<button>`, `<a href>`, `<summary>`,
 *      or any element with `role="button" | "link" | "menuitem" |
 *      "menuitemcheckbox" | "menuitemradio" | "tab"`.
 *   3. Lacks every accessible-name pathway:
 *        a. Direct-child `<title>` element with non-empty text content.
 *        b. `role="img"` on the `<svg>` plus a non-empty `aria-label`
 *           or any `aria-labelledby`. (Without `role="img"` the SVG is
 *           not exposed as an image to AT and the labeling is ignored.)
 *        c. A descendant `<use xlink:href="#id">` (or `<use href>` —
 *           SVG 2 supports both) where `#id` resolves to a `<symbol>`
 *           in the same file whose own descendant `<title>` carries a
 *           non-empty name.
 *   4. Is NOT decoratively suppressed: `aria-hidden="true"`,
 *      `role="presentation"`, or `role="none"` on the `<svg>` itself.
 *   5. The interactive ancestor itself does NOT already carry a
 *      visible label or `aria-label` / `aria-labelledby`. When the
 *      `<button aria-label="Search"><svg>…</svg></button>` carries the
 *      name on the parent, the SVG is functionally decorative — fix
 *      would be to add `aria-hidden` to the SVG, but the AT outcome is
 *      already correct, so we don't fire. (`aria/icon-font-hidden`
 *      flags the cousin "labeled parent + unhidden icon" anti-pattern
 *      for icon-fonts; the SVG analog is out of scope here per
 *      ai-first-consumer "Don't duplicate capability".)
 *
 * `<use>` cross-symbol resolution: only same-file resolution is
 * attempted. An external sprite reference (`href="sprite.svg#id"`,
 * `xlink:href="/icons.svg#id"`) is unresolvable from static analysis;
 * we surface the finding with reason text noting the limitation, and
 * the agent reads the sprite file to confirm. A bare `#id` that does
 * not resolve to any same-file `<symbol id="id">` is treated as a
 * dangling reference and the SVG is reported as unnamed.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findHtmlElementsByTag,
  findJsxElementsByTag,
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

export const rule = defineRule({
  id: "media/svg-accessible-name",
  satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"],
  severity: "error",
  scope: "node",
  // The fix is judgment-bound — what the SVG depicts comes from the
  // surrounding code (button label, link destination), not the rule.
  // `verify-in-source` matches `media/alt-text-missing`'s lane.
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      'Inline <svg> elements inside interactive contexts (<button>, <a>, role=button) must expose an accessible name via a child <title>, role="img" + aria-label/aria-labelledby, or a resolvable <use> reference to a named <symbol>.',
    rationale:
      'An inline <svg> inside a <button> or <a> IS the visual representation of the control. Without a <title> child, role="img" + aria-label, or a <use> referencing a named <symbol>, screen readers announce nothing for the SVG and (when the parent has no other accessible name) the control becomes opaque — the canonical icon-only-button anti-pattern. Static detection is load-bearing because the antipattern is mechanical: design-tool exports (Figma, Illustrator) strip <title> by default, and inlining the export into a <button> is a one-line copy that ships unnamed every time.',
    goodExample: `<button><svg viewBox="0 0 24 24"><title>Search</title><path d="M0 0"/></svg></button>`,
    badExample: `<button><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>`,
    normativeQuote:
      "All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for the situations listed below: controls, input, time-based media, tests, sensory, CAPTCHA, decoration/formatting/invisible.",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-content",
      "https://www.w3.org/TR/SVG2/struct.html#DescriptionAndTitleElements",
      "https://www.w3.org/TR/SVG2/struct.html#UseElement",
      "https://www.w3.org/WAI/tutorials/images/decorative/",
    ],
  },
  check(ctx) {
    if (ctx.language === "html") {
      checkHtml(ctx.ast as HtmlDocument, ctx.filePath, (v) => ctx.emit(v));
    } else if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      checkJsx(ctx.ast as TsxModule, ctx.filePath, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

/** Native tag names that are always interactive controls. */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(["button", "summary"]);

/** Roles whose presence makes an ancestor an interactive control. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
]);

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function checkHtml(doc: HtmlDocument, filePath: string, emit: Emit): void {
  // Index every same-file <symbol id="…"> once so <use xlink:href="#id">
  // resolution is O(1) per check rather than O(symbols × uses).
  const symbolIndex = indexHtmlSymbols(doc);
  for (const ancestor of walkHtmlElements(doc)) {
    if (!isHtmlInteractiveAncestor(ancestor)) continue;
    if (htmlAncestorHasOwnName(ancestor)) continue;
    for (const svg of findDirectSvgDescendantsHtml(ancestor)) {
      if (isHtmlSvgDecorative(svg)) continue;
      const reason = analyzeHtmlSvgNaming(svg, symbolIndex);
      if (reason === null) continue;
      emit({
        severity: "error",
        location: { filePath, line: svg.loc.start.line, column: svg.loc.start.column },
        message: buildMessage(ancestor.tagName, reason),
        suggestion: buildSuggestion(ancestor.tagName, reason),
      });
    }
  }
}

/**
 * True when `<a>` has `href` (otherwise it's a placeholder and the
 * `<svg>` is in a non-interactive context), `<button>` / `<summary>`
 * unconditionally, or any element with an interactive ARIA role.
 */
function isHtmlInteractiveAncestor(el: HtmlElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "a" && hasHtmlAttribute(el, "href")) return true;
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = getHtmlAttribute(el, "role")?.toLowerCase() ?? "";
  return INTERACTIVE_ROLES.has(role);
}

/**
 * True when the interactive ancestor itself carries a textual or ARIA
 * accessible name. When it does, the inline SVG is functionally
 * decorative and the name reaches AT through the parent — the
 * remediation is `aria-hidden` on the SVG, not a `<title>`. To avoid
 * teaching the wrong fix and to stay out of icon-font-hidden's lane,
 * we don't emit in that case. (Note: `title` attribute is excluded from
 * the name set by design — see `accessibleNameHtml` JSDoc in
 * `aria/icon-font-hidden.shared.ts` for the rationale.)
 */
function htmlAncestorHasOwnName(el: HtmlElement): boolean {
  if (hasHtmlAttribute(el, "aria-labelledby")) return true;
  const ariaLabel = getHtmlAttribute(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  return visibleTextExcludingSvgsHtml(el).trim().length > 0;
}

function visibleTextExcludingSvgsHtml(root: HtmlElement): string {
  let out = "";
  for (const child of root.children) {
    out += visibleTextNodeHtml(child);
  }
  return out;
}

function visibleTextNodeHtml(node: HtmlNode): string {
  if (node.kind === "HtmlText") return node.value;
  if (node.kind !== "HtmlElement") return "";
  // SVG subtrees don't contribute to the parent's accessible-name
  // calculation — the inner `<path>`, `<text>`, etc. don't reach AT
  // through the host. Skip them so a `<button><svg><text>…</text>
  // </svg></button>` isn't credited as labeled.
  if (node.tagName.toLowerCase() === "svg") return "";
  return visibleTextExcludingSvgsHtml(node);
}

/**
 * Returns inline `<svg>` descendants of an interactive ancestor —
 * descend through any non-interactive intermediate (`<span>`, `<div>`,
 * `<i>`) but stop at a nested interactive control: that nested element
 * is its own ancestor candidate and the outer walk will visit it on a
 * later iteration.
 */
function findDirectSvgDescendantsHtml(ancestor: HtmlElement): readonly HtmlElement[] {
  const out: HtmlElement[] = [];
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    if (node !== ancestor && isHtmlInteractiveAncestor(node)) return;
    if (node.tagName.toLowerCase() === "svg") {
      out.push(node);
      return; // don't descend into the <svg> looking for nested <svg>
    }
    for (const child of node.children) visit(child);
  };
  for (const child of ancestor.children) visit(child);
  return out;
}

function isHtmlSvgDecorative(svg: HtmlElement): boolean {
  if (getHtmlAttribute(svg, "aria-hidden") === "true") return true;
  const role = getHtmlAttribute(svg, "role")?.toLowerCase();
  return role === "presentation" || role === "none";
}

/**
 * Diagnoses the SVG's accessible-name state. Returns `null` when at
 * least one pathway resolves; otherwise returns a tagged failure
 * reason that drives the `reason` text in `message` / `suggestion`.
 */
function analyzeHtmlSvgNaming(
  svg: HtmlElement,
  symbolIndex: HtmlSymbolIndex,
): NamingFailure | null {
  if (hasNonEmptyTitleChildHtml(svg)) return null;
  if (hasRoleImgWithLabelHtml(svg)) return null;
  const useResult = analyzeHtmlUseReferences(svg, symbolIndex);
  if (useResult === "named") return null;
  if (useResult === "external-unresolvable") return { kind: "use-external-unresolvable" };
  if (useResult === "dangling") return { kind: "use-dangling" };
  return { kind: "no-name" };
}

function hasNonEmptyTitleChildHtml(svg: HtmlElement): boolean {
  for (const child of svg.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() !== "title") continue;
    if (htmlTextContent(child).length > 0) return true;
  }
  return false;
}

function hasRoleImgWithLabelHtml(svg: HtmlElement): boolean {
  const role = getHtmlAttribute(svg, "role")?.toLowerCase();
  if (role !== "img") return false;
  const label = getHtmlAttribute(svg, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  return hasHtmlAttribute(svg, "aria-labelledby");
}

type HtmlSymbolIndex = ReadonlyMap<string, HtmlElement>;

/**
 * Builds an `id → <symbol>` map across the document. SVG 2 lets `<use>`
 * reference any element with an id, but the canonical sprite shape is
 * `<symbol id="…">` and that's what we resolve against. Other targets
 * (`<g id>`, `<svg id>` with nested `<title>`) are out of scope —
 * adding them would require a deeper conformance walk; the agent reads
 * the file when our diagnosis says "external" or "dangling."
 */
function indexHtmlSymbols(doc: HtmlDocument): HtmlSymbolIndex {
  const out = new Map<string, HtmlElement>();
  for (const symbol of findHtmlElementsByTag(doc, "symbol")) {
    const id = getHtmlAttribute(symbol, "id");
    if (id !== null && id.length > 0) out.set(id, symbol);
  }
  return out;
}

type UseResult = "named" | "external-unresolvable" | "dangling" | "no-use";

/**
 * Walks `<use>` descendants of the SVG. Each `<use>` is one of:
 *   - same-file fragment (`href="#id"` / `xlink:href="#id"`) → resolve
 *     against `symbolIndex`. A symbol with a non-empty `<title>`
 *     descendant counts as "named"; otherwise the <use> is a dangling
 *     reference.
 *   - external (`href="sprite.svg#id"`, absolute URL) → unresolvable
 *     statically. Surfaced as `external-unresolvable` so the agent
 *     reads the sprite to verify; we don't silently pass.
 *
 * Any single <use> resolving to "named" is enough to clear the SVG.
 * Otherwise the strongest negative signal wins (dangling > external)
 * so message / suggestion text is concrete.
 */
function analyzeHtmlUseReferences(svg: HtmlElement, symbolIndex: HtmlSymbolIndex): UseResult {
  let result: UseResult = "no-use";
  const visit = (node: HtmlNode): void => {
    if (node.kind !== "HtmlElement") return;
    if (node.tagName.toLowerCase() === "use") {
      result = combineUseResults(result, classifyHtmlUse(node, symbolIndex));
      if (result === "named") return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of svg.children) visit(child);
  return result;
}

function classifyHtmlUse(node: HtmlElement, symbolIndex: HtmlSymbolIndex): UseResult {
  const ref = getHtmlAttribute(node, "xlink:href") ?? getHtmlAttribute(node, "href");
  if (ref === null) return "no-use";
  return resolveUseRefHtml(ref, symbolIndex);
}

/**
 * Folds a per-`<use>` classification into the running result for the
 * SVG. "named" is absorbing — once any `<use>` resolves to a titled
 * symbol the whole SVG is named. Otherwise the strongest negative
 * signal sticks: dangling > external-unresolvable > no-use.
 */
function combineUseResults(running: UseResult, next: UseResult): UseResult {
  if (running === "named" || next === "named") return "named";
  if (running === "dangling" || next === "dangling") return "dangling";
  if (running === "external-unresolvable" || next === "external-unresolvable") {
    return "external-unresolvable";
  }
  return "no-use";
}

function resolveUseRefHtml(
  ref: string,
  symbolIndex: HtmlSymbolIndex,
): "named" | "external-unresolvable" | "dangling" {
  const trimmed = ref.trim();
  if (!trimmed.startsWith("#")) return "external-unresolvable";
  const id = trimmed.slice(1);
  const symbol = symbolIndex.get(id);
  if (!symbol) return "dangling";
  return symbolHasNonEmptyTitleHtml(symbol) ? "named" : "dangling";
}

function symbolHasNonEmptyTitleHtml(symbol: HtmlElement): boolean {
  // Search descendants — `<symbol>` typically wraps the `<title>` as a
  // direct child, but some toolchains nest it inside a `<g>`.
  for (const child of symbol.children) {
    if (child.kind !== "HtmlElement") continue;
    if (child.tagName.toLowerCase() === "title" && htmlTextContent(child).length > 0) return true;
    if (symbolHasNonEmptyTitleHtml(child)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// JSX
// ---------------------------------------------------------------------------

function checkJsx(module: TsxModule, filePath: string, emit: Emit): void {
  const symbolIndex = indexJsxSymbols(module);
  for (const ancestor of walkJsxElements(module)) {
    if (!isJsxInteractiveAncestor(ancestor)) continue;
    if (jsxAncestorHasOwnName(ancestor)) continue;
    for (const svg of findDirectSvgDescendantsJsx(ancestor)) {
      if (isJsxSvgDecorative(svg)) continue;
      const reason = analyzeJsxSvgNaming(svg, symbolIndex);
      if (reason === null) continue;
      emit({
        severity: "error",
        location: { filePath, line: svg.loc.start.line, column: svg.loc.start.column },
        message: buildMessage(ancestor.tagName, reason),
        suggestion: buildSuggestion(ancestor.tagName, reason),
      });
    }
  }
}

function isJsxInteractiveAncestor(el: JsxElement): boolean {
  const tag = el.tagName;
  // PascalCase wrappers are opaque — we cannot know what they render.
  // Skip them to avoid false positives; the agent reads the file.
  if (tag.length > 0 && (tag[0] ?? "") >= "A" && (tag[0] ?? "") <= "Z") return false;
  if (tag === "a" && hasJsxAttribute(el, "href")) return true;
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = getJsxAttributeString(el, "role")?.toLowerCase() ?? "";
  return INTERACTIVE_ROLES.has(role);
}

function jsxAncestorHasOwnName(el: JsxElement): boolean {
  if (hasJsxAttribute(el, "aria-labelledby")) return true;
  const ariaLabel = getJsxAttributeString(el, "aria-label");
  if (ariaLabel !== null && ariaLabel.trim().length > 0) return true;
  if (visibleTextExcludingSvgsJsx(el).trim().length > 0) return true;
  // Runtime-valued children (`<button>{label}</button>`) likely carry
  // a name we can't see statically. Treat as labeled — false-positive
  // avoidance dominates for the SVG-in-button case (same tradeoff
  // `aria/icon-font-hidden` makes).
  for (const child of el.children) {
    if (child.kind === "JsxExpression") return true;
  }
  return false;
}

function visibleTextExcludingSvgsJsx(root: JsxElement): string {
  let out = "";
  for (const child of root.children) {
    out += visibleTextNodeJsx(child);
  }
  return out;
}

function visibleTextNodeJsx(node: JsxNode): string {
  if (node.kind === "JsxText") return node.value;
  if (node.kind !== "JsxElement") return "";
  if (node.tagName.toLowerCase() === "svg") return "";
  return visibleTextExcludingSvgsJsx(node);
}

function findDirectSvgDescendantsJsx(ancestor: JsxElement): readonly JsxElement[] {
  const out: JsxElement[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    if (node !== ancestor && isJsxInteractiveAncestor(node)) return;
    if (node.tagName.toLowerCase() === "svg") {
      out.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of ancestor.children) visit(child);
  return out;
}

function isJsxSvgDecorative(svg: JsxElement): boolean {
  if (getJsxAttributeString(svg, "aria-hidden") === "true") return true;
  const role = getJsxAttributeString(svg, "role")?.toLowerCase();
  return role === "presentation" || role === "none";
}

function analyzeJsxSvgNaming(svg: JsxElement, symbolIndex: JsxSymbolIndex): NamingFailure | null {
  if (hasNonEmptyTitleChildJsx(svg)) return null;
  if (hasRoleImgWithLabelJsx(svg)) return null;
  const useResult = analyzeJsxUseReferences(svg, symbolIndex);
  if (useResult === "named") return null;
  if (useResult === "external-unresolvable") return { kind: "use-external-unresolvable" };
  if (useResult === "dangling") return { kind: "use-dangling" };
  return { kind: "no-name" };
}

function hasNonEmptyTitleChildJsx(svg: JsxElement): boolean {
  for (const child of svg.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName.toLowerCase() !== "title") continue;
    if (jsxTextContent(child).length > 0) return true;
    // Expression child (e.g. `<title>{label}</title>`) — same
    // false-negative-friendly tradeoff as `media/alt-text-missing`.
    for (const inner of child.children) {
      if (inner.kind === "JsxExpression") return true;
    }
  }
  return false;
}

function hasRoleImgWithLabelJsx(svg: JsxElement): boolean {
  const role = getJsxAttributeString(svg, "role")?.toLowerCase();
  if (role !== "img") return false;
  const label = getJsxAttributeString(svg, "aria-label");
  if (label !== null && label.trim().length > 0) return true;
  if (hasJsxAttribute(svg, "aria-labelledby")) return true;
  // Runtime-valued aria-label — treat as named.
  const labelAttr = svg.attributes.find((a) => a.name === "aria-label");
  return labelAttr?.value?.kind === "Expression";
}

type JsxSymbolIndex = ReadonlyMap<string, JsxElement>;

function indexJsxSymbols(module: TsxModule): JsxSymbolIndex {
  const out = new Map<string, JsxElement>();
  for (const symbol of findJsxElementsByTag(module, "symbol")) {
    const id = getJsxAttributeString(symbol, "id");
    if (id !== null && id.length > 0) out.set(id, symbol);
  }
  return out;
}

function analyzeJsxUseReferences(svg: JsxElement, symbolIndex: JsxSymbolIndex): UseResult {
  let result: UseResult = "no-use";
  const visit = (node: JsxNode): void => {
    if (node.kind !== "JsxElement") return;
    if (node.tagName.toLowerCase() === "use") {
      result = combineUseResults(result, classifyJsxUse(node, symbolIndex));
      if (result === "named") return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of svg.children) visit(child);
  return result;
}

/**
 * Reads the SVG 2 / SVG 1.1 reference attribute off a `<use>` element.
 * SVG 2 promotes plain `href`; SVG 1.1 used `xlink:href`. JSX commonly
 * spells the latter as `xlinkHref` (React's normalized form) but the
 * raw `xlink:href` is also valid in real source.
 */
function readJsxUseRef(node: JsxElement): string | null {
  return (
    getJsxAttributeString(node, "xlinkHref") ??
    getJsxAttributeString(node, "xlink:href") ??
    getJsxAttributeString(node, "href")
  );
}

function classifyJsxUse(node: JsxElement, symbolIndex: JsxSymbolIndex): UseResult {
  const ref = readJsxUseRef(node);
  if (ref === null) return "no-use";
  return resolveUseRefJsx(ref, symbolIndex);
}

function resolveUseRefJsx(
  ref: string,
  symbolIndex: JsxSymbolIndex,
): "named" | "external-unresolvable" | "dangling" {
  const trimmed = ref.trim();
  if (!trimmed.startsWith("#")) return "external-unresolvable";
  const id = trimmed.slice(1);
  const symbol = symbolIndex.get(id);
  if (!symbol) return "dangling";
  return symbolHasNonEmptyTitleJsx(symbol) ? "named" : "dangling";
}

function symbolHasNonEmptyTitleJsx(symbol: JsxElement): boolean {
  for (const child of symbol.children) {
    if (child.kind !== "JsxElement") continue;
    if (child.tagName.toLowerCase() === "title" && jsxTextContent(child).length > 0) return true;
    if (symbolHasNonEmptyTitleJsx(child)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Message / suggestion construction
// ---------------------------------------------------------------------------

type NamingFailure =
  | { readonly kind: "no-name" }
  | { readonly kind: "use-external-unresolvable" }
  | { readonly kind: "use-dangling" };

function buildMessage(ancestorTag: string, reason: NamingFailure): string {
  const ancestorPhrase = formatAncestorPhrase(ancestorTag);
  if (reason.kind === "no-name") {
    return (
      `Inline <svg> inside ${ancestorPhrase} has no accessible name — ` +
      `no <title> child, no role="img" + aria-label/aria-labelledby, and no <use> reference. ` +
      `Screen readers announce nothing for the control.`
    );
  }
  if (reason.kind === "use-external-unresolvable") {
    return (
      `Inline <svg> inside ${ancestorPhrase} references an external sprite via <use href> ` +
      `but has no <title> child or aria-label of its own. The accessible name depends on ` +
      `whether the referenced <symbol> in the sprite file has a <title> — verify in source.`
    );
  }
  return (
    `Inline <svg> inside ${ancestorPhrase} references a same-file id via <use href="#…"> ` +
    `but no matching <symbol id="…"> with a non-empty <title> exists in this file — ` +
    `the reference is dangling and the SVG has no accessible name.`
  );
}

function buildSuggestion(ancestorTag: string, reason: NamingFailure): string {
  const ancestorPhrase = formatAncestorPhrase(ancestorTag);
  if (reason.kind === "no-name") {
    return (
      `Add a <title> child as the first element of the <svg> describing what the icon means in ` +
      `the context of ${ancestorPhrase} (e.g., <title>Search</title>, <title>Close dialog</title>). ` +
      `Alternatives: set role="img" plus aria-label="…" on the <svg>, or move the name to the ` +
      `${ancestorPhrase} via aria-label and add aria-hidden="true" to the <svg>. If the SVG is ` +
      `purely decorative because the parent already carries the name, mark the <svg> ` +
      `aria-hidden="true".`
    );
  }
  if (reason.kind === "use-external-unresolvable") {
    return (
      `Read the sprite file to confirm the referenced <symbol> has a non-empty <title>. ` +
      `If it does not, add a <title> child to the <svg> directly (e.g., <title>Search</title>) ` +
      `or set aria-label on the <svg>. The fix-here is more reliable than mutating a shared ` +
      `sprite, since other consumers may already depend on the symbol's current shape.`
    );
  }
  return (
    `The <use href="#…"> id does not match any <symbol id="…"> in this file. Either fix the ` +
    `reference to point at a real symbol whose <title> describes the icon, or add a <title> ` +
    `child directly to the <svg> as a fallback. If this <svg> is decorative, mark it ` +
    `aria-hidden="true".`
  );
}

function formatAncestorPhrase(tag: string): string {
  const lower = tag.toLowerCase();
  if (lower === "a") return "<a>";
  if (lower === "button") return "<button>";
  if (lower === "summary") return "<summary>";
  return `<${tag}>`;
}
