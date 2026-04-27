/**
 * HTML5 implicit-close tables — the closed sets backing the HTML
 * parser's tolerance for hand-authored, browser-renderable markup
 * that omits explicit end tags.
 *
 * The HTML Living Standard's "Tag omission in text/html" notes
 * (https://html.spec.whatwg.org/multipage/syntax.html#optional-tags)
 * allow several elements to skip their explicit `</tag>` when the
 * close can be inferred from context. Without these tables every
 * `<p>foo<p>bar`, `<li>one<li>two`, `<tr><td>a<td>b`, and the
 * canonical `<p>...</body></html>` ending surfaces in
 * `analysisCoverage.partialParseFiles` with reasons like
 * "Stray </html> at top level" / "Unclosed <p>" / "Unclosed <li>" —
 * the unclosed descendants steal the `</body></html>` closers and
 * the trailing root-tag closers look stray. Agents reading those
 * reasons reasonably treat the file as broken HTML and skip it,
 * silently missing real a11y findings on the recovered subtree.
 *
 * The two tables here encode the spec mechanics:
 *
 *   - `IMPLIED_END_TAG_ELEMENTS` — the set of element names whose
 *     end tag may be omitted. The parser uses this set to recognise
 *     which open elements are eligible for implicit close when an
 *     ancestor's closer arrives or a sibling-implicit opener appears.
 *   - `IMPLICIT_CLOSE_ON_OPEN` — for each implied-end element, the
 *     openers that trigger implicit close before the new sibling is
 *     parsed. Encoded as a `currentParent → openers-that-close-it`
 *     map; the closed set on each row mirrors the spec's tag-
 *     omission notes for that element (the "p-closer" set, `<li>` on
 *     `<li>`, `<dt>`/`<dd>` on each other, `<tr>` on `<tr>`, etc.).
 *
 * Both tables use lowercased tag names; lookups in the parser are
 * O(1) hash-set / hash-map probes per token.
 */

/**
 * HTML5 elements whose end tag is optional under the spec.
 *
 * Each element listed here has a normative "Tag omission in
 * text/html" note that allows the end tag to be omitted under the
 * conditions implemented in {@link IMPLICIT_CLOSE_ON_OPEN} (sibling-
 * implicit) and the ancestor-closer recovery in the parser's
 * `#consumeChildren` (parent-implicit). The set is intentionally a
 * closed list — widening it without a matching fixture would re-hide
 * the silent-miss failure mode on every element shape we haven't
 * verified parses cleanly.
 */
export const IMPLIED_END_TAG_ELEMENTS: ReadonlySet<string> = new Set([
  "p",
  "li",
  "dt",
  "dd",
  "option",
  "optgroup",
  "rb",
  "rp",
  "rt",
  "rtc",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "colgroup",
]);

/**
 * Per-element opener triggers that implicitly close the key element
 * before the new sibling is parsed. Mirrors the HTML Living
 * Standard's "Tag omission" notes:
 *
 *   - `<p>` is closed by the standard block-level openers (the spec's
 *     "p-closer" set) so `<p>foo<p>bar` and `<p>foo<ul>` parse the
 *     way browsers render them.
 *   - `<li>` is closed by another `<li>`.
 *   - `<dt>` / `<dd>` close on each other.
 *   - `<option>` closes on `<option>` or `<optgroup>`.
 *   - `<tr>` closes on `<tr>`.
 *   - `<td>` / `<th>` close on `<td>`, `<th>`, `<tr>`.
 *   - `<thead>` / `<tbody>` / `<tfoot>` close on each other.
 *   - `<rt>` / `<rp>` close on each other.
 *   - `<rb>` / `<rtc>` close on the rest of the ruby annotation set.
 *   - `<colgroup>` closes on a sibling `<colgroup>`.
 */
export const IMPLICIT_CLOSE_ON_OPEN: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>([
  [
    "p",
    new Set([
      "address",
      "article",
      "aside",
      "blockquote",
      "details",
      "div",
      "dl",
      "fieldset",
      "figcaption",
      "figure",
      "footer",
      "form",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "header",
      "hgroup",
      "hr",
      "main",
      "menu",
      "nav",
      "ol",
      "p",
      "pre",
      "search",
      "section",
      "table",
      "ul",
    ]),
  ],
  ["li", new Set(["li"])],
  ["dt", new Set(["dt", "dd"])],
  ["dd", new Set(["dt", "dd"])],
  ["option", new Set(["option", "optgroup"])],
  ["optgroup", new Set(["optgroup"])],
  ["tr", new Set(["tr"])],
  ["td", new Set(["td", "th", "tr"])],
  ["th", new Set(["td", "th", "tr"])],
  ["thead", new Set(["tbody", "tfoot"])],
  ["tbody", new Set(["tbody", "tfoot"])],
  ["tfoot", new Set(["tbody"])],
  ["rt", new Set(["rt", "rp"])],
  ["rp", new Set(["rt", "rp"])],
  ["rb", new Set(["rb", "rt", "rp", "rtc"])],
  ["rtc", new Set(["rb", "rtc"])],
  ["colgroup", new Set(["colgroup"])],
]);

/** Predicate matching the start character of an HTML element name. */
function isNameStart(ch: string): boolean {
  return /[a-zA-Z]/.test(ch);
}

/** Predicate matching characters allowed inside an HTML element name. */
function isNameChar(ch: string): boolean {
  return /[a-zA-Z0-9\-_:]/.test(ch);
}

/**
 * Returns the lowercased tag name at the `</tag>` closer position
 * `pos` in `source` without advancing. Returns null when `pos` is
 * not at a closing tag or when the would-be tag name is empty.
 *
 * Used by the implicit-close logic in the HTML parser to recognise
 * an ancestor closer before the stray-close recovery would
 * otherwise consume it.
 */
export function peekClosingTagName(source: string, pos: number): string | null {
  if (source[pos] !== "<" || source[pos + 1] !== "/") return null;
  let i = pos + 2;
  const start = i;
  while (i < source.length) {
    const c = source[i];
    if (c === undefined) break;
    if (!isNameChar(c)) break;
    i += 1;
  }
  if (i === start) return null;
  return source.slice(start, i).toLowerCase();
}

/**
 * Returns the lowercased tag name at the `<tag>` opener position
 * `pos` in `source` without advancing. Returns null at a comment /
 * doctype / closing tag / processing instruction, or when the
 * would-be tag name is empty.
 */
export function peekOpeningTagName(source: string, pos: number): string | null {
  if (source[pos] !== "<") return null;
  const next = source[pos + 1];
  if (next === undefined || next === "/" || next === "!" || next === "?") return null;
  if (!isNameStart(next)) return null;
  let i = pos + 1;
  const start = i;
  while (i < source.length) {
    const c = source[i];
    if (c === undefined) break;
    if (!isNameChar(c)) break;
    i += 1;
  }
  if (i === start) return null;
  return source.slice(start, i).toLowerCase();
}
