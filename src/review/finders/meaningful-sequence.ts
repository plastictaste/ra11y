/**
 * Candidate finder: review/meaningful-sequence
 * Criteria: wcag22:1.3.2, wcag21:1.3.2
 * Spec: https://www.w3.org/TR/WCAG22/#meaningful-sequence
 *
 * Surfaces visual/DOM-order divergence for reviewer inspection. Two
 * surfaces are equally legitimate signals:
 *
 *   1. HTML/JSX *consumers* that apply utility classes for visual
 *      reordering — `class="order-2"`, `className="flex-row-reverse"`,
 *      Tailwind responsive prefixes like `md:order-1`, etc. The class
 *      consumer is the actual reorder site; whether the visual order
 *      still matches meaning depends on the surrounding markup the
 *      agent reads.
 *
 *   2. Authored CSS rules that set `order` or `flex-direction:
 *      *-reverse` on a styled component selector (`.product-grid`,
 *      `[data-layout="reverse"]`). These are component-level reorders
 *      the consumer applies via the parent class.
 *
 * Utility-class definition sites — single-class CSS rules like
 * `.order-3 { order: 3; }` shipped by Bootstrap/Tailwind/utility CSS
 * frameworks — are NOT a useful signal. They are definitions of a
 * utility, not consumers of it. Field reports against bulk-template
 * scans surfaced ~560 such candidates (14 `.order-*` selectors × ~40
 * templates), all pointing at vendor `bootstrap.css` rather than at
 * any consumer markup. Silenced via a deterministic selector-shape
 * check below; the consumer path picks up the actual reorder sites.
 *
 * Per AI-first doctrine (docs/kb/architecture/ai-first-consumer.md):
 * the tool's job is to point at real consumer reorder sites; the agent
 * decides whether the reorder is meaningful. The reason text names the
 * specific class token + the likely visual effect.
 */

import { defineCandidateFinder } from "../../api/plugin.ts";
import {
  findCssDeclaration,
  getHtmlAttribute,
  getJsxAttributeString,
  walkCssRules,
  walkHtmlElements,
  walkJsxElements,
} from "../../engine/ast-helpers.ts";
import type { CssStylesheet, HtmlDocument, TsxModule } from "../../types/ast.ts";
import type { ReviewCandidate } from "../../types/review.ts";

const CRITERION_IDS = ["wcag22:1.3.2", "wcag21:1.3.2"] as const;

const REVERSE_VALUES = new Set(["row-reverse", "column-reverse"]);

/**
 * Utility-class tokens for visual reordering. Two families:
 *
 *   - `order-<token>` — Tailwind/Bootstrap ordering. Numeric (Bootstrap
 *     `.order-0..12`, Tailwind `.order-1..12`) and named (Tailwind
 *     `.order-first`, `.order-last`, `.order-none`).
 *   - `flex-(row|col|column)-reverse` — flex-direction utilities
 *     (Tailwind `.flex-row-reverse` / `.flex-col-reverse`; Bootstrap
 *     `.flex-row-reverse` / `.flex-column-reverse`).
 *
 * Stripped of any responsive / state prefix (`md:`, `lg:`, `hover:`)
 * before matching so `md:order-1` and `sm:flex-row-reverse` count.
 */
const ORDER_NUMERIC_RE = /^order-(?:-?\d+)$/;
const ORDER_NAMED_RE = /^order-(?:first|last|none)$/;
const FLEX_REVERSE_RE = /^flex-(?:row|col|column)-reverse$/;
const GRID_FLOW_DENSE_RE = /^grid-flow-(?:row|col|column)-dense$/;

/**
 * Selector shape for a utility-class *definition* — a single class
 * selector with no combinators, no descendant selector, no pseudo-class
 * chain, whose class name matches one of the utility-token regexes.
 * `.order-3 { order: 3 }` matches; `.product-grid .order-row { ... }`
 * does not (the second is a real authored selector that happens to
 * mention `order`). The intent is to silence vendor utility-CSS
 * libraries while leaving authored CSS reorders fully surfaced.
 */
const UTILITY_DEFN_SELECTOR_RE =
  /^\s*\.(order-(?:-?\d+|first|last|none)|flex-(?:row|col|column)-reverse|grid-flow-(?:row|col|column)-dense)\s*$/;

interface ClassMatch {
  /** The matched utility token, e.g. `order-2`, `flex-row-reverse`. */
  readonly token: string;
  /** Family for reason-text shaping. */
  readonly family: "order" | "flex-reverse" | "grid-flow-dense";
}

/**
 * Inspects a class-attribute value (from `class=` / `className=`) for
 * any utility-class token from the families above. Returns the FIRST
 * match — one candidate per element is enough; the agent reads the
 * surrounding markup to enumerate the rest. Responsive / state
 * prefixes (`sm:`, `md:`, `hover:`, `dark:`) are stripped before token
 * matching so Tailwind's prefixed utilities count.
 */
function matchUtilityClass(classValue: string): ClassMatch | null {
  for (const raw of classValue.split(/\s+/)) {
    if (!raw) continue;
    // Strip Tailwind-style prefix chain: `md:hover:order-2` → `order-2`.
    // Take the segment after the last `:`.
    const lastColon = raw.lastIndexOf(":");
    const token = lastColon >= 0 ? raw.slice(lastColon + 1) : raw;
    if (ORDER_NUMERIC_RE.test(token) || ORDER_NAMED_RE.test(token)) {
      return { token, family: "order" };
    }
    if (FLEX_REVERSE_RE.test(token)) {
      return { token, family: "flex-reverse" };
    }
    if (GRID_FLOW_DENSE_RE.test(token)) {
      return { token, family: "grid-flow-dense" };
    }
  }
  return null;
}

function reasonForClassMatch(tagName: string, match: ClassMatch): string {
  const tag = tagName.toLowerCase();
  switch (match.family) {
    case "order":
      return `<${tag} class="...${match.token}..."> applies a flex/grid \`order\` utility — visual position diverges from DOM order. Verify the surrounding flex/grid container's reading sequence still matches meaning, or that DOM order is the meaningful sequence and only visual position is reordered.`;
    case "flex-reverse":
      return `<${tag} class="...${match.token}..."> applies a flex-direction reverse utility — children render in reverse visual order. Verify the DOM child order is the meaningful sequence (reversed visually only) or restructure so the visual order reads correctly.`;
    case "grid-flow-dense":
      return `<${tag} class="...${match.token}..."> applies grid auto-flow dense packing — items may be visually placed out of DOM order to fill gaps. Verify the visual order still matches the meaningful reading sequence.`;
  }
}

function reasonForCssOrder(): string {
  return "CSS `order` property reorders visual layout -- verify reading sequence matches DOM order. (utility-class definition sites like `.order-3 { order: 3 }` are silenced; this rule sets `order` on a non-utility selector.)";
}

function reasonForCssFlexReverse(): string {
  return "CSS `flex-direction` reverses visual layout -- verify reading sequence matches DOM order.";
}

export const finder = defineCandidateFinder({
  id: "review/meaningful-sequence",
  criterionIds: [...CRITERION_IDS],
  scope: "node",
  appliesTo: { fileExtensions: [".html", ".htm", ".tsx", ".jsx", ".css"] },
  docs: {
    description:
      "Finds HTML/JSX consumers applying flex/grid order utilities (`order-N`, `flex-row-reverse`, `grid-flow-*-dense`) and authored CSS rules that set `order` / `flex-direction: *-reverse` on non-utility selectors. Utility-class definition sites (`.order-3 { order: 3 }`) are silenced — the consumer is the meaningful reorder site.",
    reviewPrompt:
      "Verify that the visual order created by the utility class or CSS rule still matches the meaningful reading sequence in the DOM.",
    references: ["https://www.w3.org/TR/WCAG22/#meaningful-sequence"],
  },
  find(ctx) {
    const candidates: ReviewCandidate[] = [];

    if (ctx.language === "html") {
      scanHtml(ctx.ast as HtmlDocument, ctx.filePath, candidates);
    } else if (ctx.language === "tsx" || ctx.language === "jsx") {
      scanJsx(ctx.ast as TsxModule, ctx.filePath, candidates);
    } else if (ctx.language === "css") {
      scanCss(ctx.ast as CssStylesheet, ctx.filePath, candidates);
    }

    return candidates;
  },
});

function scanHtml(root: HtmlDocument, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkHtmlElements(root)) {
    const classValue = getHtmlAttribute(el, "class");
    if (classValue === null) continue;
    const match = matchUtilityClass(classValue);
    if (!match) continue;
    pushCandidates(
      candidates,
      filePath,
      el.loc.start.line,
      el.loc.start.column,
      reasonForClassMatch(el.tagName, match),
    );
  }
}

function scanJsx(root: TsxModule, filePath: string, candidates: ReviewCandidate[]): void {
  for (const el of walkJsxElements(root)) {
    const classValue = getJsxAttributeString(el, "className") ?? getJsxAttributeString(el, "class");
    if (classValue === null) continue;
    const match = matchUtilityClass(classValue);
    if (!match) continue;
    pushCandidates(
      candidates,
      filePath,
      el.loc.start.line,
      el.loc.start.column,
      reasonForClassMatch(el.tagName, match),
    );
  }
}

function scanCss(root: CssStylesheet, filePath: string, candidates: ReviewCandidate[]): void {
  for (const rule of walkCssRules(root)) {
    // Silence utility-class definitions: `.order-3 { order: 3 }`,
    // `.flex-row-reverse { flex-direction: row-reverse }`. These are
    // shipped by utility CSS frameworks (Bootstrap, Tailwind, custom
    // utility layers) and emit one candidate per definition × every
    // template that bundles the same vendor stylesheet — pure noise
    // that points at no consumer. Authored selectors like
    // `.product-grid { flex-direction: row-reverse }` keep firing
    // because `.product-grid` does not match the utility-token shape.
    if (UTILITY_DEFN_SELECTOR_RE.test(rule.selector)) continue;

    const orderDecl = findCssDeclaration(rule, "order");
    if (orderDecl) {
      pushCandidates(
        candidates,
        filePath,
        orderDecl.loc.start.line,
        orderDecl.loc.start.column,
        reasonForCssOrder(),
      );
    }

    const flexDecl = findCssDeclaration(rule, "flex-direction");
    if (flexDecl && REVERSE_VALUES.has(flexDecl.value.trim().toLowerCase())) {
      pushCandidates(
        candidates,
        filePath,
        flexDecl.loc.start.line,
        flexDecl.loc.start.column,
        reasonForCssFlexReverse(),
      );
    }
  }
}

function pushCandidates(
  candidates: ReviewCandidate[],
  filePath: string,
  line: number,
  column: number,
  reason: string,
): void {
  for (const criterionId of CRITERION_IDS) {
    // Confidence "high": the matched tokens (utility-class names,
    // `order` declarations, `flex-direction: *-reverse`) are
    // deterministic. The reviewer question — whether the reorder
    // matches meaning — is what the agent answers from surrounding
    // markup; the finder's job is to point at the site.
    candidates.push({
      criterionId,
      location: { filePath, line, column },
      reason,
      confidence: "high",
    });
  }
}
