/**
 * Shared contrast-rule helpers. `contrast/minimum` (WCAG 1.4.3 AA)
 * and `contrast/enhanced` (WCAG 1.4.6 AAA) are structurally
 * identical — they walk CSS rules, extract a (foreground,
 * background) pair, check the font size, and compare the ratio
 * against a threshold. Only the threshold constants differ.
 *
 * This module owns the walking + extraction logic. Callers pass
 * the minima they want applied and the SC they cite. Keeps both
 * rule files short and ensures any extraction bug gets fixed in
 * one place.
 *
 * `:root` custom-property resolution (-
 * RESOLUTION): design-system CSS routinely declares tokens on `:root`
 * (`:root { --fg: #111; --bg: #fff }`) and consumes them via `var()`
 * (`.card { color: var(--fg); background: var(--bg) }`). The pair
 * path used to silently skip these — `parseColor("var(--fg)")`
 * returns `null`, so the rule saw no resolvable color and emitted no
 * finding, even when the literal pair failed 1:1. The extraction
 * helpers now run a single-pass same-file substitution: pass 1
 * collects `:root { --name: <value> }` declarations, pass 2
 * substitutes one level when a declaration value is a bare
 * `var(--name)` (no fallback, no nested lookup). Explicitly
 * unsupported: nested `var(--x)` inside the resolved value (a
 * follow-up), `var(--x, #000)` fallback values (a follow-up),
 * `--name` declared on a different file (the cascade can override).
 * Per ADR 0026 + Q5 coverage-confidence doctrine, any rule whose
 * spec now spans cross-file token files but whose implementation is
 * same-file declares `crossFileCapable: false` so the clean tally
 * downgrades to `coverageConfidence: "medium"` — honest "ran but
 * evidence was bounded" in place of silent-miss `"high"`.
 *
 * Cross-file Tailwind cross-reference (`couldBeWrongBecause` opt-in):
 *   `collectTailwindOverrideClasses` walks every JSX / HTML element
 *   in the scan and returns the set of plain class names that co-occur
 *   with a `text-*` or `bg-*` Tailwind utility. When a CSS contrast
 *   failure targets one of those classes, the consumer-site Tailwind
 *   utility overrides the declared color/background and the scanner's
 *   attribute-level evidence is categorically weaker than the agent's
 *   file-level evidence — the rule surfaces `tailwind_class_on_consumer`
 *   as informational signal. Deterministic class-token link, NOT
 *   heuristic suppression (CLAUDE.md §1). See
 *   docs/adr/0009-violation-could-be-wrong-because.md.
 */

import { walkCssRules, walkHtmlElements, walkJsxElements } from "../../engine/ast-helpers.ts";
import { parseTailwind } from "../../input/parsers/tailwind.ts";
import type {
  CssRule as CssCssRule,
  CssDeclaration,
  CssStylesheet,
  HtmlDocument,
  HtmlElement,
  JsxElement,
  TsxModule,
} from "../../types/ast.ts";
import type { Language, ProjectContext } from "../../types/rule.ts";
import { parseColor, type Rgb } from "../../utils/color.ts";
import { contrast } from "../../utils/contrast.ts";

export interface ContrastCheckOptions {
  readonly minNormal: number;
  readonly minLarge: number;
  readonly scLabel: string; // e.g. "WCAG 1.4.3" or "WCAG 1.4.6"
}

export interface ContrastFinding {
  readonly selector: string;
  readonly line: number;
  readonly column: number;
  readonly ratio: number;
  readonly minimum: number;
  readonly isLarge: boolean;
  readonly fgSource: string;
  readonly bgSource: string;
  /**
   * Populated when one half of the color pair (fg or bg) was resolved
   * by walking up to a document-default selector (`:root` / `html` /
   * `body`) rather than read directly off the failing rule. The string
   * names which side was inherited and from which ancestor selector,
   * so the consumer rule's message + `couldBeWrongBecause` code carry
   * enough context for the agent to verify the descendant relationship
   * (the scanner cannot prove `.btn` is actually rendered inside
   * `<body>` — the idiom is dominant, but the evidence is heuristic).
   * Omitted on same-rule pairs where both halves are declared locally
   */
  readonly cascadeSource?: {
    readonly side: "foreground" | "background";
    readonly ancestorSelector: string;
  };
}

/**
 * An emitted-alongside signal: this CSS rule has a text-or-boundary
 * color declaration AND an image-backed background (`background-image`
 * / gradient / `background: …url()…`), so the static scanner cannot
 * compute a luminance for the background. Consumer rules surface this
 * as an `info`-severity finding carrying
 * `couldBeWrongBecause: [BG_IMAGE_UNRESOLVABLE]` — honest surfacing,
 * no fabricated ratio. Per CLAUDE.md §1 "Surface, don't suppress."
 */
export interface BgImageUnresolvableFinding {
  readonly selector: string;
  readonly line: number;
  readonly column: number;
  /** Foreground property whose declaration triggered the pairing (e.g. `color`, `border-color`). */
  readonly fgProperty: string;
  readonly fgSource: string;
  readonly bgSource: string;
  /** Which CSS property surfaced the unresolvable background. */
  readonly bgProperty: "background-image" | "background";
}

/**
 * `couldBeWrongBecause` code surfaced on info findings emitted by the
 * contrast rules when a foreground color declaration sits on a rule
 * whose background is image-backed (url() / linear-gradient() / etc).
 * Static analysis cannot compute a luminance for the image, so the
 * scanner honestly surfaces "unevaluated — verify manually" rather
 * than silently skipping the declaration. See CLAUDE.md §1 (Surface,
 * don't suppress) and docs/adr/0009-violation-could-be-wrong-because.md.
 */
export const BG_IMAGE_UNRESOLVABLE = "background_image_unresolvable";

/**
 * Default foreground properties consulted by the text-contrast rules
 * (`contrast/minimum`, `contrast/enhanced`) when pairing against an
 * unresolvable image-backed background.
 */
export const TEXT_FOREGROUND_PROPERTIES: readonly string[] = ["color"];

/**
 * Foreground properties consulted by `contrast/non-text` when pairing
 * a user-authored boundary/graphic color against an unresolvable
 * image-backed background. Mirrors the property set the rule evaluates
 * in its normal boundary loop.
 */
export const NON_TEXT_FOREGROUND_PROPERTIES: readonly string[] = [
  "border-color",
  "border",
  "outline-color",
  "outline",
  "fill",
  "stroke",
];

interface ColorPair {
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly fgSource: string;
  readonly bgSource: string;
  readonly cascadeSource?: {
    readonly side: "foreground" | "background";
    readonly ancestorSelector: string;
  };
}

/**
 * Document-default color declarations walked off `:root` / `html` /
 * `body` selectors, fueling the cross-selector cascade fallback.
 * When a child rule declares one
 * half of the contrast pair (e.g. `article { color: #999 }`) and the
 * other half lives on a document-default selector
 * (`body { background: #fff }`), the pair extractor walks up and
 * produces a live pair — the canonical real-world idiom that silently
 * missed contrast failures before the fallback existed.
 *
 * Same-file only, mirrors the `:root` custom-property resolver's scope
 * — cross-file document defaults (layout partials declaring `body
 * { color }` in a separate stylesheet) stay unresolved and the rule's
 * `crossFileCapable: false` metadata surfaces the limit at the coverage
 * layer per ADR 0026. Last-write-wins on duplicate declarations across
 * ancestor rules, matching CSS intra-file cascade semantics.
 */
interface CascadeDefaults {
  readonly color?: { readonly value: string; readonly selector: string };
  readonly background?: { readonly value: string; readonly selector: string };
}

const PT_PER_PX = 72 / 96;
const PX_PER_REM = 16;
const PX_PER_EM = 16;

/**
 * Walk every CSS rule in `stylesheet` and yield a finding for each
 * rule that declares a resolvable color pair whose contrast ratio
 * falls below the supplied threshold.
 *
 * Same-file `:root` custom-property substitution runs before the pair
 * extractor so design-system stylesheets that declare `:root { --fg:
 * #111 }` and consume `var(--fg)` resolve to live colors. Explicitly
 * unsupported: cross-file tokens, nested var references, and
 * `var(--x, #fff)` fallback values — those remain unresolved (the
 * pair path gives up) and the rule's `crossFileCapable: false`
 * metadata surfaces the limitation at the coverage layer.
 */
export function findContrastFailures(
  stylesheet: CssStylesheet,
  opts: ContrastCheckOptions,
): ContrastFinding[] {
  const out: ContrastFinding[] = [];
  const rootVars = collectRootCustomProperties(stylesheet);
  const cascadeDefaults = collectCascadeDefaults(stylesheet, rootVars);
  for (const cssRule of walkCssRules(stylesheet)) {
    const pair = extractColorPair(cssRule, rootVars, cascadeDefaults);
    if (!pair) continue;
    const ratio = contrast(pair.fg, pair.bg);
    const isLarge = isLargeText(cssRule);
    const minimum = isLarge ? opts.minLarge : opts.minNormal;
    if (ratio >= minimum) continue;
    out.push({
      selector: cssRule.selector,
      line: cssRule.loc.start.line,
      column: cssRule.loc.start.column,
      ratio,
      minimum,
      isLarge,
      fgSource: pair.fgSource,
      bgSource: pair.bgSource,
      ...(pair.cascadeSource ? { cascadeSource: pair.cascadeSource } : {}),
    });
  }
  return out;
}

export function buildContrastMessage(finding: ContrastFinding, scLabel: string): string {
  const size = finding.isLarge ? "large text" : "normal text";
  if (finding.cascadeSource) {
    const side = finding.cascadeSource.side;
    const ancestor = finding.cascadeSource.ancestorSelector;
    const sourceNote =
      side === "background"
        ? `the background was inherited from '${ancestor}' (background: ${finding.bgSource})`
        : `the foreground was inherited from '${ancestor}' (color: ${finding.fgSource})`;
    return `'${finding.selector}' has color contrast ratio ${finding.ratio.toFixed(2)}:1 against its background — ${scLabel} requires ${finding.minimum}:1 for ${size}. Note: ${sourceNote}; verify this rule's element actually renders inside that ancestor.`;
  }
  return `'${finding.selector}' has color contrast ratio ${finding.ratio.toFixed(2)}:1 against its background — ${scLabel} requires ${finding.minimum}:1 for ${size}.`;
}

export function buildContrastSuggestion(finding: ContrastFinding): string {
  const size = finding.isLarge ? "large text" : "normal text";
  const gap = (finding.minimum / finding.ratio).toFixed(2);
  const base = `Adjust \`color: ${finding.fgSource}\` or \`background: ${finding.bgSource}\` so the pair reaches ${finding.minimum}:1 for ${size}. Current ratio: ${finding.ratio.toFixed(2)}:1 — you need ${gap}× more contrast. Pick a replacement from your project's design-system palette and verify the pair clears the threshold.`;
  if (!finding.cascadeSource) return base;
  const side = finding.cascadeSource.side;
  const ancestor = finding.cascadeSource.ancestorSelector;
  const inheritedNote =
    side === "background"
      ? `The missing \`background\` was inherited from '${ancestor}' — adding an explicit \`background-color\` on '${finding.selector}' (or adjusting the ancestor default) will override the cascade.`
      : `The missing \`color\` was inherited from '${ancestor}' — adding an explicit \`color\` on '${finding.selector}' (or adjusting the ancestor default) will override the cascade.`;
  return `${base} ${inheritedNote}`;
}

function extractColorPair(
  cssRule: CssCssRule,
  rootVars: ReadonlyMap<string, string>,
  cascadeDefaults: CascadeDefaults,
): ColorPair | null {
  const fgDecl = findDeclaration(cssRule, "color");
  const bgDecl =
    findDeclaration(cssRule, "background-color") ?? findDeclaration(cssRule, "background");
  if (fgDecl && bgDecl) {
    return buildSameRulePair(fgDecl.value, bgDecl.value, rootVars);
  }
  // Cross-selector cascade fallback:
  // one half lives on the rule, the other on a document-default selector
  // elsewhere in the file. Skip for ancestor-default selectors themselves
  // (they ARE the source, no cascading into themselves), and keep the
  // same-file-only scope mirroring `:root` custom-property resolution.
  // Cross-file document defaults stay unresolved; the rule's
  // `crossFileCapable: false` flag carries the limit at the coverage
  // layer per ADR 0026.
  if (isCascadeAncestorSelector(cssRule.selector)) return null;
  if (fgDecl && !bgDecl && cascadeDefaults.background) {
    return buildInheritedBackgroundPair(fgDecl.value, cascadeDefaults.background, rootVars);
  }
  if (bgDecl && !fgDecl && cascadeDefaults.color) {
    return buildInheritedForegroundPair(bgDecl.value, cascadeDefaults.color, rootVars);
  }
  return null;
}

function buildSameRulePair(
  fgValue: string,
  bgValue: string,
  rootVars: ReadonlyMap<string, string>,
): ColorPair | null {
  const fg = parseColor(extractColorToken(fgValue, rootVars));
  const bg = parseColor(extractColorToken(bgValue, rootVars));
  if (!(fg && bg)) return null;
  if (bg.a === 0) return null;
  return { fg, bg, fgSource: fgValue, bgSource: bgValue };
}

function buildInheritedBackgroundPair(
  fgValue: string,
  bgDefault: { readonly value: string; readonly selector: string },
  rootVars: ReadonlyMap<string, string>,
): ColorPair | null {
  const fg = parseColor(extractColorToken(fgValue, rootVars));
  const bg = parseColor(extractColorToken(bgDefault.value, rootVars));
  if (!(fg && bg)) return null;
  if (bg.a === 0) return null;
  return {
    fg,
    bg,
    fgSource: fgValue,
    bgSource: bgDefault.value,
    cascadeSource: { side: "background", ancestorSelector: bgDefault.selector },
  };
}

function buildInheritedForegroundPair(
  bgValue: string,
  fgDefault: { readonly value: string; readonly selector: string },
  rootVars: ReadonlyMap<string, string>,
): ColorPair | null {
  const fg = parseColor(extractColorToken(fgDefault.value, rootVars));
  const bg = parseColor(extractColorToken(bgValue, rootVars));
  if (!(fg && bg)) return null;
  if (bg.a === 0) return null;
  return {
    fg,
    bg,
    fgSource: fgDefault.value,
    bgSource: bgValue,
    cascadeSource: { side: "foreground", ancestorSelector: fgDefault.selector },
  };
}

function findDeclaration(cssRule: CssCssRule, property: string): CssDeclaration | undefined {
  const target = property.toLowerCase();
  return cssRule.declarations.find((d) => d.property.toLowerCase() === target);
}

/**
 * Extracts the first parseable color token from a declaration value.
 * Consults `rootVars` when the trimmed value or a tokenized part is a
 * bare `var(--name)` reference — substitutes the `:root`-declared
 * literal one level, then attempts `parseColor` on the result.
 * Explicitly bounded: nested `var(...)` inside the resolved value is
 * not recursively expanded (the substitution returns the first-pass
 * literal verbatim), and `var(--x, #fff)` fallback syntax is not yet
 * understood — both paths fall through to "unresolvable" and the
 * caller skips the pair. Rule metadata (`crossFileCapable: false`)
 * names the limitation at the per-rule coverage layer.
 */
function extractColorToken(rawValue: string, rootVars: ReadonlyMap<string, string>): string {
  const trimmed = rawValue.trim();
  const resolvedWhole = resolveVarReference(trimmed, rootVars);
  if (parseColor(resolvedWhole)) return resolvedWhole;
  const tokens = tokenizeValue(trimmed);
  for (const token of tokens) {
    const resolvedTok = resolveVarReference(token, rootVars);
    if (parseColor(resolvedTok)) return resolvedTok;
  }
  return trimmed;
}

function tokenizeValue(value: string): string[] {
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

function isLargeText(cssRule: CssCssRule): boolean {
  const sizeDecl = findDeclaration(cssRule, "font-size");
  if (!sizeDecl) return false;
  const sizePt = resolveFontSizePt(sizeDecl.value);
  if (sizePt === null) return false;
  if (sizePt >= 18) return true;
  if (sizePt >= 14) {
    const weightDecl = findDeclaration(cssRule, "font-weight");
    if (weightDecl && isBold(weightDecl.value)) return true;
  }
  return false;
}

function resolveFontSizePt(value: string): number | null {
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

function isBold(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "bold") return true;
  if (trimmed === "bolder") return true;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 700;
}

// ---------------------------------------------------------------------------
// `:root` custom-property resolution
// ---------------------------------------------------------------------------

/**
 * Matches a bare `var(--name)` reference — no whitespace outside the
 * parens, no fallback comma, and no additional trailing/leading
 * tokens. `var(--fg, #000)` (fallback) and `1px solid var(--border)`
 * (embedded in a shorthand) don't match; the token walker in
 * {@link extractColorToken} feeds individual whitespace tokens so an
 * embedded reference only resolves when it arrived as its own token.
 *
 * The name capture is deliberately permissive (anything but `)`) so
 * CSS's full custom-property naming grammar stays in-scope — the
 * downstream map lookup fails closed if the author did something
 * exotic, and failed-closed on a bogus name is the same as "unresolved,
 * skip the pair" which is already the honest behavior.
 */
const BARE_VAR_REFERENCE_PATTERN = /^var\(\s*(--[^,)\s]+)\s*\)$/;

/**
 * Walks the stylesheet once and returns the map of `--name → value`
 * declarations authored on a `:root` selector. Selectors that include
 * `:root` as one of a comma-separated list (e.g. `:root, [data-theme]`)
 * also contribute; any selector without a `:root` segment is ignored.
 *
 * Same-file only by construction — the stylesheet this call is
 * invoked against is the only substrate considered. Cross-file token
 * stylesheets (`tokens.css` ⇒ `components.css`) are outside the scope
 * the consumer rule's `crossFileCapable: false` metadata names, so a
 * clean tally downgrades to `coverageConfidence: "medium"` per ADR
 * 0026.
 */
export function collectRootCustomProperties(
  stylesheet: CssStylesheet,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const cssRule of walkCssRules(stylesheet)) {
    if (!isRootSelector(cssRule.selector)) continue;
    for (const decl of cssRule.declarations) {
      if (!decl.property.startsWith("--")) continue;
      const value = decl.value.trim();
      if (value.length === 0) continue;
      // Later declaration wins on duplicate name — mirrors the CSS
      // cascade's intra-rule behavior; the author's last write for a
      // given `:root { --name: ... }` is the one a consumer sees.
      out.set(decl.property, value);
    }
  }
  return out;
}

function isRootSelector(selector: string): boolean {
  return selector.split(",").some((part) => part.trim().toLowerCase() === ":root");
}

/**
 * Resolves a single `var(--name)` token via one same-file substitution
 * lookup. Returns the resolved literal when:
 *
 *   - `token` matches `BARE_VAR_REFERENCE_PATTERN` (no fallback, no
 *     embedded context),
 *   - `--name` is present in `rootVars`, AND
 *   - the resolved literal itself contains no `var(` call (a nested
 *     reference — explicit unsupported; returning the original token
 *     keeps the downstream `parseColor` honest — `parseColor("var(...)")`
 *     returns `null` and the caller treats the pair as unresolved).
 *
 * Any other shape (fallback-style `var(--x, #000)`, unknown `--name`,
 * nested references in the resolved value) returns `token` unchanged
 * so `parseColor` sees the original expression and fails closed.
 */
function resolveVarReference(token: string, rootVars: ReadonlyMap<string, string>): string {
  const match = BARE_VAR_REFERENCE_PATTERN.exec(token);
  if (!match) return token;
  const name = match[1];
  if (name === undefined) return token;
  const resolved = rootVars.get(name);
  if (resolved === undefined) return token;
  // Nested var(...) references stay unresolved — a second-pass
  // expansion would need to guard against cycles and doesn't buy
  // much on real CSS (token files rarely chain). Returning the
  // original token here lets `parseColor` fail naturally and the
  // caller treats the pair as "can't evaluate statically" — honest
  // surfacing per CLAUDE.md §1.
  if (/\bvar\s*\(/.test(resolved)) return token;
  return resolved;
}

// ---------------------------------------------------------------------------
// Cross-selector cascade fallback
// ---------------------------------------------------------------------------

/**
 * Selector segments treated as document-default ancestors for the
 * cross-selector cascade fallback. Matches the three selectors an
 * author would normally reach for to declare "the default for the
 * whole page" — `:root`, `html`, `body`. Comparison is
 * case-insensitive per CSS syntax; kept simple deliberately to avoid
 * stretching into general-purpose CSS cascade resolution (specificity,
 * pseudo-classes, `@media` scoping, descendant-combinator chains —
 * all out of scope).
 */
const CASCADE_ANCESTOR_SEGMENTS: ReadonlySet<string> = new Set([":root", "html", "body"]);

/**
 * `couldBeWrongBecause` code surfaced on contrast findings whose
 * foreground or background was resolved by walking up to a
 * document-default selector (`:root` / `html` / `body`) rather than
 * read off the failing rule. The scanner cannot prove the failing
 * element is actually rendered inside that ancestor — the dominant
 * idiom (document-wide defaults on `body`) makes the pairing
 * overwhelmingly likely, but an element nested in a different
 * container with its own `background` override would not inherit the
 * cascaded default at all. Informational only per the AI-first
 * consumer doctrine: the agent reads the cited file and decides. See
 * docs/kb/architecture/ai-first-consumer.md §"No heuristic
 * suppression" and docs/adr/0009-violation-could-be-wrong-because.md.
 */
export const CASCADE_INHERITED_CONTEXT = "cascade_inherited_context";

/**
 * Returns `true` when `selector` names a document-default ancestor
 * (`:root`, `html`, `body`) — either standalone or as one of a
 * comma-separated list (e.g. `html, body`). Comparison is
 * case-insensitive; pseudo-class / attribute suffixes disqualify the
 * segment (`body.dark` is not a plain ancestor for the fallback's
 * purposes — it is a variant that only applies under a class-gated
 * condition, and falling back to it would invent cascade context the
 * scanner has no evidence for). Keeping the match strict preserves the
 * "named idiom" contract the fallback is scoped to.
 */
function isCascadeAncestorSelector(selector: string): boolean {
  return selector.split(",").some((part) => {
    const trimmed = part.trim().toLowerCase();
    return CASCADE_ANCESTOR_SEGMENTS.has(trimmed);
  });
}

/**
 * Walks the stylesheet once gathering `color` and `background(-color)`
 * declarations authored on document-default ancestor selectors
 * (`:root`, `html`, `body`). Last-write-wins on duplicates across
 * ancestor rules, matching CSS intra-file cascade semantics — the
 * author's most-recent declaration for a given default is the one a
 * consumer element inherits in the absence of an explicit override.
 *
 * `:root` custom-property substitution runs against the declaration
 * value before the map is populated, so a token-driven document
 * default (`body { background: var(--bg) }`) resolves to its literal.
 * Image-backed defaults (url() / gradient) are skipped — the scanner
 * cannot compute their luminance, and falling back to an image would
 * invent a color. Transparent backgrounds (`background: transparent` /
 * `background-color: rgba(0,0,0,0)`) are also skipped so the fallback
 * doesn't pair a real foreground against a zero-alpha background and
 * emit a nonsense ratio — same mitigation the same-rule pair path uses
 * via the `bg.a === 0` check in {@link extractColorPair}.
 */
function collectCascadeDefaults(
  stylesheet: CssStylesheet,
  rootVars: ReadonlyMap<string, string>,
): CascadeDefaults {
  let color: { value: string; selector: string } | undefined;
  let background: { value: string; selector: string } | undefined;
  for (const cssRule of walkCssRules(stylesheet)) {
    if (!isCascadeAncestorSelector(cssRule.selector)) continue;
    const colorDecl = findDeclaration(cssRule, "color");
    if (colorDecl && parseColor(extractColorToken(colorDecl.value, rootVars))) {
      color = { value: colorDecl.value, selector: cssRule.selector };
    }
    const bgDecl =
      findDeclaration(cssRule, "background-color") ?? findDeclaration(cssRule, "background");
    if (bgDecl && isUsableCascadeBackground(bgDecl.value, rootVars)) {
      background = { value: bgDecl.value, selector: cssRule.selector };
    }
  }
  return {
    ...(color ? { color } : {}),
    ...(background ? { background } : {}),
  };
}

/**
 * A cascade-default `background` / `background-color` declaration is
 * "usable" only when it resolves to an opaque color literal — image-
 * backed values (url(), gradient functions) cannot be scored against
 * a consumer `color` and transparent values would fabricate a nonsense
 * ratio. The bounded set of usable shapes keeps the fallback honest:
 * if the document default is an image or transparent, the fallback
 * stays silent on the descendant rule (the same-file `:root` var path
 * also fails closed on unresolved halves).
 */
function isUsableCascadeBackground(
  rawValue: string,
  rootVars: ReadonlyMap<string, string>,
): boolean {
  if (IMAGE_BACKED_VALUE_PATTERN.test(rawValue)) return false;
  const parsed = parseColor(extractColorToken(rawValue, rootVars));
  if (!parsed) return false;
  if (parsed.a === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Image-backed background detection (`couldBeWrongBecause` opt-in)
// ---------------------------------------------------------------------------

/**
 * CSS values naming image-producing functions. Matches any occurrence
 * of `url(` or a `*-gradient(` call anywhere inside the declaration
 * value — shorthand `background: #fff url('bg.png') no-repeat` and
 * `background-image: linear-gradient(...)` both resolve to "image-
 * backed." Matching is case-insensitive per CSS syntax rules.
 *
 * Exported so the inline-style helper module (`_shared-inline.ts`)
 * shares the exact same regex — inline `style="background-image: …"`
 * and stylesheet `background-image: …` must be classified identically.
 */
export const IMAGE_BACKED_VALUE_PATTERN =
  /\burl\s*\(|\b(?:linear|radial|conic|repeating-linear|repeating-radial|repeating-conic)-gradient\s*\(/i;

/**
 * Returns the image-backed background declaration on `cssRule`, or
 * `null` if neither `background` nor `background-image` names an
 * image/gradient value. Prefers the most specific property
 * (`background-image`) when both are present.
 */
function findImageBackedBackground(
  cssRule: CssCssRule,
): { readonly decl: CssDeclaration; readonly property: "background-image" | "background" } | null {
  const bgImage = findDeclaration(cssRule, "background-image");
  if (bgImage && IMAGE_BACKED_VALUE_PATTERN.test(bgImage.value)) {
    return { decl: bgImage, property: "background-image" };
  }
  const bgShort = findDeclaration(cssRule, "background");
  if (bgShort && IMAGE_BACKED_VALUE_PATTERN.test(bgShort.value)) {
    return { decl: bgShort, property: "background" };
  }
  return null;
}

/**
 * Walks every CSS rule in `stylesheet` and yields one
 * `BgImageUnresolvableFinding` per (foreground-property, rule) pair
 * where:
 *
 *   1. the rule declares one of `foregroundProperties` with a
 *      resolvable color, AND
 *   2. the rule declares `background-image: <image>` or
 *      `background: …<image>…` (url() / any *-gradient()).
 *
 * The scanner cannot compute luminance for an image/gradient, so the
 * caller emits an info-severity finding carrying `couldBeWrongBecause:
 * [BG_IMAGE_UNRESOLVABLE]` instead of silently skipping the pair.
 * Honest surfacing, no fabricated ratio. Per CLAUDE.md §1.
 *
 * Note: a rule that also has a resolvable `background-color` still
 * counts — the image overlays the color and the scanner cannot predict
 * which wins at the glyph's position. Emitting here preserves signal;
 * the existing color-pair path also fires when it can, so the agent
 * sees both the computed ratio and the "but there's an image on top"
 * note.
 */
export function collectBgImageUnresolvable(
  stylesheet: CssStylesheet,
  foregroundProperties: readonly string[] = TEXT_FOREGROUND_PROPERTIES,
): BgImageUnresolvableFinding[] {
  const out: BgImageUnresolvableFinding[] = [];
  const rootVars = collectRootCustomProperties(stylesheet);
  for (const cssRule of walkCssRules(stylesheet)) {
    const bg = findImageBackedBackground(cssRule);
    if (!bg) continue;
    for (const fgProperty of foregroundProperties) {
      const fgDecl = findDeclaration(cssRule, fgProperty);
      if (!fgDecl) continue;
      const fg = parseColor(extractColorToken(fgDecl.value, rootVars));
      if (!fg) continue;
      out.push({
        selector: cssRule.selector,
        line: cssRule.loc.start.line,
        column: cssRule.loc.start.column,
        fgProperty,
        fgSource: fgDecl.value,
        bgSource: bg.decl.value,
        bgProperty: bg.property,
      });
    }
  }
  return out;
}

/**
 * Context-aware message for an info-severity bg-image-unresolvable
 * finding. Names the selector, the foreground property that surfaced
 * the pair, and the minimum the agent should verify against — so the
 * emitted finding carries enough context for the agent to investigate
 * without round-tripping.
 */
export function buildBgImageUnresolvableMessage(
  finding: BgImageUnresolvableFinding,
  minimum: number,
  scLabel: string,
): string {
  return `'${finding.selector}' declares ${finding.fgProperty} '${finding.fgSource}' against ${finding.bgProperty} '${finding.bgSource}' — contrast cannot be evaluated statically because the background is an image or gradient. ${scLabel} requires at least ${minimum}:1; verify manually against the image's actual luminance at the glyph position.`;
}

/**
 * Fix text for an info-severity bg-image-unresolvable finding. Points
 * the agent at the deterministic escape hatch (authoring a fallback
 * `background-color` behind the image, which the scanner can then
 * evaluate) while preserving the manual-verification option.
 */
export function buildBgImageUnresolvableSuggestion(
  finding: BgImageUnresolvableFinding,
  minimum: number,
): string {
  return `Set an explicit \`background-color\` as a fallback behind the image so contrast can be evaluated, or confirm manually that the \`${finding.fgProperty}: ${finding.fgSource}\` has at least ${minimum}:1 contrast against the visual background of the image at every glyph position. If the image has a dark/light overlay that guarantees contrast, keep the current CSS and note the overlay in a comment so future reviewers know why it is safe.`;
}

// ---------------------------------------------------------------------------
// Cross-file Tailwind cross-reference — `couldBeWrongBecause` opt-in.
// ---------------------------------------------------------------------------

/**
 * Token code surfaced on `Violation.couldBeWrongBecause` when a CSS
 * contrast failure targets a class that co-occurs with a qualifying
 * Tailwind utility on a JSX/HTML consumer. Informational signal only —
 * the agent investigates the consumer file and decides. See
 * docs/adr/0009-violation-could-be-wrong-because.md.
 *
 * The same reason code is shared across every contrast rule; the
 * utility *family* that qualifies as an override varies by rule (text
 * vs. background for text contrast, border / outline / ring for the
 * non-text boundary contrast). The axis lives in the rule, not the
 * reason code — agents read the cited file and figure out which
 * declaration the utility overrides.
 */
export const TAILWIND_CLASS_ON_CONSUMER = "tailwind_class_on_consumer";

/**
 * Utility families that override the *text-vs-background* pair a
 * text-contrast rule checks. `text-*` overrides `color`; `bg-*`
 * overrides `background-color` / `background`. Scoped deliberately —
 * border / outline / ring utilities live in a separate set consumed
 * by `contrast/non-text`.
 */
export const TEXT_CONTRAST_OVERRIDE_FAMILIES: ReadonlySet<string> = new Set(["text", "bg"]);

/**
 * Utility families that override the *boundary-vs-surroundings* pair
 * the non-text contrast rule checks:
 *
 *   - `border-*` (including bare `border`, `border-{color}`,
 *     `border-{width}`, `border-{side}-*`, and `border-[<arbitrary>]`)
 *     — directly overrides the `border` / `border-color` declaration
 *     the rule evaluated.
 *   - `outline-*` — directly overrides the `outline` /
 *     `outline-color` declaration.
 *   - `ring-*` — applies a box-shadow-based boundary on the element.
 *     The non-text rule's intent is "the user-visible boundary of the
 *     control has 3:1 contrast." A ring utility places a visible
 *     boundary on the same element; it's a credible override even
 *     when the failing CSS declared `border-color`. Agent investigates
 *     and decides.
 *
 * `divide-*` is intentionally excluded. It applies borders *between
 * children of a container*, not on the element itself — the non-text
 * rule fires on the failing element (the button, the svg, the `.btn`),
 * not on its container, so `divide-*` on the failing element does not
 * override the boundary the rule evaluated. Including it would dilute
 * the signal with consumer elements whose `divide-*` utility affects
 * unrelated children.
 */
export const NON_TEXT_CONTRAST_OVERRIDE_FAMILIES: ReadonlySet<string> = new Set([
  "border",
  "outline",
  "ring",
]);

/**
 * Walks every JSX and HTML className in the project and returns the
 * set of plain class names that co-occur on an element with a
 * qualifying Tailwind utility from `families`. Variant-scoped
 * utilities (e.g. `md:text-*`, `hover:border-*`) do NOT qualify — they
 * are conditional and can't override the declared CSS at all viewport
 * widths / states. Only unqualified utilities do.
 *
 * This is the same cross-file primitive `focus/outline-visible` uses
 * for its focus-visible ring cross-reference — tokenized via
 * `parseTailwind`, no new parser pass. Deterministic class-token link,
 * never heuristic.
 */
export function collectTailwindOverrideClasses(
  ctx: ProjectContext,
  families: ReadonlySet<string> = TEXT_CONTRAST_OVERRIDE_FAMILIES,
): ReadonlySet<string> {
  const usage = new Set<string>();
  for (const file of ctx.files) {
    indexFileForTailwindOverride(file.ast, file.language, families, usage);
  }
  return usage;
}

function indexFileForTailwindOverride(
  ast: unknown,
  language: Language,
  families: ReadonlySet<string>,
  usage: Set<string>,
): void {
  if (language === "tsx" || language === "jsx" || language === "ts" || language === "js") {
    for (const el of walkJsxElements(ast as TsxModule)) {
      indexClassStringForOverride(jsxClassString(el), families, usage);
    }
    return;
  }
  if (language === "html") {
    for (const el of walkHtmlElements(ast as HtmlDocument)) {
      indexClassStringForOverride(htmlClassString(el), families, usage);
    }
  }
}

function indexClassStringForOverride(
  classString: string | null,
  families: ReadonlySet<string>,
  usage: Set<string>,
): void {
  if (!classString) return;
  const tokens = parseTailwind(classString);
  const plainClasses: string[] = [];
  let qualifies = false;
  for (const tok of tokens) {
    if (tok.malformed) continue;
    if (tok.variants.length > 0) {
      // Variant-scoped utilities (e.g. `md:text-*`, `hover:bg-*`) are
      // conditional; they can't override the declared CSS at all
      // viewport widths / states. Only unqualified utilities qualify.
      continue;
    }
    if (tok.utility.length === 0) continue;
    plainClasses.push(tok.utility);
    if (isOverridingUtility(tok.utility, families)) qualifies = true;
  }
  if (!qualifies) return;
  for (const cls of plainClasses) usage.add(cls);
}

function isOverridingUtility(utility: string, families: ReadonlySet<string>): boolean {
  const family = utility.split("-")[0] ?? utility;
  return families.has(family);
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

/**
 * First `.<ident>` token in a selector's subject compound. Mirrors the
 * helper in `focus/outline-visible` — compound selectors like
 * `.card.active` cross-reference on `card`. Returns `null` when the
 * selector is bare-element or otherwise not class-scoped.
 */
export function extractPrimarySelectorClass(selector: string): string | null {
  const parts = selector.split(/\s+/);
  const subject = parts[parts.length - 1] ?? selector;
  const head = subject.split(/:(?!:)/)[0] ?? subject;
  return /\.([A-Za-z_][\w-]*)/.exec(head)?.[1] ?? null;
}

export { detectUserStatePseudo } from "./_user-state-pseudo.ts";
