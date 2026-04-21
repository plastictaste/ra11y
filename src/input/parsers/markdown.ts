/**
 * In-house Markdown parser — lightweight HTML-residue extractor.
 *
 * Strategy (ADR 0025 Option B): `.md` and `.markdown` files in
 * static-site-generator projects (Jekyll, Hugo, MkDocs, Docusaurus,
 * Astro content collections, Docs sites, Bootstrap-style documentation
 * repos) routinely embed raw HTML — data tables with `<th scope>`,
 * `<iframe title>` video embeds, admonition `<div class="note">`,
 * inline `<img alt>`. That embedded HTML is the scanner's target.
 * A faithful CommonMark parser (~2000 LOC) is out of proportion to
 * the coverage gain; this adapter strips the markdown-specific
 * syntax that isn't HTML and hands the residue to `parseHtml`.
 *
 * Passes (in order, all operating on a parallel character buffer so
 * line/column offsets in the surviving HTML AST stay aligned with
 * the original source):
 *
 *   1. Strip leading YAML (`---\n…\n---\n`) or TOML (`+++\n…\n+++\n`)
 *      frontmatter. Frontmatter is data, not authored markup.
 *   2. Strip fenced code blocks (` ``` … ``` ` and `~~~ … ~~~`). Their
 *      content is illustrative — CommonMark examples, API samples,
 *      shell snippets. Parsing their content as HTML would flag the
 *      very patterns the docs are demonstrating.
 *   3. Strip inline code spans (`` `…` ``). Same rationale at the
 *      paragraph-inline scale.
 *   4. Strip ATX headings (`# …`, `## …`, …). The heading text reaches
 *      rendered output as `<h1>`/`<h2>`/… but we don't synthesize the
 *      element — the line is blanked. A full CommonMark parser would
 *      produce heading elements; we consciously don't (ADR 0025 names
 *      heading hierarchy as an accepted residue gap).
 *   5. Strip Setext headings (`Title\n===` / `Title\n---`). Same
 *      rationale as ATX; additionally, the underline line uses the
 *      same character sequence that can appear in a thematic break,
 *      so we only strip when the preceding line is non-blank prose.
 *   6. Rewrite markdown image syntax `![alt](url)` in place to
 *      `<img src="url" alt="alt">` so existing `media/alt-text-*`
 *      rules (and the rest of the alt-text rule family) evaluate the
 *      alt attribute the same way they would for an HTML `<img>`.
 *      The replacement is wider than the original; remaining
 *      characters on the same line are preserved in order, so
 *      `<img>` positions are line-accurate even if column offsets
 *      shift by a few characters. Findings on subsequent lines are
 *      unaffected.
 *   7. Hand the residue to `parseHtml`. Raw HTML blocks (tables,
 *      iframes, admonition divs, inline `<a>` / `<img>`) pass through
 *      unchanged.
 *
 * Scope the parser reaches (residue-only coverage):
 *   - Embedded HTML — `<table>`, `<iframe>`, `<div class>`, inline
 *     `<a>`, `<img>`, `<figure>`, `<figcaption>`, ...
 *   - Markdown image alt-text — the single most-reported gap in
 *     static-site-generator scans.
 *   - Kramdown IAL (`{: .note .warning}`) — translated to a `class`
 *     attribute on the immediately preceding HTML block element so
 *     `aria/role-from-class-only` and admonition-class rules can see
 *     the pattern. Optional; a missing implementation is documented
 *     rather than hand-rolled around.
 *
 * Scope the parser does not reach (documented gaps, surfaced via
 * `analysisCoverage.hints` in the MCP response):
 *   - Link-text accessibility — `[text](url)` is not rewritten; the
 *     scanner would need a full CommonMark inline parser to recover
 *     the text correctly.
 *   - Heading hierarchy — stripped, not converted.
 *   - Prose readability / contrast — out of scope for any static
 *     scanner without rendered output.
 *
 * Like every ra11y parser: never throws. Returns a partial tree plus
 * `ParseError[]`. Stripped regions are blanked with whitespace so
 * line/column numbers in the surviving tree stay aligned with the
 * original source.
 */

import type { ParseError } from "../../types/ast.ts";
import { type HtmlParseResult, parseHtml } from "./html.ts";
import { applyKramdownIal } from "./markdown-ial.ts";

export function parseMarkdown(source: string): HtmlParseResult {
  const errors: ParseError[] = [];
  // Each strip pass replaces characters with space/newline in a
  // parallel buffer, preserving line positions so downstream findings
  // land on the correct source line.
  const buf = source.split("");
  stripFrontmatter(source, buf);
  stripFencedCodeBlocks(source, buf);
  stripAtxHeadings(source, buf);
  stripSetextHeadings(source, buf);
  stripInlineCodeSpans(source, buf);
  // Image rewrite operates on the current stripped state; it reads
  // `buf` rather than `source` so it can't match syntax inside a
  // fenced code block (which was blanked in pass 2).
  rewriteMarkdownImages(buf);
  applyKramdownIal(buf);
  const transformed = buf.join("");
  const html = parseHtml(transformed);
  return {
    root: html.root,
    errors: [...errors, ...html.errors],
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — frontmatter strip
// ---------------------------------------------------------------------------

/**
 * Strips a leading YAML (`---`) or TOML (`+++`) frontmatter fence. The
 * fence must start at byte 0 and be followed by a newline. A `---`
 * anywhere else in the document is a thematic break or a setext
 * heading underline, not frontmatter.
 */
function stripFrontmatter(source: string, buf: string[]): void {
  const fence = detectFrontmatterFence(source);
  if (fence === null) return;
  let p = fence.length;
  if (source[p] === "\r") p += 1;
  if (source[p] !== "\n") return;
  p += 1;
  const closingIdx = findClosingFrontmatterFence(source, p, fence);
  if (closingIdx === -1) return;
  blankRange(source, buf, 0, closingIdx);
}

function detectFrontmatterFence(source: string): string | null {
  if (source.startsWith("---")) {
    if (source[3] === "-") return null;
    return "---";
  }
  if (source.startsWith("+++")) {
    if (source[3] === "+") return null;
    return "+++";
  }
  return null;
}

function findClosingFrontmatterFence(source: string, startPos: number, fence: string): number {
  let p = startPos;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    const line = source.slice(p, lineEnd);
    if (line === fence) {
      return advancePastNewline(source, lineEnd);
    }
    p = advancePastNewline(source, lineEnd);
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Pass 2 — fenced code block strip
// ---------------------------------------------------------------------------

interface CodeFenceInfo {
  readonly char: "`" | "~";
  readonly length: number;
}

function stripFencedCodeBlocks(source: string, buf: string[]): void {
  let p = 0;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    const line = source.slice(p, lineEnd);
    const fence = detectCodeFence(line);
    if (fence === null) {
      p = advancePastNewline(source, lineEnd);
      continue;
    }
    const blockStart = p;
    const bodyStart = advancePastNewline(source, lineEnd);
    const closingEnd = findCodeFenceClose(source, bodyStart, fence);
    const blockEnd = closingEnd === -1 ? source.length : closingEnd;
    blankRange(source, buf, blockStart, blockEnd);
    p = blockEnd;
  }
}

function detectCodeFence(line: string): CodeFenceInfo | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i += 1;
  const char = line[i];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (line[i + length] === char) length += 1;
  if (length < 3) return null;
  return { char, length };
}

function findCodeFenceClose(source: string, startPos: number, open: CodeFenceInfo): number {
  let p = startPos;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    const line = source.slice(p, lineEnd);
    if (isClosingFence(line, open)) {
      return advancePastNewline(source, lineEnd);
    }
    p = advancePastNewline(source, lineEnd);
  }
  return -1;
}

function isClosingFence(line: string, open: CodeFenceInfo): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i += 1;
  let length = 0;
  while (line[i + length] === open.char) length += 1;
  if (length < open.length) return false;
  for (let j = i + length; j < line.length; j += 1) {
    const ch = line[j];
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pass 3 — inline code span strip
// ---------------------------------------------------------------------------

/**
 * Blanks inline backtick code spans (`` `code` ``). CommonMark allows
 * multi-backtick delimiters (`` ``two backticks`` ``) for spans that
 * themselves contain backticks; we honor that by requiring the close
 * to have the same number of backticks as the open. Multi-line spans
 * are tolerated (the delimiter match runs until it finds the close or
 * EOF). The line-alignment invariant is preserved via `blankRange`.
 *
 * Operates on `source` (not the buffer) because fenced-code-block
 * regions were replaced in `buf` with spaces but `source` still has
 * the backticks — we don't want to re-match a span that was already
 * subsumed by a fence. The caller ensures pass 2 runs before pass 3,
 * and we read `buf` to skip already-blanked regions.
 */
function stripInlineCodeSpans(source: string, buf: string[]): void {
  let p = 0;
  while (p < source.length) {
    if (buf[p] !== source[p] || source[p] !== "`") {
      p += 1;
      continue;
    }
    // Measure the opening run.
    let openLen = 0;
    while (source[p + openLen] === "`") openLen += 1;
    const openEnd = p + openLen;
    // Find a matching close of the same length.
    const closeStart = findMatchingBacktickClose(source, openEnd, openLen);
    if (closeStart === -1) {
      // No close — leave it alone. The HTML parser will see the
      // literal backticks as text.
      p = openEnd;
      continue;
    }
    blankRange(source, buf, p, closeStart + openLen);
    p = closeStart + openLen;
  }
}

function findMatchingBacktickClose(source: string, startPos: number, runLen: number): number {
  let p = startPos;
  while (p < source.length) {
    if (source[p] !== "`") {
      p += 1;
      continue;
    }
    let run = 0;
    while (source[p + run] === "`") run += 1;
    if (run === runLen) return p;
    // A run of different length doesn't match — skip past it so we
    // don't mis-count backticks in `` ```text with a `short` span ``.
    p += run;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Pass 4 — ATX heading strip
// ---------------------------------------------------------------------------

/**
 * Strips ATX headings — lines whose first non-whitespace character is
 * `#` repeated 1-6 times followed by a space or EOL. The full line
 * (through the trailing `\n`, exclusive) is blanked. Per CommonMark
 * the leading `#` can be indented up to 3 spaces.
 */
function stripAtxHeadings(source: string, buf: string[]): void {
  let p = 0;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    if (buf[p] !== source[p]) {
      // Inside a region blanked by an earlier pass — skip.
      p = advancePastNewline(source, lineEnd);
      continue;
    }
    const line = source.slice(p, lineEnd);
    if (isAtxHeading(line)) {
      blankRange(source, buf, p, lineEnd);
    }
    p = advancePastNewline(source, lineEnd);
  }
}

function isAtxHeading(line: string): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i += 1;
  if (line[i] !== "#") return false;
  let hashes = 0;
  while (line[i + hashes] === "#") hashes += 1;
  if (hashes < 1 || hashes > 6) return false;
  const after = line[i + hashes];
  // After the hashes must be a space / tab or the line end.
  if (after === undefined) return true;
  if (after === " " || after === "\t") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Pass 5 — Setext heading strip
// ---------------------------------------------------------------------------

/**
 * Strips Setext-style headings:
 *
 *     Title line
 *     ==========
 *
 *     Subtitle line
 *     -------------
 *
 * A setext underline is a line of `=` or `-` characters (1+) that
 * follows a non-blank prose line. The combined block (title + blank?
 * + underline) is blanked. We require the immediately preceding line
 * to be non-blank and not itself an underline — `-` on its own after
 * a blank is a thematic break, not a setext underline.
 */
function stripSetextHeadings(source: string, buf: string[]): void {
  let p = 0;
  let prevLineStart = -1;
  let prevLineEnd = -1;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    const line = source.slice(p, lineEnd);
    if (
      prevLineStart !== -1 &&
      isSetextUnderline(line) &&
      isNonBlankProseLine(source, buf, prevLineStart, prevLineEnd)
    ) {
      blankRange(source, buf, prevLineStart, lineEnd);
    }
    prevLineStart = p;
    prevLineEnd = lineEnd;
    p = advancePastNewline(source, lineEnd);
  }
}

function isSetextUnderline(line: string): boolean {
  let i = 0;
  while (i < 3 && line[i] === " ") i += 1;
  const ch = line[i];
  if (ch !== "=" && ch !== "-") return false;
  let length = 0;
  while (line[i + length] === ch) length += 1;
  if (length < 1) return false;
  for (let j = i + length; j < line.length; j += 1) {
    const c = line[j];
    if (c !== " " && c !== "\t") return false;
  }
  return true;
}

function isNonBlankProseLine(source: string, buf: string[], start: number, end: number): boolean {
  let sawNonSpace = false;
  for (let i = start; i < end; i += 1) {
    // If the line was already blanked by an earlier pass the buffer
    // holds spaces — don't treat the original content as prose.
    if (buf[i] !== source[i]) return false;
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r") continue;
    sawNonSpace = true;
  }
  if (!sawNonSpace) return false;
  // Reject lines that are themselves an underline (avoid matching two
  // consecutive `====` runs).
  return !isSetextUnderline(source.slice(start, end));
}

// ---------------------------------------------------------------------------
// Pass 6 — markdown image rewrite `![alt](url)` → `<img src="url" alt="alt">`
// ---------------------------------------------------------------------------

/**
 * Rewrites markdown image syntax in the character buffer. The
 * replacement is longer than the original; remaining characters on
 * the same line shift right but stay on the same line, so line-level
 * finding positions remain accurate. The replacement is clamped so
 * it never consumes a newline boundary.
 *
 * Alt text and URLs with embedded `)` / `(` / newlines are not
 * supported — those go through as literal text. The CommonMark spec
 * does allow them via reference links and escaped parentheses; a
 * faithful implementation is larger than the ADR scope allows and
 * the common case (no nested parens, no newlines) covers the
 * overwhelming majority of real-world Jekyll / Hugo / Docusaurus
 * usage.
 */
function rewriteMarkdownImages(buf: string[]): void {
  const text = buf.join("");
  const matches = findImageMatches(text);
  if (matches.length === 0) return;
  // Apply from last to first so offsets of earlier matches stay valid.
  for (let m = matches.length - 1; m >= 0; m -= 1) {
    const match = matches[m];
    if (!match) continue;
    writeReplacement(buf, match);
  }
}

interface ImageMatch {
  readonly start: number;
  readonly end: number;
  readonly alt: string;
  readonly url: string;
}

function findImageMatches(text: string): readonly ImageMatch[] {
  const out: ImageMatch[] = [];
  let p = 0;
  while (p < text.length) {
    if (text[p] !== "!" || text[p + 1] !== "[") {
      p += 1;
      continue;
    }
    const altStart = p + 2;
    const altEnd = findChar(text, altStart, "]", "\n");
    if (altEnd === -1 || text[altEnd] !== "]") {
      p += 1;
      continue;
    }
    if (text[altEnd + 1] !== "(") {
      p += 1;
      continue;
    }
    const urlStart = altEnd + 2;
    const urlEnd = findChar(text, urlStart, ")", "\n");
    if (urlEnd === -1 || text[urlEnd] !== ")") {
      p += 1;
      continue;
    }
    const alt = text.slice(altStart, altEnd);
    const url = text.slice(urlStart, urlEnd).split(/\s+"/)[0] ?? "";
    out.push({ start: p, end: urlEnd + 1, alt, url: url.trim() });
    p = urlEnd + 1;
  }
  return out;
}

/**
 * Returns the offset of the first occurrence of `stop` in `text`
 * starting at `from`, or -1 if the scan hits `breaker` (newline) or
 * EOF first.
 */
function findChar(text: string, from: number, stop: string, breaker: string): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === stop) return i;
    if (ch === breaker) return -1;
  }
  return -1;
}

/**
 * Splices an `<img>` replacement into `buf` at the image-match range.
 * The new length may differ from the original; when the replacement
 * is shorter, the trailing positions are padded with spaces so the
 * buffer's overall length (and line count) is preserved.
 */
function writeReplacement(buf: string[], match: ImageMatch): void {
  const altEscaped = escapeAttr(match.alt);
  const urlEscaped = escapeAttr(match.url);
  const replacement = `<img src="${urlEscaped}" alt="${altEscaped}">`;
  const originalLen = match.end - match.start;
  const replacementChars = replacement.split("");
  if (replacementChars.length <= originalLen) {
    for (let i = 0; i < replacementChars.length; i += 1) {
      buf[match.start + i] = replacementChars[i] ?? " ";
    }
    for (let i = replacementChars.length; i < originalLen; i += 1) {
      buf[match.start + i] = " ";
    }
    return;
  }
  // Replacement is longer. Overwrite the original span in place then
  // splice the remaining characters into the buffer so the array
  // grows; this shifts downstream characters right but keeps them on
  // the same line (the replacement never contains `\n`).
  for (let i = 0; i < originalLen; i += 1) {
    buf[match.start + i] = replacementChars[i] ?? " ";
  }
  const overflow = replacementChars.slice(originalLen);
  buf.splice(match.end, 0, ...overflow);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------------
// Pass 7 — kramdown IAL — implementation lives in `./markdown-ial.ts`.
// ---------------------------------------------------------------------------
// See `applyKramdownIal` imported at the top of this file.

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
