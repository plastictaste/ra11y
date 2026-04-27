/**
 * Layout-tail diagnostic for the HTML parser's stray-closing-tag
 * recovery. Splits the generic stray-close wording into three cases:
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
 *   2. A genuine root-level stray — `depth === 0` with no
 *      enclosing scope. The wording names the actual stray tag
 *      ("Stray </X> at top level") so the agent doesn't read a
 *      bare "Stray closing tag" and have to re-open the file to
 *      learn which tag is the culprit.
 *   3. A nested stray — `depth > 0`, an enclosing ancestor is
 *      still open. Reformulated as "Mismatched </X> close at line
 *      N (inside <ancestor>)" so the reason names both the
 *      offending tag and the actual scope. The historic "at top
 *      level" wording was the misdiagnosis: a stray observed
 *      inside an open element body is NOT at the document root,
 *      and an agent reading "top level" wastes a read confirming
 *      the root closes cleanly. Reserve "top level" for case 2.
 *
 * The recoverable error still fires in all three cases (so
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
 *
 * Branch order:
 *
 *   1. The Liquid layout-tail rename fires only when ALL three
 *      gates hold:
 *
 *      - `depth === 0` — the closer is tailing the whole document,
 *        not orphaned inside an unclosed element body. Without this
 *        guard a nested recovered close on a Liquid-opened file
 *        would be mis-labeled as a layout tail on every ancestor
 *        re-entry.
 *      - Closer name is one of `html` / `body` / `head`. Any other
 *        closer (`</div>`, `</section>`, …) is a real structural
 *        bug, not the documented layout-tail shape.
 *      - First non-whitespace content in the source is a Liquid
 *        `{% include %}` / `{% render %}` directive — the partial
 *        that contributes the opening root tag.
 *
 *   2. Nested stray (`depth > 0`, an enclosing ancestor is still
 *      open) — name the offending tag and the immediate enclosing
 *      scope. `enclosingTag` MUST be the lowercased name at the
 *      top of the parser's `#openStack`; the parser guarantees a
 *      non-empty stack whenever `depth > 0` because each
 *      `#consumeChildren` push happens before `depth` increments.
 *
 *   3. Genuine root-level stray (`depth === 0` after the layout-
 *      tail check failed) — name the actual stray tag in the
 *      message so the agent doesn't read a bare "Stray closing
 *      tag" and have to re-open the file to learn which tag is
 *      the culprit.
 *
 * @param closerName    — raw stray-tag name from the source (case
 *   preserved for the rendered message; case-insensitive matching
 *   against the layout-tail closer set).
 * @param depth         — current `#consumeChildren` recursion depth
 *   in the parser. `0` means the stray sits at the document root;
 *   `> 0` means it sits inside one or more open element bodies.
 * @param line          — 1-based source line of the stray's `<`,
 *   surfaced verbatim in the nested-stray message so the reason
 *   itself names the location (the `partialParseFiles[].reason`
 *   field on the wire is just the message string; the underlying
 *   `position` doesn't reach the agent).
 * @param enclosingTag  — lowercased name of the nearest still-open
 *   ancestor (`undefined` at `depth === 0`). Used only by branch 2.
 * @param hasLiquidIncludeHead — pre-computed Liquid-head detector
 *   result; passed in rather than re-derived so the parser caches
 *   the detection across multiple stray-close events on one file.
 */
export function strayClosingTagMessage(
  closerName: string,
  depth: number,
  line: number,
  enclosingTag: string | undefined,
  hasLiquidIncludeHead: boolean,
): string {
  const lower = closerName.toLowerCase();
  if (depth === 0 && LAYOUT_TAIL_CLOSERS.has(lower) && hasLiquidIncludeHead) {
    return `Elided layout-tail </${lower}> — file opens with a Liquid {% include %} directive whose sibling partial closes this root tag`;
  }
  if (depth > 0 && enclosingTag !== undefined) {
    return `Mismatched </${closerName}> close at line ${line} (inside <${enclosingTag}>)`;
  }
  return `Stray </${closerName}> at top level`;
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
