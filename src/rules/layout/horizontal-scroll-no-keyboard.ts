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

  emit({
    severity: "warning",
    location: {
      filePath: "",
      line: offending.decl.loc.start.line,
      column: offending.decl.loc.start.column,
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
