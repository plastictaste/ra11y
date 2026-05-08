/**
 * Rule: pointer/target-size-enhanced
 * Satisfies: wcag22:2.5.5, wcag21:2.5.5
 * Spec: https://www.w3.org/TR/WCAG22/#target-size-enhanced
 *
 * > The size of the target for pointer inputs is at least 44 by 44 CSS
 * > pixels, except when:
 * >   - Equivalent: The target is available through an equivalent link
 * >     or control on the same page that is at least 44 by 44 CSS
 * >     pixels;
 * >   - Inline: The target is in a sentence or block of text;
 * >   - User Agent Control: The size of the target is determined by
 * >     the user agent and is not modified by the author;
 * >   - Essential: A particular presentation of the target is essential
 * >     to the information being conveyed.
 *
 * WCAG 2.1 Level AAA criterion (also retained in WCAG 2.2 — the AAA
 * "enhanced" companion to the new 2.2 AA SC 2.5.8 "minimum"). Note that
 * SC 2.5.5 does NOT have the "Spacing" exception that SC 2.5.8 carries —
 * a 30×30 button satisfies AA but fails AAA.
 *
 * Sibling to `pointer/target-size`. The two rules share scanning logic
 * via `_target-size-shared.ts`; they differ only in:
 *   - threshold (44 CSS px vs 24),
 *   - SC label embedded in messages,
 *   - the `satisfies` list,
 *   - the spec URL in `references`.
 *
 * A site targeting only AA disables this rule via config; sites
 * pursuing AAA conformance keep it on. Severity is "warning" because
 * the static heuristic cannot verify runtime computed size — only the
 * author's declared intent. Severity is also "warning" rather than
 * "error" because AAA is aspirational; most public-facing sites target
 * AA. Mirrors the `contrast/enhanced` posture for the same reason.
 *
 * Static-analysis scope (identical to the AA sibling):
 *
 *   1. CSS rules whose selector targets likely-interactive elements
 *      and that pin width/height (or min-width/min-height) below 44px
 *      without compensating padding.
 *   2. JSX/HTML interactive elements (button, role=button, anchor,
 *      input[type=button|submit|checkbox|radio|image]) whose
 *      `className`/`class` Tailwind utilities resolve below 44px, or
 *      whose inline `style` declares too-small dimensions.
 *
 * Skip (no flag):
 *   - Inline interactive elements inside text-flow ancestors (`p`,
 *     `li`, `td`, …) — the WCAG "Inline" exception.
 *   - `<input type="range|color|file|date|…">` (user-agent sized).
 *   - When the same selector also sets compensating padding.
 */

import { defineRule } from "../../api/plugin.ts";
import type { CssStylesheet, HtmlDocument, TsxModule } from "../../types/ast.ts";
import type { RuleContext } from "../../types/rule.ts";
import { scanCss, scanHtml, scanJsx, type TargetSizeOpts } from "./_target-size-shared.ts";
import { MIN_TARGET_PX_AAA } from "./target-size-helpers.ts";

const OPTS: TargetSizeOpts = {
  minPx: MIN_TARGET_PX_AAA,
  scLabel: "WCAG 2.1 SC 2.5.5",
  // Tailwind has no single utility for 44px; `w-11 h-11` (2.75rem = 44px) is the
  // closest stock match and is what users adopt for AAA-grade touch targets.
  fixTailwindClasses: "w-11 h-11",
};

export const rule = defineRule({
  id: "pointer/target-size-enhanced",
  satisfies: ["wcag22:2.5.5", "wcag21:2.5.5"],
  severity: "warning",
  scope: "document",
  fixClass: "guidance",
  appliesTo: {
    fileExtensions: [".css", ".html", ".htm", ".tsx", ".jsx"],
  },
  docs: {
    description:
      "Pointer targets must measure at least 44×44 CSS pixels (WCAG 2.1 SC 2.5.5 AAA, the enhanced companion to SC 2.5.8 AA at 24×24), unless the inline, equivalent, user-agent, or essential exception applies.",
    rationale:
      "AAA-grade touch targets help users with substantial motor impairments, severe tremors, or low-precision pointing devices. The 44 CSS pixel minimum aligns with platform HIG guidance (Apple HIG, Material) and is what AAA-conformant public-sector and accessibility-critical sites target. A 30×30 button satisfies the AA SC 2.5.8 minimum but still fails AAA — and unlike AA, the AAA SC has no Spacing exception, so non-overlapping placement does not save an undersized target.",
    goodExample:
      '.icon-button { width: 44px; height: 44px; }\n<button className="w-11 h-11">×</button>',
    badExample:
      '.icon-button { width: 32px; height: 32px; }\n<button className="w-8 h-8">×</button>',
    normativeQuote:
      "The size of the target for pointer inputs is at least 44 by 44 CSS pixels, except when: Equivalent, Inline, User Agent Control, or Essential.",
    references: [
      "https://www.w3.org/TR/WCAG22/#target-size-enhanced",
      "https://www.w3.org/WAI/WCAG21/Understanding/target-size.html",
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
