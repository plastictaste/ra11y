/**
 * Rule: layout/horizontal-scroll-no-keyboard
 * Satisfies: wcag22:2.1.1, wcag21:2.1.1
 * Spec: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * > All functionality of the content is operable through a keyboard
 * > interface without requiring specific timings for individual
 * > keystrokes, except where the underlying function requires input
 * > that depends on the path of the user's movement and not just the
 * > endpoints.
 *
 * Source: https://www.w3.org/TR/WCAG22/#keyboard
 *
 * Flags CSS rules that declare `overflow-x: auto|scroll` (or shorthand
 * `overflow: auto|scroll`) on a selector. Elements matching those
 * selectors that wrap wide content (a `<table>`, a long row of cards,
 * a code block, a chart) become independently scrollable regions in
 * the rendered DOM. Without `tabindex="0"` plus an accessible name
 * (typically `aria-label`/`aria-labelledby`), keyboard-only users
 * cannot place focus on the region and cannot scroll horizontally to
 * reveal off-axis content — the region's content is unreachable from
 * the keyboard, failing SC 2.1.1.
 *
 * This rule is necessarily a candidate-style emission. Static CSS
 * analysis can see the declaration but cannot see which DOM elements
 * eventually match the selector at render time, nor whether the agent
 * has already added `tabindex="0"` + `aria-label` on those elements.
 * The rule surfaces the CSS declaration as a review candidate so the
 * agent can read the rendered consumer (HTML/JSX) and verify the
 * wrapper carries the keyboard affordance. Severity is `warning` to
 * match the predicate strength.
 *
 * Detection rules:
 *   - `overflow-x: auto|scroll` on any rule fires.
 *   - `overflow: auto|scroll` (shorthand applies to both axes) on any
 *     rule fires.
 *   - `overflow: hidden|visible|clip|<longhand-only>` does not fire.
 *   - One emission per CSS rule, even when both `overflow-x` and the
 *     shorthand are declared in the same rule body.
 *   - List/comma-separated selectors and `:is(.a, .b)` count once per
 *     enclosing CSS rule (the rule has one declaration; the matched
 *     elements get the candidate annotation collectively).
 *   - Selectors whose every comma-separated branch targets an
 *     intrinsically focusable element (`textarea`, `input`, `select`,
 *     `button`, `iframe`, `a[href]`, `audio[controls]`,
 *     `video[controls]`) or carries an explicit `[tabindex]` attribute
 *     selector do NOT fire — those elements already enter the tab order
 *     by default and the keyboard hook the rule recommends would be
 *     redundant. Per AI-first doctrine "Heuristic emission is the
 *     symmetric twin of heuristic suppression": emitting on the textbook
 *     reset CSS pattern `textarea { overflow: auto }` would direct the
 *     agent to add `tabindex` / `aria-label` to a `<textarea>` that
 *     already accepts focus, which is a false positive on every CSS
 *     reset stylesheet.
 */

import { defineRule } from "../../api/plugin.ts";
import { walkCssRules } from "../../engine/ast-helpers.ts";
import type { CssDeclaration, CssRule, CssStylesheet } from "../../types/ast.ts";

/** CSS values for `overflow*` that produce a scrollable region. */
const SCROLLABLE_VALUES: ReadonlySet<string> = new Set(["auto", "scroll"]);

export const rule = defineRule({
  id: "layout/horizontal-scroll-no-keyboard",
  satisfies: ["wcag22:2.1.1", "wcag21:2.1.1"],
  severity: "warning",
  scope: "document",
  fixClass: "verify-in-source",
  appliesTo: {
    fileExtensions: [".css"],
  },
  docs: {
    description:
      'CSS rules that create a horizontally scrollable region (overflow-x: auto/scroll, or the overflow shorthand with auto/scroll) need elements matching that selector to also carry tabindex="0" and an accessible name so keyboard-only users can focus and scroll the region.',
    rationale:
      'When CSS makes an element scrollable but the element is not focusable, keyboard-only users cannot reach the content beyond the visible viewport. Pointer users can drag or wheel-scroll; keyboard users have no equivalent affordance unless the wrapper itself is in the tab order. WCAG 2.1.1 Keyboard requires that all functionality — including reading the off-axis content of a scrollable region — be reachable from the keyboard. The fix on the rendered element is `tabindex="0"` plus `aria-label` (or `aria-labelledby`) so the focused region announces what it contains.',
    goodExample: `.table-wrapper {
  overflow-x: auto;
}
/* In the rendered DOM, the wrapper element carries the keyboard hooks: */
/* <div class="table-wrapper" tabindex="0" aria-label="Quarterly results"> */
/*   <table>...</table>                                                   */
/* </div>                                                                 */`,
    badExample: `.table-wrapper {
  overflow-x: auto;
}
/* Rendered as <div class="table-wrapper"><table>...</table></div> with no */
/* tabindex or aria-label — keyboard users cannot scroll the table.        */`,
    normativeQuote:
      "All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes, except where the underlying function requires input that depends on the path of the user's movement and not just the endpoints.",
    references: [
      "https://www.w3.org/TR/WCAG22/#keyboard",
      "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html",
      "https://adrianroselli.com/2020/11/under-engineered-responsive-tables.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language !== "css") return;
    const stylesheet = ctx.ast as CssStylesheet;
    for (const cssRule of walkCssRules(stylesheet)) {
      checkRule(cssRule, (v) => ctx.emit(v));
    }
  },
});

type Emit = (v: {
  severity: "warning";
  location: { filePath: string; line: number; column: number };
  message: string;
  suggestion: string;
}) => void;

interface ScrollableDeclaration {
  readonly decl: CssDeclaration;
  readonly axis: "x" | "both";
  readonly value: string;
}

function checkRule(cssRule: CssRule, emit: Emit): void {
  const offending = findScrollableDeclaration(cssRule.declarations);
  if (!offending) return;
  const targeted = firstNonFocusableBranchPosition(cssRule);
  // `firstNonFocusableBranchPosition` returns null only when every
  // comma-separated branch is intrinsically focusable — the same predicate
  // the rule's docstring suppresses on (textbook reset CSS).
  if (!targeted) return;

  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: targeted.line,
      column: targeted.column,
    },
    message: buildMessage(cssRule.selector, offending),
    suggestion: buildSuggestion(cssRule.selector, offending),
  });
}

/**
 * Returns the first declaration in this rule that creates a horizontal
 * scrollable region — either `overflow-x: auto|scroll` or the
 * shorthand `overflow: auto|scroll` (which applies to both axes).
 *
 * The `overflow` shorthand also accepts a two-value form (`overflow:
 * hidden auto`) where the first token sets `overflow-x` and the second
 * sets `overflow-y`. We check the first token there as well so
 * `overflow: scroll hidden` on a wrapper still fires.
 */
function findScrollableDeclaration(
  declarations: readonly CssDeclaration[],
): ScrollableDeclaration | null {
  for (const decl of declarations) {
    const prop = decl.property.toLowerCase();
    if (prop === "overflow-x") {
      const value = primaryToken(decl.value);
      if (SCROLLABLE_VALUES.has(value)) {
        return { decl, axis: "x", value };
      }
      continue;
    }
    if (prop === "overflow") {
      const value = primaryToken(decl.value);
      if (SCROLLABLE_VALUES.has(value)) {
        return { decl, axis: "both", value };
      }
    }
  }
  return null;
}

/** Returns the first whitespace-delimited token of a CSS value, lowercased. */
function primaryToken(value: string): string {
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  return head.toLowerCase();
}

function buildMessage(selector: string, offending: ScrollableDeclaration): string {
  const propLabel = offending.axis === "x" ? "overflow-x" : "overflow";
  return `'${selector} { ${propLabel}: ${offending.value} }' creates a horizontally scrollable region — keyboard-only users cannot scroll it unless the matched element also has \`tabindex="0"\` plus an accessible name (\`aria-label\` or \`aria-labelledby\`).`;
}

function buildSuggestion(selector: string, offending: ScrollableDeclaration): string {
  const propLabel = offending.axis === "x" ? "overflow-x" : "overflow";
  return `Add \`tabindex="0"\` and \`aria-label="<region description>"\` (or \`aria-labelledby\`) to every element that matches '${selector}' in the rendered HTML/JSX, so the scrollable region enters the tab order and announces what it contains. Example: \`<div class="${stripLeadingDot(selector)}" tabindex="0" aria-label="Quarterly results table">\`. The CSS \`${propLabel}: ${offending.value}\` declaration is fine — the fix is on the consuming element, not on the stylesheet.`;
}

/**
 * Best-effort selector → class-attribute hint for the suggestion's
 * inline example. Keeps the worked example readable for typical
 * `.foo` selectors; falls back to the raw selector for compound or
 * pseudo-class shapes the agent will rewrite anyway.
 */
function stripLeadingDot(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.startsWith(".") && /^\.[\w-]+$/.test(trimmed)) {
    return trimmed.slice(1);
  }
  return trimmed;
}

/**
 * Element type names that are intrinsically focusable in HTML — they
 * enter the tab order by default and do not need `tabindex="0"` to be
 * keyboard-reachable. The rule's recommended fix (`tabindex="0"` plus
 * `aria-label`) would be redundant on these and direct the agent to a
 * non-fix on a textbook reset CSS pattern like `textarea { overflow:
 * auto }`.
 */
const ALWAYS_FOCUSABLE_TYPES: ReadonlySet<string> = new Set([
  "textarea",
  "input",
  "select",
  "button",
  "iframe",
]);

/**
 * Element types that are focusable when paired with a specific
 * attribute — `<a>` only enters the tab order with `href`, and
 * `<audio>` / `<video>` only with `controls`. The map names the
 * required attribute name.
 */
const CONDITIONAL_FOCUSABLE_TYPES: ReadonlyMap<string, string> = new Map([
  ["a", "href"],
  ["area", "href"],
  ["audio", "controls"],
  ["video", "controls"],
]);

/**
 * Walks the comma-separated branches of `cssRule.selector` and returns
 * the source position of the FIRST branch that is non-focusable — the
 * branch the rule's reason text frames as the candidate to verify.
 *
 * Returns `null` when every comma-separated branch is intrinsically
 * focusable (textbook reset CSS pattern); the caller then suppresses
 * the emission, matching the docstring's focusable-only carve-out.
 *
 * The position math: `cssRule.loc.start` is the position of the FIRST
 * non-whitespace character of the selector text in the source (the
 * parser calls `#skipWhitespace()` before `#consumeQualifiedRule`).
 * The stored `cssRule.selector` is `.trim()`'d but `.trim()` only
 * removes leading/trailing whitespace — internal newlines and column
 * offsets stay intact. Walking the trimmed selector string while
 * counting newlines therefore produces a (line, column) for any byte
 * offset within the selector, anchored at `cssRule.loc.start`.
 *
 * Per the AI-first doctrine "Reason / priority / fix-description must
 * agree" extension to "the cited line must point at the predicate the
 * reason names": when the rule reports `'<selector> { overflow: auto }'`
 * with the matched non-focusable branch as the candidate, the cited
 * (line, column) must land on that branch in the source — not on a
 * sibling selector and not on the declaration line.
 */
function firstNonFocusableBranchPosition(
  cssRule: CssRule,
): { line: number; column: number } | null {
  const branches = splitTopLevelWithOffsets(cssRule.selector, ",");
  if (branches.length === 0) return null;
  for (const branch of branches) {
    if (!branchIsFocusable(branch.text)) {
      return offsetToPosition(
        cssRule.selector,
        branch.offset,
        cssRule.loc.start.line,
        cssRule.loc.start.column,
      );
    }
  }
  return null;
}

/**
 * Splits `input` on `delimiter`, but only at top-level (depth 0 with
 * respect to `()` and `[]`). Returns each non-empty segment paired with
 * its 0-based byte offset within `input` (the offset of the segment's
 * first non-whitespace character — leading whitespace inside the
 * segment is skipped so the offset lands on the selector token, not on
 * the post-comma newline).
 */
function splitTopLevelWithOffsets(
  input: string,
  delimiter: string,
): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let segmentStart = 0;
  for (let i = 0; i <= input.length; i++) {
    const ch = i < input.length ? input[i] : delimiter;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      const raw = input.slice(segmentStart, i);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      if (text.length > 0) out.push({ text, offset: segmentStart + leading });
      segmentStart = i + 1;
    }
  }
  return out;
}

/**
 * Converts a 0-based byte offset within `text` to a 1-based (line,
 * column) position in the source, anchored at (`originLine`,
 * `originColumn`) — the source position of `text[0]`.
 */
function offsetToPosition(
  text: string,
  offset: number,
  originLine: number,
  originColumn: number,
): { line: number; column: number } {
  let line = originLine;
  let column = originColumn;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * Returns the rightmost compound selector of `branch` — the subject of
 * the selector, the element the rule applies to. Splits on top-level
 * descendant / child / sibling combinators and returns the last
 * non-empty segment.
 */
function rightmostCompound(branch: string): string {
  // Combinators: whitespace (descendant), `>`, `+`, `~`. Replace top-
  // level combinator chars with spaces, then take the last whitespace-
  // delimited token.
  let depth = 0;
  let normalized = "";
  for (const ch of branch) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~")) {
      normalized += " ";
      continue;
    }
    normalized += ch;
  }
  const tokens = normalized
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return tokens[tokens.length - 1] ?? branch.trim();
}

/**
 * True when the rightmost compound of `branch` is a focusable subject.
 * See {@link firstNonFocusableBranchPosition} for the predicate shape
 * — the rule emits when at least one branch returns false here.
 */
function branchIsFocusable(branch: string): boolean {
  const subject = rightmostCompound(branch);
  if (subject.length === 0) return false;

  // `:is(...)` / `:where(...)` can re-introduce a non-focusable subject
  // through one of their inner branches (e.g. `:is(textarea, .div)`).
  // Without recursing into the parens, we cannot prove every inner
  // branch is focusable — so we conservatively return false and let the
  // rule emit. The static-suppression cost is one extra candidate on
  // an unusual selector shape; the silent-miss cost would be hiding a
  // real `.div` finding behind an `:is()` wrapper.
  if (/:is\(|:where\(/i.test(subject)) return false;

  // Explicit [tabindex] anywhere in the compound makes the subject
  // focusable regardless of the type selector. This covers
  // `[tabindex="0"]`, `[tabindex="-1"]` (programmatically focusable),
  // and bare `[tabindex]` shorthand.
  if (/\[tabindex(?:[~|^$*]?=|])/i.test(subject)) return true;

  // Extract the leading type-selector token (alphabetic chars at the
  // start of the compound). Compounds without a leading type are
  // non-focusable by default — `.foo`, `#bar`, `[data-x]`, `*` —
  // because the selector matches arbitrary HTML elements.
  const typeMatch = subject.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (!typeMatch) return false;
  const type = typeMatch[0].toLowerCase();

  if (ALWAYS_FOCUSABLE_TYPES.has(type)) return true;

  const requiredAttr = CONDITIONAL_FOCUSABLE_TYPES.get(type);
  if (requiredAttr) {
    // Look for `[href]`, `[href="…"]`, `[href^="…"]`, etc., scoped to
    // the rightmost compound (we already extracted that).
    const attrPattern = new RegExp(`\\[${requiredAttr}(?:[~|^$*]?=|])`, "i");
    return attrPattern.test(subject);
  }

  return false;
}
