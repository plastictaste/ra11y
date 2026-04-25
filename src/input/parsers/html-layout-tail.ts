/**
 * Layout-tail diagnostic for the HTML parser's stray-closing-tag
 * recovery. Splits "Stray closing tag at top level" into two cases:
 *
 *   1. The Liquid-composed-layout shape — Jekyll's canonical
 *      `_layouts/*.html` wraps `{{ content }}` between
 *      `{%- include top.html -%}` (opens `<html>` / `<body>` in a
 *      sibling partial) and `{%- include footer.html -%}` (closes
 *      `</body></html>` in the same sibling). The wrapper file
 *      therefore ends with a literal `</html>` / `</body>` whose
 *      opener lives elsewhere. The reason gets a shape-naming
 *      rename so an agent reading `partialParseFiles[].reason`
 *      routes to the include-chain composition instead of
 *      treating the file as a parser failure.
 *   2. Everything else — the generic "Stray closing tag at top
 *      level" wording stays so real structural bugs don't get
 *      dressed up as layout composition.
 *
 * The recoverable error still fires in both cases (so
 * `partialParseFiles` retains the honest "scan degraded"
 * telemetry); only the message string differs. Per the AI-first
 * consumer doctrine (surface, don't suppress), the move when a
 * heuristic-prone wording is too coarse is to enrich the text an
 * agent reads — not to hide the signal.
 */

/**
 * Root-document tags that a Liquid-composed layout routinely closes
 * on behalf of a sibling partial. Matching on a closed set keeps
 * the recognition precise — the rename fires for the documented
 * layout-tail shape, not arbitrary stray closers that might mask a
 * real structural bug.
 */
const LAYOUT_TAIL_CLOSERS: ReadonlySet<string> = new Set(["html", "body", "head"]);

/**
 * Choose the recoverable-error message for a stray closing tag.
 * The Liquid layout-tail rename fires only when ALL three gates
 * hold:
 *
 *   - `depth === 0` — the closer is tailing the whole document,
 *     not orphaned inside an unclosed element body. Without this
 *     guard a nested recovered close on a Liquid-opened file
 *     would be mis-labeled as a layout tail on every ancestor
 *     re-entry.
 *   - Closer name is one of `html` / `body` / `head`. Any other
 *     closer (`</div>`, `</section>`, …) is a real structural bug,
 *     not the documented layout-tail shape.
 *   - First non-whitespace content in the source is a Liquid
 *     `{% include %}` / `{% render %}` directive — the partial
 *     that contributes the opening root tag.
 */
export function strayClosingTagMessage(
  closerName: string,
  depth: number,
  hasLiquidIncludeHead: boolean,
): string {
  const lower = closerName.toLowerCase();
  if (depth === 0 && LAYOUT_TAIL_CLOSERS.has(lower) && hasLiquidIncludeHead) {
    return `Elided layout-tail </${lower}> — file opens with a Liquid {% include %} directive whose sibling partial closes this root tag`;
  }
  return "Stray closing tag at top level";
}

/**
 * Returns true when `source` begins (after optional BOM + whitespace)
 * with a Liquid `{% include %}` / `{% render %}` directive, permitting
 * both plain and whitespace-control (`{%-` / `-%}`) delimiters. Used
 * by {@link strayClosingTagMessage} to decide whether the document is
 * a Liquid-composed layout wrapper whose opening root tag lives in a
 * sibling partial.
 *
 * Exported for unit testing so the detector's acceptance surface is
 * visible as a pure function. Intentionally narrow: `include` /
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
