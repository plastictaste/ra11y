import type { HtmlElement, HtmlNode } from "../../types/ast.ts";

/**
 * Template-directive handling for the in-house HTML parser.
 *
 * Rules that consume visible text (semantics/label-in-name,
 * semantics/list-structure, document/page-titled,
 * navigation/link-descriptive-text) operate on the rendered-text
 * shape — the string a sighted user actually sees. Liquid/Jinja/ERB
 * directives are not visible; leaving them in text nodes produced
 * false positives on every Jekyll-shaped template.
 *
 * Two helpers live here:
 *
 *   - {@link stripTemplateDirectives} removes inline `{{ … }}`,
 *     `{% … %}`, and ERB (`<%= … %>`, `<% … %>`, `<%# … %>`) spans
 *     from a text fragment and reports whether anything was stripped.
 *   - The parser's text-node path delegates to these helpers; the
 *     `{% capture %}…{% endcapture %}` / `{% comment %}…{% endcomment %}`
 *     opaque-block handling stays inline in the parser because it
 *     needs to mutate position/line/column state.
 *
 * Directives are NOT replaced with a placeholder token: the rendered
 * output Liquid produces is `expr.toString()`, which can be any string
 * (including empty). Inserting a sentinel would be dishonest in a
 * different direction — a downstream substring check would match on
 * the sentinel rather than the real runtime value.
 */

/**
 * Removes template-directive spans from a text-node string so rules
 * that consume visible text operate on the rendered-text shape.
 * Handles Liquid/Jinja interpolation (`{{ … }}`), Liquid/Jinja tags
 * (`{% … %}`), and ERB (`<%= … %>`, `<% … %>`, `<%# … %>`). Balanced
 * only by the literal closer — we don't parse the template language.
 * Unclosed spans are left intact as literal text (same recovery shape
 * as an unterminated attribute quote).
 */
export function stripTemplateDirectives(text: string): {
  value: string;
  stripped: boolean;
} {
  let stripped = false;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const span = detectDirectiveSpan(text, i);
    if (span === null) {
      out += text[i];
      i += 1;
      continue;
    }
    if (span.end === -1) {
      out += text.slice(i);
      return { value: out, stripped };
    }
    i = span.end + 2;
    stripped = true;
  }
  return { value: out, stripped };
}

/**
 * At position `i`, returns the closer offset of a directive span
 * starting here, or `null` if `i` does not open one. `end === -1`
 * signals an unclosed span (caller should preserve the remainder
 * verbatim).
 */
function detectDirectiveSpan(text: string, i: number): { end: number } | null {
  const c0 = text.charCodeAt(i);
  if (c0 === 0x7b) {
    const two = text.slice(i, i + 2);
    if (two === "{{") return { end: text.indexOf("}}", i + 2) };
    if (two === "{%") return { end: text.indexOf("%}", i + 2) };
  } else if (c0 === 0x3c && text.slice(i, i + 2) === "<%") {
    return { end: text.indexOf("%>", i + 2) };
  }
  return null;
}

/**
 * Tag names whose body is NOT rendered at the block's position in
 * the stream. `capture` assigns its body to a Liquid variable;
 * `comment` discards its body. Treating these as opaque text spans
 * keeps their element children from appearing as DOM siblings of the
 * surrounding structure (the Jekyll docs-nav bug: `<a>` inside a
 * `{% capture %}` tripped `semantics/list-structure` as a naked
 * `<ul>` child).
 *
 * Intentionally narrow: `if`, `for`, `unless`, `block`, etc. render
 * their body inline (conditionally or repeatedly) — treating those as
 * opaque would hide real element structure.
 */
export const OPAQUE_BLOCK_DIRECTIVES: ReadonlySet<string> = new Set(["capture", "comment"]);

/**
 * Reads the Liquid/Jinja tag name starting at `{% …` (caller must
 * already have verified the `{%` prefix). Skips an optional
 * whitespace-control dash (`{%-`) and leading horizontal whitespace,
 * then reads an identifier. Returns the empty string if no identifier
 * follows (caller should treat that as "not a block directive we
 * recognize").
 */
export function readTemplateTagName(source: string, openPos: number): string {
  let cursor = openPos + 2;
  if (source[cursor] === "-") cursor += 1;
  while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) {
    cursor += 1;
  }
  const nameStart = cursor;
  while (cursor < source.length) {
    const c = source[cursor];
    if (c === undefined || !/[a-zA-Z_]/.test(c)) break;
    cursor += 1;
  }
  return source.slice(nameStart, cursor);
}

/**
 * At a `{%` position, returns true iff the tag name (after optional
 * `-` and whitespace) is exactly `endTag` followed by a delimiter
 * character (space, `-`, `%`, tab, newline).
 */
/**
 * True when any descendant text node under `element` had a template
 * directive stripped during parsing. Rules consuming visible text use
 * this to append the `template_directive_stripped` signal so the
 * agent knows the check ran against the rendered-text shape.
 */
export function htmlSubtreeHasStrippedDirective(element: HtmlElement): boolean {
  const visit = (node: HtmlNode): boolean => {
    if (node.kind === "HtmlText") return node.containsTemplateDirective === true;
    if (node.kind === "HtmlElement") for (const c of node.children) if (visit(c)) return true;
    return false;
  };
  for (const child of element.children) if (visit(child)) return true;
  return false;
}

export function matchesTemplateEndTag(source: string, openPos: number, endTag: string): boolean {
  let cursor = openPos + 2;
  if (source[cursor] === "-") cursor += 1;
  while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) {
    cursor += 1;
  }
  const name = source.slice(cursor, cursor + endTag.length);
  if (name !== endTag) return false;
  const follow = source[cursor + endTag.length];
  return (
    follow === " " ||
    follow === "-" ||
    follow === "%" ||
    follow === "\t" ||
    follow === "\n" ||
    follow === "\r"
  );
}
