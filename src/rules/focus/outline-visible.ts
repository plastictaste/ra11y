/**
 * Rule: focus/outline-visible
 * Satisfies: wcag22:2.4.7, wcag21:2.4.7
 * Spec: https://www.w3.org/TR/WCAG22/#focus-visible
 *
 * > Any keyboard operable user interface has a mode of operation where
 * > the keyboard focus indicator is visible.
 *
 * Flags CSS rules that set `outline: none`/`0` or `outline-style: none`
 * without a replacement focus indicator in the same rule block, when
 * the selector targets focusable content. Two predicate branches:
 *
 *   - Focus-pseudo branch: selector contains `:focus` or
 *     `:focus-visible` (`a:focus`, `.btn:focus-visible`).
 *   - Universal branch: any comma-separated selector group has a
 *     universal `*` subject (`*`, `*, p`, `*[data-x]`). A bare `*`
 *     rule wipes the outline on every element in every state — the
 *     UA stylesheet's `:focus { outline: ... }` has lower author
 *     priority, so author-level `* { outline: 0 }` is the canonical
 *     F78 focus-indicator failure pattern.
 *
 * Severity resolution (in precedence order):
 *   1. Universal-subject selector (`*`, `*, *:focus`) → `error`. Most
 *      severe — strips outline globally, no scoping at all.
 *   2. Bare-element / focus-pseudo selector (`a:focus`,
 *      `button:focus-visible`, `:focus`) → `error`. Selector targets
 *      interactivity itself; no further evidence needed.
 *   3. Class-scoped selector whose primary class is applied in the
 *      project to a concrete interactive element (`button`, `a[href]`,
 *      `input`, `select`, `textarea`, `summary`, or a `role` that
 *      implies interactivity) → `error`. Deterministic class-token
 *      link: the CSS rule DOES land on an interactive element, and
 *      `info` would silently mis-triage what is a high-confidence
 *      2.4.7 violation.
 *   4. Class-scoped selector with no interactive-element evidence →
 *      `info`. Surface the candidate so the agent can investigate;
 *      the class may apply to non-interactive wrappers.
 *
 * Cross-file Tailwind cross-reference (all scoped severities):
 *   Class-scoped candidates are auto-resolved when the SAME className
 *   appears on a JSX/HTML element that also carries a
 *   `focus-visible:ring-*` / `focus-visible:outline-*` /
 *   `focus-visible:shadow-*` Tailwind utility. This is a deterministic
 *   class-token link — NOT heuristic suppression (CLAUDE.md §1). A
 *   looser match (`focus:ring-*`, `hover:ring-*`, or "visually similar"
 *   classes) is NOT allowed here: only the literal `focus-visible:`
 *   variant qualifies, because only that variant is an author-chosen
 *   statement that this element has a focus-visible indicator. One
 *   element is sufficient evidence; no numeric / filename thresholds.
 *   Applies before the interactivity upgrade — an explicit author
 *   replacement supersedes the upgraded severity.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findCssDeclaration,
  getHtmlAttribute,
  getJsxAttributeString,
  walkCssRules,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import { parseTailwind } from "../../input/parsers/tailwind.ts";
import type {
  CssRule,
  CssStylesheet,
  HtmlDocument,
  HtmlElement,
  JsxElement,
  TsxModule,
} from "../../types/ast.ts";
import type { EmittedViolation, Language, ProjectContext } from "../../types/rule.ts";

/** Properties that serve as replacement focus indicators. */
const REPLACEMENT_INDICATORS: readonly string[] = [
  "box-shadow",
  "border",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "background-color",
  "background",
  "text-decoration",
  // Tailwind ring utilities compile to these CSS custom properties:
  "--tw-ring-offset-shadow",
  "--tw-ring-shadow",
  "--tw-ring-color",
  "--tw-ring-offset-width",
  "ring-color",
];

const FOCUS_PSEUDO_PATTERN = /:focus(?:-visible)?\b/;

/**
 * Utility families that compensate for a removed native focus ring.
 * `focus:` / `hover:` variants do NOT count — different user state, not
 * an author statement about focus-visible.
 */
const FOCUS_UTILITY_FAMILIES: ReadonlySet<string> = new Set(["ring", "outline", "shadow"]);

/**
 * Native HTML / JSX tags whose default accessibility-tree role is
 * interactive for 2.4.7 purposes. `<a>` requires an `href` to count
 * (bare `<a>` has no default role); `<input type="hidden">` never
 * counts.
 */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);

/**
 * ARIA roles that make an otherwise non-interactive element take an
 * interactive focus indicator. Mirrors the set used by
 * `tooltip/dismissable` + `semantics/label-in-name`; the authoritative
 * reference is WAI-ARIA's widget-role taxonomy.
 */
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
  id: "focus/outline-visible",
  satisfies: ["wcag22:2.4.7", "wcag21:2.4.7"],
  severity: "error",
  scope: "project",
  fixClass: "verify-in-source",
  docs: {
    description:
      "CSS rules on :focus/:focus-visible must not remove the outline without providing a replacement focus indicator.",
    rationale:
      "Keyboard users rely on the focus indicator to know which element is active. Removing outline with `outline: none` on :focus without a replacement makes the page unusable for anyone navigating by keyboard — sighted screen-reader users, motor-impaired users, and power users alike.",
    goodExample: `button:focus-visible { outline: 2px solid #0066cc; }`,
    badExample: `a:focus { outline: none; }`,
    normativeQuote:
      "Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible.",
    references: [
      "https://www.w3.org/TR/WCAG22/#focus-visible",
      "https://www.w3.org/WAI/WCAG22/Techniques/failures/F78",
    ],
  },
  afterProject(ctx) {
    const usage = collectFocusVisibleClassUsage(ctx);
    const interactiveClasses = collectInteractiveClassUsage(ctx);
    for (const file of ctx.files) {
      if (file.language !== "css") continue;
      for (const cssRule of walkCssRules(file.ast as CssStylesheet)) {
        emitIfMissingIndicator(cssRule, file.filePath, usage, interactiveClasses, (v) =>
          ctx.emit(v),
        );
      }
    }
  },
});

type ClassSet = ReadonlySet<string>;
type Emit = (v: EmittedViolation) => void;

function emitIfMissingIndicator(
  cssRule: CssRule,
  filePath: string,
  usage: ClassSet,
  interactiveClasses: ClassSet,
  emit: Emit,
): void {
  const universalMatch = hasUniversalSubject(cssRule.selector);
  const focusBranches = splitFocusBranches(cssRule.selector);
  if (!universalMatch && focusBranches.length === 0) return;
  if (!removesOutline(cssRule)) return;
  if (hasReplacementIndicator(cssRule)) return;

  if (universalMatch) {
    // Universal-subject selector strips outline on every element in
    // every state. Author-level `* { outline: 0 }` defeats the UA
    // stylesheet's `:focus { outline: ... }` because UA rules have
    // lower author priority — F78 calls this out as the canonical
    // focus-indicator failure pattern. Always error; no class-scoped
    // cross-reference applies (there's no class to cross-reference
    // with a focus-visible utility).
    emit({
      severity: "error",
      location: { filePath, line: cssRule.loc.start.line, column: cssRule.loc.start.column },
      message: buildUniversalMessage(cssRule.selector),
      suggestion: buildUniversalSuggestion(cssRule.selector),
    });
    return;
  }

  // Per-branch evaluation: a compound selector like
  // `a:hover, a:focus { outline: 0 }` (and its SCSS-flattened siblings)
  // shares one rule body across multiple branches, but only the
  // branches containing `:focus` / `:focus-visible` drive the F78
  // failure. Each focus branch's own scope (bare element vs. class,
  // primary class, interactivity, focus-visible cross-reference)
  // contributes independently; the lexically-last branch must not
  // shadow a focus branch on a different class.
  const severity = classifyFocusBranches(focusBranches, usage, interactiveClasses);
  if (severity === null) return; // suppressed by cross-reference
  emit({
    severity,
    location: { filePath, line: cssRule.loc.start.line, column: cssRule.loc.start.column },
    message: buildMessage(cssRule.selector),
    suggestion: buildSuggestion(cssRule.selector),
  });
}

/**
 * Aggregate severity across every focus branch of a compound selector.
 * Returns `null` when the rule must be suppressed (any focus branch's
 * primary class carries a `focus-visible:ring|outline|shadow-*` utility
 * — explicit author replacement). Otherwise picks the most severe
 * outcome across branches: `error` if any branch is bare-element /
 * pseudo-only or its class is bound to a concrete interactive element;
 * `info` if every branch is class-scoped without interactivity evidence.
 */
function classifyFocusBranches(
  branches: readonly string[],
  usage: ClassSet,
  interactiveClasses: ClassSet,
): "error" | "info" | null {
  let severity: "error" | "info" = "info";
  for (const branch of branches) {
    const scoped = isScopedSelector(branch);
    const className = scoped ? extractPrimaryClass(branch) : null;
    if (className !== null && usage.has(className)) return null;
    if (!scoped) severity = "error";
    else if (className !== null && interactiveClasses.has(className)) severity = "error";
  }
  return severity;
}

/**
 * Split the selector on top-level commas and return only the branches
 * that contain `:focus` / `:focus-visible`. Empty result means the rule
 * has no focus branch (and thus the focus-zeroing predicate doesn't
 * apply). Branches are trimmed; commas inside `[]` / `()` (attribute
 * selectors, `:is(...)`) are not splits.
 */
function splitFocusBranches(selector: string): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const push = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (FOCUS_PSEUDO_PATTERN.test(trimmed)) out.push(trimmed);
  };
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      push(selector.slice(start, i));
      start = i + 1;
    }
  }
  push(selector.slice(start));
  return out;
}

/**
 * True if any comma-separated selector group is an *unconditional*
 * universal — a single `*` compound with no combinator, no descendant
 * ancestor, no class/id/attribute scoping. The unconditional case is
 * the F78 failure pattern: a rule that wipes the outline from every
 * element irrespective of state or context.
 *
 * Matches: `*`, `*, p`, `*[data-x]`, `*.foo`, `*:focus` (universal
 * subject; `:focus` narrows by state but the rule still applies to
 * every element when focused).
 *
 * Does NOT match: `:focus *` (descendant-of-focused — focused element
 * keeps its outline), `* + p` (subject is `p`, universal is sibling
 * matcher), `.x *` (descendant of `.x`).
 */
function hasUniversalSubject(selector: string): boolean {
  for (const group of selector.split(",")) {
    const trimmed = group.trim();
    if (trimmed.length === 0) continue;
    // Reject any combinator (descendant, child, sibling) — those
    // narrow the rule to a context, not "every element."
    if (/[\s>+~]/.test(trimmed)) continue;
    if (trimmed.startsWith("*")) return true;
  }
  return false;
}

/** True if the selector targets a specific class, id, or attribute — not a bare element. */
function isScopedSelector(selector: string): boolean {
  const base = selector.replace(/:focus(-visible)?\b/g, "").trim();
  return base.includes(".") || base.includes("#") || base.includes("[");
}

/**
 * First `.<ident>` token in the selector's subject compound. Compound
 * selectors like `.card.active:focus-visible` cross-reference on `card`.
 */
function extractPrimaryClass(selector: string): string | null {
  const parts = selector.split(/\s+/);
  const subject = parts[parts.length - 1] ?? selector;
  const head = subject.split(/:(?!:)/)[0] ?? subject;
  return /\.([A-Za-z_][\w-]*)/.exec(head)?.[1] ?? null;
}

function removesOutline(cssRule: CssRule): boolean {
  const outline = findCssDeclaration(cssRule, "outline");
  if (outline) {
    const v = outline.value.trim().toLowerCase();
    if (v === "none" || v === "0" || v === "0px") return true;
  }
  const outlineStyle = findCssDeclaration(cssRule, "outline-style");
  return outlineStyle?.value.trim().toLowerCase() === "none";
}

/** Same rule block provides a visible alternative (box-shadow, border, later outline, …). */
function hasReplacementIndicator(cssRule: CssRule): boolean {
  if (hasNonNoneOutlineLater(cssRule)) return true;
  for (const indicator of REPLACEMENT_INDICATORS) {
    const decl = findCssDeclaration(cssRule, indicator);
    if (decl === undefined) continue;
    if (indicator === "box-shadow" && !isMeaningfulBoxShadow(decl.value)) continue;
    return true;
  }
  return false;
}

/**
 * `box-shadow` only counts as a focus-indicator replacement when it
 * actually paints something. Two failure modes the existing predicate
 * silently credited:
 *
 *   - `box-shadow: none` — explicit reset; paints nothing.
 *   - `box-shadow: var(--ring)` — value resolves at runtime to whatever
 *     the consuming theme defines, possibly `none` or a non-ring shadow.
 *     Static analysis has no honest way to confirm a focus ring, so we
 *     don't silently credit (per AI-first doctrine: "Numeric-threshold
 *     heuristics are suppression" applies symmetrically to "trust the
 *     unresolved variable as positive evidence").
 *
 * The simplest safe predicate: any literal, non-`none`, non-`var(...)`
 * value in the box-shadow declaration counts. The agent reading the
 * source can verify the actual visual effect; we just refuse to invent
 * confidence we don't have.
 */
function isMeaningfulBoxShadow(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  if (trimmed === "none") return false;
  // Unresolved `var(...)` references — even with a fallback (`var(--x,
  // 0 0 0 2px blue)`) we can't know whether the runtime resolution
  // yields a focus ring. Don't auto-credit.
  if (trimmed.includes("var(")) return false;
  return true;
}

/** Handles the `outline: none; outline: 2px solid blue;` reset-then-replace pattern. */
function hasNonNoneOutlineLater(cssRule: CssRule): boolean {
  let sawNone = false;
  for (const decl of cssRule.declarations) {
    if (decl.property.toLowerCase() !== "outline") continue;
    const val = decl.value.trim().toLowerCase();
    if (val === "none" || val === "0" || val === "0px") sawNone = true;
    else if (sawNone) return true;
  }
  return false;
}

/**
 * Walk every JSX/HTML className in the project; return the set of plain
 * class names that co-occur on an element with a qualifying
 * `focus-visible:ring|outline|shadow-*` utility. Uses existing
 * `parseTailwind` tokenizer output — no new parser pass.
 */
function collectFocusVisibleClassUsage(ctx: ProjectContext): ClassSet {
  const usage = new Set<string>();
  for (const file of ctx.files) indexFile(file.ast, file.language, usage);
  return usage;
}

function indexFile(ast: unknown, language: Language, usage: Set<string>): void {
  if (language === "tsx" || language === "jsx" || language === "ts" || language === "js") {
    for (const el of walkJsxElements(ast as TsxModule)) indexClassString(jsxClassString(el), usage);
    return;
  }
  if (language === "html") {
    for (const el of walkHtmlElements(ast as HtmlDocument))
      indexClassString(htmlClassString(el), usage);
  }
}

/**
 * Walk every JSX/HTML element in the project; return the set of plain
 * class names that appear on at least one concrete interactive element
 * (`<button>`, `<a href>`, `<input>`, `<select>`, `<textarea>`,
 * `<summary>`, or any tag with `role` in {button, link, checkbox, …}).
 * One call site of evidence is sufficient; numeric / filename thresholds
 * would be suppression (CLAUDE.md §1, ai-first-consumer.md "Numeric-
 * threshold heuristics"). Used to upgrade a class-scoped
 * `:focus { outline: none }` from `info` to `error`.
 */
function collectInteractiveClassUsage(ctx: ProjectContext): ClassSet {
  const usage = new Set<string>();
  for (const file of ctx.files) indexInteractiveFile(file.ast, file.language, usage);
  return usage;
}

function indexInteractiveFile(ast: unknown, language: Language, usage: Set<string>): void {
  if (language === "tsx" || language === "jsx" || language === "ts" || language === "js") {
    for (const el of walkJsxElements(ast as TsxModule)) {
      if (!isInteractiveJsxElement(el)) continue;
      addClassTokens(jsxClassString(el), usage);
    }
    return;
  }
  if (language === "html") {
    for (const el of walkHtmlElements(ast as HtmlDocument)) {
      if (!isInteractiveHtmlElement(el)) continue;
      addClassTokens(htmlClassString(el), usage);
    }
  }
}

function isInteractiveHtmlElement(element: HtmlElement): boolean {
  const role = getHtmlAttribute(element, "role");
  if (role !== null && INTERACTIVE_ROLES.has(role.trim().toLowerCase())) return true;
  const tag = element.tagName.toLowerCase();
  if (!INTERACTIVE_TAGS.has(tag)) return false;
  if (tag === "a") return getHtmlAttribute(element, "href") !== null;
  if (tag === "input") {
    const type = getHtmlAttribute(element, "type");
    return type === null || type.trim().toLowerCase() !== "hidden";
  }
  return true;
}

function isInteractiveJsxElement(element: JsxElement): boolean {
  const role = getJsxAttributeString(element, "role");
  if (role !== null && INTERACTIVE_ROLES.has(role.trim().toLowerCase())) return true;
  // JSX tag names are case-sensitive; lowercase the comparison input
  // so `<Button>` React components are not counted as native <button>.
  // A bare lowercase tag that matches an HTML interactive element is
  // the only JSX shape that contributes evidence here.
  const tag = element.tagName;
  if (tag !== tag.toLowerCase()) return false;
  if (!INTERACTIVE_TAGS.has(tag)) return false;
  if (tag === "a") return getJsxAttributeString(element, "href") !== null;
  if (tag === "input") {
    const type = getJsxAttributeString(element, "type");
    return type === null || type.trim().toLowerCase() !== "hidden";
  }
  return true;
}

function addClassTokens(classString: string | null, usage: Set<string>): void {
  if (!classString) return;
  // Plain-class tokenization only — we DO NOT care about Tailwind
  // variants here (those are the focus-visible replacement signal,
  // handled separately by `indexClassString` above). A bare class
  // token without a variant is what a class-scoped CSS selector
  // (`.magic`) can match.
  for (const tok of parseTailwind(classString)) {
    if (tok.malformed) continue;
    if (tok.variants.length !== 0) continue;
    if (tok.utility.length === 0) continue;
    usage.add(tok.utility);
  }
}

function indexClassString(classString: string | null, usage: Set<string>): void {
  if (!classString) return;
  const { plainClasses, qualifies } = partitionTokens(parseTailwind(classString));
  if (!qualifies) return;
  for (const cls of plainClasses) usage.add(cls);
}

function partitionTokens(
  tokens: readonly { variants: readonly string[]; utility: string; malformed: boolean }[],
): { plainClasses: string[]; qualifies: boolean } {
  const plainClasses: string[] = [];
  let qualifies = false;
  for (const tok of tokens) {
    if (tok.malformed) continue;
    if (tok.variants.length === 0) {
      if (tok.utility.length > 0) plainClasses.push(tok.utility);
      continue;
    }
    if (isFocusVisibleIndicator(tok.variants, tok.utility)) qualifies = true;
  }
  return { plainClasses, qualifies };
}

function isFocusVisibleIndicator(variants: readonly string[], utility: string): boolean {
  if (!variants.includes("focus-visible")) return false;
  const family = utility.split("-")[0] ?? utility;
  return FOCUS_UTILITY_FAMILIES.has(family);
}

function jsxClassString(element: JsxElement): string | null {
  for (const attr of element.attributes) {
    if (attr.name !== "className" && attr.name !== "class") continue;
    if (!attr.value || attr.value.kind !== "StringLiteral") return null;
    return attr.value.value;
  }
  return null;
}

function htmlClassString(element: HtmlElement): string | null {
  for (const attr of element.attributes) {
    if (attr.name.toLowerCase() === "class") return attr.value ?? null;
  }
  return null;
}

function buildMessage(selector: string): string {
  return `'${selector}' removes the focus outline without a replacement indicator — keyboard users won't see which element is focused.`;
}

function buildSuggestion(selector: string): string {
  const base = `Add a visible focus indicator to '${selector}'. Replace \`outline: none\` with a custom outline (e.g., \`outline: 2px solid #0066cc\`), or add \`box-shadow: 0 0 0 2px #0066cc\` as an alternative. If you're resetting only to re-style, keep the replacement in the same rule block.`;
  if (isScopedSelector(selector)) {
    return `${base} If this element uses Tailwind's \`focus-visible:ring-*\` or \`focus-visible:outline-*\` classes on the component, the focus indicator is already provided — suppress this note by adding \`/* ra11y-disable-next-line focus/outline-visible */\` on the line above the CSS rule (or \`/* ra11y-disable focus/outline-visible */\` at the top of the file). Criterion-level pragmas (\`wcag22:2.4.7\`) work too.`;
  }
  return base;
}

function buildUniversalMessage(selector: string): string {
  return `'${selector}' removes the outline globally — every element loses its focus indicator on every state, leaving keyboard users with no way to see which element is focused.`;
}

function buildUniversalSuggestion(selector: string): string {
  return `Drop the universal outline reset and add a focus-state indicator instead. Either delete the \`outline\` declaration from '${selector}' and let the browser's default :focus outline render, or replace it with explicit per-state styles (\`*:focus-visible { outline: 2px solid #0066cc; }\` or scoped per-component \`focus-visible\` rules with \`outline\` / \`box-shadow\` / \`border-color\`). Universal \`outline: 0\` is the F78 failure pattern — it overrides the user-agent focus ring everywhere.`;
}
