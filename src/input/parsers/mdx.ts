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
 *   3. Strip top-level `import` / `export` statements. These are ESM
 *      module wiring — they can contain `<` characters (`Array<T>` in
 *      TS-style exports) that would confuse the TSX scanner. They also
 *      don't contribute authored DOM.
 *   4. Hand the residual to `parseTsx`. Its top-level scanner skips
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
 *   - Indented code blocks (four-space convention). Uncommon in MDX
 *     pipelines (fenced is the norm); rely on the TSX tolerance pass
 *     for any `<` that slips through.
 */

import type { ParseError, TsxModule } from "../../types/ast.ts";
import { DEFAULT_EXAMPLE_COMPONENT_NAMES, extractMdxExampleCode } from "./mdx-example-extractor.ts";
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

export function parseMdx(source: string, options: MdxParseOptions = {}): TsxParseResult {
  const errors: ParseError[] = [];
  // Each pass operates on the character buffer and replaces stripped
  // regions with space/newline so downstream line numbers match the
  // original source.
  const buf = source.split("");
  stripFrontmatter(source, buf);
  stripFencedCodeBlocks(source, buf);
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
// Pass 3 — import / export line strip
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
