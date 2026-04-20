/**
 * In-house Astro parser — v0.1.x minimal adapter.
 *
 * An `.astro` file is two regions: an optional *component script* —
 * a TypeScript/JavaScript fence delimited by `---` at the top of the
 * file — followed by an HTML template that may interleave arbitrary
 * JSX-flavoured expressions, component references, and inline
 * `<style>` / `<script>` blocks. A faithful Astro compiler resolves
 * imported components, evaluates the script, and expands expressions;
 * doing any of that zero-dep is out of reach.
 *
 * But the authoring surface a11y rules care about — `<img alt>`,
 * `<a>` text, headings, landmarks, `<button>` labels, contrast from
 * inline `<style>` — lives in the template region, which is just
 * HTML with some JSX-style `{expr}` braces sprinkled in. The HTML
 * parser already tolerates arbitrary tag names (including
 * capital-cased component tags like `<Icon>`), routes inline
 * `<style>` to the CSS parser, and keeps `<script>` as opaque
 * raw-text. So the minimum viable shape is: strip the component
 * script, hand the template to `parseHtml`, return an
 * `HtmlParseResult`.
 *
 * Strategy (same adapter pattern as `parseMdx` and `parseScss`):
 * pre-transform the Astro source into HTML-equivalent source, then
 * delegate. The output is an `HtmlParseResult` with exactly the AST
 * shape the HTML parser emits, so downstream rules need zero
 * changes.
 *
 * Transform passes (in order):
 *
 *   1. Strip the component-script frontmatter fence: `---\n…\n---\n`
 *      at the start of the file. The opening `---` must be at byte
 *      0 on its own line; the closing `---` must appear on its own
 *      line somewhere downstream. Stripped region is blanked with
 *      whitespace (newlines preserved) so line numbers in the
 *      surviving template stay aligned with the original source —
 *      critical for accurate finding locations.
 *
 *   2. Hand the residual template to `parseHtml`. That parser
 *      handles:
 *        - `<style>` and `<script>` blocks as raw-text regions
 *          (script stays opaque; `<style>` content is a single
 *          text node the CSS rules can pick up separately when the
 *          containing file is reanalyzed).
 *        - Uppercase component tags (`<Icon>`, `<Header>`) tolerated
 *          as arbitrary HTML elements — the same treatment JSX gets
 *          for opaque custom components today.
 *        - `{expr}` expression braces inside attributes or text
 *          flow through as literal characters. We can't resolve
 *          them without evaluating Astro's runtime; matching
 *          template-directives policy, we parse them as literal
 *          and let the agent investigate when a rule flags
 *          something that depends on runtime.
 *
 * Like every ra11y parser: never throws. Returns a partial tree
 * plus `ParseError[]`. An unclosed frontmatter fence is a parse
 * error flagged `recoverable: true` — the template is still fed
 * to `parseHtml` from the point where we stopped hoping to find a
 * close, so downstream rules don't lose coverage.
 *
 * Out of scope (honest pass-through):
 *   - Expression interpolation (`{expr}` stays literal).
 *   - `set:html` / `set:text` / `is:raw` directives — treated as
 *     regular attributes; the HTML parser doesn't know their
 *     semantics.
 *   - Fragment shorthand (`<>…</>`) — Astro allows this inside
 *     expressions; in the top-level template it isn't valid Astro.
 *     If it appears, `parseHtml` treats `<>` as stray text and
 *     recovers.
 *   - Imported component resolution — `<Icon>` stays opaque.
 */

import type { ParseError } from "../../types/ast.ts";
import { type HtmlParseResult, parseHtml } from "./html.ts";

export function parseAstro(source: string): HtmlParseResult {
  const errors: ParseError[] = [];
  // Each pass operates on the character buffer and replaces stripped
  // regions with space/newline so downstream line/column numbers
  // match the original source.
  const buf = source.split("");
  stripFrontmatter(source, buf, errors);
  const transformed = buf.join("");
  const html = parseHtml(transformed);
  return {
    root: html.root,
    errors: [...errors, ...html.errors],
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — component-script frontmatter strip
// ---------------------------------------------------------------------------

/**
 * Strips the leading component-script fence: `---\n…\n---\n`. The
 * opening fence must start at byte 0 and be followed by a newline
 * (with optional `\r`). The closing fence must appear alone on its
 * line downstream. Non-fenced sources (no leading `---`) are a no-op.
 *
 * When the opening fence is present but no closing fence is found
 * before EOF, we record a recoverable `ParseError` and leave the
 * source unmodified — the HTML parser will then scan the entire
 * file including the script region, which will at worst emit
 * further recoverable errors but never throw.
 */
function stripFrontmatter(source: string, buf: string[], errors: ParseError[]): void {
  if (!hasOpeningFence(source)) return;
  // The opening fence is three dashes followed by a newline. Advance
  // past it to the start of the script body.
  let p = 3;
  if (source[p] === "\r") p += 1;
  if (source[p] !== "\n") {
    // `---` followed by something other than a newline (e.g. `---foo`)
    // isn't a frontmatter fence. Leave it alone.
    return;
  }
  p += 1;
  const closingIdx = findClosingFence(source, p);
  if (closingIdx === -1) {
    errors.push({
      message: "Unterminated Astro component-script fence (missing closing `---`)",
      position: { line: 1, column: 1, offset: 0 },
      recoverable: true,
    });
    return;
  }
  blankRange(source, buf, 0, closingIdx);
}

/**
 * Returns true when `source` opens with an Astro component-script
 * fence — exactly three dashes on their own (a `----` or longer
 * line is not a fence). The caller verifies the trailing newline.
 */
function hasOpeningFence(source: string): boolean {
  if (!source.startsWith("---")) return false;
  // `----` and longer are not a fence; they're something else the
  // author wrote (most likely not valid Astro, but definitely not
  // a script fence).
  if (source[3] === "-") return false;
  return true;
}

/**
 * Returns the byte offset just past the closing fence line
 * (including its trailing newline), or -1 if no closing fence
 * exists. The closing fence must appear alone on its line —
 * exactly three dashes, optionally followed by trailing
 * whitespace, then a newline or EOF.
 */
function findClosingFence(source: string, startPos: number): number {
  let p = startPos;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    if (isFenceLine(source, p, lineEnd)) {
      return advancePastNewline(source, lineEnd);
    }
    p = advancePastNewline(source, lineEnd);
  }
  return -1;
}

/**
 * Returns true when `source[start…end)` is exactly `---` followed
 * optionally by trailing whitespace. `end` points at the `\n` or
 * past the string end — the line's content is `[start, end)`.
 */
function isFenceLine(source: string, start: number, end: number): boolean {
  if (end - start < 3) return false;
  if (source[start] !== "-" || source[start + 1] !== "-" || source[start + 2] !== "-") {
    return false;
  }
  // Four-or-more dashes aren't a fence line.
  if (source[start + 3] === "-") return false;
  // Anything other than trailing whitespace fails the fence match —
  // `---foo` isn't a fence. CR is tolerated so CRLF line endings work.
  for (let i = start + 3; i < end; i += 1) {
    const ch = source[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function findLineEnd(source: string, pos: number): number {
  let p = pos;
  while (p < source.length && source[p] !== "\n") p += 1;
  return p;
}

function advancePastNewline(source: string, pos: number): number {
  if (pos >= source.length) return source.length;
  if (source[pos] === "\n") return pos + 1;
  return pos;
}

/**
 * Replaces `[start, end)` in `buf` with whitespace, preserving `\n`
 * and `\r` so line numbers stay aligned. `buf` is a parallel array
 * to `source`; the source stays available for lookups while the
 * buffer accumulates the transform.
 */
function blankRange(source: string, buf: string[], start: number, end: number): void {
  const stop = Math.min(end, source.length);
  for (let i = start; i < stop; i += 1) {
    const ch = source[i];
    buf[i] = ch === "\n" ? "\n" : ch === "\r" ? "\r" : " ";
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { HtmlParseResult } from "./html.ts";
