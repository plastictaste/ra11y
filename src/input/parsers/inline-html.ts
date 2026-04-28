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
 * The companion {@link detectInlineHtmlPatternSamples} runs a broader
 * pattern probe (including jQuery-style `.html(\`…\`)` calls) and returns
 * `{ path, line, pattern }` samples regardless of static/dynamic split.
 * When the routed parser produced zero findings on a file that contained
 * one of these patterns, the samples surface on
 * `warningsDetails.js_innerhtml_template_literal_unparsed.fileSamples[]`
 * so the agent has file:line pointers to investigate the dropped islands.
 * Per the AI-first doctrine "Routing skips that drop content are the
 * symmetric twin of suppression."
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

/**
 * One inline-HTML pattern occurrence in a JS/TS source file. The
 * `pattern` field names which API was used so the agent can route the
 * investigation (e.g. `innerHTML` rewrites are typically static
 * widget-mount calls; `document.write` is usually a legacy shim).
 */
export interface InlineHtmlPatternSample {
  readonly path: string;
  readonly line: number;
  readonly pattern: InlineHtmlPattern;
}

/**
 * Pattern names surfaced on {@link InlineHtmlPatternSample.pattern}. The
 * deterministic-token surface keeps the wire shape stable; agents
 * branch on identity, never on free-form prose.
 */
export type InlineHtmlPattern =
  | "innerHTML"
  | "outerHTML"
  | "insertAdjacentHTML"
  | "document.write"
  | "jquery.html";

// Each entry pairs an InlineHtmlPattern with its detection regex. The
// jQuery `.html(\`…\`)` form is matched conservatively — it only fires
// when the argument is a backtick template literal, mirroring the
// extractor's static/dynamic gating. Order is the iteration order of
// the detector; ties break on first-match so a single source position
// is attributed to one pattern.
const PATTERN_DETECTORS: ReadonlyArray<{
  readonly pattern: InlineHtmlPattern;
  readonly regex: RegExp;
}> = [
  { pattern: "innerHTML", regex: /\.innerHTML\s*=\s*`/g },
  { pattern: "outerHTML", regex: /\.outerHTML\s*=\s*`/g },
  { pattern: "insertAdjacentHTML", regex: /\binsertAdjacentHTML\s*\(/g },
  { pattern: "document.write", regex: /\bdocument\.write(?:ln)?\s*\(/g },
  // jQuery `.html(\`…\`)` — backtick-literal only, mirroring the
  // extractor's static-content predicate. We also accept single/double-
  // quote string args here because the doctrine names jQuery's
  // `.html('…')` shape explicitly; the agent reading the cited line
  // decides whether the content is real HTML or a sentinel string.
  { pattern: "jquery.html", regex: /\.html\s*\(\s*[`'"]/g },
];

/**
 * Hard cap on the number of samples surfaced on
 * `warningsDetails.js_innerhtml_template_literal_unparsed.fileSamples[]`.
 * Five is enough to ground the agent's investigation across the most
 * common shapes; the full set of files is reachable via Grep on the
 * cited patterns.
 */
export const INLINE_HTML_PATTERN_SAMPLE_CAP = 5;

/**
 * Scan a JS/TS source for inline-HTML construction patterns and return
 * up to {@link INLINE_HTML_PATTERN_SAMPLE_CAP} `{ path, line, pattern }`
 * samples. Independent of {@link extractInlineHtmlFragments} — the
 * extractor only handles backtick template literals and gates on
 * static/dynamic; this detector catches the broader pattern surface
 * (including jQuery `.html(...)` and string-literal `.write(...)`)
 * regardless. Callers cross-reference the per-file sample list against
 * the post-scan finding-bearing file set: files with detector matches
 * AND zero findings indicate the routing skip the doctrine names.
 *
 * @param source - Full source text of the JS/TS file.
 * @param filePath - The file's path, used as the `path` field on samples.
 * @returns Up to N samples in source-position order.
 */
export function detectInlineHtmlPatternSamples(
  source: string,
  filePath: string,
): readonly InlineHtmlPatternSample[] {
  const samples: InlineHtmlPatternSample[] = [];
  const seen = new Set<number>();
  for (const { pattern, regex } of PATTERN_DETECTORS) {
    const re = new RegExp(regex.source, "g");
    let match = re.exec(source);
    while (match !== null) {
      const offset = match.index;
      // Dedupe by source offset so a single position isn't attributed
      // to two overlapping patterns (e.g. `.html(\`…\`)` could in
      // principle match ahead of a future pattern at the same offset).
      if (!seen.has(offset)) {
        seen.add(offset);
        const line = countNewlines(source, 0, offset) + 1;
        samples.push({ path: filePath, line, pattern });
      }
      match = re.exec(source);
    }
  }
  // Sort by line so the wire shape is deterministic across runs even
  // when two patterns match at distinct offsets on the same line.
  samples.sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
  return samples.slice(0, INLINE_HTML_PATTERN_SAMPLE_CAP);
}

/**
 * Per-JS/TS-file inline-HTML pass used by the MCP parse helpers:
 * extracts static template literals as synthetic `ParsedFile`
 * fragments (so rules run against the injected markup), records
 * dynamic-literal declines for the warning-channel signal, and stamps
 * the broader detector's per-file sample list onto `samplesByPath`.
 * Returns the file's declined count for the caller to accumulate.
 *
 * Extracted from `tools-helpers.ts`'s parse loop so the orchestrator
 * there stays under the per-file budget as new evidence axes accrete
 * — the inline-HTML pipeline is a single concept with two outputs
 * (synthetic fragments + warning telemetry) and belongs alongside its
 * sibling extractors in this module.
 */
export function accumulateInlineHtml(
  result: ParsedFile,
  parsed: ParsedFile[],
  samplesByPath: Map<string, readonly InlineHtmlPatternSample[]>,
): number {
  const { fragments, declined } = extractInlineHtmlFragments(result.source, result.filePath);
  parsed.push(...fragments);
  const samples = detectInlineHtmlPatternSamples(result.source, result.filePath);
  if (samples.length > 0) samplesByPath.set(result.filePath, samples);
  return declined;
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
