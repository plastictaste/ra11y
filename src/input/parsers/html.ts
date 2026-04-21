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
        // Stray closing tag at top level — skip it but record the error.
        const start = this.#pos;
        const startPos = this.#position();
        this.#advance(2);
        this.#readUntil(">");
        if (this.#peek() === ">") this.#advance(1);
        this.#errors.push({
          message: "Stray closing tag at top level",
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

    while (!this.#eof()) {
      // Look for a closing tag matching our parent (case-insensitive).
      if (this.#startsWithClosingTag(parentTag)) {
        this.#consumeClosingTag();
        return children;
      }
      if (isRawText) {
        // Raw-text elements (script/style/title/textarea) — consume
        // everything until a matching close tag as a single text node.
        // `<title>` and `<textarea>` are visible to users and AT, so we
        // strip template directives from their rendered value (same
        // treatment as the inline `#consumeText` path). `<script>` and
        // `<style>` aren't visible, so the strip is a no-op on any
        // well-formed directive and harmless otherwise.
        const start = this.#pos;
        const startPos = this.#position();
        while (!(this.#eof() || this.#startsWithClosingTag(parentTag))) {
          this.#advance(1);
        }
        const raw = this.#source.slice(start, this.#pos);
        const { value, stripped } = stripTemplateDirectives(raw);
        children.push({
          kind: "HtmlText",
          range: { start, end: this.#pos },
          loc: { start: startPos, end: this.#position() },
          value,
          ...(stripped ? { containsTemplateDirective: true } : {}),
        });
        if (!this.#eof()) {
          this.#consumeClosingTag();
        }
        return children;
      }
      const node = this.#consumeNode();
      if (node) children.push(node);
    }
    // Unclosed parent element. Recover gracefully.
    this.#errors.push({
      message: `Unclosed <${parentTag}> element`,
      position: this.#position(),
      recoverable: true,
    });
    return children;
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
   * If positioned at the start of a non-rendering Liquid/Jinja block
   * directive (`{% capture x %}…{% endcapture %}` or
   * `{% comment %}…{% endcomment %}`), consume through the matching
   * closer as opaque text and return true. Otherwise return false
   * without advancing. Unclosed blocks run to EOF — same recovery
   * shape as an unterminated string.
   *
   * The set is intentionally narrow: `if`, `for`, `unless`, `block`,
   * etc. render their body content inline (conditionally or
   * repeatedly) — treating those as opaque would hide real element
   * structure. Only `capture` (assigns body to a variable) and
   * `comment` (discards body) are definitionally non-rendering.
   */
  #consumeOpaqueBlockDirective(): boolean {
    if (this.#peek() !== "{" || this.#peek(1) !== "%") return false;
    // Peek the tag name without advancing. Skip `{%` plus optional
    // whitespace-control dash (`{%-`), then read a run of identifier
    // chars.
    let cursor = this.#pos + 2;
    if (this.#source[cursor] === "-") cursor += 1;
    while (cursor < this.#source.length && (this.#source[cursor] === " " || this.#source[cursor] === "\t")) {
      cursor += 1;
    }
    const nameStart = cursor;
    while (cursor < this.#source.length) {
      const c = this.#source[cursor];
      if (c === undefined || !/[a-zA-Z_]/.test(c)) break;
      cursor += 1;
    }
    const tagName = this.#source.slice(nameStart, cursor);
    if (tagName !== "capture" && tagName !== "comment") return false;
    const endTag = `end${tagName}`;
    // Consume `{% tagName … %}` opener.
    this.#advance(2); // "{%"
    while (!this.#eof()) {
      if (this.#peek() === "%" && this.#peek(1) === "}") {
        this.#advance(2);
        break;
      }
      this.#advance(1);
    }
    // Consume body until we find `{% endTag %}`. Liquid's
    // whitespace-control variants (`{%- endcapture -%}`) work here
    // because we resolve the tag name past an optional leading dash.
    while (!this.#eof()) {
      if (this.#peek() === "{" && this.#peek(1) === "%" && this.#matchesEndBlockTag(endTag)) {
        // Consume `{% endTag %}`.
        this.#advance(2); // "{%"
        while (!this.#eof()) {
          if (this.#peek() === "%" && this.#peek(1) === "}") {
            this.#advance(2);
            return true;
          }
          this.#advance(1);
        }
        return true;
      }
      this.#advance(1);
    }
    return true;
  }

  /**
   * At `{%`, returns true iff the tag name (after optional `-` and
   * whitespace) is exactly `endTag` followed by a delimiter character.
   */
  #matchesEndBlockTag(endTag: string): boolean {
    let cursor = this.#pos + 2;
    if (this.#source[cursor] === "-") cursor += 1;
    while (cursor < this.#source.length && (this.#source[cursor] === " " || this.#source[cursor] === "\t")) {
      cursor += 1;
    }
    const name = this.#source.slice(cursor, cursor + endTag.length);
    if (name !== endTag) return false;
    const follow = this.#source[cursor + endTag.length];
    return (
      follow === " " ||
      follow === "-" ||
      follow === "%" ||
      follow === "\t" ||
      follow === "\n" ||
      follow === "\r"
    );
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
 * Removes template-directive spans from a text-node string so rules
 * that consume visible text operate on the rendered-text shape. Handles:
 *   - Liquid / Jinja: `{{ … }}` interpolation, `{% … %}` tags
 *   - ERB: `<%= … %>`, `<% … %>`, `<%# … %>`
 *
 * Balanced only by the literal closer — we don't parse the template
 * language. Unclosed spans are left intact as literal text (same
 * recovery shape as an unterminated attribute quote).
 *
 * The `stripped` flag propagates to `HtmlText.containsTemplateDirective`
 * so rules can append the `template_directive_stripped` signal to
 * their reason text. Directives are NOT replaced with a placeholder
 * token: the rendered output Liquid produces is `expr.toString()`,
 * which can be any string (including empty). Inserting a sentinel
 * would be dishonest in a different direction — a downstream
 * substring check would match on the sentinel rather than the real
 * runtime value.
 */
function stripTemplateDirectives(text: string): { value: string; stripped: boolean } {
  let stripped = false;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const two = text.charCodeAt(i) === 0x7b /* '{' */ ? text.slice(i, i + 2) : "";
    const erbTwo = text.charCodeAt(i) === 0x3c /* '<' */ ? text.slice(i, i + 2) : "";
    if (two === "{{" || two === "{%") {
      const closer = two === "{{" ? "}}" : "%}";
      const end = text.indexOf(closer, i + 2);
      if (end === -1) {
        // Unclosed span — leave as literal and stop scanning so the
        // rest (which may include a close delimiter we'd otherwise
        // miscount) is preserved verbatim.
        out += text.slice(i);
        return { value: out, stripped };
      }
      i = end + 2;
      stripped = true;
      continue;
    }
    if (erbTwo === "<%") {
      // `<%= … %>`, `<% … %>`, `<%# … %>` all close on `%>`.
      const end = text.indexOf("%>", i + 2);
      if (end === -1) {
        out += text.slice(i);
        return { value: out, stripped };
      }
      i = end + 2;
      stripped = true;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return { value: out, stripped };
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
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};
