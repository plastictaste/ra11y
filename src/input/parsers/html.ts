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
 * The full HTML5 spec parsing lands in Phase 5 polish, driven by fuzz
 * tests.
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
import {
  matchesTemplateEndTag,
  OPAQUE_BLOCK_DIRECTIVES,
  readTemplateTagName,
  stripTemplateDirectives,
} from "./html-template-directives.ts";

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

/**
 * Root-document tags that a Liquid-composed layout routinely closes on
 * behalf of a sibling partial. Jekyll's canonical pattern splits the
 * document across `_includes/top.html` (opens `<html>` / `<body>`) and
 * a `_layouts/*.html` wrapper (closes `</body></html>`); the wrapper
 * therefore ends with a bare `</html>` / `</body>` that has no matching
 * open inside the same file. Matching on a closed set keeps the
 * recognition precise — we rename the diagnostic for the documented
 * layout-tail shape, not arbitrary stray closers that might mask a real
 * structural bug.
 */
const LAYOUT_TAIL_CLOSERS: ReadonlySet<string> = new Set(["html", "body", "head"]);

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
      if (this.#startsWith("</")) {
        // Stray closing tag — skip it but record the error. The message
        // discriminates the Liquid root-layout shape (a top-level
        // `</html>` / `</body>` / `</head>` on a file whose first non-
        // whitespace content is `{% include %}` / `{% render %}`) from
        // the generic recovered-stray-close path. Both still emit a
        // recoverable error so `analysisCoverage.partialParseFiles`
        // retains the honest "scan degraded" telemetry, but the Liquid
        // case names the shape so an agent reading the entry routes to
        // the include-chain composition instead of treating it as an
        // unexpected parse failure. The partial AST built from this
        // file (usually a `<body>` or `<main>` subtree plus a trailing
        // stray closer) is still handed to the rule pipeline; document
        // rules already gate on `isHtmlFragment` / `isHtmlLayoutOrPartial`,
        // so this is not a suppression — it is a rename of the reason
        // string the `partialParseFiles[].reason` surface echoes.
        const start = this.#pos;
        const startPos = this.#position();
        this.#advance(2);
        const closerName = this.#readTagName();
        this.#readUntil(">");
        if (this.#peek() === ">") this.#advance(1);
        this.#errors.push({
          message: this.#strayClosingTagMessage(closerName),
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
      if (this.#peek(1) !== undefined && isNameStart(this.#peek(1) ?? "")) {
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
    const attributes: HtmlAttribute[] = [];
    let selfClosing = false;

    while (!this.#eof()) {
      this.#skipWhitespace();
      const ch = this.#peek();
      if (ch === ">") {
        this.#advance(1);
        break;
      }
      if (ch === "/") {
        if (this.#peek(1) === ">") {
          selfClosing = true;
          this.#advance(2);
          break;
        }
        this.#advance(1); // stray /
        continue;
      }
      if (ch === undefined) {
        this.#errors.push({
          message: `Unterminated start tag <${tagName}>`,
          position: startPos,
          recoverable: true,
        });
        break;
      }
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

    const isVoid = VOID_ELEMENTS.has(tagName.toLowerCase());
    if (isVoid) selfClosing = true;

    let children: HtmlNode[] = [];
    if (!selfClosing) {
      children = this.#consumeChildren(tagName);
    }

    const end = this.#pos;
    return {
      kind: "HtmlElement",
      range: this.#range(start, end),
      loc: { start: startPos, end: this.#position() },
      tagName,
      attributes,
      children,
      selfClosing,
    };
  }

  #consumeChildren(parentTag: string): HtmlNode[] {
    const children: HtmlNode[] = [];
    const isRawText = RAW_TEXT_ELEMENTS.has(parentTag.toLowerCase());
    // Track nesting depth so `#strayClosingTagMessage` can scope the
    // Liquid layout-tail rename to document-top (`depth === 0`).
    this.#depth += 1;
    while (!this.#eof()) {
      if (this.#startsWithClosingTag(parentTag)) {
        this.#consumeClosingTag();
        this.#depth -= 1;
        return children;
      }
      if (isRawText) {
        children.push(this.#consumeRawText(parentTag));
        if (!this.#eof()) this.#consumeClosingTag();
        this.#depth -= 1;
        return children;
      }
      const node = this.#consumeNode();
      if (node) children.push(node);
    }
    this.#errors.push({
      message: `Unclosed <${parentTag}> element`,
      position: this.#position(),
      recoverable: true,
    });
    this.#depth -= 1;
    return children;
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
   * Chooses the message for a stray closing tag. The generic message
   * ("Stray closing tag at top level") is preserved for the majority
   * case; the Liquid-composed-layout case earns a shape-naming
   * message so the `partialParseFiles[].reason` an agent reads on
   * the MCP response routes to the composition chain in one read.
   *
   * Recognition gates (all must hold) — intentionally narrow so the
   * rename is precise and real parser bugs keep the generic wording:
   *
   *   - `#depth === 0` — the closer is tailing the whole document,
   *     not orphaned inside an unclosed element body. Without this
   *     guard a nested recovered close on a Liquid-opened file would
   *     be mis-labeled as a layout tail.
   *   - Closer name is one of `html` / `body` / `head` — the three
   *     tags a sibling partial plausibly closes on our behalf. Any
   *     other closer (`</div>`, `</section>`, …) is a real
   *     structural bug, not the documented layout-tail shape.
   *   - First non-whitespace content in the source is a Liquid
   *     `{% include %}` / `{% render %}` directive — the partial
   *     that contributes the opening root tag. See
   *     {@link detectLiquidIncludeHead} for the exact detector.
   *
   * The rename is a reason-string enrichment — not a suppression.
   * The recoverable error still fires so `partialParseFiles` still
   * ships the file to an agent; only the `reason` surface changes.
   * Per the AI-first consumer doctrine (surface, don't suppress),
   * the right move when a heuristic is too coarse is to enrich the
   * text an agent reads, not to hide the signal.
   */
  #strayClosingTagMessage(closerName: string): string {
    const lower = closerName.toLowerCase();
    if (this.#depth === 0 && LAYOUT_TAIL_CLOSERS.has(lower) && this.#hasLiquidIncludeHead()) {
      return `Elided layout-tail </${lower}> — file opens with a Liquid {% include %} directive whose sibling partial closes this root tag`;
    }
    return "Stray closing tag at top level";
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

/**
 * Returns true when `source` begins (after optional BOM + whitespace)
 * with a Liquid `{% include %}` / `{% render %}` directive, permitting
 * both plain and whitespace-control (`{%-` / `-%}`) delimiters. The
 * parser uses this to distinguish a legitimate Liquid-composed layout
 * wrapper (whose sibling partial contributes the opening root tag)
 * from a structurally broken HTML file, so a trailing bare `</html>`
 * gets an honest "layout-tail" diagnostic instead of the generic
 * "stray closing tag" wording.
 *
 * Exported for unit testing so the detector's acceptance surface is
 * visible as a pure function; the parser consumes it through the
 * `#hasLiquidIncludeHead` cache. Intentionally narrow: `include` /
 * `render` are the Liquid tags that pull in a sibling's markup;
 * `{% extends %}` / `{% block %}` (Jinja-style) do not currently
 * participate in the layout-tail rename — widening the list without
 * a matching fixture would re-hide the silent-miss failure mode on
 * every template shape we haven't verified.
 */
export function detectLiquidIncludeHead(source: string): boolean {
  // Strip optional UTF-8 BOM, then anchor a single regex at the start.
  // `^\s*` tolerates leading whitespace / blank lines; `\{%-?` accepts
  // the whitespace-control (`{%-`) variant; `\b(include|render)\b`
  // binds on the two Liquid tags that pull in a sibling partial. Any
  // other head — `{% if %}`, `{% capture %}`, bare `{{ content }}` —
  // falls through and keeps the parser's generic stray-close wording.
  const head = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return /^\s*\{%-?\s*(?:include|render)\b/.test(head);
}

/** Decodes HTML entities in attribute values and text nodes. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
      return match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
      return match;
    }
    const named = NAMED_ENTITIES[entity];
    return named ?? match;
  });
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};
