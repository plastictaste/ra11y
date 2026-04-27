/**
 * Inline-HTML fragment extractor for JavaScript and TypeScript files.
 *
 * Detects `innerHTML = \`...\``, `insertAdjacentHTML(pos, \`...\`)`,
 * `document.write(\`...\`)`, and `outerHTML = \`...\`` patterns in JS/TS
 * source and — when the template literal content is static (no `${…}`
 * interpolations) — parses the HTML substring and returns a synthetic
 * `ParsedFile` so the full rule pipeline sees the injected markup.
 *
 * When the literal contains interpolations (dynamic content), extraction
 * is declined and the caller receives a `declined` count > 0 — this is
 * the signal for emitting `js_innerhtml_template_literal_unparsed` on
 * the scan response so an agent knows static analysis missed the islands.
 *
 * Design note: the extractor is deliberately conservative. Only backtick
 * template literals are targeted — string-literal concatenations, `+`
 * expressions, and variable references are not resolved. The agent's own
 * Read + Grep pass is the right arbiter for those; our job is to point
 * and annotate, not to guess.
 */

import type { ParsedFile } from "../../engine/scanner.ts";
import { parseHtml } from "./html.ts";

/**
 * Result of the extraction pass.
 *
 * `fragments` — synthetic `ParsedFile` entries (one per static template
 * literal found). Each uses a virtual path `<filePath>:innerHTML:L<line>`
 * so findings are attributed to the source JS file + approximate line.
 *
 * `declined` — count of innerHTML/insertAdjacentHTML/document.write
 * patterns that were detected but NOT extracted because the template
 * literal contained `${…}` interpolations. A non-zero value signals that
 * the caller should emit `js_innerhtml_template_literal_unparsed`.
 */
export interface InlineHtmlExtractResult {
  readonly fragments: readonly ParsedFile[];
  readonly declined: number;
}

// Matches the keyword/assignment up to and including the opening backtick.
// Covers: `.innerHTML = \``, `.outerHTML = \``, `insertAdjacentHTML(pos, \``,
// `document.write(\`` and `document.writeln(\``.
const INNERHTML_PATTERN =
  /(?:\.innerHTML\s*=\s*`|\.outerHTML\s*=\s*`|insertAdjacentHTML\s*\([^,)]*,\s*`|document\.write(?:ln)?\s*\(\s*`)/g;

/**
 * Extract static HTML content from innerHTML/insertAdjacentHTML/
 * document.write/outerHTML template literals in a JS/TS source string.
 *
 * @param source - Full source text of the JS/TS file.
 * @param filePath - The file's path, used to build virtual fragment paths.
 * @returns Extracted fragments and declined count (dynamic literals).
 */
export function extractInlineHtmlFragments(
  source: string,
  filePath: string,
): InlineHtmlExtractResult {
  const fragments: ParsedFile[] = [];
  let declined = 0;

  const re = new RegExp(INNERHTML_PATTERN.source, "g");
  let match = re.exec(source);
  while (match !== null) {
    // The backtick is the last character of the match.
    const backtickOffset = match.index + match[0].length - 1;
    // Count newlines before the backtick to determine the source line.
    const line = countNewlines(source, 0, backtickOffset) + 1;
    // Scan from the character after the opening backtick.
    const result = scanTemplateLiteralBody(source, backtickOffset + 1);

    if (result.hasDynamic || result.content === null) {
      declined++;
    } else {
      // Static template literal — parse its content as HTML.
      const { root, errors } = parseHtml(result.content);
      fragments.push({
        filePath: `${filePath}:innerHTML:L${line}`,
        source: result.content,
        ast: { language: "html", root, errors },
      });
    }

    // Advance past the end of the literal so we don't re-enter it.
    re.lastIndex = result.endOffset;
    match = re.exec(source);
  }

  return { fragments, declined };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Count newline characters in `source` between `start` and `end` (exclusive). */
function countNewlines(source: string, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) {
    if (source[i] === "\n") n++;
  }
  return n;
}

/**
 * Advance through a template literal body tracking expression-block depth.
 * Called from `scanTemplateLiteralBody` after the dynamic `${` marker is seen.
 * Returns the offset just after the matching `}` at depth 0.
 */
function skipExpressionBlock(source: string, startAfterDollarBrace: number): number {
  let depth = 1;
  let i = startAfterDollarBrace;
  const len = source.length;
  while (i < len && depth > 0) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

/**
 * Scan a template literal body starting at `pos` (the character AFTER the
 * opening backtick). Returns the static content (or `null` when unterminated),
 * whether it has dynamic expressions, and the offset just past the closing
 * backtick.
 *
 * Split into body-scan + expression-block helper so each function stays
 * within the cognitive-complexity budget.
 */
function scanTemplateLiteralBody(
  source: string,
  pos: number,
): { content: string | null; hasDynamic: boolean; endOffset: number } {
  let i = pos;
  let hasDynamic = false;
  const len = source.length;

  while (i < len) {
    const ch = source[i];
    if (ch === "\\") {
      // Escaped character inside the template literal body — skip two chars.
      i += 2;
      continue;
    }
    if (ch === "`") {
      return { content: source.slice(pos, i), hasDynamic, endOffset: i + 1 };
    }
    if (ch === "$" && source[i + 1] === "{") {
      hasDynamic = true;
      i = skipExpressionBlock(source, i + 2);
      continue;
    }
    i++;
  }

  // Unterminated template literal — decline.
  return { content: null, hasDynamic, endOffset: i };
}
