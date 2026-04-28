/**
 * Internal helpers for the SCSS parser adapter. Kept out of
 * `scss.ts` so the main file stays under the 500-LOC budget and
 * each slice has a cohesive responsibility:
 *
 *   - character-level probes (string, block comment, identifier)
 *   - brace matching and top-level detection
 *   - literal-value extraction for `$var:` RHS expressions
 *   - selector-list combining for nesting flattening
 */

import type { CssNode, CssStylesheet, ParseError } from "../../types/ast.ts";

// ---------------------------------------------------------------------------
// Character-level helpers
// ---------------------------------------------------------------------------

export function isIdentChar(c: string): boolean {
  if (c.length === 0) return false;
  const code = c.charCodeAt(0);
  return (
    (code >= 0x30 && code <= 0x39) || // 0-9
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    c === "-" ||
    c === "_"
  );
}

export function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

export function readIdent(source: string, start: number): string {
  let p = start;
  while (p < source.length) {
    const ch = source[p];
    if (ch === undefined || !isIdentChar(ch)) break;
    p += 1;
  }
  return source.slice(start, p);
}

export function skipStringFrom(source: string, start: number, quote: string): number {
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

export function skipBlockCommentFrom(source: string, start: number): number {
  let p = start + 2;
  while (p < source.length) {
    if (source[p] === "*" && source[p + 1] === "/") return p + 2;
    p += 1;
  }
  return source.length;
}

export function findLineEnd(source: string, start: number): number {
  let p = start;
  while (p < source.length && source[p] !== "\n") p += 1;
  return p;
}

/**
 * Scans forward from `open` (a `{`) and returns the offset of the
 * matching `}` accounting for nested blocks, strings, and comments.
 * Returns -1 if no match.
 */
export function findMatchingBrace(source: string, open: number): number {
  let depth = 0;
  let p = open;
  while (p < source.length) {
    const skipped = skipTriviaAt(source, p);
    if (skipped !== p) {
      p = skipped;
      continue;
    }
    const ch = source[p];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return p;
    }
    p += 1;
  }
  return -1;
}

/**
 * If `pos` is the start of a string literal, block comment, or line
 * comment, returns the offset immediately after the trivia. Otherwise
 * returns `pos`. Callers detect "skipped" by comparing the return
 * value to `pos`.
 */
function skipTriviaAt(source: string, pos: number): number {
  const ch = source[pos];
  if (ch === '"' || ch === "'") return skipStringFrom(source, pos, ch);
  if (ch === "/" && source[pos + 1] === "*") return skipBlockCommentFrom(source, pos);
  if (ch === "/" && source[pos + 1] === "/") {
    let p = pos;
    while (p < source.length && source[p] !== "\n") p += 1;
    return p;
  }
  return pos;
}

/**
 * Scans forward from `start` looking for the first character in
 * `stops` that appears at paren-depth 0 and outside strings /
 * comments. Returns the offset of the stop character, or
 * `source.length` if no stop is found. Used by the at-rule header
 * scanner, statement-terminator scanner, variable-value scanner, and
 * classification lookahead.
 */
export function scanForDelim(
  source: string,
  start: number,
  stops: (ch: string, parenDepth: number) => boolean,
): number {
  let p = start;
  let parenDepth = 0;
  while (p < source.length) {
    const skipped = skipTriviaAt(source, p);
    if (skipped !== p) {
      p = skipped;
      continue;
    }
    const ch = source[p] ?? "";
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (stops(ch, parenDepth)) return p;
    p += 1;
  }
  return source.length;
}

/**
 * Returns true if `offset` sits outside any `{ ... }` block in the
 * source. Used to decide whether a `$var:` declaration is top-level
 * and therefore eligible for substitution. O(offset) per check;
 * callers are rare (one per `$var:` declaration).
 */
export function isAtTopLevel(source: string, offset: number): boolean {
  let depth = 0;
  let p = 0;
  while (p < offset) {
    const skipped = skipTriviaAt(source, p);
    if (skipped !== p) {
      p = skipped;
      continue;
    }
    const ch = source[p];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    p += 1;
  }
  return depth === 0;
}

// ---------------------------------------------------------------------------
// Line-comment normalization
// ---------------------------------------------------------------------------

/**
 * Rewrites `//...<newline>` in `out` so the CSS parser sees a block
 * comment of the same length. When the body is too short to fit the
 * minimum 4-char block-comment form we blank the whole fragment to
 * spaces (still same length, still valid CSS).
 */
export function rewriteLineComment(out: string[], start: number, bodyEnd: number): void {
  const bodyLen = bodyEnd - start - 2;
  if (bodyLen >= 2) {
    out[start] = "/";
    out[start + 1] = "*";
    out[bodyEnd - 2] = "*";
    out[bodyEnd - 1] = "/";
    return;
  }
  for (let i = start; i < bodyEnd; i += 1) out[i] = " ";
}

// ---------------------------------------------------------------------------
// Literal variable extraction
// ---------------------------------------------------------------------------

/**
 * Given the raw RHS of a variable declaration, returns a literal CSS
 * value if one is present, or null if the value can't be statically
 * resolved. Only literals we can safely inline into the CSS output
 * qualify: hex colours, named colours, simple length/number units,
 * rgb/rgba/hsl/hsla function calls with no interpolation or math,
 * and aliases to already-resolved variables.
 *
 * `sigil` is the variable-reference prefix character for the calling
 * dialect (SCSS uses `$`, Less uses `@`). It parameterizes both the
 * alias-to-other-variable check on the RHS and the "is the arg list a
 * literal" guard used by the colour-function match (so `rgba(@a, …)`
 * is rejected as non-literal in Less the same way `rgba($a, …)` is in
 * SCSS). Defaults to `$` so existing SCSS callers are unchanged.
 */
export function extractLiteralValue(
  raw: string,
  vars: ReadonlyMap<string, string>,
  sigil = "$",
): string | null {
  const trimmed = raw.replace(/\s*!default\s*$/i, "").trim();
  if (trimmed.length === 0) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(trimmed) && trimmed.length <= 32) return trimmed;
  const colorFnMatch = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(trimmed);
  if (colorFnMatch) {
    const args = colorFnMatch[2] ?? "";
    if (isLiteralArgList(args, sigil)) return trimmed;
  }
  if (trimmed.startsWith(sigil)) {
    const name = readIdent(trimmed, 1);
    if (name.length > 0 && name.length === trimmed.length - 1) {
      return vars.get(name) ?? null;
    }
    return null;
  }
  if (/^-?\d+(\.\d+)?(px|em|rem|%|vh|vw|pt|ch|ex|deg|s|ms)?$/.test(trimmed)) return trimmed;
  return null;
}

function isLiteralArgList(args: string, sigil: string): boolean {
  if (args.includes(sigil)) return false;
  if (args.includes("#{")) return false;
  if (/\d\s*[*/]\s*\d/.test(args)) return false;
  if (/\d\s*[+-]\s*\d/.test(args)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Selector combining for nesting flattening
// ---------------------------------------------------------------------------

/**
 * Concatenates a child selector with the parent selector stack,
 * resolving `&` references. Handles comma-separated selectors on both
 * sides. Returns null on ambiguity (e.g. `&` inside a context we don't
 * want to guess about, or `&` at the top level).
 */
export function resolveSelector(
  child: string,
  parents: readonly string[],
  errors: ParseError[],
  offset: number,
): readonly string[] | null {
  const parentSelector = parents.join(" ");
  const parentList = parentSelector.length === 0 ? [""] : splitSelectors(parentSelector);
  const childList = splitSelectors(child);
  const out: string[] = [];
  for (const parent of parentList) {
    for (const piece of childList) {
      const combined = combineSelectors(parent, piece);
      if (combined === null) {
        errors.push({
          message: `SCSS nested selector "${sanitizeSelectorForMessage(piece)}" under "${sanitizeSelectorForMessage(parent)}" is too complex to flatten`,
          position: { line: 1, column: 1, offset },
          recoverable: true,
        });
        return null;
      }
      out.push(combined);
    }
  }
  return [out.join(", ")];
}

/**
 * Strips newlines, collapses internal whitespace, and truncates a
 * selector token to a single readable line for inclusion in parse-error
 * messages.
 *
 * Without this, `head` slices that span multiple lines or run past the
 * usual selector length leak raw multi-line file content into the
 * `ParseError.message`. Downstream consumers (the agent-response
 * formatter, MCP error-detail surfaces, IDE diagnostics) embed the
 * message verbatim, so the leakage breaks line-oriented displays and
 * confuses the consuming agent — `reason` text reads as "this is the
 * selector" but is actually a chunk of source code.
 */
export function sanitizeSelectorForMessage(selector: string): string {
  // Replace any run of whitespace (including newlines) with one space,
  // so the message stays single-line.
  const collapsed = selector.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_SELECTOR_MESSAGE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SELECTOR_MESSAGE_LENGTH)}…`;
}

const MAX_SELECTOR_MESSAGE_LENGTH = 80;

/** Splits a selector list on top-level commas. */
export function splitSelectors(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = selector.slice(start).trim();
  if (tail.length > 0) out.push(tail);
  if (out.length === 0) out.push("");
  return out;
}

/**
 * Combines a parent selector with a child selector piece. Handles:
 *   - `&` at start: replace with parent (`&.active` under `.btn` →
 *     `.btn.active`).
 *   - `&` anywhere else: replace with parent (suffix form).
 *   - No `&`: descendant combinator (single space).
 *
 * Returns null if the child contains `&` in a position that would
 * require selector-list distribution we can't safely synthesize.
 */
function combineSelectors(parent: string, child: string): string | null {
  const trimmedChild = child.trim();
  if (trimmedChild.length === 0) return parent;
  if (parent.length === 0) {
    if (trimmedChild.includes("&")) return null;
    return trimmedChild;
  }
  if (!trimmedChild.includes("&")) {
    return `${parent} ${trimmedChild}`;
  }
  return trimmedChild.split("&").join(parent);
}

// ---------------------------------------------------------------------------
// At-rule classification sets
// ---------------------------------------------------------------------------

/** Standard CSS at-rules we pass through to the CSS parser verbatim. */
export const PASSTHROUGH_AT_RULES: ReadonlySet<string> = new Set([
  "media",
  "supports",
  "keyframes",
  "-webkit-keyframes",
  "-moz-keyframes",
  "font-face",
  "page",
  "charset",
  "namespace",
  "container",
  "layer",
  "property",
  "counter-style",
  "font-feature-values",
  "scope",
  "starting-style",
  "view-transition",
]);

/** Block-form Sass at-rules we strip entirely (body + all). */
export const BLOCK_STRIP_AT_RULES: ReadonlySet<string> = new Set([
  "mixin",
  "function",
  "if",
  "else",
  "for",
  "each",
  "while",
]);

/** Statement-form Sass at-rules we strip to the next `;` or newline. */
export const STATEMENT_STRIP_AT_RULES: ReadonlySet<string> = new Set([
  "include",
  "use",
  "forward",
  "import",
  "return",
  "debug",
  "warn",
  "error",
  "extend",
  "at-root",
  "content",
]);

// ---------------------------------------------------------------------------
// SCSS unresolved-variable detection
// ---------------------------------------------------------------------------

/**
 * True when the source contains at least one top-level `$var: …;`
 * declaration. Cheap regex scan; we accept that a `$var` reference
 * inside an interpolation string would also trip the test, because the
 * companion AST check (zero color literals downstream) is the
 * load-bearing half — interpolation-only files never produce literal
 * colors regardless.
 *
 * Used by {@link scssVariableDeclarationsLikelyUnresolved} as the first
 * gate in the "token-only SCSS file" predicate; pulled out of the call
 * site so the regex literal is named.
 */
export function hasTopLevelScssVariableDeclaration(source: string): boolean {
  return SCSS_VAR_DECL_RE.test(source);
}

const SCSS_VAR_DECL_RE = /(^|[\s;{}])\$[A-Za-z_][\w-]*\s*:/m;

/**
 * Pattern matching a literal-color value the contrast extractor could
 * resolve: hex (`#abc`, `#abcdef`, `#abcdef12`), `rgb(…)` / `rgba(…)`,
 * `hsl(…)` / `hsla(…)`, or `currentColor`. Named colors are deliberately
 * out of scope — the false-positive cost (a `color: inherit` in a
 * variable-only theme partial reading as "resolved") would degrade the
 * signal. The contrast extractor's full named-color set lives in
 * `src/utils/color.ts`; mirroring it here would couple the detector to
 * the rule's color vocabulary unnecessarily.
 */
const RESOLVED_COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(|\bcurrentColor\b/i;

/**
 * Honest "did SCSS variable substitution produce any usable color
 * literal in this file's CSS output?" predicate
 *
 * Returns `true` when the source declares at least one `$var: …`
 * AND the resulting CSS AST carries no literal-color value across all
 * rule declarations. The companion case — a `_variables.scss` partial
 * whose only role is to define tokens for downstream compilation — is
 * precisely this shape: declarations vanish during preprocessing, no
 * rules survive, and the resulting AST is empty.
 *
 * Walks `rules[*].declarations[*].value` (and into nested at-rule
 * blocks) looking for the first resolvable color literal. The first
 * match short-circuits — the predicate only needs to know "any color
 * literal present?", not how many. Pure over its inputs; cheap over
 * realistic SCSS file sizes (typical theme partial: ≤ 200 declarations).
 *
 * False-positive note: a file like `body { background: var(--bg); }`
 * with a `$var: …;` declaration trips the predicate even though the
 * `var(--bg)` reference might resolve at runtime. That's intentional —
 * the SCSS preprocessor is the only resolution we run; CSS custom
 * properties resolve at the cascade layer the static scanner cannot
 * reach. The honest signal is "this scan saw no literal colors after
 * SCSS substitution" — same shape the agent acts on.
 */
export function scssVariableDeclarationsLikelyUnresolved(
  scssSource: string,
  cssRoot: CssStylesheet,
): boolean {
  if (!hasTopLevelScssVariableDeclaration(scssSource)) return false;
  return !anyResolvedColorInCssNodes(cssRoot.rules);
}

/**
 * Recursively walks a CSS node list looking for the first declaration
 * whose value contains a resolvable color literal. Returns `true` on
 * the first match, `false` when the walk completes without one.
 */
function anyResolvedColorInCssNodes(nodes: readonly CssNode[]): boolean {
  for (const node of nodes) {
    if (nodeHasResolvedColor(node)) return true;
  }
  return false;
}

/** Per-node check — extracted to keep the loop body trivial. */
function nodeHasResolvedColor(node: CssNode): boolean {
  if (node.kind === "CssRule") {
    return ruleHasResolvedColor(node.declarations);
  }
  if (node.kind === "CssAtRule") {
    return anyResolvedColorInCssNodes(node.children);
  }
  return false;
}

/** True when any declaration value matches a resolvable color literal. */
function ruleHasResolvedColor(declarations: readonly { readonly value: string }[]): boolean {
  for (const decl of declarations) {
    if (RESOLVED_COLOR_LITERAL_RE.test(decl.value)) return true;
  }
  return false;
}
