/**
 * Line-statistics helpers for the build-artifact long-line
 * corroborator. Extracted from `build-artifacts.ts` so the parent
 * module stays under the file-line cap. Pairs with the
 * `likely-minified-by-line-stats` classification: the helpers below
 * walk a source string once to derive the count-floor, ratio, and
 * median predicates the corroborator consumes.
 *
 * Exposed as a generic helper that takes the long-line threshold as
 * a parameter so the parent owns the canonical
 * `MINIFIED_LINE_THRESHOLD` constant. The data-URL deduction is
 * folded in here (long lines whose >threshold reach is dominated by
 * an inline `data:` URL have their length replaced by the residual
 * length, and are reported separately on
 * `dataUrlDominatedLongLineCount` so the parent can apply the
 * deduction to count-floor / ratio without re-scanning).
 *
 * Self-contained — imports only the data-URL helper sibling.
 */

import { longestDataUrlPayloadLength } from "./build-artifacts-data-url.ts";

/**
 * Result shape returned by {@link computeLineStats}. The parent
 * corroborator deducts `dataUrlDominatedLongLineCount` from
 * `longLineCount` before applying the count-floor / ratio predicates.
 * The median already consumes the deducted distribution: long lines
 * dominated by a `data:` URL payload contribute their residual
 * length (line.length - longest data-URL length) to the median
 * computation, so the median branch reflects the file's authored-
 * content distribution rather than its inlined-asset bytes.
 */
export interface LineStats {
  readonly totalLines: number;
  readonly longLineCount: number;
  readonly medianLineLength: number;
  readonly maxLineLength: number;
  readonly dataUrlDominatedLongLineCount: number;
}

/**
 * One contiguous line-statistics scan returning every corroboration
 * predicate input in a single pass. Splitting into separate loops
 * would double the hot-path work on every parsed file; folding them
 * here keeps the helper O(N) with one pass plus one sort for the
 * median. Empty input returns zeroed stats — the caller must treat
 * a zero-line file as "no corroboration" to avoid a degenerate
 * median.
 *
 * `maxLineLength` rides along (zero extra work — a running max over
 * the same lengths) so the corroborator can stamp it into the
 * structured signal as the deterministic `value`: the agent reading
 * `value: 712, threshold: 500` knows exactly which line shape
 * carried the verdict.
 */
export function computeLineStats(source: string, longLineThreshold: number): LineStats {
  if (source.length === 0) {
    return {
      totalLines: 0,
      longLineCount: 0,
      medianLineLength: 0,
      maxLineLength: 0,
      dataUrlDominatedLongLineCount: 0,
    };
  }
  const lines = collectLines(source);
  let longLineCount = 0;
  let maxLineLength = 0;
  let dataUrlDominatedLongLineCount = 0;
  const effectiveLengths: number[] = new Array<number>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const len = line.length;
    let effectiveLen = len;
    if (len > longLineThreshold) {
      longLineCount += 1;
      const longestDataUrl = longestDataUrlPayloadLength(line);
      if (longestDataUrl > 0 && len - longestDataUrl <= longLineThreshold) {
        dataUrlDominatedLongLineCount += 1;
        effectiveLen = len - longestDataUrl;
      }
    }
    effectiveLengths[i] = effectiveLen;
    if (len > maxLineLength) maxLineLength = len;
  }
  return {
    totalLines: effectiveLengths.length,
    longLineCount,
    medianLineLength: medianOfUnsortedLengths(effectiveLengths),
    maxLineLength,
    dataUrlDominatedLongLineCount,
  };
}

/**
 * Walks `source` once and returns one entry per line with its raw
 * string contents. CRLF sequences fold to a single line break so
 * Windows-authored / Windows-checked-out files report the same line
 * count as POSIX ones. A trailing line without a terminator still
 * counts as one line. A trailing line break does NOT spawn a phantom
 * empty entry — `wc -l + 1` semantics for unterminated input,
 * `wc -l` semantics for terminated. (Without this skip, a minified
 * bundle ending with a Windows-style trailing `\r\n` after one
 * 700-char run would report `[700, 0]`, dragging the median to 350
 * and silently dropping the corroborator's median conjunct.) Returns
 * line strings (not just lengths) so the data-URL deduction can
 * inspect content without a second linear pass.
 */
function collectLines(source: string): readonly string[] {
  const lines: string[] = [];
  let lineStart = 0;
  let lastWasCR = false;
  let lastWasTerminator = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10 || ch === 13) {
      if (ch === 10 && lastWasCR) {
        lastWasCR = false;
        lastWasTerminator = true;
        lineStart = i + 1;
        continue;
      }
      lines.push(source.slice(lineStart, i));
      lastWasCR = ch === 13;
      lastWasTerminator = true;
      lineStart = i + 1;
      continue;
    }
    lastWasCR = false;
    lastWasTerminator = false;
  }
  if (!lastWasTerminator) lines.push(source.slice(lineStart));
  return lines;
}

/**
 * Median of `lengths` by sorting a COPY (the caller owns the scratch
 * array, we don't mutate it). Empty input → 0; even lengths average
 * the middle two (floored — medians of integer line lengths stay
 * integer for easy comparison against the threshold).
 */
function medianOfUnsortedLengths(lengths: readonly number[]): number {
  if (lengths.length === 0) return 0;
  const sorted = [...lengths].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.floor(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}
