/**
 * Minified-file locator enrichment for the `review/timing` finder.
 *
 * When a `setTimeout` / `setInterval` candidate's cited file is a
 * minified bundle — `.min.` infix in the basename OR a single line
 * longer than {@link MINIFIED_LINE_ENRICHMENT_THRESHOLD} chars — the
 * bare `line:column` pointer on the emitted candidate is
 * definitionally unhelpful: all matches sit on the same long line,
 * and the per-match column values are invisible to the agent reading
 * a compact display ("bootstrap.min.js:6 col 1" eight times over on
 * the same six-line minified bundle is the canonical field-report
 * shape).
 *
 * This module supplies {@link minifiedLocatorClause}, which the
 * finder appends to its reason text in that narrow case. The clause
 * restates the offset as a byte column within the enclosing line
 * AND echoes a ~80-char substring surrounding the match so the agent
 * can locate the specific call without guessing (`grep` on the
 * echoed substring, or `Read` within the echoed column range).
 *
 * Kept local to `src/review/` rather than sharing the
 * build-artifact classifier in `src/mcp/build-artifacts.ts`:
 *
 *   - Thresholds differ on purpose. The build-artifact classifier
 *     fires on a 500-char single line to label the file a build
 *     artifact in `scannedBuildArtifacts`. This reason-text
 *     enrichment holds out for 1000 chars — the bar for "a
 *     `line:column` pointer is definitionally unhelpful here" is
 *     higher than "this file is machine-output," and a 600-char
 *     authored Tailwind `@apply` line should not get "minified
 *     file" prose attached to its setTimeout calls.
 *   - `src/review/` finders stay decoupled from `src/mcp/` so the
 *     finder layer remains a content layer, not a consumer of MCP
 *     response machinery.
 *
 * Doctrine: additive reason enrichment, not suppression — the
 * candidate still surfaces through `files[]` / `candidates[]` at
 * the same confidence (medium). See
 * `docs/kb/architecture/ai-first-consumer.md`.
 */

import { truncateForEcho } from "../../engine/ast-helpers.ts";

/**
 * Byte-count threshold above which a single uninterrupted line is
 * treated as minified machine output for reason-text-enrichment
 * purposes.
 *
 * Deliberately higher than the build-artifact classifier's
 * general-purpose 500 (see `src/mcp/build-artifacts.ts`): the
 * enrichment only earns its place when the cited `line:column`
 * pointer is *definitionally unhelpful* because the file collapses
 * to one line. A 600-char authored Tailwind `@apply` line or a long
 * data-attribute literal is not that — it would get a misleading
 * "minified file" framing. 1000 chars is the working floor above
 * which the file is effectively guaranteed to be machine emitted
 * and the agent needs the intra-line offset + context window to
 * locate any specific call.
 */
const MINIFIED_LINE_ENRICHMENT_THRESHOLD = 1000;

/**
 * Half-width (in chars) of the context window echoed around a minified
 * match in the reason text. Total window is `2 * N` characters centered
 * on the call-site offset, trimmed to the enclosing line bounds. 40 is
 * enough to surface a handful of adjacent identifiers (common enough
 * in minified bundles that a variable sequence like `,f,u,s` is a
 * disambiguating anchor) without bloating the reason beyond readable
 * length on eight+ same-line matches in one response.
 */
const MINIFIED_CONTEXT_HALF_WIDTH = 40;

/** `.min.` infix (case-sensitive) in the basename. */
const MIN_INFIX_RE = /\.min\./u;

/**
 * Build the optional minified-file locator clause appended to a
 * setTimeout / setInterval reason when the cited file's basename
 * carries a `.min.` infix OR the file's first line is longer than
 * {@link MINIFIED_LINE_ENRICHMENT_THRESHOLD} chars.
 *
 * Returns `""` when the enrichment does not apply — the caller
 * concatenates unconditionally so present-when-meaningful is honest
 * at the reason-text level without sprinkling conditionals through
 * the assembly path.
 *
 * Scoped to the enclosing line on both sides: if the match sits 20
 * chars from the start of a 50 KB line, the window starts at col 1
 * rather than spilling backward across the preceding newline. The
 * echoed substring is passed through {@link truncateForEcho} with an
 * 80-char cap so any pathological minified run of non-whitespace
 * can't balloon the reason.
 */
export function minifiedLocatorClause(filePath: string, source: string, offset: number): string {
  if (!isMinifiedForEnrichment(filePath, source)) return "";
  const { lineStart, lineEnd } = enclosingLineBounds(source, offset);
  const byteCol = offset - lineStart + 1;
  const windowStart = Math.max(lineStart, offset - MINIFIED_CONTEXT_HALF_WIDTH);
  const windowEnd = Math.min(lineEnd, offset + MINIFIED_CONTEXT_HALF_WIDTH);
  const context = source.slice(windowStart, windowEnd);
  // Collapse any interior line terminators (shouldn't exist inside a
  // single line but defensive) so the clause stays on one line.
  const collapsed = context.replace(/[\r\n]+/g, " ");
  const echoed = truncateForEcho(collapsed, 80);
  return ` (minified file — match at byte col ${byteCol} within context \`${echoed}\`)`;
}

/**
 * True when the file should get the minified-locator enrichment. A
 * `.min.` infix in the basename is canonical (pre-minified bundle)
 * and a single line longer than
 * {@link MINIFIED_LINE_ENRICHMENT_THRESHOLD} chars is strong enough
 * evidence on its own. Either alone suffices; both can hold on the
 * same file. The check stays O(source length) via a single linear
 * scan that short-circuits as soon as one line crosses the
 * threshold.
 *
 * Also exposed as a public predicate so finders can populate the
 * structured `ReviewCandidate.vendorPathHint` field — the same
 * "this looks like minified third-party / build-output code" signal
 * the reason-text enrichment surfaces as prose, available as a
 * typed boolean for agents that prefer not to parse free-form text.
 * Strictly additive: never gates suppression or downgrades the
 * candidate.
 */
export function isMinifiedForEnrichment(filePath: string, source: string): boolean {
  const basename = basenameOf(filePath);
  if (MIN_INFIX_RE.test(basename)) return true;
  return hasLongSingleLine(source, MINIFIED_LINE_ENRICHMENT_THRESHOLD);
}

/**
 * Returns the offset of the start and end (exclusive of the line
 * terminator) of the line that contains `offset`. Handles both LF
 * and CRLF terminators — walking backward to the nearest `\n` for
 * the start and forward to the next `\n` or `\r` for the end so a
 * CRLF-terminated single line doesn't echo the trailing `\r`.
 */
function enclosingLineBounds(
  source: string,
  offset: number,
): { readonly lineStart: number; readonly lineEnd: number } {
  let lineStart = 0;
  for (let i = Math.min(offset, source.length) - 1; i >= 0; i--) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      lineStart = i + 1;
      break;
    }
  }
  let lineEnd = source.length;
  for (let i = offset; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10 /* \n */ || c === 13 /* \r */) {
      lineEnd = i;
      break;
    }
  }
  return { lineStart, lineEnd };
}

/**
 * O(N) scan returning true when any single uninterrupted line in
 * `source` is longer than `threshold` characters. Same shape as
 * `hasLongMinifiedLine` in `src/mcp/build-artifacts.ts` but
 * parameterized on the threshold so the review-finder's higher
 * (1000-char) bar can coexist with the build-artifact classifier's
 * lower (500-char) bar without one triggering the other's prose.
 * Duplicated locally rather than cross-imported to keep `src/review/`
 * decoupled from `src/mcp/` — finders are content, not MCP-layer
 * code.
 */
function hasLongSingleLine(source: string, threshold: number): boolean {
  let runLength = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 10 || ch === 13) {
      runLength = 0;
      continue;
    }
    runLength++;
    if (runLength > threshold) return true;
  }
  return false;
}

function basenameOf(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}
