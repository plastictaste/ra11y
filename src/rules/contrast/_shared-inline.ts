/**
 * Inline `style="…"` helpers for the contrast rules.
 *
 * `contrast/minimum`, `contrast/enhanced`, and `contrast/non-text`
 * all need to evaluate the same pattern on HTML elements:
 *
 *   <p style="color:#777;background-color:#ccc">  ← AA text contrast
 *   <button style="border:1px solid #ddd;background:#fff">  ← non-text
 *
 * Historically the rules only looked at standalone `.css` files and
 * `<style>` blocks, so every inline `style="…"` declaration pair went
 * unevaluated — a silent miss on a ubiquitous real-world pattern
 * (static-site-template scans consistently reported zero contrast
 * findings despite heavy inline-style use).
 *
 * This module exports the walker + message builders; `_shared.ts`
 * keeps its stylesheet-path helpers. The two modules share
 * `IMAGE_BACKED_VALUE_PATTERN` so inline `background-image: …` and
 * stylesheet `background-image: …` are classified identically.
 *
 * Pure functions. No I/O, no cross-file state.
 */

import { getHtmlAttribute, walkHtmlElements } from "../../engine/ast-helpers.ts";
import type { HtmlDocument, HtmlElement } from "../../types/ast.ts";
import { parseColor, type Rgb } from "../../utils/color.ts";
import { contrast } from "../../utils/contrast.ts";
import {
  type ContrastCheckOptions,
  IMAGE_BACKED_VALUE_PATTERN,
  TEXT_FOREGROUND_PROPERTIES,
} from "./_shared.ts";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * A single property/value declaration parsed from an HTML element's
 * inline `style="…"` attribute. Mirrors the shape of `CssDeclaration`
 * but omits source positions — inline-style findings anchor on the
 * element's own `loc`, not on a position inside the attribute string.
 */
export interface InlineStyleDeclaration {
  readonly property: string;
  readonly value: string;
}

/**
 * A contrast finding derived from an element's inline `style="…"`
 * attribute. Parallel to `ContrastFinding` for CSS rules but keyed on
 * the element's tag + source position. `pseudoSelector` is the
 * agent-visible label — intentionally NOT a real CSS selector, since
 * inline declarations have no class / id to hook on.
 */
export interface InlineStyleContrastFinding {
  readonly tagName: string;
  readonly pseudoSelector: string;
  readonly line: number;
  readonly column: number;
  readonly ratio: number;
  readonly minimum: number;
  readonly isLarge: boolean;
  readonly fgSource: string;
  readonly bgSource: string;
}

/**
 * A bg-image-unresolvable finding derived from an element's inline
 * `style="…"` attribute. Parallel to `BgImageUnresolvableFinding` —
 * the scanner cannot compute luminance for an image/gradient in an
 * inline style any more than it can for a stylesheet rule, so the
 * consumer surfaces the pair as an info-severity finding.
 */
export interface InlineStyleBgImageUnresolvableFinding {
  readonly tagName: string;
  readonly pseudoSelector: string;
  readonly line: number;
  readonly column: number;
  readonly fgProperty: string;
  readonly fgSource: string;
  readonly bgSource: string;
  readonly bgProperty: "background-image" | "background";
}

// ---------------------------------------------------------------------------
// Declaration parsing
// ---------------------------------------------------------------------------

/**
 * Parses an HTML inline `style="…"` attribute value into its component
 * declarations. Split on `;`, each part split once on `:`. Property
 * names are lowercased; values are trimmed. Parts without a `:`
 * separator are silently skipped.
 */
export function parseInlineStyleDeclarations(styleAttr: string): InlineStyleDeclaration[] {
  const out: InlineStyleDeclaration[] = [];
  for (const part of styleAttr.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (property.length === 0 || value.length === 0) continue;
    out.push({ property, value });
  }
  return out;
}

/**
 * Look up a single property by name in a parsed inline-style list.
 * Property names in `declarations` are already lowercased by the
 * `parseInlineStyleDeclarations` contract.
 */
export function findInlineStyleDeclaration(
  declarations: readonly InlineStyleDeclaration[],
  property: string,
): InlineStyleDeclaration | undefined {
  const target = property.toLowerCase();
  return declarations.find((d) => d.property === target);
}

// ---------------------------------------------------------------------------
// Walkers
// ---------------------------------------------------------------------------

/**
 * Walks every HTML element and yields a contrast finding for each
 * element whose inline `style="…"` declares a foreground + background
 * pair below the supplied threshold. The walker is split into an
 * outer loop (iterate elements, read background) and
 * `checkInlineForegroundPair` (evaluate each foreground property) so
 * the cognitive-complexity budget stays under the project cap.
 *
 * `foregroundProperties` defaults to the text-contrast set (`color`);
 * `contrast/non-text` passes the boundary set elsewhere, through its
 * own emitter.
 */
export function findInlineStyleContrastFailures(
  doc: HtmlDocument,
  opts: ContrastCheckOptions,
  foregroundProperties: readonly string[] = TEXT_FOREGROUND_PROPERTIES,
): InlineStyleContrastFinding[] {
  const out: InlineStyleContrastFinding[] = [];
  for (const element of walkHtmlElements(doc)) {
    const ctx = readInlineContrastContext(element);
    if (!ctx) continue;
    const bg = readInlineBackground(ctx.decls);
    if (!bg) continue;
    for (const fgProperty of foregroundProperties) {
      const finding = scoreInlinePair(element, ctx.decls, bg, fgProperty, opts);
      if (finding) out.push(finding);
    }
  }
  return out;
}

/**
 * Walks every HTML element and yields a bg-image-unresolvable finding
 * per (foreground-property, element) pair where the inline `style="…"`
 * declares an image-backed background alongside a resolvable
 * foreground color. Parallel to `collectBgImageUnresolvable` in
 * `_shared.ts` — same shape split between CSS and HTML paths.
 */
export function collectInlineStyleBgImageUnresolvable(
  doc: HtmlDocument,
  foregroundProperties: readonly string[] = TEXT_FOREGROUND_PROPERTIES,
): InlineStyleBgImageUnresolvableFinding[] {
  const out: InlineStyleBgImageUnresolvableFinding[] = [];
  for (const element of walkHtmlElements(doc)) {
    const ctx = readInlineContrastContext(element);
    if (!ctx) continue;
    const bg = findInlineImageBackedBackground(ctx.decls);
    if (!bg) continue;
    for (const fgProperty of foregroundProperties) {
      const finding = recordInlineUnresolvablePair(element, ctx.decls, bg, fgProperty);
      if (finding) out.push(finding);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-element / per-foreground helpers
// ---------------------------------------------------------------------------

/**
 * Reads the inline `style` attribute and parses it into declarations.
 * Returns `null` when the element has no inline style, when the
 * attribute is empty, or when no parseable declarations remain — so
 * the walker can `continue` on a single falsy check.
 */
function readInlineContrastContext(
  element: HtmlElement,
): { readonly decls: readonly InlineStyleDeclaration[] } | null {
  const styleAttr = getHtmlAttribute(element, "style");
  if (styleAttr === null || styleAttr.trim().length === 0) return null;
  const decls = parseInlineStyleDeclarations(styleAttr);
  if (decls.length === 0) return null;
  return { decls };
}

function scoreInlinePair(
  element: HtmlElement,
  decls: readonly InlineStyleDeclaration[],
  bg: { readonly rgb: Rgb; readonly source: string },
  fgProperty: string,
  opts: ContrastCheckOptions,
): InlineStyleContrastFinding | null {
  const fgDecl = findInlineStyleDeclaration(decls, fgProperty);
  if (!fgDecl) return null;
  const fg = parseColor(extractInlineColorToken(fgDecl.value));
  if (!fg) return null;
  const ratio = contrast(fg, bg.rgb);
  const isLarge = isInlineLargeText(decls);
  const minimum = isLarge ? opts.minLarge : opts.minNormal;
  if (ratio >= minimum) return null;
  return {
    tagName: element.tagName,
    pseudoSelector: describeInlineTarget(element.tagName, fgProperty),
    line: element.loc.start.line,
    column: element.loc.start.column,
    ratio,
    minimum,
    isLarge,
    fgSource: fgDecl.value,
    bgSource: bg.source,
  };
}

function recordInlineUnresolvablePair(
  element: HtmlElement,
  decls: readonly InlineStyleDeclaration[],
  bg: {
    readonly decl: InlineStyleDeclaration;
    readonly property: "background-image" | "background";
  },
  fgProperty: string,
): InlineStyleBgImageUnresolvableFinding | null {
  const fgDecl = findInlineStyleDeclaration(decls, fgProperty);
  if (!fgDecl) return null;
  const fg = parseColor(extractInlineColorToken(fgDecl.value));
  if (!fg) return null;
  return {
    tagName: element.tagName,
    pseudoSelector: describeInlineTarget(element.tagName, fgProperty),
    line: element.loc.start.line,
    column: element.loc.start.column,
    fgProperty,
    fgSource: fgDecl.value,
    bgSource: bg.decl.value,
    bgProperty: bg.property,
  };
}

/**
 * Resolves the background on an inline-style declaration list. Prefers
 * `background-color` over the `background` shorthand (matches
 * `extractColorPair` for CSS rules). Returns `null` when no
 * declaration resolves to a concrete color.
 */
function readInlineBackground(
  decls: readonly InlineStyleDeclaration[],
): { readonly rgb: Rgb; readonly source: string } | null {
  const bgDecl =
    findInlineStyleDeclaration(decls, "background-color") ??
    findInlineStyleDeclaration(decls, "background");
  if (!bgDecl) return null;
  const rgb = parseColor(extractInlineColorToken(bgDecl.value));
  if (!rgb) return null;
  if (rgb.a === 0) return null;
  return { rgb, source: bgDecl.value };
}

/**
 * Returns the image-backed background declaration on `decls`, or
 * `null` when neither `background` nor `background-image` carries an
 * image/gradient value. Shares `IMAGE_BACKED_VALUE_PATTERN` with the
 * CSS-path helper so classification is identical across surfaces.
 */
function findInlineImageBackedBackground(decls: readonly InlineStyleDeclaration[]): {
  readonly decl: InlineStyleDeclaration;
  readonly property: "background-image" | "background";
} | null {
  const bgImage = findInlineStyleDeclaration(decls, "background-image");
  if (bgImage && IMAGE_BACKED_VALUE_PATTERN.test(bgImage.value)) {
    return { decl: bgImage, property: "background-image" };
  }
  const bgShort = findInlineStyleDeclaration(decls, "background");
  if (bgShort && IMAGE_BACKED_VALUE_PATTERN.test(bgShort.value)) {
    return { decl: bgShort, property: "background" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Value-level helpers
// ---------------------------------------------------------------------------

/** Extract the first parseable color token from an inline declaration value. */
function extractInlineColorToken(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (parseColor(trimmed)) return trimmed;
  const tokens = tokenizeInlineValue(trimmed);
  for (const token of tokens) {
    if (parseColor(token)) return token;
  }
  return trimmed;
}

/**
 * Whitespace-tokenize an inline declaration value, respecting balanced
 * parentheses so `rgb(…)` / `hsl(…)` / `linear-gradient(…)` survive as
 * single tokens.
 */
function tokenizeInlineValue(value: string): string[] {
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
// Large-text heuristic (font-size / font-weight on the element itself)
// ---------------------------------------------------------------------------

const PT_PER_PX = 72 / 96;
const PX_PER_REM = 16;
const PX_PER_EM = 16;

/**
 * Large-text heuristic for an inline-style declaration list. Applies
 * the same ≥18pt / ≥14pt-bold rule as the CSS path but reads values
 * from `font-size` / `font-weight` within the element's own inline
 * declarations. A missing `font-size` returns `false` — the scanner
 * cannot statically resolve inherited font size, so it falls back to
 * the strict normal-text threshold.
 */
function isInlineLargeText(decls: readonly InlineStyleDeclaration[]): boolean {
  const sizeDecl = findInlineStyleDeclaration(decls, "font-size");
  if (!sizeDecl) return false;
  const sizePt = resolveInlineFontSizePt(sizeDecl.value);
  if (sizePt === null) return false;
  if (sizePt >= 18) return true;
  if (sizePt < 14) return false;
  const weightDecl = findInlineStyleDeclaration(decls, "font-weight");
  return weightDecl !== undefined && isInlineBold(weightDecl.value);
}

function resolveInlineFontSizePt(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  const match = /^([+-]?\d*\.?\d+)(px|pt|rem|em|%)?$/.exec(trimmed);
  if (!match) return null;
  const n = Number.parseFloat(match[1] ?? "0");
  if (!Number.isFinite(n)) return null;
  const unit = match[2] ?? "px";
  if (unit === "pt") return n;
  if (unit === "px") return n * PT_PER_PX;
  if (unit === "rem") return n * PX_PER_REM * PT_PER_PX;
  if (unit === "em") return n * PX_PER_EM * PT_PER_PX;
  return null;
}

function isInlineBold(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "bold" || trimmed === "bolder") return true;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 700;
}

// ---------------------------------------------------------------------------
// Message / suggestion builders
// ---------------------------------------------------------------------------

/**
 * Agent-visible label for an inline-style finding. Preserves the
 * element's tag so messages read like `<p inline style color>` — the
 * form is deliberately not a real CSS selector, since inline
 * declarations have no class / id to hook on.
 */
function describeInlineTarget(tagName: string, fgProperty: string): string {
  return `<${tagName.toLowerCase()} inline style ${fgProperty}>`;
}

/**
 * Context-aware message builder for an inline-style contrast failure.
 * Mirrors the CSS-path message but names the element + tag so the
 * agent knows it's an HTML inline-style issue, not a stylesheet rule.
 */
export function buildInlineStyleContrastMessage(
  finding: InlineStyleContrastFinding,
  scLabel: string,
): string {
  const size = finding.isLarge ? "large text" : "normal text";
  return `${finding.pseudoSelector} has color contrast ratio ${finding.ratio.toFixed(2)}:1 against its inline background — ${scLabel} requires ${finding.minimum}:1 for ${size}.`;
}

/**
 * Fix-suggestion builder for an inline-style contrast failure. Names
 * the actual inline declaration pair so the agent can target the edit,
 * and points at the same remediation paths as the stylesheet-path
 * suggestion — with the extra option of moving the declaration into a
 * class so it inherits the project's design-system palette.
 */
export function buildInlineStyleContrastSuggestion(finding: InlineStyleContrastFinding): string {
  const size = finding.isLarge ? "large text" : "normal text";
  const gap = (finding.minimum / finding.ratio).toFixed(2);
  return `Adjust the inline \`color: ${finding.fgSource}\` or \`background: ${finding.bgSource}\` on the ${finding.pseudoSelector} element. Current ratio: ${finding.ratio.toFixed(2)}:1; you need ${finding.minimum}:1 for ${size} (${gap}× more contrast). Move the declarations into a CSS class so the project's design-system palette keeps contrast consistent, or pick replacement colors from your design system and verify the pair clears the threshold.`;
}

/**
 * Context-aware message for an inline-style bg-image-unresolvable
 * finding. Names the element, the foreground property, and the
 * minimum the agent should verify against.
 */
export function buildInlineStyleBgImageUnresolvableMessage(
  finding: InlineStyleBgImageUnresolvableFinding,
  minimum: number,
  scLabel: string,
): string {
  return `${finding.pseudoSelector} declares inline ${finding.fgProperty} '${finding.fgSource}' against ${finding.bgProperty} '${finding.bgSource}' — contrast cannot be evaluated statically because the background is an image or gradient. ${scLabel} requires at least ${minimum}:1; verify manually against the image's actual luminance at the glyph position.`;
}

/**
 * Fix suggestion for an inline-style bg-image-unresolvable finding.
 * Points at the same remediation the CSS-path suggestion does — a
 * fallback color behind the image, or manual verification — with the
 * extra option of moving the declaration into a CSS rule.
 */
export function buildInlineStyleBgImageUnresolvableSuggestion(
  finding: InlineStyleBgImageUnresolvableFinding,
  minimum: number,
): string {
  return `Set an explicit \`background-color\` on the element (either inline alongside the image, or by moving the declarations into a CSS class) so contrast can be evaluated, or confirm manually that the \`${finding.fgProperty}: ${finding.fgSource}\` has at least ${minimum}:1 contrast against the visual background of the image at every glyph position. If the image has a dark/light overlay that guarantees contrast, keep the markup and note the overlay in a comment so future reviewers know why it is safe.`;
}
