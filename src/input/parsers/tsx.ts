/**
 * Minimal in-house TSX/JSX parser — v0.0.x surface.
 *
 * This is NOT a full TypeScript parser. It scans source for top-level
 * and nested JSX elements, extracts tag names, string-literal attributes,
 * and text children, and returns a `TsxModule` AST. It's enough to
 * drive the first wave of a11y rules (alt-text, link text, lang
 * attribute, etc.) that only need JSX structure, not full type info.
 *
 * Phase 5 replaces this with a TypeScript-compiler-API-backed parser
 * that pools the `ts` import. The API shape stays the same.
 *
 * Implementation strategy: we treat JSX like HTML but with {expression}
 * children tracked separately. We skip over JS/TS code outside JSX,
 * entering JSX mode when we see `<TagName` where TagName starts with
 * a letter and is followed by ASCII identifier characters.
 *
 * Complexity note: the top-level scanner and element consumers are
 * built from small single-purpose helpers (#skipLineComment,
 * #skipQuoted, #consumeJsxOpenTag, #consumeJsxClosingTag, etc.) so
 * each method stays within the project's cognitive-complexity budget.
 * If you're adding a new JSX construct, add a helper for it rather
 * than inlining the logic into the main loop.
 */

import type {
  JsxAttribute,
  JsxAttributeValue,
  JsxElement,
  JsxExpression,
  JsxNode,
  JsxText,
  ParseError,
  SourcePosition,
  TsxModule,
} from "../../types/ast.ts";
import { isStorybookStoryFile } from "../../utils/path.ts";
import { classifyAngleBracket } from "./tsx-generic-classifier.ts";
import { synthesizeStorybookArgsElements } from "./tsx-storybook-synthesis.ts";

export interface TsxParseResult {
  readonly root: TsxModule;
  readonly errors: readonly ParseError[];
}

/**
 * Optional knobs for {@link parseTsx}. The parser stays a pure
 * `(source) → AST` function for the common case; callers that have a
 * file path on hand pass it so file-shape-specific passes (currently
 * just the Storybook `args` synthesis) can engage. Callers without a
 * file path just omit `options` — same behavior as v0.0.x.
 */
export interface TsxParseOptions {
  /**
   * Absolute or project-relative path of the file being parsed.
   * Drives the Storybook synthesis pass via `isStorybookStoryFile`.
   * No effect on non-story files. The path is never read from disk.
   */
  readonly filePath?: string;
}

const SELF_CLOSING_VOID: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export function parseTsx(source: string, options: TsxParseOptions = {}): TsxParseResult {
  const jsxMode = inferJsxMode(source, options.filePath);
  const nonJsxExtension = isNonJsxExtension(options.filePath);
  const result = new TsxParser(source, jsxMode, nonJsxExtension).parse();
  // Storybook synthesis is the only file-path-aware pass today. Engage
  // when the path looks like a story file (`isStorybookStoryFile` is the
  // single source of truth — see `src/utils/path.ts`); otherwise the
  // result is identical to v0.0.x. Synthesized elements are appended to
  // `module.jsxElements` so existing AST walkers see them without any
  // rule-side change. Each synthetic element carries its own
  // `synthesized` marker so downstream consumers can label findings as
  // derived; no rule branches on the marker today.
  if (!(options.filePath && isStorybookStoryFile(options.filePath))) return result;
  const { elements } = synthesizeStorybookArgsElements(source);
  if (elements.length === 0) return result;
  const root: TsxModule = {
    kind: result.root.kind,
    range: result.root.range,
    loc: result.root.loc,
    jsxElements: [...result.root.jsxElements, ...elements],
  };
  return { root, errors: result.errors };
}

class TsxParser {
  #source: string;
  #pos = 0;
  // Line/column tracked incrementally — see HtmlParser for the why.
  #line = 1;
  #col = 1;
  #errors: ParseError[] = [];
  #elements: JsxElement[] = [];
  /**
   * When `false`, the top-level scanner treats `<identifier` as a literal
   * `<` character rather than a JSX element opener. Populated by
   * {@link inferJsxMode} from the file extension and a light source-level
   * JSX-import signal (see `hasJsxImportSignal`). Bare `.js`/`.ts`/`.mjs`/
   * `.cjs` files without such a signal set this to `false`, so minified
   * JS containing `r.length<b.length` comparison operators does not trip
   * "Unclosed JSX element <b.length>" (Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS).
   * JSX-bearing extensions (`.jsx`/`.tsx`/`.mdx`/`.astro`) stay at `true`
   * and preserve every existing rule-evaluation path.
   */
  readonly #jsxEnabled: boolean;
  /**
   * Set when the caller supplied a `filePath` whose extension is NOT
   * JSX-bearing (`.js`/`.cjs`/`.mjs`/`.ts`/`.css`/`.json`/etc.). When the
   * scanner still emits a structural JSX error on such a file — typically
   * a minified `.js` whose `r.length<b.length` parses as `<b.length>` open
   * tag once a stray JSX-import signal flipped `#jsxEnabled` back on — the
   * reason text rewrites to name the false-JSX context honestly instead of
   * blaming the author for "Unclosed JSX element <r.length>"
   * (V1-JS-PARSE-ERROR-REASON-MISLEADING). The fragment is preserved
   * verbatim in both shapes so grep against historical reports still
   * matches.
   */
  readonly #nonJsxExtension: boolean;

  constructor(source: string, jsxEnabled = true, nonJsxExtension = false) {
    this.#source = source;
    this.#jsxEnabled = jsxEnabled;
    this.#nonJsxExtension = nonJsxExtension;
  }

  parse(): TsxParseResult {
    const startPos = this.#position();
    while (!this.#eof()) {
      this.#scanToJsx();
      if (this.#eof()) break;
      const el = this.#consumeJsxElement();
      if (el) this.#elements.push(el);
    }
    const endPos = this.#position();
    const root: TsxModule = {
      kind: "TsxModule",
      range: { start: 0, end: this.#source.length },
      loc: { start: startPos, end: endPos },
      jsxElements: this.#elements,
    };
    return { root, errors: this.#errors };
  }

  // ---------------------------------------------------------------------
  // Top-level scanner — fast-forward through JS/TS code to the next JSX
  // tag, skipping strings, templates, and comments so the parser doesn't
  // misread literal `<` characters in strings as element openers.
  // ---------------------------------------------------------------------

  #scanToJsx(): void {
    while (!this.#eof()) {
      const c = this.#peek();
      if (c === undefined) return;
      if (this.#skipSkippable(c)) continue;
      if (c === "<" && isTagStart(this.#peek(1))) {
        // Bare `.js`/`.ts` files without a JSX-import signal: `<Ident`
        // is almost always a comparison operator (e.g. `r.length<b.length`
        // in minified IIFEs), never a JSX element opener. Advance past
        // the `<` so the comparison parses as ordinary JS and the file
        // doesn't drop to partial-parse.
        if (!this.#jsxEnabled) {
          this.#advance(1);
          continue;
        }
        const classified = classifyAngleBracket(this.#source, this.#pos);
        if (classified?.isGeneric) {
          this.#advance(classified.endPos - this.#pos);
          continue;
        }
        return;
      }
      this.#advance(1);
    }
  }

  /** Returns true if `c` begins a skippable construct and it was consumed. */
  #skipSkippable(c: string): boolean {
    if (c === "/" && this.#peek(1) === "/") {
      this.#skipLineComment();
      return true;
    }
    if (c === "/" && this.#peek(1) === "*") {
      this.#skipBlockComment();
      return true;
    }
    if (c === '"' || c === "'") {
      this.#skipQuoted(c);
      return true;
    }
    if (c === "`") {
      this.#skipTemplateLiteral();
      return true;
    }
    return false;
  }

  #skipLineComment(): void {
    while (!this.#eof() && this.#peek() !== "\n") this.#advance(1);
  }

  #skipBlockComment(): void {
    this.#advance(2);
    while (!this.#eof()) {
      if (this.#peek() === "*" && this.#peek(1) === "/") break;
      this.#advance(1);
    }
    if (!this.#eof()) this.#advance(2);
  }

  #skipQuoted(quote: '"' | "'"): void {
    this.#advance(1);
    while (!this.#eof() && this.#peek() !== quote) {
      if (this.#peek() === "\\") this.#advance(2);
      else this.#advance(1);
    }
    if (!this.#eof()) this.#advance(1);
  }

  #skipTemplateLiteral(): void {
    this.#advance(1);
    while (!this.#eof() && this.#peek() !== "`") {
      if (this.#peek() === "\\") this.#advance(2);
      else this.#advance(1);
    }
    if (!this.#eof()) this.#advance(1);
  }

  // ---------------------------------------------------------------------
  // Element consumer
  // ---------------------------------------------------------------------

  #consumeJsxElement(): JsxElement | null {
    const start = this.#pos;
    const startPos = this.#position();
    this.#advance(1); // "<"
    const tagName = this.#readTagName();
    if (!tagName) {
      this.#advance(1); // back off past the stray '<'
      return null;
    }

    const { attributes, selfClosing, hasSpreadProps } = this.#consumeJsxOpenTag(tagName, startPos);
    const effectiveSelfClosing =
      selfClosing || (isLowercase(tagName) && SELF_CLOSING_VOID.has(tagName));
    const children: JsxNode[] = effectiveSelfClosing ? [] : this.#consumeJsxChildren(tagName);

    return {
      kind: "JsxElement",
      range: { start, end: this.#pos },
      loc: { start: startPos, end: this.#position() },
      tagName,
      attributes,
      children,
      selfClosing: effectiveSelfClosing,
      hasSpreadProps,
    };
  }

  /** Parses the attributes between `<Tag ` and the closing `>` or `/>`. */
  #consumeJsxOpenTag(
    tagName: string,
    startPos: SourcePosition,
  ): { attributes: JsxAttribute[]; selfClosing: boolean; hasSpreadProps: boolean } {
    const attributes: JsxAttribute[] = [];
    let hasSpreadProps = false;
    while (!this.#eof()) {
      this.#skipWhitespace();
      const terminator = this.#consumeOpenTagTerminator(tagName, startPos);
      if (terminator === "close") return { attributes, selfClosing: false, hasSpreadProps };
      if (terminator === "self-close") return { attributes, selfClosing: true, hasSpreadProps };
      const posBefore = this.#pos;
      const step = this.#consumeJsxAttributeOrSpread();
      if (step.kind === "attribute") attributes.push(step.attribute);
      else if (step.kind === "spread") hasSpreadProps = true;
      if (this.#pos === posBefore) this.#advance(1);
    }
    return { attributes, selfClosing: false, hasSpreadProps };
  }

  /**
   * Detects whether the current position ends the open tag (`>`, `/>`)
   * or is an EOF error, advancing past the terminator. Returns `"attr"`
   * when the caller should try to consume an attribute instead.
   */
  #consumeOpenTagTerminator(
    tagName: string,
    startPos: SourcePosition,
  ): "close" | "self-close" | "attr" {
    const ch = this.#peek();
    if (ch === undefined) {
      this.#errors.push({
        message: this.#formatStructuralJsxError("Unterminated", tagName),
        position: startPos,
        recoverable: true,
      });
      return "close";
    }
    if (ch === ">") {
      this.#advance(1);
      return "close";
    }
    if (ch === "/" && this.#peek(1) === ">") {
      this.#advance(2);
      return "self-close";
    }
    if (ch === "/") this.#advance(1);
    return "attr";
  }

  // ---------------------------------------------------------------------
  // Attribute consumer
  // ---------------------------------------------------------------------

  /**
   * One step of the open-tag loop. A `{` opens a spread attribute
   * (`{...props}`) whose raw expression we intentionally discard; anything
   * else falls through to the named-attribute parser. Keeping the branch
   * here (not inside `consumeJsxAttribute`) keeps each helper single-purpose.
   */
  #consumeJsxAttributeOrSpread():
    | { kind: "attribute"; attribute: JsxAttribute }
    | { kind: "spread" }
    | { kind: "none" } {
    if (this.#peek() === "{") {
      this.#skipBraceBlock();
      return { kind: "spread" };
    }
    const attribute = this.#consumeJsxAttribute();
    return attribute ? { kind: "attribute", attribute } : { kind: "none" };
  }

  #consumeJsxAttribute(): JsxAttribute | null {
    const start = this.#pos;
    const startPos = this.#position();

    const name = this.#readAttributeName();
    if (!name) return null;

    this.#skipWhitespace();
    const value = this.#peek() === "=" ? this.#parseJsxAttributeValue() : null;

    return {
      kind: "JsxAttribute",
      range: { start, end: this.#pos },
      loc: { start: startPos, end: this.#position() },
      name,
      value,
    };
  }

  #parseJsxAttributeValue(): JsxAttributeValue | null {
    this.#advance(1); // consume "="
    this.#skipWhitespace();
    const ch = this.#peek();
    if (ch === '"' || ch === "'") return this.#parseStringAttributeValue(ch);
    if (ch === "{") return this.#parseExpressionAttributeValue();
    return null;
  }

  #parseStringAttributeValue(quote: '"' | "'"): JsxAttributeValue {
    this.#advance(1);
    const valStart = this.#pos;
    while (!this.#eof() && this.#peek() !== quote) this.#advance(1);
    const value: JsxAttributeValue = {
      kind: "StringLiteral",
      value: this.#source.slice(valStart, this.#pos),
    };
    if (!this.#eof()) this.#advance(1);
    return value;
  }

  #parseExpressionAttributeValue(): JsxAttributeValue {
    const exprStart = this.#pos;
    this.#skipBraceBlock();
    return { kind: "Expression", raw: this.#source.slice(exprStart, this.#pos) };
  }

  /**
   * Consumes a balanced `{...}` expression block starting at the current
   * position. Respects nested braces and skips over string literals,
   * template literals, and comments — their inner `{`/`}` characters
   * never contribute to depth. Without this, a JSX attribute expression
   * whose template-literal body contains a literal `}` (e.g. an inline
   * JS/HTML snippet in Astro/Starlight `<Example code={`<button
   * onclick="x()}">`} />`) would close the expression early and leave
   * the parser positioned inside template content, emitting a spurious
   * "Unclosed JSX element" on the parent tag
   * (Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS).
   *
   * Advances past the closing `}`.
   */
  #skipBraceBlock(): void {
    let depth = 0;
    while (!this.#eof()) {
      const c = this.#peek();
      if (c === undefined) return;
      if (this.#skipSkippable(c)) continue;
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        this.#advance(1);
        if (depth === 0) return;
        continue;
      }
      this.#advance(1);
    }
  }

  // ---------------------------------------------------------------------
  // Children consumer
  // ---------------------------------------------------------------------

  #consumeJsxChildren(tagName: string): JsxNode[] {
    const children: JsxNode[] = [];
    while (!this.#eof()) {
      if (this.#isMatchingClosingTag(tagName)) {
        this.#consumeJsxClosingTag();
        return children;
      }
      const before = this.#pos;
      const child = this.#consumeJsxChildNode();
      if (child) children.push(child);
      if (this.#pos === before) this.#advance(1);
    }
    this.#errors.push({
      message: this.#formatStructuralJsxError("Unclosed", tagName),
      position: this.#position(),
      recoverable: true,
    });
    return children;
  }

  /** Dispatches to the right child consumer based on the current character. */
  #consumeJsxChildNode(): JsxNode | null {
    const ch = this.#peek();
    if (ch === "<" && isTagStart(this.#peek(1))) return this.#consumeJsxElement();
    if (ch === "{") return this.#consumeJsxExpressionChild();
    return this.#consumeJsxTextChild();
  }

  #consumeJsxExpressionChild(): JsxExpression {
    const start = this.#pos;
    const startPos = this.#position();
    this.#skipBraceBlock();
    return {
      kind: "JsxExpression",
      range: { start, end: this.#pos },
      loc: { start: startPos, end: this.#position() },
      raw: this.#source.slice(start, this.#pos),
    };
  }

  #consumeJsxTextChild(): JsxText | null {
    const start = this.#pos;
    const startPos = this.#position();
    while (!this.#eof()) {
      const c = this.#peek();
      if (c === "<" || c === "{" || c === undefined) break;
      this.#advance(1);
    }
    if (this.#pos === start) {
      // Progress guarantee — consume one literal character even if it
      // doesn't start a recognized construct.
      this.#advance(1);
    }
    const value = this.#source.slice(start, this.#pos);
    if (value.length === 0) return null;
    return {
      kind: "JsxText",
      range: { start, end: this.#pos },
      loc: { start: startPos, end: this.#position() },
      value,
    };
  }

  #isMatchingClosingTag(tagName: string): boolean {
    if (this.#peek() !== "<" || this.#peek(1) !== "/") return false;
    const after = this.#source.slice(this.#pos + 2, this.#pos + 2 + tagName.length);
    return after.toLowerCase() === tagName.toLowerCase();
  }

  #consumeJsxClosingTag(): void {
    this.#advance(2); // "</"
    this.#readTagName();
    while (!this.#eof() && this.#peek() !== ">") this.#advance(1);
    if (!this.#eof()) this.#advance(1);
  }

  // ---------------------------------------------------------------------
  // Error formatting
  // ---------------------------------------------------------------------

  /**
   * Builds the reason string for a structural JSX error (`Unterminated` /
   * `Unclosed` element). On JSX-bearing extensions (`.tsx`/`.jsx`/`.mdx`/
   * `.astro`) and callers that supplied no `filePath`, the message stays
   * the original parser-internal phrasing so the v0.1.x rule and report
   * tests don't churn. On non-JSX extensions, the message rewrites to
   * name the false-JSX context honestly: the upstream pipeline routed a
   * `.js`/`.ts`/`.css`/etc. file to the TSX parser, the parser tripped
   * on a `<` that was almost certainly a JS comparison operator, and an
   * agent reading the report should fix the parser routing rather than
   * "fix the JSX." The original `<tagName>` fragment is preserved so
   * grep against earlier reports still matches
   * (V1-JS-PARSE-ERROR-REASON-MISLEADING).
   */
  #formatStructuralJsxError(kind: "Unterminated" | "Unclosed", tagName: string): string {
    if (!this.#nonJsxExtension) return `${kind} JSX element <${tagName}>`;
    return `Minified or plain-JS <${tagName}> parsed as JSX element; file likely needs a non-JSX parser.`;
  }

  // ---------------------------------------------------------------------
  // Low-level character helpers
  // ---------------------------------------------------------------------

  #readTagName(): string {
    const start = this.#pos;
    while (!this.#eof()) {
      const c = this.#peek();
      if (c === undefined) break;
      if (/[a-zA-Z0-9_.]/.test(c)) this.#advance(1);
      else break;
    }
    return this.#source.slice(start, this.#pos);
  }

  #readAttributeName(): string {
    const start = this.#pos;
    while (!this.#eof()) {
      const c = this.#peek();
      if (
        c === undefined ||
        c === "=" ||
        c === ">" ||
        c === "/" ||
        c === " " ||
        c === "\t" ||
        c === "\n"
      ) {
        break;
      }
      this.#advance(1);
    }
    return this.#source.slice(start, this.#pos);
  }

  #skipWhitespace(): void {
    while (!this.#eof()) {
      const c = this.#peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.#advance(1);
      else break;
    }
  }

  #peek(offset = 0): string | undefined {
    return this.#source[this.#pos + offset];
  }

  #advance(n: number): void {
    const end = Math.min(this.#pos + n, this.#source.length);
    for (let i = this.#pos; i < end; i++) {
      if (this.#source[i] === "\n") {
        this.#line += 1;
        this.#col = 1;
      } else {
        this.#col += 1;
      }
    }
    this.#pos = end;
  }

  #eof(): boolean {
    return this.#pos >= this.#source.length;
  }

  #position(): SourcePosition {
    return { line: this.#line, column: this.#col, offset: this.#pos };
  }
}

function isTagStart(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return /[a-zA-Z]/.test(ch);
}

function isLowercase(s: string): boolean {
  if (s.length === 0) return false;
  const first = s[0];
  if (first === undefined) return false;
  return first === first.toLowerCase() && first !== first.toUpperCase();
}

// ---------------------------------------------------------------------------
// JSX-mode gate
// ---------------------------------------------------------------------------

/**
 * File extensions that carry authored JSX by spec. Tokens of the form
 * `<Identifier` in these files are JSX element openers by default.
 *
 * `.mdx` and `.astro` pre-transform through their own parsers before
 * reaching `parseTsx`, but each of those parsers inherits the
 * JSX-enabled default — tags in the post-transform residue are authored
 * JSX, not stray comparison operators.
 */
const JSX_BEARING_EXTENSIONS: ReadonlySet<string> = new Set([".jsx", ".tsx", ".mdx", ".astro"]);

/**
 * File extensions that are JS/TS but do NOT carry authored JSX by
 * default. Minified bundles under these extensions commonly include
 * `a<b` comparison operators that the JSX scanner misreads as element
 * openers (`Unclosed JSX element <b.length>` on
 * `jekyll/lib/jekyll/commands/serve/livereload_assets/livereload.js`
 * is the canonical case for Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS).
 *
 * The gate is bypassed when the file carries an explicit JSX-import
 * signal (`from "react"` or a `@jsx` pragma) — some authored `.js`
 * files in the wild still use JSX under a classic-runtime build.
 */
const BARE_JS_EXTENSIONS: ReadonlySet<string> = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
]);

/**
 * Decides whether the parser's top-level scanner should treat
 * `<Identifier` as a JSX element opener for this input. JSX-bearing
 * extensions (`.jsx`/`.tsx`/`.mdx`/`.astro`) stay on; bare JS/TS turns
 * off unless the source carries a JSX-import signal. Callers that don't
 * supply `filePath` default to on — every existing test path continues
 * to work.
 */
function inferJsxMode(source: string, filePath: string | undefined): boolean {
  if (filePath === undefined) return true;
  const ext = lowercaseExtension(filePath);
  if (JSX_BEARING_EXTENSIONS.has(ext)) return true;
  if (!BARE_JS_EXTENSIONS.has(ext)) return true;
  return hasJsxImportSignal(source);
}

function lowercaseExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "";
  // Guard against `/path.to/file` (the dot precedes the final `/`).
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (dot < lastSep) return "";
  return filePath.slice(dot).toLowerCase();
}

/**
 * Probes the leading window of the source for a classic-runtime JSX
 * signal — a React import or an explicit `@jsx` pragma comment. Used
 * only for bare `.js`/`.ts` inputs; JSX-bearing extensions skip the
 * probe entirely.
 *
 * Deliberately narrow: a `react` import signals intent; reading deeper
 * would add cost and false positives (e.g. `react-router` strings in
 * prose comments). The 4KB window matches `CLASSIFY_WINDOW` in
 * `tsx-generic-classifier.ts` so scan-confidence telemetry stays
 * proportional to actual scan work.
 */
const JSX_IMPORT_SIGNAL_WINDOW = 4096;
const JSX_IMPORT_SIGNAL_RE =
  /(?:\bfrom\s+["']react["']|\brequire\(\s*["']react["']\s*\)|\/\*\*?\s*@jsx\b|\/\/\s*@jsx\b)/;

function hasJsxImportSignal(source: string): boolean {
  const head =
    source.length <= JSX_IMPORT_SIGNAL_WINDOW ? source : source.slice(0, JSX_IMPORT_SIGNAL_WINDOW);
  return JSX_IMPORT_SIGNAL_RE.test(head);
}

/**
 * True when `filePath` is supplied AND the extension is NOT one of
 * `.jsx`/`.tsx`/`.mdx`/`.astro`. Drives the
 * `#formatStructuralJsxError` reason rewrite so the
 * `partialParseFiles[].reason` an agent reads on a `.js`/`.ts`/`.css`/
 * etc. file names the false-JSX context honestly instead of pretending
 * the author left a JSX tag unclosed (V1-JS-PARSE-ERROR-REASON-MISLEADING).
 *
 * Returns `false` when `filePath` is undefined — back-compat for the
 * many call sites (test helpers, MCP session, apply-fix internals) that
 * still parse without a path. Those paths keep the original parser
 * phrasing.
 */
function isNonJsxExtension(filePath: string | undefined): boolean {
  if (filePath === undefined) return false;
  const ext = lowercaseExtension(filePath);
  if (ext === "") return false;
  return !JSX_BEARING_EXTENSIONS.has(ext);
}
