/**
 * In-house HTML parser.
 *
 * A character-driven tokenizer + tree builder producing the HTML AST
 * defined in src/types/ast.ts. Zero dependencies, a11y-aware, and
 * forgiving: malformed input never throws — the parser returns a
 * partial tree plus a `ParseError[]`.
 *
 * Scope for v0.0.x:
 *   - tags, attributes (quoted, unquoted, boolean), self-closing
 *   - text, comments, doctype
 *   - script/style content passthrough (raw-text mode)
 *   - HTML entities (named + numeric) in attribute values and text
 *   - void elements (img, br, input, …) are auto-self-closed
 *
 * Out of scope for v0.0.x: CDATA outside foreign content, full error
 * recovery per the HTML5 parsing algorithm, XML processing instructions.
 * The full HTML5 spec parsing arrives later, driven by fuzz tests.
 *
 * Recoverable-error predicate (what surfaces in
 * `analysisCoverage.partialParseFiles[].reason`):
 *
 *   - The stray-close diagnostic fires ONLY when a closing tag has
 *     no matching opener anywhere in the open-element stack. The
 *     HTML5 implied-end-tag set ({@link IMPLIED_END_TAG_ELEMENTS} —
 *     `<p>`, `<li>`, `<dt>`, `<dd>`, `<option>`, `<thead>`/`<tbody>`/
 *     `<tfoot>`, `<tr>`/`<td>`/`<th>`, `<rt>`/`<rp>`, `<colgroup>`,
 *     `<optgroup>`) is closed implicitly when an ancestor's closer
 *     arrives or a sibling that triggers implicit close opens, so
 *     hand-authored browser-renderable HTML (every `<p>` with no
 *     explicit `</p>`, every `<li>` whose sibling `<li>` opens, every
 *     `<tr>` followed by another `<tr>`, plus the trailing
 *     `</body></html>` after such elements) parses cleanly. The
 *     message wording branches on whether the stray sits at the
 *     document root (`Stray </X> at top level`) or inside an open
 *     ancestor body (`Mismatched </X> close at line N (inside
 *     <ancestor>)`); see {@link strayClosingTagMessage} for the
 *     full predicate.
 *   - "Unclosed <X> element" fires ONLY when an element NOT in the
 *     implied-end set runs to EOF without its closer (`<div>`,
 *     `<span>`, `<section>`, …) — these still genuinely indicate a
 *     structural bug.
 *   - "Unterminated start tag <X>" fires when `<X` runs to EOF
 *     without a `>` or `/>` close.
 *
 * Anything that is not one of the above shapes (trailing whitespace,
 * comments, doctypes, raw-text blocks, balanced template-directive
 * spans) produces no recoverable error.
 */

import type {
  HtmlAttribute,
  HtmlComment,
  HtmlDoctype,
  HtmlDocument,
  HtmlElement,
  HtmlNode,
  HtmlText,
  ParseError,
  SourcePosition,
  SourceRange,
} from "../../types/ast.ts";
import { decodeEntities } from "./html-entities.ts";
import {
  IMPLICIT_CLOSE_ON_OPEN,
  IMPLIED_END_TAG_ELEMENTS,
  peekClosingTagName,
  peekOpeningTagName,
} from "./html-implicit-close.ts";
import { detectLiquidIncludeHead, strayClosingTagMessage } from "./html-layout-tail.ts";
import {
  matchesTemplateEndTag,
  OPAQUE_BLOCK_DIRECTIVES,
  readTemplateTagName,
  stripTemplateDirectives,
} from "./html-template-directives.ts";
import { looksLikeUrlSchemeOpener } from "./html-url-scheme.ts";

// Re-exported so the existing test surface stays at the parser entry
// point even though the detector itself lives in a sibling module
// (extracted to keep `html.ts` under the file-LOC budget).
export { detectLiquidIncludeHead };

/** HTML void elements that must not have closing tags. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
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

/** Elements whose content is treated as raw text (no nested parsing). */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "textarea", "title"]);

export interface HtmlParseResult {
  readonly root: HtmlDocument;
  readonly errors: readonly ParseError[];
}

export function parseHtml(source: string): HtmlParseResult {
  const parser = new HtmlParser(source);
  return parser.parse();
}

class HtmlParser {
  #source: string;
  #pos = 0;
  // Line/column are maintained incrementally so #position() is O(1).
  // Rescanning from offset 0 every call turned a 2MB HTML file into an
  // O(n²) parse that never returned in practice — see docs/performance.md.
  #line = 1;
  #col = 1;
  #errors: ParseError[] = [];
  /**
   * Element-nesting depth. Increments on entry to `#consumeChildren`
   * and decrements on exit, so a stray closer observed from
   * `#consumeNode` can distinguish "orphaned inside an element body"
   * (the historic shape) from "tailing the whole document" (the
   * Liquid root-layout shape). Tracked as a counter so the layout-
   * tail recognition stays scoped to `depth === 0`; without it a
   * nested recovered stray close on a Liquid-opened file would be
   * mis-labeled as a layout tail on every ancestor re-entry.
   */
  #depth = 0;
  /**
   * Lazily-computed flag: is this file's first non-whitespace content
   * a Liquid `{% include %}` / `{% render %}` directive? That shape
   * means the partial handing us `<html>` / `<body>` lives in the
   * included sibling, so a bare `</html>` / `</body>` / `</head>` at
   * the document tail is expected layout composition, not a parse bug.
   * `undefined` until first query; the detector runs at most once.
   */
  #liquidIncludeHead: boolean | undefined;
  /**
   * Stack of currently-open element names (lowercased), in
   * outer-to-inner order. Pushed on entry to `#consumeChildren`,
   * popped on exit. Used by the implicit-close logic to recognise
   * when a closing tag belongs to an *ancestor* (not the current
   * parent), which is the cue that the current parent's end tag was
   * omitted by spec — see {@link IMPLIED_END_TAG_ELEMENTS} and the
   * "Tag omission in text/html" notes in the HTML Living Standard.
   */
  #openStack: string[] = [];

  constructor(source: string) {
    this.#source = source;
  }

  parse(): HtmlParseResult {
    const startPos = this.#position();
    const children: HtmlNode[] = [];
    while (!this.#eof()) {
      const node = this.#consumeNode();
      if (node) children.push(node);
    }
    const endPos = this.#position();
    return {
      root: {
        kind: "HtmlDocument",
        range: { start: 0, end: this.#source.length },
        loc: { start: startPos, end: endPos },
        children,
      },
      errors: this.#errors,
    };
  }

  #consumeNode(): HtmlNode | null {
    if (this.#peek() === "<") {
      // Tag-like construct.
      if (this.#startsWith("<!--")) return this.#consumeComment();
      if (
        this.#startsWith("<!") ||
        this.#startsWith("<!DOCTYPE") ||
        this.#startsWithIgnoreCase("<!doctype")
      ) {
        return this.#consumeDoctype();
      }
      if (this.#startsWith("</")) return this.#consumeStrayClosingTag();
      if (this.#peek(1) !== undefined && isNameStart(this.#peek(1) ?? "")) {
        // Markdown-autolink recovery: `<https://…>` / `<mailto:…>` look
        // like element openers to the tag-name reader (which accepts `:`
        // as a name char for XML namespaces). See
        // `./html-url-scheme.ts` for the full rationale and keyword set.
        if (looksLikeUrlSchemeOpener(this.#source, this.#pos)) {
          return this.#consumeText();
        }
        return this.#consumeElement();
      }
      // Not a recognized tag-like construct — treat '<' as literal text.
      return this.#consumeText();
    }
    return this.#consumeText();
  }

  #consumeElement(): HtmlElement {
    const start = this.#pos;
    const startPos = this.#position();
    this.#advance(1); // "<"
    const tagName = this.#readTagName();
    const { attributes, selfClosing: explicitSelfClose, terminated } = this.#consumeStartTagBody();

    if (!terminated) {
      this.#errors.push({
        message: `Unterminated start tag <${tagName}>`,
        position: startPos,
        recoverable: true,
      });
    }

    const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase());
    const selfClosing = explicitSelfClose || isVoid;

    let children: HtmlNode[] = [];
    if (!selfClosing && terminated) {
      children = this.#consumeChildren(tagName);
    }

    return {
      kind: "HtmlElement",
      range: this.#range(start, this.#pos),
      loc: { start: startPos, end: this.#position() },
      tagName,
      attributes,
      children,
      selfClosing,
    };
  }

  /**
   * Consumes a start tag's attribute list and the trailing `>` or
   * `/>`. Returns a `terminated` flag distinguishing "closed
   * normally" from "EOF before close", so `#consumeElement` can
   * surface a single recoverable error for the unterminated case
   * (covering both `<p` and `<img src=` shapes) and skip
   * `#consumeChildren` on the broken tag.
   */
  #consumeStartTagBody(): {
    attributes: HtmlAttribute[];
    selfClosing: boolean;
    terminated: boolean;
  } {
    const attributes: HtmlAttribute[] = [];
    let selfClosing = false;
    let terminated = false;

    while (!this.#eof()) {
      this.#skipWhitespace();
      const ch = this.#peek();
      if (ch === ">") {
        this.#advance(1);
        terminated = true;
        break;
      }
      if (ch === "/") {
        if (this.#peek(1) === ">") {
          selfClosing = true;
          this.#advance(2);
          terminated = true;
          break;
        }
        this.#advance(1); // stray /
        continue;
      }
      if (ch === undefined) break;
      // Progress guarantee: consumeAttribute advances on any valid
      // attribute. If it stalls (empty name, no `=`), fall through
      // and advance one character so the loop always makes progress.
      const posBefore = this.#pos;
      const attr = this.#consumeAttribute();
      if (this.#pos === posBefore) {
        this.#advance(1);
        continue;
      }
      attributes.push(attr);
    }

    return { attributes, selfClosing, terminated };
  }

  #consumeChildren(parentTag: string): HtmlNode[] {
    const children: HtmlNode[] = [];
    const parentLower = parentTag.toLowerCase();
    const isRawText = RAW_TEXT_ELEMENTS.has(parentLower);
    const hasImpliedEnd = IMPLIED_END_TAG_ELEMENTS.has(parentLower);
    // Track nesting depth so `strayClosingTagMessage` can scope the
    // Liquid layout-tail rename to document-top (`depth === 0`).
    this.#depth += 1;
    this.#openStack.push(parentLower);
    while (!this.#eof()) {
      if (this.#startsWithClosingTag(parentTag)) {
        this.#consumeClosingTag();
        return this.#exitChildren(children);
      }
      if (isRawText) {
        children.push(this.#consumeRawText(parentTag));
        if (!this.#eof()) this.#consumeClosingTag();
        return this.#exitChildren(children);
      }
      if (hasImpliedEnd && this.#shouldImplicitlyClose(parentLower)) {
        return this.#exitChildren(children);
      }
      const node = this.#consumeNode();
      if (node) children.push(node);
    }
    // EOF reached without a matching closer. Implied-end-tag elements
    // are spec-allowed to have no end tag at document end (e.g. a
    // trailing `<p>` with no `</p>` before `</body>` was already
    // implicitly closed by the body close; if EOF arrives we infer the
    // close silently). Non-implied-end elements at EOF still surface
    // the recoverable error so genuinely unclosed structure stays
    // visible.
    if (!hasImpliedEnd) {
      this.#errors.push({
        message: `Unclosed <${parentTag}> element`,
        position: this.#position(),
        recoverable: true,
      });
    }
    return this.#exitChildren(children);
  }

  /**
   * Pop the current parent off the open-element stack and return
   * `children` to the caller. Centralised so every early-return path
   * out of `#consumeChildren` decrements `#depth` and the stack
   * symmetrically — a missed pop would leak the parent name into
   * later implicit-close ancestor checks and silently mis-route
   * subsequent stray closers.
   */
  #exitChildren(children: HtmlNode[]): HtmlNode[] {
    this.#depth -= 1;
    this.#openStack.pop();
    return children;
  }

  /**
   * HTML5 implicit-close check, called from `#consumeChildren` when
   * the current parent is in the implied-end-tag set. Returns true
   * when the next token is either (a) a closing tag for an ancestor
   * or (b) an opening tag in the parent's implicit-close-on-open
   * set. The outer `#consumeChildren` call will see the same token
   * and either match the ancestor closer or treat the opener as a
   * sibling. Spec-correct for `<p>foo<p>bar`, `<li>one<li>two`,
   * `<tr>...<tr>...`, and `<p>foo</body>`.
   */
  #shouldImplicitlyClose(parentLower: string): boolean {
    const closerName = peekClosingTagName(this.#source, this.#pos);
    if (closerName !== null && closerName !== parentLower && this.#openStack.includes(closerName)) {
      return true;
    }
    const openerName = peekOpeningTagName(this.#source, this.#pos);
    if (openerName !== null) {
      const closersForParent = IMPLICIT_CLOSE_ON_OPEN.get(parentLower);
      if (closersForParent?.has(openerName)) return true;
    }
    return false;
  }

  /**
   * Consumes raw-text element content (script/style/title/textarea).
   * `<title>` and `<textarea>` are visible to users and AT, so
   * template directives are stripped from the rendered value; for
   * `<script>` and `<style>` the strip is a no-op on well-formed
   * directives and harmless otherwise.
   */
  #consumeRawText(parentTag: string): HtmlText {
    const start = this.#pos;
    const startPos = this.#position();
    while (!(this.#eof() || this.#startsWithClosingTag(parentTag))) {
      this.#advance(1);
    }
    const raw = this.#source.slice(start, this.#pos);
    const { value, stripped } = stripTemplateDirectives(raw);
    return {
      kind: "HtmlText",
      range: { start, end: this.#pos },
      loc: { start: startPos, end: this.#position() },
      value,
      ...(stripped ? { containsTemplateDirective: true } : {}),
    };
  }

  #consumeClosingTag(): void {
    this.#advance(2); // "</"
    this.#readTagName();
    this.#readUntil(">");
    if (this.#peek() === ">") this.#advance(1);
  }

  /**
   * Consumes a stray `</tag>` that has no matching open, records a
   * recoverable ParseError, and returns an empty text node so the
   * outer node iterator keeps progressing. Called both from the
   * document root and from inside an unclosed element body — the
   * `#depth` counter and `#openStack` together drive which message
   * shape the recorded error gets.
   *
   * The recorded error message branches on three cases (see
   * {@link strayClosingTagMessage} for the full predicate):
   *
   *   1. The Liquid root-layout shape (top-level `</html>` /
   *      `</body>` / `</head>` on a file whose first non-whitespace
   *      content is `{% include %}` / `{% render %}`) — renamed so
   *      an agent routes to include-chain composition instead of
   *      treating it as a parser failure.
   *   2. A nested stray (inside an open ancestor) — the message
   *      names the offending tag and the immediate enclosing scope
   *      so the agent reads "inside <div>" rather than the historic
   *      misdiagnosis "at top level."
   *   3. A genuine root-level stray — the message names the actual
   *      stray tag ("Stray </X> at top level") so the agent doesn't
   *      have to re-open the file to learn which tag is the
   *      culprit.
   *
   * All three still emit a recoverable error so
   * `analysisCoverage.partialParseFiles` retains the honest "scan
   * degraded" telemetry — only the message wording differs. The
   * partial AST (typically a `<body>` / `<main>` subtree plus a
   * trailing stray closer) is still handed to the rule pipeline;
   * document rules gate on `isHtmlFragment` /
   * `isHtmlLayoutOrPartial` so this is reason-string enrichment,
   * not suppression.
   */
  #consumeStrayClosingTag(): HtmlText {
    const start = this.#pos;
    const startPos = this.#position();
    this.#advance(2);
    const closerName = this.#readTagName();
    this.#readUntil(">");
    if (this.#peek() === ">") this.#advance(1);
    // Innermost still-open ancestor — the message names this scope
    // for the nested-stray branch so an agent reads "inside <div>"
    // instead of the historic (and misdiagnosing) "at top level".
    // `#openStack` is outer-to-inner; `at(-1)` is the immediate
    // parent. Guaranteed non-empty when `#depth > 0` because each
    // `#consumeChildren` push happens before the depth increment.
    const enclosingTag = this.#depth > 0 ? this.#openStack.at(-1) : undefined;
    this.#errors.push({
      message: strayClosingTagMessage(
        closerName,
        this.#depth,
        startPos.line,
        enclosingTag,
        this.#hasLiquidIncludeHead(),
      ),
      position: startPos,
      recoverable: true,
    });
    return {
      kind: "HtmlText",
      range: this.#range(start),
      loc: { start: startPos, end: this.#position() },
      value: "",
    };
  }

  #consumeAttribute(): HtmlAttribute {
    const start = this.#pos;
    const startPos = this.#position();
    const name = this.#readAttributeName();
    this.#skipWhitespace();
    const { value, quote } =
      this.#peek() === "=" ? this.#consumeAttributeValue() : { value: null, quote: null };

    return {
      kind: "HtmlAttribute",
      range: this.#range(start, this.#pos),
      loc: { start: startPos, end: this.#position() },
      name,
      value,
      quote,
    };
  }

  /** Parses `=value`, `="..."`, or `='...'`. Call only when peek() === "=". */
  #consumeAttributeValue(): { value: string | null; quote: '"' | "'" | null } {
    this.#advance(1); // consume "="
    this.#skipWhitespace();
    const ch = this.#peek();
    if (ch === '"' || ch === "'") return this.#consumeQuotedAttributeValue(ch);
    return { value: decodeEntities(this.#readUnquotedAttributeValue()), quote: null };
  }

  #consumeQuotedAttributeValue(quote: '"' | "'"): {
    value: string;
    quote: '"' | "'";
  } {
    this.#advance(1);
    const valueStart = this.#pos;
    while (!this.#eof() && this.#peek() !== quote) {
      // Skip balanced Liquid/Jinja spans so quotes inside
      // `{{ site.lang | default: "en-US" }}` or
      // `{% if x == "y" %}` do not terminate the attribute. We do
      // not parse the template language — we only track the literal
      // `}}` / `%}` closer. Jekyll's canonical scaffold template
      // puts a double-quoted Liquid filter argument inside a double-
      // quoted HTML attribute; before this, the inner `"` truncated
      // the attribute value and every `jekyll new` site tripped the
      // BCP 47 check in `parsing/html-has-lang`.
      if (this.#skipTemplateSpan()) continue;
      this.#advance(1);
    }
    const value = decodeEntities(this.#source.slice(valueStart, this.#pos));
    if (this.#peek() === quote) this.#advance(1);
    return { value, quote };
  }

  #readUnquotedAttributeValue(): string {
    const valueStart = this.#pos;
    while (!this.#eof()) {
      // Keep parity with the quoted case — an unquoted value may
      // also carry a template span, e.g. `class={{ theme }}`. A `>`
      // inside the span would otherwise prematurely terminate the
      // attribute.
      if (this.#skipTemplateSpan()) continue;
      const c = this.#peek();
      if (c === undefined || c === ">" || c === " " || c === "\t" || c === "\n" || c === "/") {
        break;
      }
      this.#advance(1);
    }
    return this.#source.slice(valueStart, this.#pos);
  }

  /**
   * If positioned at the start of a Liquid/Jinja span (`{{` or `{%`),
   * advance past the matching closer (`}}` or `%}`) and return true.
   * Otherwise returns false without advancing.
   *
   * The span is treated as opaque text: we don't parse the template
   * language, we just balance the delimiter pair. An unclosed span
   * runs to EOF — the same recovery shape as an unterminated quote.
   */
  #skipTemplateSpan(): boolean {
    if (this.#peek() !== "{") return false;
    const next = this.#peek(1);
    if (next !== "{" && next !== "%") return false;
    const closer = next === "{" ? "}}" : "%}";
    this.#advance(2);
    while (!this.#eof()) {
      if (this.#peek() === closer[0] && this.#peek(1) === closer[1]) {
        this.#advance(2);
        return true;
      }
      this.#advance(1);
    }
    return true;
  }

  #consumeText(): HtmlText {
    const start = this.#pos;
    const startPos = this.#position();
    // Progress guarantee: if called while sitting on `<` (a `<` that
    // #consumeNode couldn't classify as any tag construct), consume
    // one literal character first. Otherwise the outer loop would
    // spin forever.
    if (this.#peek() === "<") this.#advance(1);
    // Non-rendering block directives — `{% capture %}…{% endcapture %}`
    // assigns its body to a Liquid variable (invisible at this point in
    // the rendered stream); `{% comment %}…{% endcomment %}` is
    // discarded. Consume the full block as opaque text so the contained
    // element children never become DOM siblings of the surrounding
    // structure (the Jekyll docs-nav bug: `<a>` inside a `{% capture %}`
    // tripped `semantics/list-structure` as a naked `<ul>` child).
    this.#consumeOpaqueBlockDirective();
    while (!this.#eof() && this.#peek() !== "<") {
      if (this.#consumeOpaqueBlockDirective()) continue;
      this.#advance(1);
    }
    const raw = this.#source.slice(start, this.#pos);
    const { value, stripped } = stripTemplateDirectives(raw);
    return {
      kind: "HtmlText",
      range: { start, end: this.#pos },
      loc: { start: startPos, end: this.#position() },
      value: decodeEntities(value),
      ...(stripped ? { containsTemplateDirective: true } : {}),
    };
  }

  /**
   * If positioned at `{% capture %}` / `{% comment %}`, consume
   * through the matching `{% endX %}` as opaque text and return
   * true. Otherwise returns false without advancing. Unclosed blocks
   * run to EOF — same recovery shape as an unterminated string.
   * See {@link OPAQUE_BLOCK_DIRECTIVES} for the rationale on which
   * tags qualify.
   */
  #consumeOpaqueBlockDirective(): boolean {
    if (this.#peek() !== "{" || this.#peek(1) !== "%") return false;
    const tagName = readTemplateTagName(this.#source, this.#pos);
    if (!OPAQUE_BLOCK_DIRECTIVES.has(tagName)) return false;
    this.#consumeThroughPercentBrace();
    const endTag = `end${tagName}`;
    while (!this.#eof()) {
      if (
        this.#peek() === "{" &&
        this.#peek(1) === "%" &&
        matchesTemplateEndTag(this.#source, this.#pos, endTag)
      ) {
        this.#consumeThroughPercentBrace();
        return true;
      }
      this.#advance(1);
    }
    return true;
  }

  /** Advances through a `{% … %}` opener/closer, leaving position after `%}`. */
  #consumeThroughPercentBrace(): void {
    this.#advance(2); // "{%"
    while (!this.#eof()) {
      if (this.#peek() === "%" && this.#peek(1) === "}") {
        this.#advance(2);
        return;
      }
      this.#advance(1);
    }
  }

  #consumeComment(): HtmlComment {
    const start = this.#pos;
    const startPos = this.#position();
    this.#advance(4); // "<!--"
    const valueStart = this.#pos;
    while (!this.#eof()) {
      if (this.#peek() === "-" && this.#peek(1) === "-" && this.#peek(2) === ">") {
        break;
      }
      this.#advance(1);
    }
    const value = this.#source.slice(valueStart, this.#pos);
    if (!this.#eof()) this.#advance(3); // "-->"
    return {
      kind: "HtmlComment",
      range: this.#range(start),
      loc: { start: startPos, end: this.#position() },
      value,
    };
  }

  #consumeDoctype(): HtmlDoctype {
    const start = this.#pos;
    const startPos = this.#position();
    this.#readUntil(">");
    if (this.#peek() === ">") this.#advance(1);
    const value = this.#source.slice(start, this.#pos);
    return {
      kind: "HtmlDoctype",
      range: this.#range(start),
      loc: { start: startPos, end: this.#position() },
      value,
    };
  }

  /**
   * True when the file's first non-whitespace content is a Liquid
   * `{%- include ... -%}` / `{% render ... %}` directive. Cached on
   * first call so repeated stray-closer checks on the same document
   * don't rescan the head. See {@link detectLiquidIncludeHead} for
   * the shared detector (kept module-level so it is unit-testable
   * without instantiating the parser).
   */
  #hasLiquidIncludeHead(): boolean {
    this.#liquidIncludeHead ??= detectLiquidIncludeHead(this.#source);
    return this.#liquidIncludeHead;
  }

  // -------------------------------------------------------------------------
  // Character helpers
  // -------------------------------------------------------------------------

  #peek(offset = 0): string | undefined {
    return this.#source[this.#pos + offset];
  }

  #eof(): boolean {
    return this.#pos >= this.#source.length;
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

  #startsWith(s: string): boolean {
    return this.#source.startsWith(s, this.#pos);
  }

  #startsWithIgnoreCase(s: string): boolean {
    const slice = this.#source.slice(this.#pos, this.#pos + s.length);
    return slice.toLowerCase() === s.toLowerCase();
  }

  #startsWithClosingTag(tagName: string): boolean {
    if (this.#peek() !== "<" || this.#peek(1) !== "/") return false;
    const after = this.#source.slice(this.#pos + 2, this.#pos + 2 + tagName.length);
    if (after.toLowerCase() !== tagName.toLowerCase()) return false;
    const follow = this.#source[this.#pos + 2 + tagName.length];
    return follow === ">" || follow === " " || follow === "\t" || follow === "\n" || follow === "/";
  }

  #readTagName(): string {
    const start = this.#pos;
    while (!this.#eof()) {
      const c = this.#peek();
      if (c === undefined) break;
      if (isNameChar(c)) this.#advance(1);
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
      )
        break;
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

  #readUntil(stop: string): void {
    while (!this.#eof() && this.#peek() !== stop) {
      this.#advance(1);
    }
  }

  #range(start: number, end?: number): SourceRange {
    return { start, end: end ?? this.#pos };
  }

  #position(): SourcePosition {
    return { line: this.#line, column: this.#col, offset: this.#pos };
  }
}

function isNameStart(ch: string): boolean {
  return /[a-zA-Z]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[a-zA-Z0-9\-_:]/.test(ch);
}
