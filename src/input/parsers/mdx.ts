/**
 * In-house MDX parser — v0.1.x minimal adapter.
 *
 * MDX is Markdown + embedded JSX: prose, headings, lists, code fences,
 * plus JSX elements and imports/exports at the module level. A
 * faithful MDX compiler (micromark + mdast-util-mdx + remark + rehype)
 * is thousands of lines and zero-dep-incompatible. But the authoring
 * surface a11y rules care about — `<img>` with or without alt, `<a>`
 * link text, custom components with ARIA props, heading structure
 * inside JSX — is the JSX subset, and the JSX subset is statically
 * recoverable by the existing TSX parser.
 *
 * Strategy (same adapter pattern as `parseScss`): pre-transform MDX
 * source into TSX-equivalent source, then delegate to `parseTsx`. The
 * output is a `TsxParseResult` with exactly the AST shape the TSX
 * parser emits, so downstream rules (alt-text, link-text, heading
 * rules, etc.) need zero changes.
 *
 * Transform passes (in order):
 *
 *   1. Strip leading YAML/TOML frontmatter (`---\n…\n---\n` or
 *      `+++\n…\n+++\n`). Frontmatter is data, not authored surface.
 *   2. Strip fenced code blocks (``` or ~~~). Their content is
 *      illustrative, not rendered; stripping prevents accidental JSX
 *      detection inside prose examples like ```` ```jsx\n<img/>\n``` ````.
 *   3. Strip indented code blocks (4-space- or tab-indented blocks
 *      following a blank line). Same rationale as fenced — these are
 *      illustrative HTML/JSX samples in MDX docs, and CommonMark also
 *      uses this form when a fence sits inside a list item past the
 *      3-space fence-indent ceiling (the fence is then unrecognized
 *      and the surrounding lines act as plain indented code). The
 *      "must follow a blank line" guard protects authored JSX whose
 *      children are 4-space-indented (e.g. a `<Card>` at column 0
 *      with `<CardBody>` at column 4 — those rows are part of the
 *      JSX block, not a code block).
 *      Spec: https://spec.commonmark.org/0.31.2/#indented-code-blocks
 *      Symmetry with `parseMarkdown`'s pass 3: both `.md` and `.mdx`
 *      pipelines strip the same three code forms (fenced + indented +
 *      inline) so downstream consumers cannot drift on whether
 *      illustrative samples bleed through.
 *   4. Strip inline code spans (`` `…` ``). Same rationale at the
 *      paragraph-inline scale — `` `<iframe>` `` in prose is a
 *      formatted code mention, not a rendered element. Symmetry with
 *      `parseMarkdown`'s inline-code pass: both `.md` and `.mdx`
 *      pipelines expose the same residual shape so downstream
 *      consumers (the TSX scanner today, any future token-walking
 *      finder) cannot drift on whether prose backticks are visible.
 *   5. Strip top-level `import` / `export` statements. These are ESM
 *      module wiring — they can contain `<` characters (`Array<T>` in
 *      TS-style exports) that would confuse the TSX scanner. They also
 *      don't contribute authored DOM.
 *   6. Hand the residual to `parseTsx`. Its top-level scanner skips
 *      arbitrary prose between JSX tags via `#scanToJsx`, so naked
 *      markdown (headings, paragraphs, lists, bold/italic) just flows
 *      past until the next `<TagName` is found.
 *
 * Like every ra11y parser: never throws. Returns a partial tree plus
 * `ParseError[]`. Stripped regions are blanked with whitespace so
 * line/column numbers in the surviving tree stay aligned with the
 * original source — critical for accurate finding locations.
 *
 * Scope (minimal, honest):
 *   - Frontmatter, code fences, and imports/exports stripped.
 *   - JSX blocks parsed by the TSX adapter — covers the bulk of
 *     `<Component>` / `<html-tag>` authoring in MDX.
 *   - Markdown prose flows past the TSX scanner without being
 *     interpreted as JSX (heuristic: `<` followed by a space or
 *     non-identifier character isn't a tag start).
 *
 * Out of scope (honest pass-through or parse-error):
 *   - MDX expressions at document scope (`{frontmatter.title}`) — not
 *     interpreted; the TSX scanner treats `{` as a normal character
 *     outside JSX. No a11y signal in them today.
 *   - MDX v1 `export default function Layout({ children })` wrappers —
 *     stripped with the rest of the `export` line; any JSX inside a
 *     multi-line export is lost. Single-line exports are the common
 *     case in Astro/Docusaurus/Next.js MDX.
 */

import type { ParseError, TsxModule } from "../../types/ast.ts";
import {
  type CodeDemoPropMatch,
  DEFAULT_EXAMPLE_COMPONENT_NAMES,
  extractMdxExampleCode,
} from "./mdx-example-extractor.ts";
import { parseTsx, type TsxParseResult } from "./tsx.ts";

/**
 * Optional knobs for {@link parseMdx}. Omitted callers get the v0.1.x
 * default behaviour: the docs-component code-prop extractor runs
 * against the built-in allow-list (`Example` / `Demo` / `Playground`).
 */
export interface MdxParseOptions {
  /**
   * Allow-list of MDX JSX component names whose `code` prop carries a
   * template-literal HTML body to extract and re-parse through the
   * HTML pipeline. Default: `Example`, `Demo`, `Playground` (the
   * Starlight / Bootstrap-docs / Next-docs convention).
   *
   * Pass an empty array to disable the extractor entirely — useful for
   * pipelines that want the v0.0.x behaviour while the docs-component
   * substrate is honest-to-track via a separate pass.
   */
  readonly exampleComponentNames?: readonly string[];
}

/**
 * Extended {@link TsxParseResult} for the MDX adapter. Carries the
 * verbatim shape `parseTsx` returns plus a present-when-meaningful
 * `codeDemoPropMatches` side-channel describing every successful
 * descent into a code-demo prop's template-literal body — see
 * {@link import("./mdx-example-extractor.ts").CodeDemoPropMatch}.
 *
 * Drives the corpus-level `jsx_code_demo_prop_parsed_as_live_dom`
 * warning + per-finding `couldBeWrongBecause` propagation: agents
 * reading findings emitted on synthesized elements derived from a
 * code-demo prop's body need both the warning-channel breadcrumb (the
 * scan saw at least one descent on this corpus) and the per-finding
 * triage signal (THIS finding fired inside a descent). The MDX adapter
 * is the only parser entry point that descends today, so this is the
 * source of truth for the evidence the downstream aggregator consumes.
 *
 * Omitted entirely when the extractor produced no matches — the
 * present-when-meaningful contract per CLAUDE.md §1 "Ambiguous field
 * shapes are dishonest." Consumers that ignore the field still see a
 * structurally-identical `TsxParseResult`; consumers that branch on it
 * read a definite array when it's there.
 */
export interface MdxParseResult extends TsxParseResult {
  readonly codeDemoPropMatches?: readonly CodeDemoPropMatch[];
}

export function parseMdx(source: string, options: MdxParseOptions = {}): MdxParseResult {
  const errors: ParseError[] = [];
  // Each pass operates on the character buffer and replaces stripped
  // regions with space/newline so downstream line numbers match the
  // original source.
  const buf = source.split("");
  stripFrontmatter(source, buf);
  stripFencedCodeBlocks(source, buf);
  // Indented-code-block strip runs AFTER fenced strip so a fence's
  // own 4-space-indented content lines aren't subjected to the
  // indented-code rules; runs BEFORE inline-code so an indented
  // block's backticks don't trip the inline pass. Mirrors the order
  // in `parseMarkdown`.
  stripIndentedCodeBlocks(source, buf);
  stripInlineCodeSpans(source, buf);
  stripImportExportLines(source, buf);
  const transformed = buf.join("");
  const tsx = parseTsx(transformed);
  // Starlight / Docusaurus / Next MDX docs pipelines routinely embed
  // rendered HTML previews inside `<Example code={`…`}/>` props. The
  // TSX parser sees only the component with an opaque expression
  // attribute; the HTML body inside the template literal never enters
  // the JSX element stream, so HTML-bearing rules silently skip ~110
  // real-world docs files (bootstrap docs site alone). The extractor
  // parses the template body as HTML and appends synthesized JSX
  // elements anchored to the original MDX source positions, so rules
  // like `forms/labels-required` fire on the substrate they'd
  // otherwise miss. See `mdx-example-extractor.ts` header for the
  // substitution-free / template-literal-only gates.
  const allowList = options.exampleComponentNames ?? DEFAULT_EXAMPLE_COMPONENT_NAMES;
  const extracted = extractMdxExampleCode(source, tsx.root, allowList);
  const root: TsxModule =
    extracted.elements.length === 0
      ? tsx.root
      : {
          kind: tsx.root.kind,
          range: tsx.root.range,
          loc: tsx.root.loc,
          jsxElements: [...tsx.root.jsxElements, ...extracted.elements],
        };
  return {
    root,
    errors: [...errors, ...tsx.errors, ...extracted.errors],
    ...(extracted.propMatches.length === 0 ? {} : { codeDemoPropMatches: extracted.propMatches }),
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — frontmatter strip
// ---------------------------------------------------------------------------

/**
 * Strips a leading frontmatter fence. Accepts `---\n…\n---\n` (YAML)
 * and `+++\n…\n+++\n` (TOML). The fence must start at byte 0; a
 * `---` anywhere else is a thematic-break and belongs to prose.
 *
 * Non-fenced sources (no leading `---` or `+++`) are a no-op.
 */
function stripFrontmatter(source: string, buf: string[]): void {
  const fence = detectFrontmatterFence(source);
  if (fence === null) return;
  // Find the closing fence on its own line.
  // The opening fence occupies offsets [0, fence.length], followed by
  // a newline — start scanning from after that newline.
  let p = fence.length;
  if (source[p] === "\r") p += 1;
  if (source[p] !== "\n") return;
  p += 1;
  const closingIdx = findClosingFence(source, p, fence);
  if (closingIdx === -1) return;
  blankRange(source, buf, 0, closingIdx);
}

function detectFrontmatterFence(source: string): string | null {
  if (source.startsWith("---")) {
    // A `---` fence must be exactly three dashes on the opening line.
    // `----` and longer are not frontmatter.
    if (source[3] === "-") return null;
    return "---";
  }
  if (source.startsWith("+++")) {
    if (source[3] === "+") return null;
    return "+++";
  }
  return null;
}

/**
 * Returns the byte offset just past the closing fence line (including
 * its trailing newline), or -1 if no closing fence exists. The closing
 * fence must appear alone on its line.
 */
function findClosingFence(source: string, startPos: number, fence: string): number {
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

/**
 * Strips fenced code blocks (``` or ~~~). The fence may carry an info
 * string (`` ```jsx ``, `` ```typescript title="x.ts" ``) and may be
 * indented up to three spaces. The closing fence must use the same
 * character as the opening and be at least as long.
 *
 * Implementation is line-based: fenced code blocks are line-delimited
 * in CommonMark and this parser is used well before MDX's more
 * esoteric rules (indent-sensitive closing, mixed tilde/backtick)
 * matter to a11y signal.
 */
function stripFencedCodeBlocks(source: string, buf: string[]): void {
  let p = 0;
  while (p < source.length) {
    // Skip to the start of a line. `p` is always at a line start here
    // by loop invariant (we advance past `\n` each iteration).
    const lineEnd = findLineEnd(source, p);
    const line = source.slice(p, lineEnd);
    const fence = detectCodeFence(line);
    if (fence === null) {
      p = advancePastNewline(source, lineEnd);
      continue;
    }
    // We have an opening fence at `p`. Find the closing fence.
    const blockStart = p;
    const bodyStart = advancePastNewline(source, lineEnd);
    const closingEnd = findCodeFenceClose(source, bodyStart, fence);
    const blockEnd = closingEnd === -1 ? source.length : closingEnd;
    blankRange(source, buf, blockStart, blockEnd);
    p = blockEnd;
  }
}

interface CodeFenceInfo {
  readonly char: "`" | "~";
  readonly length: number;
}

/**
 * Returns the fence info if the line opens a fenced code block, or
 * `null` otherwise. Accepts up to 3 leading spaces per CommonMark.
 */
function detectCodeFence(line: string): CodeFenceInfo | null {
  let i = 0;
  while (i < 3 && line[i] === " ") i += 1;
  const char = line[i];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (line[i + length] === char) length += 1;
  if (length < 3) return null;
  // The info string (remainder of the line) is not validated —
  // CommonMark allows almost anything after the fence characters.
  // For backtick fences, a backtick in the info string is an error
  // per spec; we don't enforce that since we're stripping anyway.
  return { char, length };
}

/**
 * Returns the byte offset just past the closing fence line, or -1
 * when no matching close is found. The close must be the same fence
 * character and at least as long as the open.
 */
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
  // After the fence chars, only whitespace is allowed on a closing fence.
  for (let j = i + length; j < line.length; j += 1) {
    const ch = line[j];
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pass 3 — indented code block strip
// ---------------------------------------------------------------------------

/**
 * Blanks CommonMark indented code blocks: runs of lines that begin
 * with at least four spaces (or a tab) and follow a blank line. The
 * "follows a blank line" guard is the load-bearing protection for
 * authored JSX residue — when a `<Card>` at column 0 contains
 * `<CardBody>` lines indented four or more spaces, those rows belong
 * to the JSX block, NOT to a code block, because the preceding
 * `<Card>` line is non-blank.
 *
 * Why this matters in real-world MDX:
 *
 *   1. Authors write indented HTML/JSX examples without fences in
 *      Starlight / Docusaurus / Next MDX docs:
 *
 *          <div className="alert">
 *            <p>example markup</p>
 *          </div>
 *
 *   2. Authors put a fenced code block inside a list item past the
 *      3-space fence-indent ceiling. CommonMark requires the fence
 *      itself be indented ≤3 spaces; once it sits at 4+ spaces, the
 *      fence isn't recognized and the surrounding lines fall back to
 *      indented-code-block semantics.
 *
 * The block extends until a non-blank line that is NOT indented ≥4
 * spaces. Blank lines INSIDE the block (CommonMark's "lazy
 * continuation") are tolerated. Reads `buf` rather than `source` for
 * the blank-line and indent checks so already-blanked regions
 * (frontmatter, fences) act as blank for the purposes of starting a
 * new indented code block.
 *
 * Spec: https://spec.commonmark.org/0.31.2/#indented-code-blocks
 */
function stripIndentedCodeBlocks(source: string, buf: string[]): void {
  let p = 0;
  let prevLineWasBlank = true; // start-of-file counts as blank
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    const isBlank = isBlankLineInBuf(buf, p, lineEnd);
    if (isBlank) {
      prevLineWasBlank = true;
      p = advancePastNewline(source, lineEnd);
      continue;
    }
    if (prevLineWasBlank && isIndentedCodeLine(buf, p, lineEnd)) {
      const blockEnd = findIndentedCodeBlockEnd(source, buf, lineEnd);
      blankRange(source, buf, p, blockEnd);
      p = blockEnd;
      prevLineWasBlank = false;
      continue;
    }
    prevLineWasBlank = false;
    p = advancePastNewline(source, lineEnd);
  }
}

/**
 * Returns true when `[start, end)` in `buf` contains only spaces,
 * tabs, and carriage returns. Reads from `buf` so already-blanked
 * regions count as blank.
 */
function isBlankLineInBuf(buf: string[], start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const ch = buf[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return true;
}

/**
 * Returns true when the `buf` slice `[start, end)` starts with at
 * least 4 spaces or a single tab AND has at least one non-whitespace
 * character past the indent. Reads from `buf` so that lines blanked
 * by an earlier pass don't qualify.
 */
function isIndentedCodeLine(buf: string[], start: number, end: number): boolean {
  if (buf[start] === "\t") {
    return hasNonWhitespaceInRange(buf, start + 1, end);
  }
  let spaces = 0;
  while (spaces < 4 && start + spaces < end && buf[start + spaces] === " ") spaces += 1;
  if (spaces < 4) return false;
  return hasNonWhitespaceInRange(buf, start + spaces, end);
}

function hasNonWhitespaceInRange(buf: string[], start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const ch = buf[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r") return true;
  }
  return false;
}

/**
 * Walks forward from `startLineEnd` (the `\n` ending the opening
 * indented line) extending the block over indented and blank lines
 * until a non-indented non-blank line. Trailing blank lines are NOT
 * part of the block.
 */
function findIndentedCodeBlockEnd(source: string, buf: string[], startLineEnd: number): number {
  let lastIndentedLineEnd = advancePastNewline(source, startLineEnd);
  let p = lastIndentedLineEnd;
  while (p < source.length) {
    const lineEnd = findLineEnd(source, p);
    if (isBlankLineInBuf(buf, p, lineEnd)) {
      p = advancePastNewline(source, lineEnd);
      continue;
    }
    if (!isIndentedCodeLine(buf, p, lineEnd)) {
      return lastIndentedLineEnd;
    }
    p = advancePastNewline(source, lineEnd);
    lastIndentedLineEnd = p;
  }
  return lastIndentedLineEnd;
}

// ---------------------------------------------------------------------------
// Pass 4 — inline code span strip
// ---------------------------------------------------------------------------

/**
 * Blanks inline backtick code spans (`` `code` ``). Mirrors the
 * matching pass in `parseMarkdown`: `.md` and `.mdx` should expose
 * the same residual shape so the downstream TSX scanner (and any
 * future token-walking finder) sees identical text in both pipelines.
 *
 * CommonMark allows multi-backtick delimiters (`` ``two backticks`` ``)
 * for spans that themselves contain backticks; we honour that by
 * requiring the close to have the same number of backticks as the
 * open. Multi-line spans are tolerated. The line-alignment invariant
 * is preserved via `blankRange`.
 *
 * MDX-specific: backticks inside a JSX expression (`={\`…\`}` or
 * `{\`…\`}`) are JS template literals, not markdown inline code. The
 * `<Example code={\`<input/>\`}/>` shape — load-bearing for the
 * docs-component code-prop extractor — must keep its backticks. The
 * pass tracks `{`/`}` brace depth (with string/comment skip) and only
 * strips at depth 0; backticks inside expressions stay intact.
 *
 * Operates on `source` for backtick lookups (so a span already
 * subsumed by a fenced block, blanked in pass 2, doesn't re-match),
 * but reads `buf` to skip already-blanked regions. Unmatched openings
 * at depth 0 are left intact — the TSX scanner's template-literal
 * skip handles them as a fallback.
 */
function stripInlineCodeSpans(source: string, buf: string[]): void {
  const state: StripState = { p: 0, braceDepth: 0 };
  while (state.p < source.length) {
    // Skip already-blanked regions (e.g., fenced code blocks).
    if (buf[state.p] !== source[state.p]) {
      state.p += 1;
      continue;
    }
    if (advanceOverSkippable(source, state)) continue;
    if (advanceOverBrace(source, state)) continue;
    if (source[state.p] !== "`") {
      state.p += 1;
      continue;
    }
    if (state.braceDepth > 0) {
      // Inside a JSX expression — backticks here are JS template
      // literals (e.g., the `<Example code={`…`}/>` extractor's
      // load-bearing shape). Skip them as strings without blanking.
      state.p = skipStringFrom(source, state.p, "`");
      continue;
    }
    consumeProseBacktickSpan(source, buf, state);
  }
}

interface StripState {
  p: number;
  braceDepth: number;
}

/**
 * Advances `state.p` past a quoted string or JS comment when one
 * starts at the current position. Returns `true` when the cursor
 * moved (so the caller can `continue` the outer loop). Backticks
 * are NOT handled here — at depth 0 they are the strip trigger,
 * at depth > 0 the caller handles them as template literals.
 */
function advanceOverSkippable(source: string, state: StripState): boolean {
  const ch = source[state.p];
  if (ch === '"' || ch === "'") {
    state.p = skipStringFrom(source, state.p, ch);
    return true;
  }
  if (ch === "/" && source[state.p + 1] === "*") {
    state.p = skipBlockCommentFrom(source, state.p);
    return true;
  }
  if (ch === "/" && source[state.p + 1] === "/") {
    state.p = findLineEnd(source, state.p);
    return true;
  }
  return false;
}

/**
 * Updates `state.braceDepth` and advances past a `{` or `}` when one
 * sits at the current position. Returns `true` when handled so the
 * caller can `continue`.
 */
function advanceOverBrace(source: string, state: StripState): boolean {
  const ch = source[state.p];
  if (ch === "{") {
    state.braceDepth += 1;
    state.p += 1;
    return true;
  }
  if (ch === "}") {
    if (state.braceDepth > 0) state.braceDepth -= 1;
    state.p += 1;
    return true;
  }
  return false;
}

/**
 * Consumes a markdown inline code span at brace-depth 0, blanking the
 * delimiters and body in `buf` if a matching close is found. An
 * unterminated open is left intact (the TSX scanner's template-literal
 * skip swallows trailing characters as a fallback).
 */
function consumeProseBacktickSpan(source: string, buf: string[], state: StripState): void {
  let openLen = 0;
  while (source[state.p + openLen] === "`") openLen += 1;
  const openEnd = state.p + openLen;
  const closeStart = findMatchingBacktickClose(source, openEnd, openLen);
  if (closeStart === -1) {
    state.p = openEnd;
    return;
  }
  blankRange(source, buf, state.p, closeStart + openLen);
  state.p = closeStart + openLen;
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
// Pass 5 — import / export line strip
// ---------------------------------------------------------------------------

/**
 * Strips lines that begin with `import ` or `export ` at column 0.
 * MDX treats these as ESM module wiring; they are not authored DOM.
 * They can contain `<` in TS-style generic annotations
 * (`export type X = Array<Y>`) which would otherwise confuse the TSX
 * scanner when it sweeps past the residual.
 *
 * Multi-line imports (`import {\n  A,\n  B,\n} from "x"`) are handled
 * by scanning until a balanced `;` or newline-after-`}`. This
 * conservative matcher covers the common Astro / Docusaurus / Next
 * MDX shapes; exotic multi-statement lines stay intact and reach the
 * TSX scanner, which tolerates them.
 */
function stripImportExportLines(source: string, buf: string[]): void {
  let p = 0;
  while (p < source.length) {
    if (isImportOrExportAtLineStart(source, p)) {
      const end = findImportExportEnd(source, p);
      blankRange(source, buf, p, end);
      p = end;
      continue;
    }
    p = advancePastNewline(source, findLineEnd(source, p));
  }
}

function isImportOrExportAtLineStart(source: string, pos: number): boolean {
  // The caller guarantees `pos` is at a line start.
  return startsWithKeyword(source, pos, "import") || startsWithKeyword(source, pos, "export");
}

function startsWithKeyword(source: string, pos: number, keyword: string): boolean {
  if (!source.startsWith(keyword, pos)) return false;
  const after = source[pos + keyword.length];
  // Require whitespace after the keyword so `imports` / `exported`
  // in prose aren't mistaken for module wiring.
  return after === " " || after === "\t";
}

/**
 * Walks from `pos` (known to be at an `import`/`export` line start)
 * to the end of the statement — a `;` or newline at paren/brace/bracket
 * depth 0, whichever comes first. Respects strings and block comments
 * so a quoted `;` doesn't terminate early.
 */
function findImportExportEnd(source: string, pos: number): number {
  let p = pos;
  let depth = 0;
  while (p < source.length) {
    const skipped = skipStringOrComment(source, p);
    if (skipped !== null) {
      p = skipped;
      continue;
    }
    const ch = source[p];
    if (isOpenBracket(ch)) depth += 1;
    else if (isCloseBracket(ch) && depth > 0) depth -= 1;
    else if (depth === 0 && (ch === ";" || ch === "\n")) return p + 1;
    p += 1;
  }
  return p;
}

function skipStringOrComment(source: string, p: number): number | null {
  const ch = source[p];
  if (ch === '"' || ch === "'" || ch === "`") return skipStringFrom(source, p, ch);
  if (ch === "/" && source[p + 1] === "*") return skipBlockCommentFrom(source, p);
  if (ch === "/" && source[p + 1] === "/") return findLineEnd(source, p);
  return null;
}

function isOpenBracket(ch: string | undefined): boolean {
  return ch === "(" || ch === "{" || ch === "[";
}

function isCloseBracket(ch: string | undefined): boolean {
  return ch === ")" || ch === "}" || ch === "]";
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
 * and `\r` so line numbers stay aligned. `buf` is a parallel array to
 * `source`; the source stays available for lookups while the buffer
 * accumulates the transform.
 */
function blankRange(source: string, buf: string[], start: number, end: number): void {
  const stop = Math.min(end, source.length);
  for (let i = start; i < stop; i += 1) {
    const ch = source[i];
    buf[i] = ch === "\n" ? "\n" : ch === "\r" ? "\r" : " ";
  }
}

function skipStringFrom(source: string, start: number, quote: string): number {
  let p = start + 1;
  while (p < source.length) {
    const ch = source[p];
    if (ch === "\\") {
      p += 2;
      continue;
    }
    if (ch === quote) return p + 1;
    p += 1;
  }
  return source.length;
}

function skipBlockCommentFrom(source: string, start: number): number {
  let p = start + 2;
  while (p < source.length - 1) {
    if (source[p] === "*" && source[p + 1] === "/") return p + 2;
    p += 1;
  }
  return source.length;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { TsxParseResult } from "./tsx.ts";
