/**
 * Rule: color/state-class-color-only
 * Satisfies: wcag22:1.4.1, wcag21:1.4.1
 * Spec: https://www.w3.org/TR/WCAG22/#use-of-color
 *
 * > Color is not used as the only visual means of conveying information,
 * > indicating an action, prompting a response, or distinguishing a
 * > visual element.
 *
 * Source: https://www.w3.org/TR/WCAG22/#use-of-color
 *
 * Pairs with `color/meaning-by-color-only`. That rule fires on JSX/HTML
 * inline-style + class-token evidence ("the element carries a status
 * utility class with no second channel"); this rule fires on the CSS
 * authored shape ("a state class — `.active`, `.selected`, `.current`,
 * `.disabled`, `[aria-selected="true"]`, `[aria-current]`,
 * `[aria-pressed="true"]`, `:checked` — declares only color-family
 * properties to distinguish state from base"). The two surfaces feed
 * different evidence and emit independently.
 *
 * Static predicate (provable from the CSS rule's declarations alone):
 *
 *   The rule's selector targets a state class / state attribute / state
 *   pseudo, AND every declaration in the body affects only the
 *   color-family properties (`color`, `background-color`, `border-color`
 *   and its per-side variants, `outline-color`, `text-decoration-color`,
 *   `caret-color`, `accent-color`, plus `background` / `border` /
 *   `outline` / `text-decoration` shorthands whose value is purely a
 *   color literal — no `image`, no `gradient`, no `style`, no
 *   line-thickness change). If any non-color cue is also declared
 *   (`text-decoration: underline`, `font-weight: bold`, `border-style:
 *   solid`, `outline: 2px solid`, `background-image: …`, `content: …`,
 *   `transform: …`, `opacity: …`, `box-shadow: …`, `padding-*`,
 *   `margin-*`, `text-decoration-line: …`, etc.), the rule does NOT
 *   fire — a second channel is present.
 *
 * The predicate is intentionally local: we do NOT compare to a base
 * selector in the same stylesheet. Comparing to a base would be a
 * cascade-resolution heuristic (specificity ordering, source-order
 * shadowing, `@media` overlays, cross-file imports) the static scanner
 * cannot prove. The local predicate — "this state-class rule declares
 * only color cues" — is provable from this rule's declarations alone
 * and lines up with the AI-first doctrine on heuristic emission
 * (`docs/kb/architecture/ai-first-consumer.md`): emit only when the
 * predicate is provable from the code in this file alone.
 *
 * Severity is `warning` (not `error`) because the static predicate
 * cannot rule out a second channel introduced *outside* the CSS rule
 * — an icon swap in JSX, a `data-state` attribute exposed to assistive
 * tech, an `aria-pressed`-driven content change. The agent reading
 * the consumer site is the correct arbiter; this rule's job is to
 * point at the CSS shape that risks color-only differentiation, not
 * to assert the violation. Per the AI-first doctrine on "Reason text
 * and severity must agree", the message frames what is still in
 * question rather than asserting the predicate.
 *
 * State markers the rule recognizes (whole-token / exact match in the
 * raw selector string):
 *
 *   - Class tokens: `.active`, `.selected`, `.current`, `.disabled`,
 *     `.is-active`, `.is-selected`, `.is-current`, `.is-disabled`.
 *   - Attribute selectors: `[aria-selected="true"]`,
 *     `[aria-selected=true]`, `[aria-current]` (any value),
 *     `[aria-current="…"]`, `[aria-pressed="true"]`,
 *     `[aria-pressed=true]`, `[aria-checked="true"]`,
 *     `[aria-checked=true]`, `[aria-expanded="true"]`,
 *     `[aria-expanded=true]`.
 *   - Pseudo-classes: `:checked`. (NOT `:hover` / `:focus` /
 *     `:active` / `:focus-visible` — those are interaction states for
 *     transient feedback, not persistent state-of-thing-changed
 *     channels SC 1.4.1 anchors against.)
 *
 * Out of scope (deliberate):
 *   - Comparison against a base selector. See above.
 *   - `:hover`, `:focus`, `:focus-visible`, `:active` — these surface
 *     transient interactivity feedback handled elsewhere
 *     (`focus/outline-visible`).
 *   - Inline `style="color:…"` on HTML elements — covered by
 *     `color/meaning-by-color-only`.
 *   - Color contrast on the state-class rule itself — covered by
 *     `contrast/minimum`.
 */

import { defineRule } from "../../api/plugin.ts";
import { walkCssRules } from "../../engine/ast-helpers.ts";
import type { CssDeclaration, CssStylesheet } from "../../types/ast.ts";

/**
 * Properties whose presence (with any value) means the rule declares ONLY
 * a color cue — when every declaration sits in this set, the predicate
 * fires. Per-side `border-*-color` are included as exact tokens; the
 * `border-color` longhand and its 4 per-side variants are exhaustively
 * listed rather than regex-matched so that `border-style` / `border-width`
 * etc. (genuine non-color cues) are not silently swallowed.
 */
const COLOR_ONLY_LONGHANDS: ReadonlySet<string> = new Set([
  "color",
  "background-color",
  "border-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-block-color",
  "border-block-start-color",
  "border-block-end-color",
  "border-inline-color",
  "border-inline-start-color",
  "border-inline-end-color",
  "outline-color",
  "text-decoration-color",
  "text-emphasis-color",
  "caret-color",
  "accent-color",
  "column-rule-color",
]);

/**
 * Shorthands whose value is sometimes a pure color and sometimes a
 * line / image / multi-channel bundle. Each entry pairs a property name
 * with a predicate: when the predicate accepts the declaration value,
 * the declaration counts as a color-only cue; otherwise it's a non-color
 * cue (and the rule passes — second channel present).
 */
const COLOR_OR_RICHER_SHORTHANDS: ReadonlyArray<{
  readonly property: string;
  readonly isPureColor: (value: string) => boolean;
}> = [
  { property: "background", isPureColor: backgroundIsPureColor },
  { property: "border", isPureColor: borderIsPureColor },
  { property: "border-top", isPureColor: borderIsPureColor },
  { property: "border-right", isPureColor: borderIsPureColor },
  { property: "border-bottom", isPureColor: borderIsPureColor },
  { property: "border-left", isPureColor: borderIsPureColor },
  { property: "border-block", isPureColor: borderIsPureColor },
  { property: "border-block-start", isPureColor: borderIsPureColor },
  { property: "border-block-end", isPureColor: borderIsPureColor },
  { property: "border-inline", isPureColor: borderIsPureColor },
  { property: "border-inline-start", isPureColor: borderIsPureColor },
  { property: "border-inline-end", isPureColor: borderIsPureColor },
  { property: "outline", isPureColor: borderIsPureColor },
  { property: "text-decoration", isPureColor: textDecorationIsPureColor },
  { property: "column-rule", isPureColor: borderIsPureColor },
];

/**
 * State markers the rule recognizes. Each entry is the raw substring
 * the selector string must contain (case-insensitive after normalization)
 * to count as a state-class selector. The list is intentionally short
 * and exact-token: persistent state markers only, no transient
 * interaction pseudos (`:hover`, `:focus`, `:focus-visible`, `:active`).
 */
const STATE_CLASS_TOKENS: readonly string[] = [
  ".active",
  ".selected",
  ".current",
  ".disabled",
  ".is-active",
  ".is-selected",
  ".is-current",
  ".is-disabled",
];

/** State attribute markers — whole-attribute substring tests. */
const STATE_ATTR_PATTERNS: readonly RegExp[] = [
  /\[aria-selected\s*(=\s*["']?true["']?)?\]/i,
  /\[aria-current(\s*=[^\]]*)?\]/i,
  /\[aria-pressed\s*=\s*["']?true["']?\]/i,
  /\[aria-checked\s*=\s*["']?true["']?\]/i,
  /\[aria-expanded\s*=\s*["']?true["']?\]/i,
];

/** Pseudo-class state markers — whole-token boundary match. */
const STATE_PSEUDO_RE = /:checked\b/i;

export const rule = defineRule({
  id: "color/state-class-color-only",
  satisfies: ["wcag22:1.4.1", "wcag21:1.4.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".css", ".scss", ".less"],
  },
  // Cascade resolution (a sibling rule on the base selector that *does*
  // supply a non-color cue, an `@media` overlay, a cross-file import)
  // is out of scope of this rule's local predicate. The
  // `crossFileCapable: false` flag downgrades the per-rule coverage row
  // honestly per ADR 0026 — "ran but evidence was bounded" rather than
  // a silent `"high"` claim of complete coverage.
  crossFileCapable: false,
  docs: {
    description:
      "State-class CSS rules (.active, .selected, .current, .disabled, [aria-selected=true], [aria-current], [aria-pressed=true], :checked) that declare only color-family properties (color, background-color, border-color, outline-color, text-decoration-color) — with no non-color cue (text-decoration line, font-weight, border-style, outline thickness, background-image, content, transform) — risk relying on color alone to communicate the state. Surface the CSS shape so the agent can verify a second channel is present in the consumer site.",
    rationale:
      "WCAG 1.4.1 requires that state distinctions (selected vs. unselected, active vs. inactive, current vs. other) reach users who cannot perceive color — colorblind users, users under color-inverted themes, screen-reader users hearing the announcement. When a state class shifts only color (`.tab.active { color: blue; background-color: white; }` against a base `.tab { color: gray; background-color: lightgray; }`), the rendered state difference is visible to sighted full-color users only. The fix is cheap and well-known: add a non-color cue — `font-weight: bold`, `text-decoration: underline`, `border-style: solid`, an icon, or expose the state via `aria-current` / `aria-selected` / `aria-pressed` so assistive tech announces it. The static rule cannot prove the consumer site lacks a second channel (an aria attribute exposed in JSX, an icon swap), so severity is `warning` and the message frames the question rather than asserts the violation.",
    goodExample:
      ".tab.active { color: #1a56db; background-color: #fff; font-weight: 600; border-bottom: 2px solid #1a56db; }",
    badExample: ".tab.active { color: #1a56db; background-color: #fff; }",
    normativeQuote:
      "Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.",
    references: [
      "https://www.w3.org/TR/WCAG22/#use-of-color",
      "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G182",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G183",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    const stylesheet = ctx.ast as CssStylesheet;
    for (const cssRule of walkCssRules(stylesheet)) {
      const stateMarker = detectStateMarker(cssRule.selector);
      if (stateMarker === null) continue;
      if (cssRule.declarations.length === 0) continue;
      if (!declarationsAreColorOnly(cssRule.declarations)) continue;
      const colorProps = listColorProps(cssRule.declarations);
      ctx.emit({
        severity: "warning",
        location: {
          filePath: ctx.filePath,
          line: cssRule.loc.start.line,
          column: cssRule.loc.start.column,
        },
        message: buildMessage(cssRule.selector, stateMarker, colorProps),
        suggestion: buildSuggestion(cssRule.selector, stateMarker, colorProps),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Selector detection
// ---------------------------------------------------------------------------

interface StateMarker {
  /** Human-readable label of the matched state token, e.g. `.active`. */
  readonly label: string;
  /** Whether the marker is a class, attribute, or pseudo-class. */
  readonly kind: "class" | "attribute" | "pseudo";
}

/**
 * Returns the first state marker found in the selector string, or null
 * when the selector targets none of the recognized state markers.
 *
 * Selector matching is intentionally simple: whole-token substring
 * comparison on the raw selector text. Compound selectors (`.tab.active`,
 * `.list-item.is-selected[aria-current]`) match the first marker
 * encountered. We do NOT parse the selector into a structured tree —
 * the false-positive cost of a substring match (the marker appearing
 * inside an attribute value or a pseudo-element argument) is low at
 * this granularity, and a parser would be the kind of capability the
 * agent could reproduce with Read + Grep ("Don't duplicate capability
 * the agent already has"). Per the AI-first doctrine: the tool's job
 * is to point.
 */
function detectStateMarker(selector: string): StateMarker | null {
  const normalized = selector.trim();
  for (const token of STATE_CLASS_TOKENS) {
    if (containsWholeClassToken(normalized, token)) {
      return { label: token, kind: "class" };
    }
  }
  for (const pattern of STATE_ATTR_PATTERNS) {
    const match = pattern.exec(normalized);
    if (match) return { label: match[0], kind: "attribute" };
  }
  if (STATE_PSEUDO_RE.test(normalized)) {
    return { label: ":checked", kind: "pseudo" };
  }
  return null;
}

/**
 * True when `selector` contains `classToken` (e.g. `.active`) as a
 * standalone class selector — not as a substring of a longer class
 * (`.activeMenu`, `.is-active-row`). The class boundary is any
 * non-`[A-Za-z0-9_-]` character after the token, or end-of-string.
 */
function containsWholeClassToken(selector: string, classToken: string): boolean {
  let from = 0;
  while (true) {
    const idx = selector.indexOf(classToken, from);
    if (idx === -1) return false;
    const after = selector.charAt(idx + classToken.length);
    if (after === "" || !/[A-Za-z0-9_-]/.test(after)) return true;
    from = idx + 1;
  }
}

// ---------------------------------------------------------------------------
// Declaration analysis
// ---------------------------------------------------------------------------

/**
 * True when every declaration in the rule body is either:
 *   - a color-only longhand (`color`, `background-color`, `border-color`, …)
 *   - a shorthand whose value is a pure color literal (no `image`,
 *     `gradient`, `solid`, line thickness, etc.)
 *   - a custom property reference where the property is one of the
 *     color-family longhands (e.g. `color: var(--accent)`)
 *
 * Any other declaration is treated as a non-color cue and the rule
 * does NOT fire (second channel present).
 */
function declarationsAreColorOnly(declarations: readonly CssDeclaration[]): boolean {
  for (const decl of declarations) {
    if (!declarationIsColorOnly(decl)) return false;
  }
  return true;
}

function declarationIsColorOnly(decl: CssDeclaration): boolean {
  const property = decl.property.toLowerCase();
  if (COLOR_ONLY_LONGHANDS.has(property)) return true;
  for (const shorthand of COLOR_OR_RICHER_SHORTHANDS) {
    if (property === shorthand.property) {
      return shorthand.isPureColor(decl.value.trim());
    }
  }
  return false;
}

/**
 * Returns the color-family properties this rule declared, ordered by
 * appearance. Used to build a context-aware fix suggestion that names
 * the actual properties involved.
 */
function listColorProps(declarations: readonly CssDeclaration[]): readonly string[] {
  const out: string[] = [];
  for (const decl of declarations) {
    out.push(decl.property.toLowerCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shorthand-value predicates
// ---------------------------------------------------------------------------

/**
 * Pure-color test for the `background` shorthand. Returns true when the
 * value is just a color (named, hex, rgb/rgba, hsl/hsla, oklch, lch,
 * `currentColor`, `transparent`, `inherit`, `var(--foo)`, etc.) — no
 * `url(…)`, no gradient function, no positional bundle.
 */
function backgroundIsPureColor(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes("url(")) return false;
  if (lower.includes("gradient(")) return false;
  if (lower.includes("image(")) return false;
  if (lower.includes("image-set(")) return false;
  // Multi-positional shorthands (`background: white center / cover`)
  // include slashes or position keywords. The presence of any of these
  // means the shorthand is doing more than just paint.
  if (lower.includes("/")) return false;
  if (
    /\b(top|right|bottom|left|center|fixed|local|scroll|repeat|no-repeat|cover|contain)\b/i.test(
      value,
    )
  )
    return false;
  return looksLikePureColor(value);
}

/**
 * Pure-color test for `border` / `outline` / `column-rule` shorthand —
 * shorthand value `<line-width> || <line-style> || <color>`. Returns
 * true when the value carries ONLY a color (no width, no style); any
 * line-style keyword (`solid`, `dashed`, `dotted`, …) or width token
 * (`thin`, `medium`, `thick`, `1px`, etc.) means a non-color cue is
 * present.
 */
function borderIsPureColor(value: string): boolean {
  if (looksLikeLineStyle(value)) return false;
  if (looksLikeLineWidth(value)) return false;
  return looksLikePureColor(value);
}

/**
 * Pure-color test for `text-decoration` shorthand (`<line> || <style>
 * || <color>`). Returns true when the value carries ONLY a color (no
 * line, no style). The `text-decoration: underline` case — line
 * present — is the canonical second channel for this rule and must
 * NOT count as color-only.
 */
function textDecorationIsPureColor(value: string): boolean {
  if (/\b(underline|overline|line-through|blink|wavy|dashed|dotted|double|solid)\b/i.test(value))
    return false;
  return looksLikePureColor(value);
}

const LINE_STYLE_RE =
  /\b(solid|dashed|dotted|double|groove|ridge|inset|outset|wavy|none|hidden)\b/i;
const LINE_WIDTH_RE = /\b(thin|medium|thick)\b|\d/;

function looksLikeLineStyle(value: string): boolean {
  return LINE_STYLE_RE.test(value);
}

function looksLikeLineWidth(value: string): boolean {
  return LINE_WIDTH_RE.test(value);
}

/**
 * Permissive "this looks like a color value" test. Used for shorthand
 * predicates after we've ruled out lines / images / positional bundles.
 * Accepts named colors, hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`,
 * `oklch()`, `lch()`, `lab()`, `color()`, `currentColor`,
 * `transparent`, `inherit`, `initial`, `unset`, `revert`, and
 * `var(--foo)`. We don't validate the color value; if the string isn't
 * a line, image, or positional bundle and reaches here, it's a color.
 */
function looksLikePureColor(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Message + suggestion
// ---------------------------------------------------------------------------

function buildMessage(
  selector: string,
  marker: StateMarker,
  colorProps: readonly string[],
): string {
  const props = colorProps.join(", ");
  return `\`${selector}\` distinguishes its ${marker.kind === "pseudo" ? "checked" : marker.label} state from the base by changing only color-family properties (${props}). Users who can't perceive color — colorblind users, screen-reader users, users under color-inverted themes — receive no signal that the element is in a different state. Verify the consumer site supplies a second channel (a non-color CSS cue here, an icon, an \`aria-*\` state attribute exposed to assistive tech, or distinguishing prose).`;
}

function buildSuggestion(
  selector: string,
  marker: StateMarker,
  colorProps: readonly string[],
): string {
  const props = colorProps.join(", ");
  const channelHints =
    marker.kind === "attribute"
      ? `(1) add a CSS non-color cue on this rule — \`font-weight: 600\`, \`text-decoration: underline\`, \`border-bottom: 2px solid …\`, or an \`::after\` content marker; (2) the attribute selector itself (${marker.label}) already announces state via assistive tech — verify the consumer markup carries that attribute and the screen reader exposes it (some host platforms strip unsupported \`aria-*\` values)`
      : marker.kind === "pseudo"
        ? `(1) add a CSS non-color cue — \`font-weight: 600\`, \`text-decoration: underline\`, an icon via \`::before\` content; (2) ensure the underlying \`<input>\` / \`<option>\` element carries the \`aria-checked\` or native \`checked\` state that assistive tech can announce`
        : `(1) add a CSS non-color cue on this rule — \`font-weight: 600\`, \`text-decoration: underline\`, \`border-bottom: 2px solid …\`, an icon via \`::before\` content; (2) expose the state via \`aria-current\` / \`aria-selected\` / \`aria-pressed\` on the consumer markup so assistive tech announces it; (3) include a status word in the rendered prose (e.g. " (active)") via a \`.visually-hidden\` span`;
  return `\`${selector}\` declares only color (${props}). Add a non-color signal so the state reaches users who can't perceive color. Any of: ${channelHints}. Pick the channel that matches how the state reaches the page.`;
}
