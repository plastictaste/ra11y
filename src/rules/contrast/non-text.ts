/**
 * Rule: contrast/non-text
 * Satisfies: wcag22:1.4.11, wcag21:1.4.11
 * Spec: https://www.w3.org/TR/WCAG22/#non-text-contrast
 *
 * > The visual presentation of the following have a contrast ratio of at
 * > least 3:1 against adjacent color(s):
 * >   - User Interface Components: Visual information required to identify
 * >     user interface components and states, except for inactive components
 * >     or where the appearance of the component is determined by the user
 * >     agent and not modified by the author.
 * >   - Graphical Objects: Parts of graphics required to understand the
 * >     content, except when a particular presentation of graphics is
 * >     essential to the information being conveyed.
 *
 * Source: https://www.w3.org/TR/WCAG22/#non-text-contrast
 *
 * Static-analysis scope (v0.0.x):
 *   1. CSS rules whose selector targets an interactive component
 *      (button, input, select, textarea, [role="button|checkbox|switch|tab|
 *      menuitem|radio|combobox|slider"], `a` styled like a button) and that
 *      declare BOTH a border / outline color AND a background color in the
 *      same block — flag if border-vs-background contrast < 3:1.
 *   2. CSS rules targeting `svg`, `[role="img"] *`, or stroke/fill on a
 *      non-decorative graphic — flag if fill / stroke contrast against a
 *      same-rule (or sibling parent) background < 3:1.
 *
 * Bypassed cases (matching the spec exemptions):
 *   - "Inactive components": selectors containing :disabled, [disabled],
 *     [aria-disabled="true"], or class tokens matching `disabled`.
 *   - "User agent default": rules that don't author a border/outline/
 *     background color at all are skipped — we only flag what the author
 *     actually styled.
 *   - "Essential" / decorative SVGs: selectors containing [aria-hidden="true"]
 *     or `role="presentation"` / `role="none"`.
 *
 * Reuses the parser + color helpers from `./_shared.ts` so any extraction
 * fix (Tailwind theme resolution, CSS custom properties, etc.) lands in
 * one place for all three contrast rules.
 *
 * `couldBeWrongBecause` opt-in (project scope): when a scanned JSX or
 * HTML consumer carries the CSS failure's class token AND a qualifying
 * boundary Tailwind utility (`border-*`, `outline-*`, `ring-*`) on the
 * same element, the finding is tagged `tailwind_class_on_consumer`.
 * Informational only — the agent reads the consumer file and decides
 * whether the consumer-site utility actually overrides the declared
 * border/outline. See docs/adr/0009-violation-could-be-wrong-because.md.
 * The boundary-override family set is distinct from the text-contrast
 * rules' `text-*` / `bg-*` set (see `_shared.ts`).
 *
 * Image-backed backgrounds (v1.0): when a selector declares a boundary
 * or graphic color (`border-color`, `outline-color`, `fill`, `stroke`,
 * or the corresponding shorthands) alongside `background-image: …`
 * or a shorthand `background: …<image>…`, the scanner cannot compute
 * a luminance for the background. The rule emits an info-severity
 * finding carrying `couldBeWrongBecause:
 * [background_image_unresolvable]` so the agent knows the boundary
 * went unevaluated. Never fabricates a ratio.
 */

import { defineRule } from "../../api/plugin.ts";
import {
  findCssDeclaration,
  getHtmlAttribute,
  hasHtmlAttribute,
  walkCssRules,
  walkHtmlElements,
} from "../../engine/ast-helpers.ts";
import type { CssRule, CssStylesheet, HtmlDocument, HtmlElement } from "../../types/ast.ts";
import type { EmittedViolation, ProjectContext } from "../../types/rule.ts";
import { parseColor, type Rgb } from "../../utils/color.ts";
import { contrast, WCAG_AA_MIN_NON_TEXT } from "../../utils/contrast.ts";
import {
  BG_IMAGE_UNRESOLVABLE,
  buildBgImageUnresolvableMessage,
  buildBgImageUnresolvableSuggestion,
  collectBgImageUnresolvable,
  collectTailwindOverrideClasses,
  extractPrimarySelectorClass,
  NON_TEXT_CONTRAST_OVERRIDE_FAMILIES,
  NON_TEXT_FOREGROUND_PROPERTIES,
  TAILWIND_CLASS_ON_CONSUMER,
} from "./_shared.ts";
import {
  buildInlineStyleBgImageUnresolvableMessage,
  buildInlineStyleBgImageUnresolvableSuggestion,
  collectInlineStyleBgImageUnresolvable,
  findInlineStyleDeclaration,
  type InlineStyleDeclaration,
  parseInlineStyleDeclarations,
} from "./_shared-inline.ts";

const SC_LABEL = "WCAG 1.4.11";

export const rule = defineRule({
  id: "contrast/non-text",
  satisfies: ["wcag22:1.4.11", "wcag21:1.4.11"],
  severity: "error",
  // Project scope mirrors `contrast/minimum` / `contrast/enhanced`:
  // the cross-reference is cross-file by nature (CSS failure, JSX/HTML
  // consumer). `.html` / `.htm` are listed alongside `.css` so
  // `rulesFiredByExtension` honestly reports HTML inline-style evaluations
  // alongside stylesheet rules. `.scss` / `.less` are listed for the
  // same reason as `contrast/minimum`: the SCSS and Less parsers
  // preprocess preprocessor source to a CSS-shaped AST and tag
  // `Ast.language` as `"css"`, so the `afterProject` CSS branch
  // already handles them — without the extension gate, SSG docs
  // sites authoring boundary colors in Sass/Less silently report
  // `filesEvaluated: 0` for `contrast/non-text`. `.sass` (indented
  // syntax) is intentionally absent — no parser exists for it.
  scope: "project",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".css", ".html", ".htm", ".scss", ".less"],
  },
  docs: {
    description:
      "Borders, outlines, and graphical objects of user interface components must have at least 3:1 contrast against adjacent colors.",
    rationale:
      "Users with low vision rely on the visual boundary of a control (its border, focus ring, or shape) to find and operate it. WCAG 1.4.11 mandates a 3:1 contrast for that boundary against adjacent colors so the control remains identifiable for the same population that needs 1.4.3 text contrast.",
    goodExample: `.btn { background: #ffffff; border: 1px solid #595959; }  /* border ~7.0:1 vs bg */`,
    badExample: `.btn { background: #ffffff; border: 1px solid #d0d0d0; }  /* border 1.6:1 vs bg */`,
    normativeQuote:
      "The visual presentation of user interface components and graphical objects has a contrast ratio of at least 3:1 against adjacent color(s).",
    references: [
      "https://www.w3.org/TR/WCAG22/#non-text-contrast",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G195",
      "https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html",
    ],
  },
  afterProject(ctx) {
    const overrideClasses = collectTailwindOverrideClasses(
      ctx,
      NON_TEXT_CONTRAST_OVERRIDE_FAMILIES,
    );
    for (const file of ctx.files) {
      if (file.language === "css") {
        checkCssFile(ctx, file.filePath, file.ast as CssStylesheet, overrideClasses);
      } else if (file.language === "html") {
        // Inline-style boundary/graphic colors on elements classified
        // as interactive / graphic by tag or role. Silent-miss before
        // this branch existed — a
        // `<button style="border:1px solid #ccc;background:#eee">`
        // went unevaluated.
        checkHtmlFile(ctx, file.filePath, file.ast as HtmlDocument);
      }
    }
  },
});

function checkCssFile(
  ctx: ProjectContext,
  filePath: string,
  stylesheet: CssStylesheet,
  overrideClasses: ReadonlySet<string>,
): void {
  for (const cssRule of walkCssRules(stylesheet)) {
    checkRule(cssRule, filePath, overrideClasses, ctx);
  }
  // Image-backed backgrounds: surface info-severity findings for any
  // authored boundary/graphic color (border, outline, fill, stroke)
  // sitting on a rule whose background is an image or gradient. The
  // scanner cannot compute luminance; the agent verifies manually.
  for (const finding of collectBgImageUnresolvable(stylesheet, NON_TEXT_FOREGROUND_PROPERTIES)) {
    emitUnresolvable(ctx, filePath, finding);
  }
}

function checkHtmlFile(ctx: ProjectContext, filePath: string, doc: HtmlDocument): void {
  for (const element of walkHtmlElements(doc)) {
    checkInlineStyleElement(element, filePath, ctx);
  }
  for (const finding of collectInlineStyleBgImageUnresolvable(
    doc,
    NON_TEXT_FOREGROUND_PROPERTIES,
  )) {
    emitInlineUnresolvable(ctx, filePath, finding);
  }
}

function emitInlineUnresolvable(
  ctx: ProjectContext,
  filePath: string,
  finding: ReturnType<typeof collectInlineStyleBgImageUnresolvable>[number],
): void {
  const emitted: EmittedViolation = {
    severity: "info",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildInlineStyleBgImageUnresolvableMessage(finding, WCAG_AA_MIN_NON_TEXT, SC_LABEL),
    suggestion: buildInlineStyleBgImageUnresolvableSuggestion(finding, WCAG_AA_MIN_NON_TEXT),
    couldBeWrongBecause: [BG_IMAGE_UNRESOLVABLE],
  };
  ctx.emit(emitted);
}

/**
 * Tag/role-level classification for an HTML element. Parallel to
 * {@link classifySelector} but reads directly off the element —
 * stronger evidence than a selector-pattern match.
 */
function classifyInlineElement(element: HtmlElement): "interactive" | "graphic" | "ignore" {
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") {
    return "interactive";
  }
  if (tag === "svg") return "graphic";
  const role = getHtmlAttribute(element, "role");
  if (role !== null) {
    const lowered = role.trim().toLowerCase();
    if (
      lowered === "button" ||
      lowered === "checkbox" ||
      lowered === "switch" ||
      lowered === "tab" ||
      lowered === "menuitem" ||
      lowered === "radio" ||
      lowered === "combobox" ||
      lowered === "slider" ||
      lowered === "link" ||
      lowered === "option" ||
      lowered === "treeitem"
    ) {
      return "interactive";
    }
    if (lowered === "img") return "graphic";
  }
  return "ignore";
}

/**
 * Mirrors {@link isExempt} for inline-style elements — the spec's
 * "inactive components" and "presentation / essential" exemptions
 * apply here too. We read `disabled` / `aria-disabled` / `aria-hidden`
 * off the element's attribute list rather than parsing a selector.
 */
function isInlineElementExempt(element: HtmlElement): boolean {
  const ariaDisabled = getHtmlAttribute(element, "aria-disabled");
  if (ariaDisabled !== null && ariaDisabled.trim().toLowerCase() === "true") return true;
  // `disabled` is a boolean HTML attribute — its presence alone
  // qualifies for the "inactive components" WCAG carve-out, regardless
  // of whether the author wrote `disabled` or `disabled=""`.
  if (hasHtmlAttribute(element, "disabled")) return true;
  const ariaHidden = getHtmlAttribute(element, "aria-hidden");
  if (ariaHidden !== null && ariaHidden.trim().toLowerCase() === "true") return true;
  const role = getHtmlAttribute(element, "role");
  if (role !== null) {
    const lowered = role.trim().toLowerCase();
    if (lowered === "presentation" || lowered === "none") return true;
  }
  return false;
}

function checkInlineStyleElement(
  element: HtmlElement,
  filePath: string,
  ctx: ProjectContext,
): void {
  const styleAttr = getHtmlAttribute(element, "style");
  if (styleAttr === null || styleAttr.trim().length === 0) return;
  if (isInlineElementExempt(element)) return;
  const target = classifyInlineElement(element);
  if (target === "ignore") return;
  const decls = parseInlineStyleDeclarations(styleAttr);
  if (decls.length === 0) return;
  const bg = readInlineBackgroundColor(decls);
  if (!bg) return;
  const properties =
    target === "interactive"
      ? (["border", "border-color", "outline", "outline-color"] as const)
      : (["fill", "stroke"] as const);
  for (const prop of properties) {
    checkInlineBoundary(element, decls, bg, prop, filePath, ctx);
  }
}

function readInlineBackgroundColor(
  decls: readonly InlineStyleDeclaration[],
): { readonly rgb: Rgb; readonly source: string } | null {
  const bgDecl =
    findInlineStyleDeclaration(decls, "background-color") ??
    findInlineStyleDeclaration(decls, "background");
  if (!bgDecl) return null;
  const token = extractColorToken(bgDecl.value);
  const rgb = parseColor(token);
  if (!rgb) return null;
  if (rgb.a === 0) return null;
  return { rgb, source: bgDecl.value };
}

function checkInlineBoundary(
  element: HtmlElement,
  decls: readonly InlineStyleDeclaration[],
  bg: { readonly rgb: Rgb; readonly source: string },
  prop: string,
  filePath: string,
  ctx: ProjectContext,
): void {
  const fgDecl = findInlineStyleDeclaration(decls, prop);
  if (!fgDecl) return;
  const fgToken = extractColorToken(fgDecl.value);
  const fg = parseColor(fgToken);
  if (!fg) return;
  if (fg.a === 0) return;
  // Same-color border: when the boundary color resolves to the same
  // RGBA as the background, the border is intentionally invisible —
  // the perimeter is conveyed by other means (shadow, layout, sibling
  // contrast). 1.4.11 measures the visual presentation of the
  // component boundary against adjacent color; an invisible border
  // is not the boundary the spec is asking about. Suppressing the
  // 1.00:1 emission here is deterministic (RGBA equality), not a
  // heuristic — see docs/kb/architecture/ai-first-consumer.md.
  if (sameColor(fg, bg.rgb)) return;
  const ratio = contrast(fg, bg.rgb);
  if (ratio >= WCAG_AA_MIN_NON_TEXT) return;
  const pseudoSelector = `<${element.tagName.toLowerCase()} inline style ${prop}>`;
  const emitted: EmittedViolation = {
    severity: "error",
    location: {
      filePath,
      line: element.loc.start.line,
      column: element.loc.start.column,
    },
    message: buildInlineBoundaryMessage(pseudoSelector, prop, fgDecl.value, bg.source, ratio),
    suggestion: buildInlineBoundarySuggestion(prop, fgDecl.value, bg.source, ratio),
  };
  ctx.emit(emitted);
}

function buildInlineBoundaryMessage(
  pseudoSelector: string,
  prop: string,
  fgSource: string,
  bgSource: string,
  ratio: number,
): string {
  return `${pseudoSelector} has ${prop} '${fgSource}' with contrast ${ratio.toFixed(2)}:1 against inline background '${bgSource}' — ${SC_LABEL} requires at least ${WCAG_AA_MIN_NON_TEXT}:1 for non-text UI components and graphics.`;
}

function buildInlineBoundarySuggestion(
  prop: string,
  fgSource: string,
  bgSource: string,
  ratio: number,
): string {
  const gap = (WCAG_AA_MIN_NON_TEXT / ratio).toFixed(2);
  const darkerHint = suggestDarker(fgSource);
  return `Increase contrast of inline \`${prop}: ${fgSource}\` against \`background: ${bgSource}\` to at least ${WCAG_AA_MIN_NON_TEXT}:1. The current ratio is ${ratio.toFixed(2)}:1 — you need ${gap}× more contrast.${darkerHint ? ` Try \`${prop}: ${darkerHint}\` for a quick fix, or move the declarations into a CSS class so they participate in the project's design-system palette.` : ` Pick a darker boundary color or a lighter background, then verify with the WebAIM Contrast Checker.`}`;
}

function emitUnresolvable(
  ctx: ProjectContext,
  filePath: string,
  finding: ReturnType<typeof collectBgImageUnresolvable>[number],
): void {
  const emitted: EmittedViolation = {
    severity: "info",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildBgImageUnresolvableMessage(finding, WCAG_AA_MIN_NON_TEXT, SC_LABEL),
    suggestion: buildBgImageUnresolvableSuggestion(finding, WCAG_AA_MIN_NON_TEXT),
    couldBeWrongBecause: [BG_IMAGE_UNRESOLVABLE],
  };
  ctx.emit(emitted);
}

function checkRule(
  cssRule: CssRule,
  filePath: string,
  overrideClasses: ReadonlySet<string>,
  ctx: ProjectContext,
): void {
  if (isExempt(cssRule.selector)) return;

  const target = classifySelector(cssRule.selector);
  if (target === "ignore") return;

  const bg = readColor(cssRule, "background-color") ?? readColor(cssRule, "background");
  if (!bg) return;

  if (target === "interactive") {
    checkBoundary(cssRule, bg, "border", filePath, overrideClasses, ctx);
    checkBoundary(cssRule, bg, "border-color", filePath, overrideClasses, ctx);
    checkBoundary(cssRule, bg, "outline", filePath, overrideClasses, ctx);
    checkBoundary(cssRule, bg, "outline-color", filePath, overrideClasses, ctx);
    return;
  }

  // graphic
  checkBoundary(cssRule, bg, "fill", filePath, overrideClasses, ctx);
  checkBoundary(cssRule, bg, "stroke", filePath, overrideClasses, ctx);
}

function checkBoundary(
  cssRule: CssRule,
  bg: ColorRead,
  prop: string,
  filePath: string,
  overrideClasses: ReadonlySet<string>,
  ctx: ProjectContext,
): void {
  const fg = readColor(cssRule, prop);
  if (!fg) return;
  // See note on `checkInlineBoundary` — same-RGBA boundary is
  // intentionally invisible, not a 1.4.11 failure. Deterministic
  // skip; not heuristic suppression.
  if (sameColor(fg.rgb, bg.rgb)) return;
  const ratio = contrast(fg.rgb, bg.rgb);
  if (ratio >= WCAG_AA_MIN_NON_TEXT) return;

  const primaryClass = extractPrimarySelectorClass(cssRule.selector);
  const tailwindOverride = primaryClass !== null && overrideClasses.has(primaryClass);

  const emitted: EmittedViolation = {
    severity: "error",
    location: { filePath, line: cssRule.loc.start.line, column: cssRule.loc.start.column },
    message: buildMessage(cssRule.selector, prop, fg.source, bg.source, ratio),
    suggestion: buildSuggestion(prop, fg.source, bg.source, ratio),
    // Conditional spread — `couldBeWrongBecause: []` would be a
    // dishonest empty-vs-unpopulated sentinel per CLAUDE.md §1.
    ...(tailwindOverride ? { couldBeWrongBecause: [TAILWIND_CLASS_ON_CONSUMER] } : {}),
  };
  ctx.emit(emitted);
}

interface ColorRead {
  readonly rgb: Rgb;
  readonly source: string;
}

/**
 * RGBA equality. A boundary color that resolves to the same channels
 * (and same alpha) as the element's own background is intentionally
 * invisible — the spec's "visual presentation of UI components"
 * predicate doesn't apply when the author has explicitly painted the
 * boundary out. We compare strictly: any channel difference, even a
 * 1-step `#cccccc` vs `#cccccd`, falls through to the contrast check
 * because the agent reading the file would consider the difference
 * intentional.
 */
function sameColor(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function readColor(cssRule: CssRule, property: string): ColorRead | null {
  const decl = findCssDeclaration(cssRule, property);
  if (!decl) return null;
  const token = extractColorToken(decl.value);
  const rgb = parseColor(token);
  if (!rgb) return null;
  if (rgb.a === 0) return null;
  return { rgb, source: decl.value };
}

function extractColorToken(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (parseColor(trimmed)) return trimmed;
  for (const token of tokenizeShorthand(trimmed)) {
    if (parseColor(token)) return token;
  }
  return trimmed;
}

/** Tokenize on spaces while respecting parentheses (rgb(), hsl()). */
function tokenizeShorthand(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === " " && depth === 0) {
      if (current.length > 0) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// ---------------------------------------------------------------------------
// Selector classification
// ---------------------------------------------------------------------------

type Target = "interactive" | "graphic" | "ignore";

const INTERACTIVE_TAG_PATTERN =
  /(^|[\s>+~,])(button|input|select|textarea)\b|^\s*a\.btn|\.btn\b|\.button\b/i;
const INTERACTIVE_ROLE_PATTERN =
  /\[role\s*[=~|]?=\s*["']?(?:button|checkbox|switch|tab|menuitem|radio|combobox|slider|link|option|treeitem)["']?\]/i;
const GRAPHIC_PATTERN = /(^|[\s>+~,])svg\b|\[role\s*=\s*["']img["']\]/i;
const DISABLED_PATTERN =
  /:disabled\b|\[disabled\]|\[aria-disabled\s*=\s*["']?true["']?\]|\.disabled\b|\.is-disabled\b/i;
const HIDDEN_PATTERN =
  /\[aria-hidden\s*=\s*["']?true["']?\]|\[role\s*=\s*["'](?:presentation|none)["']\]/i;

function classifySelector(selector: string): Target {
  if (INTERACTIVE_ROLE_PATTERN.test(selector)) return "interactive";
  if (INTERACTIVE_TAG_PATTERN.test(selector)) return "interactive";
  if (GRAPHIC_PATTERN.test(selector)) return "graphic";
  return "ignore";
}

function isExempt(selector: string): boolean {
  if (DISABLED_PATTERN.test(selector)) return true;
  if (HIDDEN_PATTERN.test(selector)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Message + suggestion builders
// ---------------------------------------------------------------------------

function buildMessage(
  selector: string,
  prop: string,
  fgSource: string,
  bgSource: string,
  ratio: number,
): string {
  return `'${selector}' has ${prop} '${fgSource}' with contrast ${ratio.toFixed(2)}:1 against background '${bgSource}' — ${SC_LABEL} requires at least ${WCAG_AA_MIN_NON_TEXT}:1 for non-text UI components and graphics.`;
}

function buildSuggestion(prop: string, fgSource: string, bgSource: string, ratio: number): string {
  const gap = (WCAG_AA_MIN_NON_TEXT / ratio).toFixed(2);
  const darkerHint = suggestDarker(fgSource);
  return `Increase contrast of \`${prop}: ${fgSource}\` against \`background: ${bgSource}\` to at least ${WCAG_AA_MIN_NON_TEXT}:1. The current ratio is ${ratio.toFixed(2)}:1 — you need ${gap}× more contrast.${darkerHint ? ` Try \`${prop}: ${darkerHint}\` for a quick fix, or use the WebAIM Contrast Checker to tune the pair.` : ` Pick a darker boundary color or a lighter background, then verify with the WebAIM Contrast Checker.`}`;
}

/**
 * Best-effort "darker version" hint for hex inputs only — non-hex values
 * return null and the suggestion falls back to generic guidance. We never
 * promise the suggested color clears 3:1 (that depends on the background);
 * the hint is purely a starting point a developer can paste in and tweak.
 */
function suggestDarker(source: string): string | null {
  const rgb = parseColor(source.trim());
  if (!rgb) return null;
  const factor = 0.55; // pull each channel ~45% toward black
  const r = Math.max(0, Math.round(rgb.r * factor));
  const g = Math.max(0, Math.round(rgb.g * factor));
  const b = Math.max(0, Math.round(rgb.b * factor));
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}
