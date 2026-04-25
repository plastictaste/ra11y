/**
 * Rule: contrast/minimum
 * Satisfies: wcag22:1.4.3, wcag21:1.4.3
 * Spec: https://www.w3.org/TR/WCAG22/#contrast-minimum
 *
 * > The visual presentation of text and images of text has a contrast
 * > ratio of at least 4.5:1, except for the following:
 * >   - Large Text: Large-scale text and images of large-scale text
 * >     have a contrast ratio of at least 3:1.
 * >   - Incidental: Text or images of text that are part of an inactive
 * >     user interface component, pure decoration, not visible to anyone,
 * >     or part of a picture that contains significant other visual
 * >     content, have no contrast requirement.
 * >   - Logotypes: Text that is part of a logo or brand name has no
 * >     minimum contrast requirement.
 *
 * Source: https://www.w3.org/TR/WCAG22/#contrast-minimum
 *
 * This rule walks CSS rules looking for pairs of `color` and
 * background-color / background declarations that both resolve to
 * concrete color values (hex, rgb(), hsl(), or one of the 18 named
 * colors we recognize). For each pair, it computes the contrast
 * ratio against WCAG's relative-luminance formula and flags pairs
 * that fail 4.5:1 for normal text or 3:1 for large text.
 *
 * The walker + color extraction + large-text heuristic live in
 * `./_shared.ts` and are reused by `contrast/enhanced` (AAA).
 *
 * `couldBeWrongBecause` opt-in (project scope): when a scanned JSX
 * or HTML consumer carries the CSS failure's class token AND a
 * `text-*` / `bg-*` Tailwind utility on the same element, the finding
 * is tagged `tailwind_class_on_consumer`. Informational only — the
 * agent reads the consumer file and decides whether the consumer-site
 * utility actually overrides the declared color. See
 * docs/adr/0009-violation-could-be-wrong-because.md.
 *
 * Image-backed backgrounds (v1.0): when a selector declares `color`
 * alongside `background-image: …url()…` / `background-image: *-gradient(…)`
 * or a shorthand `background` containing either, the scanner cannot
 * compute a luminance for the background. The rule emits an
 * info-severity finding carrying `couldBeWrongBecause:
 * [background_image_unresolvable]` so the agent knows the pair went
 * unevaluated and can verify manually against the image. Never fabricates
 * a ratio; honestly surfaces the unknown (CLAUDE.md §1 "Surface, don't
 * suppress").
 *
 * Cross-selector cascade fallback (V1-CSS-CONTRAST-CASCADE-INHERITED):
 * real-world CSS routinely declares one half of the contrast pair on
 * a document-default selector (`body { color: #fff }`) and the other
 * on a descendant (`.article { background: lightblue }`). Before this
 * fallback existed, the pair extractor required both halves on the
 * same rule and silently missed the failing pair. The shared extractor
 * now walks the stylesheet once gathering `color` /
 * `background(-color)` declarations authored on `:root` / `html` /
 * `body`, and when a consumer rule declares only one half the
 * extractor falls back to the cascade default for the missing half.
 * Scope is deliberately narrow: plain `:root` / `html` / `body` only,
 * same-file only, no compound or pseudo-class variants
 * (`body.dark` does NOT contribute — the variant is condition-gated).
 * Findings that resolved via the fallback carry
 * `couldBeWrongBecause: [cascade_inherited_context]` so the agent
 * knows the descendant relationship was assumed from the cascade idiom
 * rather than proved — the scanner cannot prove '.btn' actually
 * renders inside `<body>`, but the idiom is dominant enough to surface
 * honestly (CLAUDE.md §1 "Surface, don't suppress"). Unresolvable cases
 * (compound ancestor selector, cross-file document default, missing
 * half of the pair) stay silent on the rule; the rule-level
 * `crossFileCapable: false` flag downgrades the coverage row to
 * `"medium"` with a structured reason per ADR 0026.
 *
 * v0.0.x coverage: in-file CSS rules (standalone .css and <style>
 * blocks). Custom properties resolve one level same-file (V1-CSS-
 * CONTRAST-VAR-ROOT-RESOLUTION); inherited document defaults resolve
 * off plain `:root` / `html` / `body` selectors
 * (V1-CSS-CONTRAST-CASCADE-INHERITED). Does NOT implement full CSS
 * cascade resolution (specificity ordering, pseudo-class variants,
 * nested-descendant combinators, `@media`-scoped overrides) — those
 * remain follow-up items where the rule's `crossFileCapable: false`
 * flag is the honest downgrade at the coverage layer.
 */

import { defineRule } from "../../api/plugin.ts";
import type { CssStylesheet, HtmlDocument } from "../../types/ast.ts";
import type { EmittedViolation, ProjectContext } from "../../types/rule.ts";
import { WCAG_AA_MIN_LARGE, WCAG_AA_MIN_NORMAL } from "../../utils/contrast.ts";
import {
  BG_IMAGE_UNRESOLVABLE,
  buildBgImageUnresolvableMessage,
  buildBgImageUnresolvableSuggestion,
  buildContrastMessage,
  buildContrastSuggestion,
  CASCADE_INHERITED_CONTEXT,
  type ContrastCheckOptions,
  collectBgImageUnresolvable,
  collectTailwindOverrideClasses,
  extractPrimarySelectorClass,
  findContrastFailures,
  TAILWIND_CLASS_ON_CONSUMER,
} from "./_shared.ts";
import {
  buildInlineStyleBgImageUnresolvableMessage,
  buildInlineStyleBgImageUnresolvableSuggestion,
  buildInlineStyleContrastMessage,
  buildInlineStyleContrastSuggestion,
  collectInlineStyleBgImageUnresolvable,
  findInlineStyleContrastFailures,
} from "./_shared-inline.ts";

const SC_LABEL = "WCAG 1.4.3 AA";

export const rule = defineRule({
  id: "contrast/minimum",
  satisfies: ["wcag22:1.4.3", "wcag21:1.4.3"],
  severity: "error",
  scope: "project",
  fixClass: "guidance",
  // `.html` / `.htm` are listed alongside `.css` so `rulesFiredByExtension`
  // honestly reports "this rule evaluated HTML files" when an inline
  // `style="color:…;background:…"` pair is scored. The rule still runs
  // in `afterProject` — the extension gate only threads through the
  // per-rule coverage tracker, not per-file dispatch.
  //
  // `.scss` / `.less` are listed because the SCSS and Less parsers
  // (`src/input/parsers/scss.ts`, `src/input/parsers/less.ts`)
  // preprocess preprocessor source into a CSS-shaped AST and the
  // dispatch sites (`src/cli/commands/scan.ts`,
  // `src/cli/commands/conformance.ts`, `src/mcp/session.ts`) tag the
  // resulting `Ast.language` as `"css"`. The `afterProject` loop
  // already handles `file.language === "css"`, so adding these
  // extensions to the gate makes the per-rule coverage tracker bump
  // `eligible` for every parsed `.scss` / `.less` file — without it,
  // SSG docs sites with their full color story authored in Sass/Less
  // (Jekyll, Hugo, Middleman, Eleventy ecosystems) silently report
  // `filesEvaluated: 0` for `contrast/minimum`. Statically resolvable
  // pairs (literal hex / named / `rgb()` colors, top-level
  // `$var: <literal>` substitution) flag normally; preprocessor
  // constructs the parsers can't statically resolve (mixin bodies,
  // `@function`, math, `#{…}` interpolation, cross-file imports,
  // Less guards) stay unresolved so the rule does not emit false
  // findings — `crossFileCapable: false` already downgrades the
  // coverage row to honestly signal that bound (ADR 0026).
  // `.sass` (indented syntax) is intentionally absent — no parser
  // exists for it; adding the extension without a parser would
  // surface a zero-output success on Sass-indented projects.
  appliesTo: {
    fileExtensions: [".css", ".html", ".htm", ".scss", ".less"],
  },
  // SC 1.4.3's spec measures the *rendered* color pair; design-system
  // CSS routinely hosts that pair across files — a `tokens.css` with
  // `:root { --fg: #111 }` feeds `components.css`'s `color: var(--fg)`.
  // The pair extractor resolves `:root` custom properties same-file
  // only (V1-CSS-CONTRAST-VAR-ROOT-RESOLUTION) — a cross-file token
  // file keeps the consumer's `var(--fg)` unresolved, and a clean
  // tally on that substrate would silently read as "confidently
  // clean." Declaring `crossFileCapable: false` downgrades the row to
  // `coverageConfidence: "medium"` with the structured reason code
  // wired in `src/engine/per-rule-coverage.ts` per ADR 0026 — honest
  // "ran but evidence was bounded" rather than silent-miss `"high"`.
  crossFileCapable: false,
  docs: {
    description:
      "Text must have a contrast ratio of at least 4.5:1 against its background (3:1 for large text).",
    rationale:
      "People with moderately low vision (common among older adults) need high contrast to read text. The 4.5:1 minimum compensates for the loss of contrast sensitivity that about 20% of the population experiences by age 80.",
    goodExample: ".button { color: #ffffff; background-color: #2b6cb0; }  /* ratio 6.3:1 */",
    badExample: ".button { color: #ffffff; background-color: #90caf9; }  /* ratio 1.9:1 */",
    normativeQuote:
      "The visual presentation of text and images of text has a contrast ratio of at least 4.5:1, except for large text, incidental text, and logotypes.",
    references: [
      "https://www.w3.org/TR/WCAG22/#contrast-minimum",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G18",
    ],
  },
  afterProject(ctx) {
    const overrideClasses = collectTailwindOverrideClasses(ctx);
    const opts: ContrastCheckOptions = {
      minNormal: WCAG_AA_MIN_NORMAL,
      minLarge: WCAG_AA_MIN_LARGE,
      scLabel: SC_LABEL,
    };
    for (const file of ctx.files) {
      if (file.language === "css") {
        checkCssFile(ctx, file.filePath, file.ast as CssStylesheet, opts, overrideClasses);
      } else if (file.language === "html") {
        // Inline `style="color:…;background:…"` on HTML elements.
        // Silent-miss before this branch existed — static-site template
        // scans reported zero contrast findings despite heavy inline
        // use. Evaluated here with the same thresholds as stylesheet
        // rules; image-backed inline backgrounds take the info-severity
        // bg-image-unresolvable path.
        checkHtmlInlineStyles(ctx, file.filePath, file.ast as HtmlDocument, opts);
      }
    }
  },
});

function checkCssFile(
  ctx: ProjectContext,
  filePath: string,
  stylesheet: CssStylesheet,
  opts: ContrastCheckOptions,
  overrideClasses: ReadonlySet<string>,
): void {
  for (const finding of findContrastFailures(stylesheet, opts)) {
    emitFinding(ctx, filePath, finding, overrideClasses);
  }
  // Image-backed backgrounds: `background-image: …url()…` and
  // `background: …linear-gradient(…)` are unresolvable statically.
  // Emit info-severity so the agent knows the pair went unevaluated.
  for (const finding of collectBgImageUnresolvable(stylesheet)) {
    emitUnresolvable(ctx, filePath, finding);
  }
}

function checkHtmlInlineStyles(
  ctx: ProjectContext,
  filePath: string,
  doc: HtmlDocument,
  opts: ContrastCheckOptions,
): void {
  for (const finding of findInlineStyleContrastFailures(doc, opts)) {
    emitInlineStyleFinding(ctx, filePath, finding);
  }
  for (const finding of collectInlineStyleBgImageUnresolvable(doc)) {
    emitInlineStyleUnresolvable(ctx, filePath, finding);
  }
}

function emitInlineStyleFinding(
  ctx: ProjectContext,
  filePath: string,
  finding: ReturnType<typeof findInlineStyleContrastFailures>[number],
): void {
  const emitted: EmittedViolation = {
    severity: "error",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildInlineStyleContrastMessage(finding, SC_LABEL),
    suggestion: buildInlineStyleContrastSuggestion(finding),
  };
  ctx.emit(emitted);
}

function emitInlineStyleUnresolvable(
  ctx: ProjectContext,
  filePath: string,
  finding: ReturnType<typeof collectInlineStyleBgImageUnresolvable>[number],
): void {
  const emitted: EmittedViolation = {
    severity: "info",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildInlineStyleBgImageUnresolvableMessage(finding, WCAG_AA_MIN_NORMAL, SC_LABEL),
    suggestion: buildInlineStyleBgImageUnresolvableSuggestion(finding, WCAG_AA_MIN_NORMAL),
    couldBeWrongBecause: [BG_IMAGE_UNRESOLVABLE],
  };
  ctx.emit(emitted);
}

function emitUnresolvable(
  ctx: ProjectContext,
  filePath: string,
  finding: ReturnType<typeof collectBgImageUnresolvable>[number],
): void {
  const emitted: EmittedViolation = {
    severity: "info",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildBgImageUnresolvableMessage(finding, WCAG_AA_MIN_NORMAL, SC_LABEL),
    suggestion: buildBgImageUnresolvableSuggestion(finding, WCAG_AA_MIN_NORMAL),
    couldBeWrongBecause: [BG_IMAGE_UNRESOLVABLE],
  };
  ctx.emit(emitted);
}

function emitFinding(
  ctx: ProjectContext,
  filePath: string,
  finding: ReturnType<typeof findContrastFailures>[number],
  overrideClasses: ReadonlySet<string>,
): void {
  const primaryClass = extractPrimarySelectorClass(finding.selector);
  const tailwindOverride = primaryClass !== null && overrideClasses.has(primaryClass);
  // Accumulate the reason codes in declared order — scanner conventions
  // treat `couldBeWrongBecause` as an unordered set, but keeping the
  // cascade note before the Tailwind note produces stable fixtures
  // when both apply (a `body`-inherited background on a class that
  // happens to co-occur with `bg-*` Tailwind utilities).
  const reasons: string[] = [];
  if (finding.cascadeSource) reasons.push(CASCADE_INHERITED_CONTEXT);
  if (tailwindOverride) reasons.push(TAILWIND_CLASS_ON_CONSUMER);
  const emitted: EmittedViolation = {
    severity: "error",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildContrastMessage(finding, SC_LABEL),
    suggestion: buildContrastSuggestion(finding),
    // Conditional spread — `couldBeWrongBecause: []` would be a
    // dishonest empty-vs-unpopulated sentinel per CLAUDE.md §1.
    ...(reasons.length > 0 ? { couldBeWrongBecause: reasons } : {}),
  };
  ctx.emit(emitted);
}
