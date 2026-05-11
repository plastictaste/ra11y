/**
 * Rule: navigation/link-no-href
 * Satisfies: wcag22:2.1.1, wcag21:2.1.1, wcag22:4.1.2, wcag21:4.1.2
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > All functionality of the content is operable through a keyboard
 * > interface without requiring specific timings for individual
 * > keystrokes […].
 *
 * Source: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * An `<a>` without an `href` is not in the default keyboard tab order
 * and is announced by screen readers as a generic container, not as
 * a link. If the element has an `onClick` (or `onclick`) handler, it
 * behaves like a button but can't be reached with Tab and can't be
 * activated with Enter — keyboard and AT users are locked out.
 *
 * The HTML spec is explicit: "The href content attribute on a and
 * area elements must have a value that is a valid URL potentially
 * surrounded by spaces." (https://html.spec.whatwg.org/#the-a-element)
 *
 * Some controls don't carry a click handler in the markup at all — the
 * behaviour is wired at runtime by a sibling `<script>` (carousel
 * `prev`/`next`, Bootstrap `dropdown-toggle`, plugin tabs/accordions,
 * `btn`/`nav-link` styled anchors). The agent reading the file can see
 * the intent the static handler-only check misses; we extend the rule
 * to fire on absent `href` plus an interactive *class* signal so those
 * silent-miss cases reach the agent too. A bare `<a id="anchor">` with
 * no class signal stays silent — that's a legitimate fragment target,
 * not a control.
 *
 * Scope split: this rule fires only when the `href` attribute is
 * GENUINELY ABSENT. Placeholder shapes (`href="#"`, `href=""`,
 * `href="  #  "`, `href="javascript:…"`) are owned by companion rules
 * `navigation/href-empty-fragment` and `navigation/href-javascript-scheme`.
 * The split keeps each rule's message text honest about the evidence
 * the snippet shows — emitting "with no href" on a line carrying
 * `href="#"` was the dishonest double-emit captured by
 * `tests/fixtures/real-world/navigation-link-no-href-on-href-empty-fragment/`.
 *
 * The fix depends on intent:
 *   - A link that navigates → add href
 *   - A control that toggles/submits → use <button type="button">
 *     instead of a bare <a onClick>
 */

import { defineRule } from "../../api/plugin.ts";
import {
  describeJsxExpressionIntent,
  findHtmlElementsByTag,
  findJsxElementsByTag,
  getHtmlAttribute,
  getJsxAttribute,
  hasHtmlAttribute,
  hasJsxAttribute,
} from "../../engine/ast-helpers.ts";
import type {
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  JsxElement,
  TsxModule,
} from "../../types/ast.ts";

/**
 * Extracts the trimmed inline text content of an element by joining its
 * direct `HtmlText` children. Used only for additive context in the
 * emission message — the agent reads the file for the full picture.
 * Returns `null` if no text content is present, and clamps long strings
 * to keep the message scannable.
 */
function htmlElementText(element: HtmlElement): string | null {
  const parts: string[] = [];
  for (const child of element.children) {
    if (child.kind === "HtmlText") parts.push(child.value);
  }
  const joined = parts.join(" ").trim().replace(/\s+/g, " ");
  if (joined.length === 0) return null;
  return joined.length > 60 ? `${joined.slice(0, 60)}…` : joined;
}

/**
 * JSX equivalent of {@link htmlElementText}. Joins direct `JsxText`
 * children (string literals); JSX expression children are opaque and
 * intentionally skipped — the agent reads the file when they matter.
 */
function jsxElementText(element: JsxElement): string | null {
  const parts: string[] = [];
  for (const child of element.children) {
    if (child.kind === "JsxText") parts.push(child.value);
  }
  const joined = parts.join(" ").trim().replace(/\s+/g, " ");
  if (joined.length === 0) return null;
  return joined.length > 60 ? `${joined.slice(0, 60)}…` : joined;
}

/**
 * Class tokens that signal an `<a>` is being styled / wired as an
 * interactive control rather than a passive link / fragment target.
 * The list is conservative — every entry corresponds to a documented
 * pattern from a widely-used library (Bootstrap, Foundation, AdminLTE,
 * Owl Carousel, Slick, jQuery UI):
 *
 *   - `btn`, `nav-link`             → Bootstrap button / nav anchor
 *   - `prev`, `next`                → carousel / pager controls
 *   - `dropdown-toggle`             → Bootstrap dropdown
 *   - `accordion-toggle`            → Bootstrap accordion
 *   - `tab`                         → tab-panel switcher
 *   - `slide`                       → carousel slide control
 *
 * A non-control `<a>` (fragment target, named anchor, in-flow link)
 * does not carry these tokens, so matching them is not a false-positive
 * source. Detection is whole-token (split on whitespace), so an
 * `<a class="user-tab-item">` does not match `tab`.
 */
const INTERACTIVE_CLASS_TOKENS = new Set<string>([
  "btn",
  "nav-link",
  "prev",
  "next",
  "dropdown-toggle",
  "accordion-toggle",
  "tab",
  "slide",
]);

function hasInteractiveClassSignal(classValue: string | null): string | null {
  if (classValue === null) return null;
  for (const token of classValue.split(/\s+/)) {
    if (token.length === 0) continue;
    if (INTERACTIVE_CLASS_TOKENS.has(token)) return token;
  }
  return null;
}

/**
 * Structural-ancestor constraints. When a flagged anchor sits inside an
 * element whose role contract restricts the shape of its descendants,
 * the bare "swap `<a>` for `<button>`" suggestion is wrong — the swap
 * either breaks the ancestor's keyboard model (menu / menubar /
 * listbox) or produces invalid markup (`<select>`, `<datalist>`, table
 * structural elements). The agent reading the file is the right
 * arbiter; this list points at the constraint so the suggestion can
 * propose the within-constraint alternative.
 *
 * Each entry is a deterministic ancestor predicate (tag + optional
 * role / class), a short label naming the constraint, and a one-line
 * fix sketch describing the within-constraint shape. Per AI-first
 * doctrine ("Don't duplicate capability the agent already has"), the
 * sketch points at the shape rather than rewriting the markup — the
 * agent reads the file and picks the right concrete edit.
 */
interface StructuralConstraint {
  /** Short token for the agent to grep on (e.g. `ul-role-menu`). */
  readonly code: string;
  /** Human-readable description of the constraint. */
  readonly label: string;
  /** One-line within-constraint fix sketch (no leading punctuation). */
  readonly fixSketch: string;
}

/**
 * Returns the structural-constraint hit for an HTML ancestor element,
 * or `null` if no constraint applies. Pure on the supplied element.
 */
function classifyHtmlConstraint(element: HtmlElement): StructuralConstraint | null {
  const tag = element.tagName.toLowerCase();
  const role = (getHtmlAttribute(element, "role") ?? "").trim().toLowerCase();
  const classValue = getHtmlAttribute(element, "class") ?? "";
  return classifyConstraint(tag, role, classValue);
}

/**
 * JSX ancestor variant. JSX `className` is the canonical attribute
 * spelling for class-name string-literal probes; some libraries forward
 * `class` as well. Expression-form attribute values are opaque and
 * intentionally not consulted — the agent reads the file.
 */
function classifyJsxConstraint(element: JsxElement): StructuralConstraint | null {
  const tag = element.tagName.toLowerCase();
  const role = jsxStringLiteralAttribute(element, "role") ?? "";
  const classValue =
    jsxStringLiteralAttribute(element, "className") ??
    jsxStringLiteralAttribute(element, "class") ??
    "";
  return classifyConstraint(tag, role.trim().toLowerCase(), classValue);
}

/**
 * Per-tag content-model constraints — fixed lookup, no role / class
 * inspection. Covers `<select>`, `<datalist>`, `<menu>`, and the table
 * structural elements whose descendants must follow a specific tag
 * scaffolding for the markup to be valid.
 */
const FIXED_TAG_CONSTRAINTS: ReadonlyMap<string, StructuralConstraint> = new Map([
  [
    "select",
    {
      code: "select-content-model",
      label: "<select> — only <option> and <optgroup> are valid descendants",
      fixSketch:
        'convert each <a> to <option value="…">label</option> and wire selection through the <select>\'s onChange',
    },
  ],
  [
    "datalist",
    {
      code: "datalist-content-model",
      label: "<datalist> — only <option> elements are valid descendants",
      fixSketch:
        'convert each <a> to <option value="…">label</option>; the <datalist> attaches to a paired <input list="…">',
    },
  ],
  [
    "menu",
    {
      code: "menu-element-content-model",
      label: "<menu> — content model expects <li> children carrying the activatable control",
      fixSketch:
        'wrap the action in <li><button type="button">…</button></li>; navigation items stay <li><a href="…">…</a></li>',
    },
  ],
  ...(["table", "tbody", "thead", "tfoot", "tr"] as const).map(
    (t): readonly [string, StructuralConstraint] => [
      t,
      {
        code: `${t}-content-model`,
        label: `<${t}> — descendants must be table-structural elements (<tr>/<td>/<th>); placing a bare interactive control here is invalid markup`,
        fixSketch:
          "place the control inside a <td> (or <th>) cell and keep the <tr>/<thead>/<tbody> scaffolding",
      },
    ],
  ),
]);

/**
 * APG composite-widget role constraints on `<ul>` / `<ol>`. Each entry
 * names the within-pattern shape descendants must take — the bare swap
 * to `<button>` loses the composite's keyboard model (roving tabindex,
 * arrow keys, escape).
 */
const LIST_ROLE_CONSTRAINTS: ReadonlyMap<string, (tag: string) => StructuralConstraint> = new Map([
  [
    "menu",
    (tag) => ({
      code: `${tag}-role-menu`,
      label: `<${tag} role="menu"> — APG menu pattern; descendants must be <li role="menuitem"> with anchor children for navigation, or <button> children for actions`,
      fixSketch:
        'keep the <a> for navigation items (add the missing href, e.g. href="/path"); for action items, replace the <a> with <button type="button"> wrapped in <li role="menuitem">. Either way, the parent <li> must carry role="menuitem" and the menu\'s focus management (roving tabindex, arrow-key handlers) must remain intact',
    }),
  ],
  [
    "menubar",
    (tag) => ({
      code: `${tag}-role-menubar`,
      label: `<${tag} role="menubar"> — APG menubar pattern; descendants must be <li role="menuitem"> with anchor children for navigation, or <button> children for actions`,
      fixSketch:
        'keep the <a> for navigation items (add a real href); for action items, replace the <a> with <button type="button"> wrapped in <li role="menuitem">. The menubar\'s focus management (roving tabindex, arrow-key handlers) must remain intact',
    }),
  ],
  [
    "listbox",
    (tag) => ({
      code: `${tag}-role-listbox`,
      label: `<${tag} role="listbox"> — APG listbox pattern; descendants must be role="option" elements, not <a> / <button>`,
      fixSketch:
        'convert each <a> to a <li role="option"> and wire selection through the listbox\'s keyboard handlers',
    }),
  ],
  [
    "tablist",
    (tag) => ({
      code: `${tag}-role-tablist`,
      label: `<${tag} role="tablist"> — APG tabs pattern; descendants must be role="tab" elements with the tablist's roving-tabindex / arrow-key model`,
      fixSketch:
        'convert each <a> to <button role="tab" type="button" aria-selected="…" aria-controls="<panel-id>"> wrapped in the <li> if the list structure is preserved',
    }),
  ],
  [
    "tree",
    (tag) => ({
      code: `${tag}-role-tree`,
      label: `<${tag} role="tree"> — APG tree pattern; descendants must be role="treeitem" elements, not bare <a> / <button>`,
      fixSketch:
        'place the control in a <li role="treeitem">; keep the <a href="…"> for navigation items or use <button> for action items, but the parent <li> must carry the tree role',
    }),
  ],
]);

function classifyConstraint(
  tag: string,
  loweredRole: string,
  classValue: string,
): StructuralConstraint | null {
  const fixed = FIXED_TAG_CONSTRAINTS.get(tag);
  if (fixed !== undefined) return fixed;
  if (tag !== "ul" && tag !== "ol") return null;
  return classifyListConstraint(tag, loweredRole, classValue);
}

function classifyListConstraint(
  tag: "ul" | "ol",
  loweredRole: string,
  classValue: string,
): StructuralConstraint | null {
  const roleHit = LIST_ROLE_CONSTRAINTS.get(loweredRole);
  if (roleHit !== undefined) return roleHit(tag);
  // Bootstrap-class signal: `class="dropdown-menu"` is the de-facto
  // role="menu" surface (Bootstrap applies the role at runtime via JS).
  // Whitespace-tokenized whole-word match — `dropdown-menu-foo` does
  // not hit, but `dropdown-menu show` does.
  if (containsClassToken(classValue, "dropdown-menu")) {
    return {
      code: `${tag}-class-dropdown-menu`,
      label: `<${tag} class="dropdown-menu"> — Bootstrap dropdown menu (role="menu" applied at runtime); descendants are menu items, not bare interactive controls`,
      fixSketch:
        'keep the <a> for navigation items (add the missing href); for action items, the canonical Bootstrap shape is <li><button class="dropdown-item" type="button">…</button></li>. Don\'t flatten the <li> wrapper — the dropdown\'s keyboard model depends on it',
    };
  }
  return null;
}

/**
 * Whole-token (whitespace-split) match for a class token. Avoids the
 * `dropdown-menu-foo` false-positive that a substring match would hit.
 */
function containsClassToken(classValue: string, token: string): boolean {
  if (classValue.length === 0) return false;
  for (const t of classValue.split(/\s+/)) {
    if (t === token) return true;
  }
  return false;
}

/**
 * Returns the first ancestor of `anchor` matching a structural-constraint
 * predicate, or `null` if none does. Walks via the supplied parent map
 * (built lazily by the caller).
 */
function findHtmlConstraintAncestor(
  anchor: HtmlElement,
  parents: ReadonlyMap<HtmlElement, HtmlElement>,
): StructuralConstraint | null {
  let cursor: HtmlElement | undefined = parents.get(anchor);
  while (cursor !== undefined) {
    const hit = classifyHtmlConstraint(cursor);
    if (hit !== null) return hit;
    cursor = parents.get(cursor);
  }
  return null;
}

function findJsxConstraintAncestor(
  anchor: JsxElement,
  parents: ReadonlyMap<JsxElement, JsxElement>,
): StructuralConstraint | null {
  let cursor: JsxElement | undefined = parents.get(anchor);
  while (cursor !== undefined) {
    const hit = classifyJsxConstraint(cursor);
    if (hit !== null) return hit;
    cursor = parents.get(cursor);
  }
  return null;
}

function jsxStringLiteralAttribute(element: JsxElement, name: string): string | null {
  const attr = getJsxAttribute(element, name);
  if (!attr?.value) return null;
  if (attr.value.kind !== "StringLiteral") return null;
  return attr.value.value;
}

/** Builds the parent map for HTML elements in one walk. */
function buildHtmlParentMap(doc: HtmlDocument): Map<HtmlElement, HtmlElement> {
  const out = new Map<HtmlElement, HtmlElement>();
  walkHtmlForParents(doc.children, null, out);
  return out;
}

function walkHtmlForParents(
  nodes: readonly HtmlNode[],
  parent: HtmlElement | null,
  out: Map<HtmlElement, HtmlElement>,
): void {
  for (const child of nodes) {
    if (child.kind !== "HtmlElement") continue;
    if (parent !== null) out.set(child, parent);
    walkHtmlForParents(child.children, child, out);
  }
}

/** Builds the parent map for JSX elements in one walk. */
function buildJsxParentMap(module: TsxModule): Map<JsxElement, JsxElement> {
  const out = new Map<JsxElement, JsxElement>();
  for (const root of module.jsxElements) {
    walkJsxForParents(root, out);
  }
  return out;
}

function walkJsxForParents(element: JsxElement, out: Map<JsxElement, JsxElement>): void {
  for (const child of element.children) {
    if (child.kind !== "JsxElement") continue;
    out.set(child, element);
    walkJsxForParents(child, out);
  }
}

type Intent = "navigation" | "mutation" | "unknown";
type Trigger = "handler" | { kind: "class"; token: string };

export const rule = defineRule({
  id: "navigation/link-no-href",
  satisfies: ["wcag22:2.1.1", "wcag21:2.1.1", "wcag22:4.1.2", "wcag21:4.1.2"],
  severity: "error",
  scope: "node",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "<a> elements with onClick but a genuinely absent href are not keyboard-operable and are announced as generic containers. Use <button> instead, or add a real href. Placeholder hrefs (`#`, ``, `javascript:…`) are owned by `navigation/href-empty-fragment` and `navigation/href-javascript-scheme`.",
    rationale:
      "An anchor without an href is a dead link. It's not in the tab order, Enter doesn't activate it, and screen readers announce it as a generic container with no role. The common pattern <a onclick='…'>Click me</a> breaks keyboard and screen-reader users completely.",
    goodExample: `<button type="button" onClick={handleClick}>Toggle menu</button>`,
    badExample: `<a onClick={handleClick}>Toggle menu</a>`,
    normativeQuote: "All functionality of the content is operable through a keyboard interface.",
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://html.spec.whatwg.org/#the-a-element",
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

function checkHtml(doc: HtmlDocument, emit: Emit): void {
  // Parent map is built lazily — only when at least one offending anchor
  // is found. Keeps the no-finding fast path free of an extra walk.
  const parentRef: { value: Map<HtmlElement, HtmlElement> | null } = { value: null };
  for (const anchor of findHtmlElementsByTag(doc, "a")) {
    // Predicate: this rule only fires when the `href` attribute is
    // genuinely absent. Placeholder shapes (`href="#"`, `href=""`,
    // `href="javascript:…"`, `href="  #  "`) are owned by the companion
    // rules `navigation/href-empty-fragment` and
    // `navigation/href-javascript-scheme` — they share the same WCAG
    // criteria but frame the wrong-role-for-runtime-behavior question
    // honestly (the message text matches the evidence: the snippet
    // shows the placeholder href, the message names it). Letting both
    // rules fire on the same line produced the dishonest double-emit
    // captured by `tests/fixtures/real-world/navigation-link-no-href-on-href-empty-fragment/`.
    if (hasHtmlAttribute(anchor, "href")) continue;
    const hasHandler = hasClickHandlerHtml(anchor);
    const classToken = hasInteractiveClassSignal(getHtmlAttribute(anchor, "class"));
    if (!hasHandler && classToken === null) continue;
    const trigger: Trigger = hasHandler ? "handler" : { kind: "class", token: classToken ?? "" };
    const intent = describeJsxExpressionIntent(getHtmlAttribute(anchor, "onclick"));
    parentRef.value ??= buildHtmlParentMap(doc);
    const constraint = findHtmlConstraintAncestor(anchor, parentRef.value);
    emit(buildViolation(anchor.loc.start, intent, trigger, constraint, htmlElementText(anchor)));
  }
}

function hasClickHandlerHtml(element: HtmlElement): boolean {
  // HTML attribute names are case-insensitive.
  return hasHtmlAttribute(element, "onclick");
}

function checkJsx(module: TsxModule, emit: Emit): void {
  const parentRef: { value: Map<JsxElement, JsxElement> | null } = { value: null };
  for (const anchor of findJsxElementsByTag(module, "a")) {
    // Predicate: see the parallel comment in `checkHtml` — this rule
    // fires only when the `href` attribute is genuinely absent. JSX
    // placeholder shapes (`href="#"`, `href=""`) are owned by
    // `navigation/href-empty-fragment`. Expression-form `href={…}` is
    // opaque at static-analysis time and is also assumed to resolve to
    // real navigation; the agent reads the file when the expression is
    // suspicious.
    if (hasJsxAttribute(anchor, "href")) continue;
    const hasHandler = hasClickHandlerJsx(anchor);
    const classToken = hasInteractiveClassSignal(jsxClassNameLiteral(anchor));
    if (!hasHandler && classToken === null) continue;
    const trigger: Trigger = hasHandler ? "handler" : { kind: "class", token: classToken ?? "" };
    const intent = describeJsxExpressionIntent(jsxOnClickExpressionText(anchor));
    parentRef.value ??= buildJsxParentMap(module);
    const constraint = findJsxConstraintAncestor(anchor, parentRef.value);
    emit(buildViolation(anchor.loc.start, intent, trigger, constraint, jsxElementText(anchor)));
  }
}

/**
 * Returns the string-literal `className` of a JSX element, or null when
 * the attribute is absent or its value is an expression. An expression
 * `className={...}` is opaque — we don't try to resolve it; the agent
 * reading the file will. (The handler-only check still covers the
 * common case where an opaque `className` co-exists with `onClick`.)
 */
function jsxClassNameLiteral(element: JsxElement): string | null {
  const attr = getJsxAttribute(element, "className");
  if (!attr?.value) return null;
  if (attr.value.kind !== "StringLiteral") return null;
  return attr.value.value;
}

function hasClickHandlerJsx(element: JsxElement): boolean {
  // React uses onClick (camelCase). The JSX parser preserves casing.
  return hasJsxAttribute(element, "onClick");
}

/**
 * Returns the raw source of the element's `onClick={…}` expression, or
 * `null` when the attribute is absent, a string-literal, or shorthand.
 * String-literal onClick is syntactically legal but semantically
 * nothing an intent probe can read — return null and let the
 * classifier fall through to "unknown".
 */
function jsxOnClickExpressionText(element: JsxElement): string | null {
  const attr = getJsxAttribute(element, "onClick");
  if (!attr?.value) return null;
  if (attr.value.kind !== "Expression") return null;
  return attr.value.raw;
}

function buildViolation(
  loc: { line: number; column: number },
  intent: Intent,
  trigger: Trigger,
  constraint: StructuralConstraint | null,
  elementText: string | null,
): {
  severity: "error";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
} {
  // Inline text is included as additive context — the agent reading the
  // file already knows the line; the inline text disambiguates which
  // anchor in a list of similar-looking placeholders the rule fired on
  // (the canonical case is a row of `<a class="nav-link">…</a>`
  // navigation placeholders sharing the same class).
  const textClause = elementText === null ? "" : ` (text: "${elementText}")`;
  const message =
    trigger === "handler"
      ? `<a> with a click handler but no href${textClause} is not keyboard-operable — it's not in the tab order and Enter won't activate it.`
      : `<a class="${trigger.token}"> with no href${textClause} is styled or wired as an interactive control (likely with a runtime-attached click handler) but is not keyboard-operable — it's not in the tab order and Enter won't activate it.`;
  return {
    severity: "error",
    location: { filePath: "", line: loc.line, column: loc.column },
    message,
    suggestion: buildSuggestion(intent, trigger, constraint),
  };
}

function buildSuggestion(
  intent: Intent,
  trigger: Trigger,
  constraint: StructuralConstraint | null,
): string {
  // When a structural-ancestor constraint applies, the bare `<a>` →
  // `<button>` swap is wrong: it either invalidates the ancestor's
  // content model (`<select>`, `<datalist>`, table tags) or breaks the
  // ancestor's keyboard / focus model (menu, menubar, listbox,
  // tablist, tree). Surface the constraint and propose the
  // within-constraint shape; let the agent reading the file pick the
  // concrete edit. Per AI-first doctrine ("Reason / priority /
  // fix-description must agree across all three channels"), the
  // suggestion text must not contradict the structural reality.
  if (constraint !== null) {
    const baseDecision =
      trigger === "handler"
        ? `Decide the intent: if the item navigates, add a real href on the <a>; if it triggers an action, replace the <a> with a <button type="button">.`
        : `Decide the intent: if it activates an in-page widget, replace the <a> with <button type="button" class="${trigger.token}">; if it navigates, add a real href.`;
    return `${baseDecision} HOWEVER, the ancestor constraint applies: ${constraint.label}. ${constraint.fixSketch}.`;
  }
  if (trigger !== "handler") {
    // Class-signal trigger: there is no inline handler to read intent
    // from, so we name the class we matched on and leave the choice
    // to the agent / author. The token is meaningful context — `prev`
    // and `dropdown-toggle` carry different intent affordances than a
    // generic `btn`.
    return `<a class="${trigger.token}"> has no href and no inline click handler — the control is almost certainly wired by a sibling <script> at runtime. If it activates an in-page widget (carousel, dropdown, tab, accordion), replace with <button type="button" class="${trigger.token}"> so it joins the tab order and responds to Enter / Space. If it should navigate, add a real href="...".`;
  }
  if (intent === "navigation") {
    return `<a onClick={...}> appears to perform navigation (keywords: navigate/router/history). Replace with a real <a href="..."> so the browser and assistive tech treat it as a link — if you need to intercept the click, keep the href and use onClick={(e) => { e.preventDefault(); navigate(url); }}.`;
  }
  if (intent === "mutation") {
    return `<a onClick={...}> appears to perform a mutation (keywords: toggle/set/open). Use <button type="button" onClick={...}> instead — anchors convey navigation, buttons convey actions. Style the button to look like a link if the visual treatment matters.`;
  }
  return `<a onClick={...}> has no href — decide the intent: if it navigates, add a real href="..."; if it performs an action, use <button type="button"> instead. Anchors communicate navigation to assistive tech; buttons communicate action.`;
}
