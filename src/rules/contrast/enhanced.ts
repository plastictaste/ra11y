/**
 * Rule: contrast/enhanced
 * Satisfies: wcag22:1.4.6, wcag21:1.4.6
 * Spec: https://www.w3.org/TR/WCAG22/#contrast-enhanced
 *
 * > The visual presentation of text and images of text has a
 * > contrast ratio of at least 7:1, except for the following:
 * >   - Large Text: 4.5:1 minimum
 * >   - Incidental: no requirement
 * >   - Logotypes: no requirement
 *
 * Structurally identical to `contrast/minimum` — same walker, same
 * color extraction, same large-text heuristic, same cross-file
 * Tailwind `couldBeWrongBecause` opt-in, same info-severity surfacing
 * of unresolvable image-backed backgrounds — only the thresholds
 * differ (7:1 / 4.5:1 instead of 4.5:1 / 3:1). Shared logic lives in
 * `./_shared.ts`.
 *
 * Severity is `warning` (not `error`) because AAA is aspirational;
 * most public-facing sites target AA. Users who want this gated
 * hard in CI bump it via ra11y.config.ts.
 */

import { defineRule } from "../../api/plugin.ts";
import type { CssStylesheet, HtmlDocument } from "../../types/ast.ts";
import type { EmittedViolation, ProjectContext } from "../../types/rule.ts";
import { WCAG_AAA_MIN_LARGE, WCAG_AAA_MIN_NORMAL } from "../../utils/contrast.ts";
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

const SC_LABEL = "WCAG 1.4.6 AAA";

export const rule = defineRule({
  id: "contrast/enhanced",
  satisfies: ["wcag22:1.4.6", "wcag21:1.4.6"],
  severity: "warning",
  scope: "project",
  fixClass: "guidance",
  // `.html` / `.htm` are listed alongside `.css` so `rulesFiredByExtension`
  // honestly reports HTML inline-style evaluations. Mirrors
  // `contrast/minimum`'s gate — the rule still runs in `afterProject`;
  // the extension list feeds the per-rule coverage tracker, not the
  // per-file dispatch.
  appliesTo: {
    fileExtensions: [".css", ".html", ".htm"],
  },
  docs: {
    description:
      "Text must have a contrast ratio of at least 7:1 against its background (4.5:1 for large text) — WCAG 1.4.6 AAA.",
    rationale:
      "People with moderate low vision benefit from 4.5:1, but people with more substantial vision loss (roughly 20/200 or worse) need the 7:1 AAA threshold to read comfortably. Government and accessibility-critical public-facing sites often target AAA for body text.",
    goodExample: ".button { color: #ffffff; background-color: #1a202c; }  /* ratio 14.5:1 */",
    badExample: ".button { color: #ffffff; background-color: #4a5568; }  /* ratio 5.1:1 */",
    normativeQuote:
      "The visual presentation of text and images of text has a contrast ratio of at least 7:1, except for large text, incidental text, and logotypes.",
    references: [
      "https://www.w3.org/TR/WCAG22/#contrast-enhanced",
      "https://www.w3.org/WAI/WCAG22/Techniques/general/G17",
    ],
  },
  afterProject(ctx) {
    const overrideClasses = collectTailwindOverrideClasses(ctx);
    const opts: ContrastCheckOptions = {
      minNormal: WCAG_AAA_MIN_NORMAL,
      minLarge: WCAG_AAA_MIN_LARGE,
      scLabel: SC_LABEL,
    };
    for (const file of ctx.files) {
      if (file.language === "css") {
        checkCssFile(ctx, file.filePath, file.ast as CssStylesheet, opts, overrideClasses);
      } else if (file.language === "html") {
        // Inline `style="color:…;background:…"` on HTML elements
        // evaluated against the AAA thresholds. Mirrors
        // `contrast/minimum` — same helper module, different numeric
        // gate (7:1 / 4.5:1 instead of 4.5:1 / 3:1).
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
  // Image-backed backgrounds: info-severity finding per
  // docs/adr/0009 — see `contrast/minimum` for the rationale.
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
    severity: "warning",
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
    message: buildInlineStyleBgImageUnresolvableMessage(finding, WCAG_AAA_MIN_NORMAL, SC_LABEL),
    suggestion: buildInlineStyleBgImageUnresolvableSuggestion(finding, WCAG_AAA_MIN_NORMAL),
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
    message: buildBgImageUnresolvableMessage(finding, WCAG_AAA_MIN_NORMAL, SC_LABEL),
    suggestion: buildBgImageUnresolvableSuggestion(finding, WCAG_AAA_MIN_NORMAL),
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
  // Mirror `contrast/minimum`'s reason-code accumulation — the shared
  // pair extractor now emits `cascadeSource` when one half of the pair
  // came from a document-default selector (`:root` / `html` / `body`),
  // and the AAA rule honors the same honest surfacing: finding still
  // fires, `couldBeWrongBecause` names the cross-selector inference
  // per.
  const reasons: string[] = [];
  if (finding.cascadeSource) reasons.push(CASCADE_INHERITED_CONTEXT);
  if (tailwindOverride) reasons.push(TAILWIND_CLASS_ON_CONSUMER);
  const emitted: EmittedViolation = {
    severity: "warning",
    location: { filePath, line: finding.line, column: finding.column },
    message: buildContrastMessage(finding, SC_LABEL),
    suggestion: buildContrastSuggestion(finding),
    // Conditional spread — `couldBeWrongBecause: []` would be a
    // dishonest empty-vs-unpopulated sentinel per CLAUDE.md §1.
    ...(reasons.length > 0 ? { couldBeWrongBecause: reasons } : {}),
  };
  ctx.emit(emitted);
}
