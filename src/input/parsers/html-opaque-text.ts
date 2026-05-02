/**
 * Opaque-text element handling for the HTML parser.
 *
 * Documentation pages routinely use `<code>` and `<pre>` to display
 * literal HTML examples — sometimes balanced, sometimes intentionally
 * showing only a close tag like `</button>` for narrative purposes. A
 * strict tag-walker reads those as nested DOM and emits stray-close
 * diagnostics that route the file into
 * `analysisCoverage.partialParseFiles[]`. Browsers tolerate the same
 * input fine because `<code>` content renders text-as-text; this
 * carve-out aligns ra11y's parse model with that pragmatic reading.
 *
 * Per the HTML Living Standard neither `<code>` nor `<pre>` is a
 * formal raw-text element (only `<script>` and `<style>` are), so the
 * carve-out is intentional and narrowly scoped — do not extend to
 * other elements unless evidence of an analogous documentation-snippet
 * failure mode warrants. Trade-off: anchors / interactive elements
 * literally nested inside `<code>` / `<pre>` no longer surface as
 * parsed elements (they become text). That's the intended outcome —
 * content shown as a code example is documentation prose, not a live
 * control; findings on real (non-`<code>`) anchors elsewhere in the
 * document are unaffected.
 *
 * Extracted from `html.ts` so the parent file stays under the
 * file-LOC budget and `#consumeChildren` stays under the cognitive-
 * complexity budget.
 */

/**
 * Elements whose text content is treated as opaque (CDATA-like).
 *
 * Differs from the parser's `RAW_TEXT_ELEMENTS` set on one axis:
 * opaque-text elements balance same-tag nesting (the canonical
 * `<pre><code>...</code></pre>` documentation snippet inside an outer
 * `<pre>` block still parses cleanly). Other tags (including
 * unrelated openers like `<button>` shown as example markup) are NOT
 * recognised — they advance one character at a time as opaque text.
 */
export const OPAQUE_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["code", "pre"]);

/** True when `tag` (case-insensitive) is in {@link OPAQUE_TEXT_ELEMENTS}. */
export function isOpaqueTextElement(tag: string): boolean {
  return OPAQUE_TEXT_ELEMENTS.has(tag.toLowerCase());
}

/**
 * Returns true when the source at `pos` starts a same-tag opener
 * `<TAG ...>` whose name matches `tagLower` (case-insensitive). Used
 * by the parser's opaque-text consumer to balance same-tag nesting
 * depth. The follow-character check matches the closing-tag
 * predicate so an opener whose tag name shares a prefix with the
 * watched tag (e.g. `<pre>` vs. a hypothetical `<preview>`) is not
 * incorrectly treated as a same-tag opener.
 */
export function startsWithSameTagOpener(source: string, pos: number, tagLower: string): boolean {
  if (source[pos] !== "<") return false;
  const after = source.slice(pos + 1, pos + 1 + tagLower.length);
  if (after.toLowerCase() !== tagLower) return false;
  const follow = source[pos + 1 + tagLower.length];
  return follow === ">" || follow === " " || follow === "\t" || follow === "\n" || follow === "/";
}

/**
 * Returns true when the source at `pos` starts a closing tag
 * `</TAG>` whose name matches `tagLower` (case-insensitive). Mirrors
 * the parser's `#startsWithClosingTag` predicate — duplicated here
 * (rather than imported) so this module stays self-contained and
 * the parser keeps its single-source `#startsWithClosingTag` for
 * the non-opaque path.
 */
export function startsWithClosingTagName(source: string, pos: number, tagLower: string): boolean {
  if (source[pos] !== "<" || source[pos + 1] !== "/") return false;
  const after = source.slice(pos + 2, pos + 2 + tagLower.length);
  if (after.toLowerCase() !== tagLower) return false;
  const follow = source[pos + 2 + tagLower.length];
  return follow === ">" || follow === " " || follow === "\t" || follow === "\n" || follow === "/";
}

/**
 * Scans an opaque-text body starting at `startOffset`, balancing
 * same-tag nesting depth. Returns the offset where the matching
 * outer `</TAG>` begins (or EOF when no matching close is found —
 * the caller treats this the same as the raw-text EOF case).
 *
 * Tag-recognition is suspended inside the body — a literal `</ul>`
 * shown for narrative purposes in a documentation snippet is treated
 * as text, not as a stray-close diagnostic. Same-tag openers and
 * closers ARE recognised so depth balancing stays accurate; other
 * tags advance one character at a time as opaque text.
 *
 * Pure offset arithmetic — no line/column tracking, no error
 * recording. The parser owns those concerns.
 */
export function scanOpaqueTextBody(source: string, startOffset: number, tagLower: string): number {
  let pos = startOffset;
  const len = source.length;
  let depth = 1;
  while (pos < len) {
    if (startsWithClosingTagName(source, pos, tagLower)) {
      depth -= 1;
      if (depth === 0) return pos;
      // Inner same-tag closer — advance past it as opaque text so the
      // outer matching-close detector keeps scanning.
      pos = skipPastTagTerminator(source, pos + 2);
      continue;
    }
    if (startsWithSameTagOpener(source, pos, tagLower)) {
      depth += 1;
      // Advance past the inner same-tag opener (quote-aware) so a
      // `>` inside an attribute value doesn't mis-balance depth.
      pos = skipOpaqueStartTagBody(source, pos + 1);
      continue;
    }
    pos += 1;
  }
  return pos;
}

/**
 * Advances past a start-tag body inside an opaque-text element.
 * Quote-aware so a `>` inside an attribute value doesn't terminate
 * the tag prematurely. Returns the offset one char past the
 * terminating `>` (or `len` at EOF). Pure offset arithmetic.
 */
export function skipOpaqueStartTagBody(source: string, startOffset: number): number {
  let pos = startOffset;
  const len = source.length;
  let inQuote: '"' | "'" | null = null;
  while (pos < len) {
    const ch = source[pos];
    if (inQuote !== null) {
      if (ch === inQuote) inQuote = null;
      pos += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      pos += 1;
      continue;
    }
    if (ch === ">") return pos + 1;
    pos += 1;
  }
  return pos;
}

/**
 * Advances past a tag's terminator `>` (or EOF). Used by the inner
 * same-tag closer branch of {@link scanOpaqueTextBody}.
 */
function skipPastTagTerminator(source: string, startOffset: number): number {
  let pos = startOffset;
  const len = source.length;
  while (pos < len && source[pos] !== ">") pos += 1;
  if (pos < len) pos += 1; // consume the `>`
  return pos;
}
