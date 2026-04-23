/**
 * In-house Less parser — v0.1.x minimal adapter.
 *
 * Less is a preprocessor dialect in the same shape as Sass: a faithful
 * compiler evaluates mixin bodies, guards, math, `when (…)` clauses,
 * and cross-file `@import`s — all out of reach for a zero-dep parser.
 * But the authored colour surface (`@primary: #0d6efd;` +
 * `.btn-primary { background: @primary; }`) is statically resolvable,
 * and that is exactly the slice WCAG contrast checking cares about.
 *
 * Strategy mirrors `parseScss`: preprocess the Less source into
 * CSS-equivalent source, then delegate to `parseCss`. Output is a
 * `CssParseResult` with the same AST shape `parseCss` emits, so every
 * downstream CSS rule (contrast/minimum, contrast/enhanced,
 * contrast/non-text, layout/*) consumes Less files unchanged.
 *
 * Scope (minimum viable, honest):
 *   - Resolve top-level `@var: <literal>;` declarations and substitute
 *     the literal into subsequent `@var` references. Anything
 *     non-literal (function calls, math, maps, guards) stays
 *     unresolved so downstream rules don't emit false findings.
 *   - Strip statement-form Less directives (`@import`, `@plugin`,
 *     `@namespace "…";` when they route through the Less import
 *     machinery). Note: standard CSS at-rules (`@media`, `@supports`,
 *     `@keyframes`, `@font-face`, `@charset`, etc.) pass through
 *     verbatim to the CSS parser.
 *   - Normalize `//` line comments to block-comment form (Less
 *     permits both; the CSS parser only recognizes `/* … *\/`).
 *   - Flatten nested selectors (`.a { .b { … } }` → `.a .b { … }`)
 *     with `&` resolution against the parent. Same logic as SCSS.
 *   - Strip mixin-call statements (`.mixin-name(<args>);` in
 *     statement position) — we can't expand them zero-dep, but we
 *     recognize the shape so the CSS parser doesn't treat the call
 *     as a malformed selector-block.
 *   - Strip mixin-definition blocks (`.mixin-name(<args>) { … }` at
 *     top level or nested) — same reasoning; the parentheses would
 *     otherwise confuse the CSS selector reader.
 *
 * Out of scope (honest pass-through or parse-error):
 *   - Less math (`@base * 2`).
 *   - Guards (`.mixin() when (…) { … }`).
 *   - `extend(.selector)` and `&:extend(.other)`.
 *   - `@plugin` resolution.
 *   - Cross-file `@import` resolution.
 *   - Property interpolation (`@{property}: value;`).
 *   - Maps / namespaces (`@colors[primary]`).
 *
 * Like every ra11y parser: never throws. Returns a partial tree plus
 * `ParseError[]`. Progress guarantees at every loop.
 */

import type { ParseError } from "../../types/ast.ts";
import { type CssParseResult, parseCss } from "./css.ts";
import {
  extractLiteralValue,
  findLineEnd,
  findMatchingBrace,
  isAtTopLevel,
  isSpace,
  PASSTHROUGH_AT_RULES,
  readIdent,
  resolveSelector,
  rewriteLineComment,
  scanForDelim,
  skipBlockCommentFrom,
  skipStringFrom,
} from "./scss-internals.ts";

export function parseLess(source: string): CssParseResult {
  const errors: ParseError[] = [];
  // Phase 1: char-level preprocessing — strip Less-only directives,
  // record variable declarations, normalize line comments, strip
  // mixin calls / definitions.
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
 * source. Stripped regions are replaced with whitespace that preserves
 * line breaks so downstream line numbers stay close to the original.
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
    handleAt(state);
    return;
  }
  if (c === "." && looksLikeMixinCallStart(state.source, state.pos)) {
    handleMixinCall(state);
    return;
  }
  advance(state, 1);
}

/**
 * Dispatches an `@` token. In Less, `@<ident>` ambiguously represents
 * either a variable declaration (followed by `:`), a variable
 * reference (inside a value), or a standard CSS at-rule (`@media`,
 * `@keyframes`, …). At statement position we distinguish by reading
 * ahead: `@name` followed (optionally through whitespace) by `:` is a
 * declaration; otherwise it's an at-rule and we let it pass through
 * (or strip the handful of Less-specific statement directives).
 */
function handleAt(state: PreprocessState): void {
  const { source } = state;
  const nameStart = state.pos + 1;
  const ident = readIdent(source, nameStart);
  if (ident.length === 0) {
    advance(state, 1);
    return;
  }
  const afterName = nameStart + ident.length;
  let p = afterName;
  while (p < source.length && isSpace(source[p])) p += 1;
  if (source[p] === ":") {
    handleVarDecl(state, ident, p);
    return;
  }
  const name = ident.toLowerCase();
  if (PASSTHROUGH_AT_RULES.has(name)) {
    advance(state, 1);
    return;
  }
  if (LESS_STATEMENT_STRIP_AT_RULES.has(name)) {
    stripStatement(state, afterName);
    return;
  }
  // Unknown at-rule — pass through. The CSS parser handles unknown
  // at-rules by consuming them as raw at-rules and won't crash.
  advance(state, 1);
}

/**
 * Consumes a `@name: <value>;` declaration. Records the literal value
 * in the vars map when top-level and statically resolvable, and blanks
 * the declaration from the output (preserving line breaks).
 */
function handleVarDecl(state: PreprocessState, ident: string, colonAt: number): void {
  const { source } = state;
  const valueStart = colonAt + 1;
  const v = scanForDelim(source, valueStart, isVarValueDelim);
  const rawValue = source.slice(valueStart, v).trim();
  const literal = extractLiteralValue(rawValue, state.vars, "@");
  if (literal !== null && isAtTopLevel(source, state.pos)) {
    state.vars.set(ident, literal);
  }
  const end = source[v] === ";" ? v + 1 : v;
  blankRange(state, state.pos, end);
  jumpTo(state, end);
}

/**
 * Strips a statement-form at-rule `@name args;`. Respects strings,
 * comments, and parens so a `;` inside a function argument list
 * doesn't terminate early.
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
 * Returns true if `pos` looks like the start of a Less mixin call or
 * definition — a dot-class-style name immediately followed by `(`.
 * The lookahead reads `.<ident>(...)` where `<ident>` may contain
 * hyphens and underscores; it does NOT accept `.foo .bar(` (combinator
 * form) since those are regular selector blocks with a function call
 * in the selector position, which Less would treat as a mixin call —
 * we keep the detection conservative to avoid stripping genuine
 * selectors.
 */
function looksLikeMixinCallStart(source: string, pos: number): boolean {
  if (source[pos] !== ".") return false;
  const name = readIdent(source, pos + 1);
  if (name.length === 0) return false;
  const afterName = pos + 1 + name.length;
  return source[afterName] === "(";
}

/**
 * Handles a token that starts with `.<ident>(`. If the statement
 * terminates with `;` before any `{`, it's a mixin call — strip it
 * entirely. If it terminates with `{`, it's a mixin definition (the
 * parentheses carry the parameter list) — strip the whole `{ … }`
 * block.
 */
function handleMixinCall(state: PreprocessState): void {
  const { source } = state;
  const start = state.pos;
  const scan = scanForDelim(source, start, isMixinDelim);
  if (scan >= source.length) {
    // Unterminated — strip to EOF so the CSS parser doesn't see a
    // half-written header, and record the recovery.
    blankRange(state, start, source.length);
    state.errors.push({
      message: "Unterminated Less mixin call or definition",
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
  // `{` — mixin definition. Find matching `}` and strip the whole
  // block.
  const end = findMatchingBrace(source, scan);
  if (end === -1) {
    blankRange(state, start, source.length);
    state.errors.push({
      message: "Unterminated Less mixin definition block",
      position: { line: state.line, column: state.col, offset: start },
      recoverable: true,
    });
    jumpTo(state, source.length);
    return;
  }
  blankRange(state, start, end + 1);
  jumpTo(state, end + 1);
}

// Delimiter predicates — small pure functions so the cognitive-
// complexity budget stays intact and the shared `scanForDelim` helper
// absorbs string / comment / paren bookkeeping.

function isStatementDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === ";" || ch === "\n");
}

function isVarValueDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === ";" || ch === "}");
}

function isMixinDelim(ch: string, parenDepth: number): boolean {
  return parenDepth === 0 && (ch === ";" || ch === "{");
}

/** Less statement-form at-rules we strip to the next `;` or newline. */
const LESS_STATEMENT_STRIP_AT_RULES: ReadonlySet<string> = new Set([
  "import",
  "plugin",
]);

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
 * Walks the preprocessed source block-by-block and rewrites nested
 * selectors into flat, parent-concatenated CSS. By this stage Less-
 * only constructs are already stripped; what remains is selector
 * blocks (possibly nested), declarations, and passthrough at-rules.
 */
function flattenNesting(source: string, errors: ParseError[]): string {
  const cursor = { pos: 0 };
  const out: string[] = [];
  flattenBlockBody(source, cursor, [], out, errors);
  if (cursor.pos < source.length) out.push(source.slice(cursor.pos));
  return out.join("");
}

/**
 * Recursive body-walker. Emits flattened CSS from `cursor.pos` until
 * either EOF or a `}` at the caller's nesting depth (which the caller
 * consumes).
 */
function flattenBlockBody(
  source: string,
  cursor: { pos: number },
  parentSelectors: readonly string[],
  out: string[],
  errors: ParseError[],
): void {
  const declBuffer: string[] = [];
  const hasDecls = { value: false };
  const flushDecls = () => {
    if (!hasDecls.value) return;
    if (parentSelectors.length > 0) {
      out.push(parentSelectors.join(" "));
      out.push(" {");
      out.push(declBuffer.join(""));
      out.push("}\n");
    } else {
      out.push(declBuffer.join(""));
    }
    declBuffer.length = 0;
    hasDecls.value = false;
  };
  while (cursor.pos < source.length) {
    const before = cursor.pos;
    if (processBlockChar(source, cursor, parentSelectors, declBuffer, hasDecls, out, errors)) {
      flushDecls();
      return;
    }
    if (cursor.pos === before) cursor.pos += 1;
  }
  flushDecls();
}

/**
 * One iteration of the block-body walker. Returns true when the
 * caller's block close `}` was consumed.
 */
function processBlockChar(
  source: string,
  cursor: { pos: number },
  parentSelectors: readonly string[],
  declBuffer: string[],
  hasDecls: { value: boolean },
  out: string[],
  errors: ParseError[],
): boolean {
  const c = source[cursor.pos];
  if (c === '"' || c === "'") {
    const end = skipStringFrom(source, cursor.pos, c);
    appendFragment(source, cursor.pos, end, parentSelectors, declBuffer, hasDecls, out);
    cursor.pos = end;
    return false;
  }
  if (c === "/" && source[cursor.pos + 1] === "*") {
    const end = skipBlockCommentFrom(source, cursor.pos);
    appendFragment(source, cursor.pos, end, parentSelectors, declBuffer, hasDecls, out);
    cursor.pos = end;
    return false;
  }
  if (c === "}") return true;
  const classify = classifyStatement(source, cursor.pos);
  if (classify.kind === "block") {
    handleNestedBlock(source, cursor, parentSelectors, classify.braceAt, out, errors);
    return false;
  }
  if (classify.kind === "decl") {
    appendFragment(source, cursor.pos, classify.end, parentSelectors, declBuffer, hasDecls, out);
    cursor.pos = classify.end;
    return false;
  }
  // `none` — whitespace or a stray close. Advance one char, pushing
  // any whitespace through to declBuffer / output.
  if (parentSelectors.length > 0 && hasDecls.value) declBuffer.push(c ?? "");
  else if (parentSelectors.length === 0) out.push(c ?? "");
  cursor.pos += 1;
  return false;
}

/**
 * Emits a source fragment either into `declBuffer` (when inside a
 * parented block) or directly to the output.
 */
function appendFragment(
  source: string,
  start: number,
  end: number,
  parentSelectors: readonly string[],
  declBuffer: string[],
  hasDecls: { value: boolean },
  out: string[],
): void {
  const slice = source.slice(start, end);
  if (parentSelectors.length > 0) {
    declBuffer.push(slice);
    hasDecls.value = true;
  } else {
    out.push(slice);
  }
}

/**
 * Handles a `{…}` block encountered inside a parent body. At-rule
 * blocks (`@media (…) { … }`) are emitted with their header intact and
 * recursed into with the *current* parent stack; selector blocks have
 * their selector resolved against the parent stack and recursively
 * flattened.
 */
function handleNestedBlock(
  source: string,
  cursor: { pos: number },
  parentSelectors: readonly string[],
  braceAt: number,
  out: string[],
  errors: ParseError[],
): void {
  const headRaw = source.slice(cursor.pos, braceAt);
  const head = headRaw.trim();
  if (head.startsWith("@")) {
    out.push(source.slice(cursor.pos, braceAt + 1));
    cursor.pos = braceAt + 1;
    flattenBlockBody(source, cursor, parentSelectors, out, errors);
    if (source[cursor.pos] === "}") {
      out.push("}\n");
      cursor.pos += 1;
    }
    return;
  }
  const resolved = resolveSelector(head, parentSelectors, errors, cursor.pos);
  if (resolved === null) {
    const braceEnd = findMatchingBrace(source, braceAt);
    cursor.pos = braceEnd === -1 ? source.length : braceEnd + 1;
    return;
  }
  cursor.pos = braceAt + 1;
  flattenBlockBody(source, cursor, resolved, out, errors);
  if (source[cursor.pos] === "}") cursor.pos += 1;
}

type Classification =
  | { readonly kind: "block"; readonly braceAt: number }
  | { readonly kind: "decl"; readonly end: number }
  | { readonly kind: "none" };

/**
 * Looks ahead from `pos` and returns whether the next statement is a
 * selector block (ends in `{`) or a declaration (ends in `;` before
 * any `{` at paren-depth 0). Returns `none` only when the next non-
 * whitespace char is a block close.
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
 * Walks the preprocessed source and replaces `@var` references with
 * their resolved literals. Unresolved references are left as-is so
 * downstream CSS rules see an unresolved token (and thus don't emit
 * false colour findings). Strings and comments are respected, and
 * standard CSS at-rule heads (`@media`, `@keyframes`, …) are left
 * alone because their identifiers never appear in the vars map.
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
  if (ch === "@") {
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
