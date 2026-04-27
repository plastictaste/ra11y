/**
 * Elides the contents of triple-backtick fenced code blocks,
 * indented (4-space / tab) code blocks, and single-backtick inline-
 * code spans from a markdown source so downstream template-directive
 * detection doesn't fire on prose examples that QUOTE template
 * syntax — a Jekyll docs page showing `<%= Time.now %>` as an ERB
 * example, a release-note embedding `{% assign %}`.
 *
 * CommonMark fence semantics: opener is 3+ backticks after ≤3 spaces
 * of leading whitespace; closer is a matching fence (≥ opener length,
 * backticks only, optional trailing whitespace) on its own line.
 * Block body is elided to blank lines so line numbers stay stable for
 * any downstream positional analysis. Inline-code spans (single
 * backtick pairs on a line) are replaced with equivalent-length
 * whitespace so column positions stay roughly aligned. Unmatched
 * backticks are left alone — CommonMark treats those as literal, and
 * retaining them is safer than greedily swallowing template-looking
 * text past the end of a real span.
 *
 * Indented code blocks (CommonMark §4.4) are sequences of non-blank
 * lines each indented by 4+ spaces or a tab, with the run preceded by
 * a blank line or document start (otherwise the indent is paragraph
 * continuation, not a code block). The conservative state machine
 * here only enters indented-code mode after a blank line; it exits on
 * the next line that is neither blank nor 4-space-indented. HTML
 * `<pre><code>` sections are out of scope (require AST-level
 * stripping, different concern).
 */

const FENCE_OPEN_RE = /^ {0,3}(`{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})\s*$/;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
const BLANK_LINE_RE = /^\s*$/;

/**
 * Walks past an indented-code-block run starting at `start`, eliding
 * each indented line in `lines` to "" and returning the index of the
 * first line that is NOT part of the run. CommonMark §4.4 lets blank
 * lines sit between indented code lines without breaking the block,
 * provided the next non-blank line is also indented.
 */
function elideIndentedBlock(lines: string[], start: number): number {
  lines[start] = "";
  let last = start;
  let j = start + 1;
  while (j < lines.length) {
    const next = lines[j] ?? "";
    if (BLANK_LINE_RE.test(next)) {
      j++;
      continue;
    }
    if (!INDENTED_CODE_RE.test(next)) break;
    for (let k = last + 1; k <= j; k++) {
      const inner = lines[k] ?? "";
      if (!BLANK_LINE_RE.test(inner)) lines[k] = "";
    }
    last = j;
    j++;
  }
  return last;
}

/**
 * Strips fenced, indented, and inline code regions from a markdown
 * source. Returns the elided string suitable for token detection.
 */
export function stripMarkdownCodeRegions(source: string): string {
  const lines = source.split("\n");
  let fenceLen = 0;
  // True when the previous non-blank handled line was either blank
  // (paragraph break) or the start of the document — i.e. a 4-space
  // indent on the next line is allowed to start an indented code
  // block. False when the previous line was prose, since paragraph
  // continuation lines may also be 4-space-indented.
  let canStartIndentedBlock = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fenceLen > 0) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close !== null && (close[1]?.length ?? 0) >= fenceLen) {
        fenceLen = 0;
        canStartIndentedBlock = false;
      } else {
        lines[i] = "";
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open !== null) {
      fenceLen = open[1]?.length ?? 0;
      canStartIndentedBlock = false;
      continue;
    }
    if (BLANK_LINE_RE.test(line)) {
      canStartIndentedBlock = true;
      continue;
    }
    if (canStartIndentedBlock && INDENTED_CODE_RE.test(line)) {
      i = elideIndentedBlock(lines, i);
      canStartIndentedBlock = false;
      continue;
    }
    lines[i] = line.replace(INLINE_CODE_RE, (m) => " ".repeat(m.length));
    canStartIndentedBlock = false;
  }
  return lines.join("\n");
}
