/**
 * In-house SCSS parser — v0.1.x minimal adapter.
 *
 * SCSS is a preprocessor dialect; a faithful compiler (Dart Sass) is
 * tens of thousands of lines and requires runtime evaluation of mixin
 * bodies, @function definitions, math, interpolation, and module
 * imports — none of which we can do zero-dep without shipping a large
 * new subsystem. But the authoring surface of a Sass-based design
 * system still contains plenty of *statically resolvable* colour
 * declarations (`$primary: #0d6efd;` → `.btn-primary { background:
 * $primary; }`), and the static slice is the part WCAG contrast
 * checking cares about.
 *
 * Strategy: transform the SCSS source into CSS-equivalent source,
 * then delegate to `parseCss`. The output is a `CssParseResult` with
 * exactly the same AST shape the CSS parser emits, so downstream
 * rules (contrast/minimum, contrast/enhanced, contrast/non-text,
 * layout/*) need zero changes.
 *
 * Scope (minimal, honest):
 *   - Strip `@mixin`, `@function`, `@if`, `@else`, `@for`, `@each`,
 *     `@while` block bodies entirely (we can't expand them zero-dep).
 *   - Strip `@include`, `@use`, `@forward`, `@import`, `@return`,
 *     `@debug`, `@warn`, `@error`, `@extend`, `@at-root`, `@content`.
 *   - Resolve top-level `$var: <literal>;` and substitute the literal
 *     into subsequent `$var` references. Anything non-literal
 *     (function calls, math, `#{...}`, nested maps) stays unresolved
 *     so downstream rules don't emit false findings.
 *   - Normalize `//` line comments to block-comment form.
 *   - Flatten nested selectors: `.a { color: red; .b { color: blue; } }`
 *     → `.a { color: red; } .a .b { color: blue; }`. `&` is resolved
 *     against the parent; complex cases emit `ParseError` and drop
 *     the block rather than synthesize wrong CSS.
 *
 * Out of scope (honest pass-through or parse-error):
 *   - `#{...}` interpolation in selectors or values.
 *   - Sass math (`10px * 2`).
 *   - `@extend`.
 *   - Cross-file module resolution (`@use "bootstrap/scss/variables"`).
 *
 * Like every ra11y parser: never throws. Returns a partial tree plus
 * `ParseError[]`. Progress guarantees at every loop.
 */

import type { ParseError } from "../../types/ast.ts";
import { type CssParseResult, parseCss } from "./css.ts";
import {
  BLOCK_STRIP_AT_RULES,
  extractLiteralValue,
  findLineEnd,
  findMatchingBrace,
  isAtTopLevel,
  isSpace,
  PASSTHROUGH_AT_RULES,
  readIdent,
  resolveSelector,
  rewriteLineComment,
  STATEMENT_STRIP_AT_RULES,
  scanForDelim,
  skipBlockCommentFrom,
  skipStringFrom,
} from "./scss-internals.ts";

export function parseScss(source: string): CssParseResult {
  const errors: ParseError[] = [];
  // Phase 1: char-level preprocessing — strip Sass-only constructs,
  // normalize line comments, collect variable declarations.
  const pre = preprocess(source);
  errors.push(...pre.errors);
  // Phase 2: token-level flattening — rewrite nested selectors into
  // parent-selector-concatenated flat rules.
  const flat = flattenNesting(pre.source, errors);
  // Phase 3: variable substitution. Run after flattening so the
  // output layout is final.
  const substituted = substituteVariables(flat, pre.vars);
  // Phase 4: delegate to CSS parser.
  const css = parseCss(substituted);
  return {
    root: css.root,
    errors: [...errors, ...css.errors],
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — preprocessing
// ---------------------------------------------------------------------------

interface PreprocessResult {
  readonly source: string;
  readonly vars: ReadonlyMap<string, string>;
  readonly errors: readonly ParseError[];
}

interface PreprocessState {
  readonly source: string;
  readonly out: string[];
  readonly vars: Map<string, string>;
  readonly errors: ParseError[];
  pos: number;
  line: number;
  col: number;
}

/**
 * Walks the source character-by-character and emits a transformed
 * source. Stripped regions are replaced with whitespace that
 * preserves line breaks so downstream line numbers stay close to
 * the original.
 */
function preprocess(source: string): PreprocessResult {
  const out = new Array<string>(source.length);
  for (let i = 0; i < source.length; i += 1) out[i] = source[i] ?? "";
  const state: PreprocessState = {
    source,
    out,
    vars: new Map(),
    errors: [],
    pos: 0,
    line: 1,
    col: 1,
  };
  while (state.pos < source.length) {
    const before = state.pos;
    stepPreprocess(state);
    if (state.pos === before) advance(state, 1);
  }
  return { source: out.join(""), vars: state.vars, errors: state.errors };
}

/** One iteration of the preprocess char-walker. */
function stepPreprocess(state: PreprocessState): void {
  const c = state.source[state.pos];
  if (c === '"' || c === "'") {
    jumpTo(state, skipStringFrom(state.source, state.pos, c));
    return;
  }
  if (c === "/" && state.source[state.pos + 1] === "*") {
    jumpTo(state, skipBlockCommentFrom(state.source, state.pos));
    return;
  }
  if (c === "/" && state.source[state.pos + 1] === "/") {
    const lineEnd = findLineEnd(state.source, state.pos);
    rewriteLineComment(state.out, state.pos, lineEnd);
    jumpTo(state, lineEnd);
    return;
  }
  if (c === "@") {
    handleAtRule(state);
    return;
  }
  if (c === "$") {
    handleDollar(state);
    return;
  }
  advance(state, 1);
}

/** Dispatches `@<name>` based on the at-rule classification. */
function handleAtRule(state: PreprocessState): void {
  const nameStart = state.pos + 1;
  const ident = readIdent(state.source, nameStart);
  const name = ident.toLowerCase();
  if (PASSTHROUGH_AT_RULES.has(name)) {
    advance(state, 1);
    return;
  }
  if (BLOCK_STRIP_AT_RULES.has(name)) {
    stripAtRuleBlock(state, ident, nameStart + ident.length);
    return;
  }
  if (STATEMENT_STRIP_AT_RULES.has(name)) {
    stripStatement(state, nameStart + ident.length);
    return;
  }
  // Unknown at-rule — pass through to the CSS parser.
  advance(state, 1);
}

/**
 * Strips a block-form at-rule `@name(args) { ... }` from the output,
 * preserving newline positions. Falls back to statement strip if the
 * at-rule ends in `;` before `{` — an honest parse-error is emitted
 * when the header or body is unterminated.
 */
function stripAtRuleBlock(state: PreprocessState, ident: string, afterName: number): void {
  const { source } = state;
  const scan = scanForDelim(source, afterName, isHeaderDelim);
  const start = state.pos;
  if (scan >= source.length) {
    blankRange(state, start, source.length);
    state.errors.push({
      message: `Unterminated SCSS @${ident} header`,
      position: { line: state.line, column: state.col, offset: start },
      recoverable: true,
    });
    jumpTo(state, source.length);
    return;
  }
  if (source[scan] === ";") {
    blankRange(state, start, scan + 1);
    jumpTo(state, scan + 1);
    return;
  }
  const end = findMatchingBrace(source, scan);
  if (end === -1) {
    blankRange(state, start, source.length);
    state.errors.push({
      message: `Unterminated SCSS @${ident} block`,
      position: { line: state.line, column: state.col, offset: start },
      recoverable: true,
    });
    jumpTo(state, source.length);
    return;
  }
  blankRange(state, start, end + 1);
  jumpTo(state, end + 1);
}

/**
 * Strips a statement-form at-rule `@name args;` from the output.
 * Respects strings, comments, and parens so a `;` inside a function
 * argument list doesn't terminate early.
 */
function stripStatement(state: PreprocessState, afterName: number): void {
  const { source } = state;
  const scan = scanForDelim(source, afterName, isStatementDelim);
  const start = state.pos;
  const end = source[scan] === ";" ? scan + 1 : scan;
  blankRange(state, start, end);
  jumpTo(state, end);
}

/**
 * Handles a `$` — either a variable declaration (blanked from the
 * output, recorded if the RHS is a literal at top level) or a
 * variable reference (passed through to phase 3 substitution).
 */
function handleDollar(state: PreprocessState): void {
  const { source } = state;
  const name = readIdent(source, state.pos + 1);
  if (name.length === 0) {
    advance(state, 1);
    return;
  }
  let p = state.pos + 1 + name.length;
  while (p < source.length && isSpace(source[p])) p += 1;
  if (source[p] !== ":") {
    advance(state, 1);
    return;
  }
  const valueStart = p + 1;
  const v = scanForDelim(source, valueStart, isVarValueDelim);
  const rawValue = source.slice(valueStart, v).trim();
  const literal = extractLiteralValue(rawValue, state.vars);
  if (literal !== null && isAtTopLevel(source, state.pos)) {
    state.vars.set(name, literal);
  }
  const end = source[v] === ";" ? v + 1 : v;
  blankRange(state, state.pos, end);
  jumpTo(state, end);
}

// Delimiter predicates — small pure functions keep complexity under
// the cognitive-complexity budget while the `scanForDelim` helper
// absorbs the string/comment/paren bookkeeping.

function isHeaderDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === "{" || ch === ";");
}

function isStatementDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === ";" || ch === "\n");
}

function isVarValueDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === ";" || ch === "}");
}

// ---------------------------------------------------------------------------
// Preprocess state helpers
// ---------------------------------------------------------------------------

function advance(state: PreprocessState, n: number): void {
  const end = Math.min(state.pos + n, state.source.length);
  for (let i = state.pos; i < end; i += 1) {
    if (state.source[i] === "\n") {
      state.line += 1;
      state.col = 1;
    } else {
      state.col += 1;
    }
  }
  state.pos = end;
}

function jumpTo(state: PreprocessState, offset: number): void {
  const target = Math.min(Math.max(offset, state.pos), state.source.length);
  advance(state, target - state.pos);
}

function blankRange(state: PreprocessState, start: number, end: number): void {
  for (let i = start; i < end; i += 1) {
    const ch = state.source[i];
    state.out[i] = ch === "\n" ? "\n" : ch === "\r" ? "\r" : " ";
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — selector-nesting flattening
// ---------------------------------------------------------------------------

/**
 * Mutable state threaded through the flatten walk. `out` is the
 * synthesized output buffer; `outLine` is the 1-based line counter of
 * `out` so far (incremented per `\n` written). `lineStarts` is the
 * precomputed source line-offset table powering O(log n)
 * source-line-of-offset lookups.
 *
 * Line preservation: synthesized fragments (the `parent { … }` envelope
 * around flushed declarations and the selector header reconstructed
 * for nested-`&` rules) carry no inherent source line. The flatten
 * phase otherwise preserves line numbers by passing source slices —
 * including their `\n` chars — through to the output. To keep emitted
 * rules at their *source* line, every selector-emit site pads `out`
 * with `\n` chars until `outLine` matches the source line of the
 * selector that produced this rule. The pad is one-way (only ever
 * adds newlines); we never collapse output lines because that would
 * conflict with the inner body's own preserved newlines.
 *
 * Why this matters: `cssRule.loc.start.line` is the address that
 * `suggest_fix(file, line)`, the source-level disable pragma, and
 * `findingId` (which hashes location) all depend on. Without this
 * preservation, two state-class selectors in the same parent block
 * collide on `findingId` because they read at the same wrong line, and
 * `suggest_fix(line)` resolves to a sibling block tens of lines off
 * the actual selector.
 *
 * Doctrine reference: "Per-finding identifiers must be addressable,
 * not collision-prone" (`docs/kb/architecture/ai-first-consumer.md`).
 */
interface FlattenState {
  readonly source: string;
  readonly out: string[];
  readonly errors: ParseError[];
  readonly lineStarts: readonly number[];
  outLine: number;
}

/**
 * Walks the preprocessed source block-by-block and rewrites nested
 * selectors into flat, parent-concatenated CSS. By this stage
 * Sass-only constructs are already stripped; what remains is selector
 * blocks (possibly nested), declarations, and passthrough at-rules.
 */
function flattenNesting(source: string, errors: ParseError[]): string {
  const cursor = { pos: 0 };
  const state: FlattenState = {
    source,
    out: [],
    errors,
    lineStarts: computeLineStarts(source),
    outLine: 1,
  };
  flattenBlockBody(state, cursor, [], -1);
  if (cursor.pos < source.length) pushSourceSlice(state, source.slice(cursor.pos));
  return state.out.join("");
}

/**
 * Recursive body-walker. Emits flattened CSS from `cursor.pos` until
 * either EOF or a `}` at the caller's nesting depth (which the
 * caller consumes).
 *
 * `parentSelectorOffset` is the source byte offset of the parent
 * block's selector header start (the `&.active,` token's first char
 * for nested-`&` rules; the bare selector for top-level rules). Used
 * by `flushDecls` to pad the output to the parent's source line
 * before emitting `parent { decls }`. Pass `-1` for top-level callers
 * (`parentSelectors === []`) where there is no parent envelope to
 * emit; the call still flushes any straggling top-level whitespace.
 */
function flattenBlockBody(
  state: FlattenState,
  cursor: { pos: number },
  parentSelectors: readonly string[],
  parentSelectorOffset: number,
): void {
  const { source } = state;
  const declBuffer: string[] = [];
  const hasDecls = { value: false };
  const flushDecls = () => {
    if (!hasDecls.value) return;
    if (parentSelectors.length > 0) {
      // Pad `out` so the synthesized `parent { … }` envelope lands at
      // the parent's source line. Without this, the envelope is
      // emitted AFTER all inner blocks have written their bodies, so
      // its line is whatever line the previous inner block ended at —
      // which can be tens of lines past the parent's actual position.
      padOutToSourceLine(state, parentSelectorOffset);
      pushSynthetic(state, parentSelectors.join(" "));
      pushSynthetic(state, " {");
      pushSourceSlice(state, declBuffer.join(""));
      pushSynthetic(state, "}\n");
    } else {
      pushSourceSlice(state, declBuffer.join(""));
    }
    declBuffer.length = 0;
    hasDecls.value = false;
  };
  while (cursor.pos < source.length) {
    const before = cursor.pos;
    if (processBlockChar(state, cursor, parentSelectors, declBuffer, hasDecls)) {
      flushDecls();
      return;
    }
    if (cursor.pos === before) cursor.pos += 1;
  }
  flushDecls();
}

/**
 * One iteration of the block-body walker. Returns true when the
 * caller's block close `}` was consumed (so the caller exits its
 * loop).
 */
function processBlockChar(
  state: FlattenState,
  cursor: { pos: number },
  parentSelectors: readonly string[],
  declBuffer: string[],
  hasDecls: { value: boolean },
): boolean {
  const { source } = state;
  const c = source[cursor.pos];
  if (c === '"' || c === "'") {
    const end = skipStringFrom(source, cursor.pos, c);
    appendFragment(state, cursor.pos, end, parentSelectors, declBuffer, hasDecls);
    cursor.pos = end;
    return false;
  }
  if (c === "/" && source[cursor.pos + 1] === "*") {
    const end = skipBlockCommentFrom(source, cursor.pos);
    appendFragment(state, cursor.pos, end, parentSelectors, declBuffer, hasDecls);
    cursor.pos = end;
    return false;
  }
  if (c === "}") return true;
  const classify = classifyStatement(source, cursor.pos);
  if (classify.kind === "block") {
    handleNestedBlock(state, cursor, parentSelectors, classify.braceAt);
    return false;
  }
  if (classify.kind === "decl") {
    appendFragment(state, cursor.pos, classify.end, parentSelectors, declBuffer, hasDecls);
    cursor.pos = classify.end;
    return false;
  }
  // `none` — whitespace or a stray close. Advance one char, passing
  // any whitespace through to declBuffer / output.
  if (parentSelectors.length > 0 && hasDecls.value) declBuffer.push(c ?? "");
  else if (parentSelectors.length === 0) pushSourceSlice(state, c ?? "");
  cursor.pos += 1;
  return false;
}

/**
 * Emits a source fragment either into `declBuffer` (when inside a
 * parented block) or directly to the output.
 */
function appendFragment(
  state: FlattenState,
  start: number,
  end: number,
  parentSelectors: readonly string[],
  declBuffer: string[],
  hasDecls: { value: boolean },
): void {
  const slice = state.source.slice(start, end);
  if (parentSelectors.length > 0) {
    declBuffer.push(slice);
    hasDecls.value = true;
  } else {
    pushSourceSlice(state, slice);
  }
}

/**
 * Handles a `{…}` block encountered inside a parent body. At-rule
 * blocks (`@media (…) { … }`) are emitted with their header intact
 * and recursed into with the *current* parent stack; selector blocks
 * have their selector resolved against the parent stack and
 * recursively flattened.
 *
 * Pads `out` to the source line of `cursor.pos` (the block's selector
 * header start) before emitting either an at-rule header or a
 * synthesized `parent { … }` envelope. Without the pad, the inner
 * body would be emitted at whatever line the previous sibling block
 * ended at — drifting the reported line of every nested rule by the
 * cumulative span of its prior siblings.
 */
function handleNestedBlock(
  state: FlattenState,
  cursor: { pos: number },
  parentSelectors: readonly string[],
  braceAt: number,
): void {
  const { source, errors } = state;
  // `classifyStatement` skipped any whitespace between the prior token
  // and the selector head, so `cursor.pos` may point at a `\n` or run
  // of spaces preceding the selector's first real char. For line
  // attribution, we want the *selector's* source line, not the
  // separator whitespace's line — `&.active,` on its own line should
  // report that line, not the line of the trailing `\n` that closed
  // the previous block.
  const headStart = firstNonSpaceOffset(source, cursor.pos, braceAt);
  const headRaw = source.slice(headStart, braceAt);
  const head = headRaw.trim();
  if (head.startsWith("@")) {
    padOutToSourceLine(state, headStart);
    pushSourceSlice(state, source.slice(headStart, braceAt + 1));
    cursor.pos = braceAt + 1;
    // For at-rules the parent envelope (if any) is the at-rule body
    // itself, not a synthesized one — so pass -1 to suppress the
    // envelope-pad on the recursive flush.
    flattenBlockBody(state, cursor, parentSelectors, -1);
    if (source[cursor.pos] === "}") {
      pushSynthetic(state, "}\n");
      cursor.pos += 1;
    }
    return;
  }
  const resolved = resolveSelector(head, parentSelectors, errors, headStart);
  if (resolved === null) {
    const braceEnd = findMatchingBrace(source, braceAt);
    cursor.pos = braceEnd === -1 ? source.length : braceEnd + 1;
    return;
  }
  cursor.pos = braceAt + 1;
  // The selector header (`headStart`) is the source line we want this
  // flattened rule to land on. flushDecls inside the recursive call
  // will pad to it before emitting `parent { decls }`.
  flattenBlockBody(state, cursor, resolved, headStart);
  if (source[cursor.pos] === "}") cursor.pos += 1;
}

/**
 * Scans `[from, to)` for the first non-whitespace character and
 * returns its offset, or `from` when the range is all whitespace (so
 * the caller still has a usable anchor). Used to attribute a nested
 * block's source line to the *selector* — `&.active,` on its own line
 * — rather than to the trailing `\n` of the previous sibling that
 * `classifyStatement` happened to leave cursor parked on.
 */
function firstNonSpaceOffset(source: string, from: number, to: number): number {
  let p = from;
  while (p < to && isSpace(source[p])) p += 1;
  return p === to ? from : p;
}

// ---------------------------------------------------------------------------
// Phase 2 — line-preservation helpers
// ---------------------------------------------------------------------------

/**
 * Precomputes the source byte offset of every line start (offset of
 * the char after each `\n`). `lineStarts[0] = 0`; `lineStarts[k]` is
 * the offset of the first char on line `k+1`. Lookup via binary
 * search in `sourceLineOf` is O(log n); building the array is O(n)
 * once per flatten call.
 */
function computeLineStarts(source: string): number[] {
  const out: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") out.push(i + 1);
  }
  return out;
}

/**
 * Returns the 1-based source line that contains the byte at `offset`.
 * Binary search over the precomputed `lineStarts` table. Out-of-range
 * offsets clamp to line 1 (`offset < 0`) or the last line
 * (`offset >= source.length`).
 */
function sourceLineOf(state: FlattenState, offset: number): number {
  const { lineStarts } = state;
  if (offset <= 0) return 1;
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const start = lineStarts[mid] ?? 0;
    if (start <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Pads `out` with `\n` chars until `outLine` reaches the source line
 * of `srcOffset`. One-way: never collapses output lines. Skips when
 * `srcOffset < 0` (top-level callers pass `-1` to suppress the pad).
 *
 * The pad is a no-op when the output is already at-or-past the
 * target — sometimes inner-block bodies consume more newlines than
 * the source had between the last emit and this one, in which case
 * the new rule lands at the body's natural line. That over-shoot is
 * the rare case and only happens when the source's nested-block body
 * is shorter than the synthesized output's body would be (typically
 * because of `@include` blanking shrinking the body); the alternative
 * (emitting at the wrong line) is strictly worse.
 */
function padOutToSourceLine(state: FlattenState, srcOffset: number): void {
  if (srcOffset < 0) return;
  const target = sourceLineOf(state, srcOffset);
  while (state.outLine < target) {
    state.out.push("\n");
    state.outLine += 1;
  }
}

/**
 * Pushes a source-derived slice (which may contain `\n` chars from
 * the original source) and updates `outLine` to reflect the newlines
 * carried in. Used for declaration buffers, comment passthroughs, and
 * top-level whitespace fall-through.
 */
function pushSourceSlice(state: FlattenState, slice: string): void {
  if (slice.length === 0) return;
  state.out.push(slice);
  for (let i = 0; i < slice.length; i += 1) if (slice[i] === "\n") state.outLine += 1;
}

/**
 * Pushes a synthesized fragment (selector envelope, trailing `}\n`)
 * and updates `outLine` for any embedded newlines. Distinguished from
 * `pushSourceSlice` only by call-site intent — both update line
 * counts the same way; the separate names make the flatten body
 * easier to audit for which fragments are source-derived vs.
 * synthesized.
 */
function pushSynthetic(state: FlattenState, fragment: string): void {
  if (fragment.length === 0) return;
  state.out.push(fragment);
  for (let i = 0; i < fragment.length; i += 1) if (fragment[i] === "\n") state.outLine += 1;
}

type Classification =
  | { readonly kind: "block"; readonly braceAt: number }
  | { readonly kind: "decl"; readonly end: number }
  | { readonly kind: "none" };

/**
 * Looks ahead from `pos` and returns whether the next statement is a
 * selector block (ends in `{`) or a declaration (ends in `;` before
 * any `{` at paren-depth 0). Returns `none` only when the next
 * non-whitespace char is a block close.
 */
function classifyStatement(source: string, pos: number): Classification {
  let p = pos;
  while (p < source.length && isSpace(source[p])) p += 1;
  if (source[p] === "}") return { kind: "none" };
  const hit = scanForDelim(source, p, isClassifyDelim);
  const ch = source[hit];
  if (ch === "{") return { kind: "block", braceAt: hit };
  if (ch === ";") return { kind: "decl", end: hit + 1 };
  if (ch === "}") return { kind: "decl", end: hit };
  return { kind: "decl", end: source.length };
}

function isClassifyDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === "{" || ch === ";" || ch === "}");
}

// ---------------------------------------------------------------------------
// Phase 3 — variable substitution
// ---------------------------------------------------------------------------

/**
 * Walks the preprocessed source and replaces `$var` references with
 * their resolved literals. Unresolved references are left as-is so
 * downstream CSS rules see an unresolved token (and thus don't emit
 * false colour findings). Strings and comments are respected.
 */
function substituteVariables(source: string, vars: ReadonlyMap<string, string>): string {
  if (vars.size === 0) return source;
  const out: string[] = [];
  let p = 0;
  while (p < source.length) {
    p = emitOneSubstitutionChunk(source, p, vars, out);
  }
  return out.join("");
}

/**
 * Emits one "chunk" of the substitution output — either a preserved
 * string / block-comment fragment, a resolved variable reference, or
 * a single verbatim character — and returns the new cursor position.
 * Splitting the body out keeps `substituteVariables` under the
 * cognitive-complexity budget.
 */
function emitOneSubstitutionChunk(
  source: string,
  p: number,
  vars: ReadonlyMap<string, string>,
  out: string[],
): number {
  const ch = source[p];
  if (ch === '"' || ch === "'") {
    const end = skipStringFrom(source, p, ch);
    out.push(source.slice(p, end));
    return end;
  }
  if (ch === "/" && source[p + 1] === "*") {
    const end = skipBlockCommentFrom(source, p);
    out.push(source.slice(p, end));
    return end;
  }
  if (ch === "$") {
    const name = readIdent(source, p + 1);
    if (name.length > 0 && vars.has(name)) {
      out.push(vars.get(name) ?? "");
      return p + 1 + name.length;
    }
  }
  out.push(ch ?? "");
  return p + 1;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { CssParseResult } from "./css.ts";
