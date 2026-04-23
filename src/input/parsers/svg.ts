/**
 * In-house SVG parser — v0.1.x minimal adapter.
 *
 * A standalone `.svg` file is XML, but the tag-and-attribute surface
 * a11y rules care about — `<title>` children, `<desc>` children,
 * `role="img"`, `aria-label`, `aria-labelledby`, `aria-hidden` — is
 * identical to the inline SVG shape the HTML parser already handles
 * when it encounters `<svg>` inside an `.html` document. The HTML
 * tokenizer tolerates arbitrary element names (the `<path>`,
 * `<circle>`, `<defs>` zoo), preserves `<title>` as a raw-text
 * element so its text content flows through intact, and treats the
 * optional XML declaration (`<?xml version="1.0"?>`) + DOCTYPE as
 * benign prolog nodes.
 *
 * So the minimum viable shape is: hand the source to `parseHtml`,
 * return an `HtmlParseResult`. Rules targeting `.svg` via the
 * `.html` extension alias (see {@link EXTENSION_ALIASES} in
 * `src/utils/path.ts`) then see the same AST shape they would from
 * an inline SVG inside an HTML document.
 *
 * Why a dedicated adapter at all if it's a passthrough? Three reasons:
 *
 *   1. Parser-registry symmetry. Every file extension resolves
 *      through a named adapter (`parseHtml`, `parseAstro`,
 *      `parseScss`, `parseMdx`, `parseMarkdown`). A future SVG-
 *      specific transform — e.g. `<use href>` resolution across
 *      `<defs>`, symbol-library inlining, or gzipped `.svgz`
 *      support — lands here without touching the call sites.
 *   2. Dispatch-site clarity. Call sites in `src/mcp/session.ts`,
 *      `src/mcp/tool-apply-fix-internals.ts`, `src/cli/commands/
 *      scan.ts`, and `src/cli/commands/conformance.ts` read as
 *      `parseSvg(source)` instead of "route `.svg` through
 *      `parseHtml` and remember the alias semantics" — the alias
 *      stays in `path.ts`, the routing stays honest.
 *   3. Future language-tag disambiguation. Today both return an
 *      `HtmlParseResult` with `language: "html"` downstream (same
 *      shape the alias table promises), but if we ever need to
 *      flag "this AST came from an SVG standalone asset, not an
 *      inline SVG in an HTML document," the adapter is the seam.
 *
 * Like every ra11y parser: never throws. Returns a partial tree
 * plus `ParseError[]` propagated directly from the HTML tokenizer.
 *
 * Out of scope (honest pass-through):
 *   - `<use href="#symbol">` expansion — the reference stays opaque.
 *     A rule targeting `<use>` can inspect `href` as a bare attribute.
 *   - CSS inside `<style>` — `<style>` is tokenized as raw-text by the
 *     HTML parser; the CSS rules don't re-parse the inner text unless
 *     the file itself is a `.css` file.
 *   - `.svgz` (gzip-compressed SVG) — not decoded; treated as binary
 *     and skipped upstream by file discovery.
 */

import { type HtmlParseResult, parseHtml } from "./html.ts";

export function parseSvg(source: string): HtmlParseResult {
  return parseHtml(source);
}

export type { HtmlParseResult } from "./html.ts";
