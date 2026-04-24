/**
 * Hint-construction helpers for `meta.analysisCoverage.hints[]` —
 * the thin-CSS coverage hint plus the Tailwind-signal detector it
 * strengthens with. Extracted from `analysis-coverage.ts` so that
 * file stays under the 500-effective-line budget; the hint shape
 * (structured `{ code, text, detail }` per V1-HINTS-STRUCTURED-CODE)
 * and the Tailwind class-shape heuristic live together since the
 * hint-detail field `tailwindDetected` is the only consumer of the
 * detector.
 */

import { walkJsxElements } from "../engine/ast-helpers.ts";
import type { ParsedFile } from "../engine/scanner.ts";
import type { TsxModule } from "../types/ast.ts";
import type { Hint } from "./hint-codes.ts";

/**
 * Builds the thin-CSS-coverage hint, strengthened with a Tailwind-
 * specific follow-up when Tailwind usage is detected. On a Tailwind
 * codebase the only realistic way to get contrast/focus-visible
 * coverage is to run the build and point scan_project at the emitted
 * CSS — naming the exact `additionalPaths` argument saves the agent
 * a discovery round trip.
 *
 * Returns a structured hint; `detail.tailwindDetected` is the
 * load-bearing discriminator an agent branches on to pick remediation
 * (`warnings.ts` consumes this to fire `tailwind_detected_css_undercounted`
 * without substring-matching `text`). `cssFiles` / `markupFiles` are
 * the raw counts that motivated the hint so agents can surface the
 * ratio directly.
 */
export function buildCssThinHint(files: readonly ParsedFile[], css: number, markup: number): Hint {
  const base =
    `Only ${css} CSS file(s) scanned vs ${markup} JSX/HTML file(s). ` +
    "Post-compile output (Tailwind, CSS-in-JS, SCSS) isn't parsed — color-contrast " +
    "and focus-visible coverage may be undercounted.";
  const tailwindDetected = hasTailwindSignal(files);
  const text = tailwindDetected
    ? `${base} Tailwind usage detected: run the build, then re-run scan_project with ` +
      '`additionalPaths: ["dist/assets"]` (or wherever your bundler emits CSS) to ' +
      "include the generated stylesheet. `additionalPaths` bypasses `.gitignore` and " +
      "the default build-dir skips for the paths you list."
    : `${base} Build the site and point \`scan\` at the emitted .css, or scan the Tailwind source config alongside JSX.`;
  return {
    code: "css_coverage_thin",
    text,
    detail: { cssFiles: css, markupFiles: markup, tailwindDetected },
  };
}

/**
 * Cheap Tailwind detector: a `class`/`className` attribute anywhere in
 * the scanned JSX whose value contains two or more tokens with the
 * `prefix-value` shape characteristic of Tailwind utilities. We
 * deliberately don't parse tailwind.config.*; that would require
 * filesystem access and version-specific config support for zero
 * marginal signal. Two utility-shaped tokens together is both sparse
 * enough to avoid false positives on class names like "site-header
 * active" and common enough to catch any real Tailwind project on the
 * first JSX file we look at.
 */
function hasTailwindSignal(files: readonly ParsedFile[]): boolean {
  for (const f of files) {
    if (f.ast.language !== "tsx" && f.ast.language !== "jsx") continue;
    if (fileHasTailwindClass(f.ast.root as TsxModule)) return true;
  }
  return false;
}

function fileHasTailwindClass(root: TsxModule): boolean {
  for (const el of walkJsxElements(root)) {
    for (const attr of el.attributes) {
      if (attr.name !== "className" && attr.name !== "class") continue;
      if (attr.value?.kind !== "StringLiteral") continue;
      if (looksLikeTailwindClassString(attr.value.value)) return true;
    }
  }
  return false;
}

/**
 * Two tokens of shape `<letters>-<letters-or-digits>` (e.g. `bg-red-500
 * text-center`, `md:hover:text-white flex`) are a strong Tailwind
 * signal. Variants with `:` (`md:`, `hover:`, `dark:`) count. Arbitrary
 * values in `[...]` also count when attached to a utility prefix.
 */
function looksLikeTailwindClassString(classString: string): boolean {
  const tokens = classString.trim().split(/\s+/);
  let matches = 0;
  for (const token of tokens) {
    if (TAILWIND_TOKEN_RE.test(token)) {
      matches += 1;
      if (matches >= 2) return true;
    }
  }
  return false;
}

const TAILWIND_TOKEN_RE = /^(?:[a-z]+:)*-?[a-z]+(?:-[a-z0-9/.%]+)+(?:\[[^\]]*\])?$/i;

/** File-category tally used to decide whether the thin-CSS hint fires. */
export function countByCategory(files: readonly ParsedFile[]): {
  jsx: number;
  html: number;
  css: number;
} {
  let jsx = 0,
    html = 0,
    css = 0;
  for (const f of files) {
    if (f.ast.language === "tsx" || f.ast.language === "jsx") jsx += 1;
    else if (f.ast.language === "html") html += 1;
    else if (f.ast.language === "css") css += 1;
  }
  return { jsx, html, css };
}
