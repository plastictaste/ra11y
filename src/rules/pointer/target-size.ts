/**
 * Rule: pointer/target-size
 * Satisfies: wcag22:2.5.8
 * Spec: https://www.w3.org/TR/WCAG22/#target-size-minimum
 *
 * > The size of the target for pointer inputs is at least 24 by 24 CSS
 * > pixels, except where:
 * >   - Spacing: Undersized targets (those less than 24 by 24 CSS pixels)
 * >     are positioned so that if a 24 CSS pixel diameter circle is
 * >     centered on the bounding box of each, the circles do not
 * >     intersect another target or the circle for another undersized
 * >     target;
 * >   - Equivalent: The function can be achieved through a different
 * >     control on the same page that meets this criterion;
 * >   - Inline: The target is in a sentence or its size is otherwise
 * >     constrained by the line-height of non-target text;
 * >   - User agent control: The size of the target is determined by the
 * >     user agent and is not modified by the author;
 * >   - Essential: A particular presentation of the target is essential
 * >     or is legally required for the information being conveyed.
 *
 * New WCAG 2.2 Level AA criterion (NOT in WCAG 2.1).
 *
 * Static-analysis scope: we cannot measure runtime computed size, so
 * we look at *author-declared* size signals only.
 *
 *   1. CSS rules whose selector targets likely-interactive elements
 *      and that pin width/height (or min-width/min-height) below 24px
 *      without compensating padding.
 *   2. JSX/HTML interactive elements (button, role=button, anchor,
 *      input[type=button|submit|checkbox|radio|image]) whose
 *      `className`/`class` Tailwind utilities resolve below 24px, or
 *      whose inline `style` declares too-small dimensions.
 *
 * Skip (no flag):
 *   - Inline interactive elements inside text-flow ancestors (`p`,
 *     `li`, `td`, …) — the WCAG "Inline" exception.
 *   - `<input type="range|color|file|date|…">` (user-agent sized).
 *   - When the same selector also sets compensating padding.
 *
 * Severity is "warning" because the static heuristic cannot verify
 * runtime computed size — only the author's declared intent.
 *
 * Scanning logic is shared with the AAA sibling `pointer/target-size-enhanced`
 * via `_target-size-shared.ts` — the only differences are the threshold
 * (24 vs 44 CSS px), the SC label embedded in messages, and the satisfies
 * list. Helpers shared between CSS / JSX / HTML branches live in the
 * sibling `target-size-helpers.ts` module.
 */

import { defineRule } from "../../api/plugin.ts";
import type { CssStylesheet, HtmlDocument, TsxModule } from "../../types/ast.ts";
import type { RuleContext } from "../../types/rule.ts";
import { scanCss, scanHtml, scanJsx, type TargetSizeOpts } from "./_target-size-shared.ts";
import { MIN_TARGET_PX_AA } from "./target-size-helpers.ts";

const OPTS: TargetSizeOpts = {
  minPx: MIN_TARGET_PX_AA,
  scLabel: "WCAG 2.2 SC 2.5.8",
  fixTailwindClasses: "w-6 h-6",
};

export const rule = defineRule({
  id: "pointer/target-size",
  satisfies: ["wcag22:2.5.8"],
  severity: "warning",
  scope: "document",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".css", ".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Pointer targets (buttons, links, form controls) must measure at least 24×24 CSS pixels, unless the inline, equivalent, user-agent, or essential exception applies.",
    rationale:
      "Users with motor impairments, tremors, or who use touch input on small screens cannot reliably hit small targets. WCAG 2.2 SC 2.5.8 sets a 24×24 CSS-pixel minimum (with documented exceptions). A button styled `w-4 h-4` (16×16) or `width: 20px; height: 20px;` is too small without compensating padding or the inline-text exception.",
    goodExample:
      '.icon-button { width: 24px; height: 24px; }\n<button className="w-6 h-6">×</button>',
    badExample:
      '.icon-button { width: 16px; height: 16px; }\n<button className="w-4 h-4">×</button>',
    normativeQuote:
      "The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except where: Spacing, Equivalent, Inline, User agent control, or Essential.",
    references: [
      "https://www.w3.org/TR/WCAG22/#target-size-minimum",
      "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html",
    ],
  },
  afterFile(ctx) {
    if (ctx.language === "css") {
      scanCss(ctx as RuleContext & { ast: CssStylesheet }, OPTS);
      return;
    }
    if (ctx.language === "html") {
      scanHtml(ctx as RuleContext & { ast: HtmlDocument }, OPTS);
      return;
    }
    if (
      ctx.language === "tsx" ||
      ctx.language === "jsx" ||
      ctx.language === "ts" ||
      ctx.language === "js"
    ) {
      scanJsx(ctx as RuleContext & { ast: TsxModule }, OPTS);
    }
  },
});
