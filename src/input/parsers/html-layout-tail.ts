/**
 * Layout-tail diagnostic for the HTML parser's stray-closing-tag
 * recovery. Splits the generic stray-close wording into four cases:
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
 *   2. The Astro-composed-layout shape — an Astro page or partial
 *      whose document envelope (`<html>` / `<body>` / `<head>`) is
 *      opened by an imported component (`<Layout>` / `<BaseLayout>`)
 *      while the page itself only emits the closing tags downstream.
 *      The shape is structurally identical to the Liquid case but
 *      the head signal differs (Astro frontmatter `---\n…\n---` vs
 *      Liquid `{% include %}`); only the parser knows the source
 *      came from `parseAstro`, so the flag is threaded in rather
 *      than re-detected from the post-strip residue (the
 *      frontmatter is blanked to whitespace by the time `parseHtml`
 *      sees the source). Unlike the Liquid case, the matching-open
 *      gate is per-tag (no `<html>` open in source while `</html>`
 *      appears) rather than a count-of-all-closers, because Astro
 *      partials commonly close `</body></html>` together — both
 *      delegated by the parent `<Layout>` component.
 *   3. A genuine root-level stray — `depth === 0` with no
 *      enclosing scope. The wording names the actual stray tag
 *      ("Stray </X> at top level") so the agent doesn't read a
 *      bare "Stray closing tag" and have to re-open the file to
 *      learn which tag is the culprit.
 *   4. A nested stray — `depth > 0`, an enclosing ancestor is
 *      still open. Reformulated as "Mismatched </X> close at line
 *      N (inside <ancestor>)" so the reason names both the
 *      offending tag and the actual scope. The historic "at top
 *      level" wording was the misdiagnosis: a stray observed
 *      inside an open element body is NOT at the document root,
 *      and an agent reading "top level" wastes a read confirming
 *      the root closes cleanly. Reserve "top level" for case 3.
 *
 * The recoverable error still fires in all four cases (so
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
 *   1. The Liquid layout-tail rename fires only when ALL FOUR
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
 *      - The file contains EXACTLY ONE root-envelope closer
 *        (`</html>` / `</body>` / `</head>` combined; case-
 *        insensitive). A wrapper that delegates root-tag closure
 *        to a sibling partial has only one such closer — the
 *        diagnosed stray itself. A file whose tail reads
 *        `</body>\n</html>` has two; that file is closing its OWN
 *        root document (broken or otherwise), not eliding root
 *        closure. Naming such a tail "Elided layout-tail" lies to
 *        the agent — the parse error is something else (forgotten
 *        opens, mis-paired structure, hand-completed envelope on a
 *        file the partial expects to leave unclosed).
 *
 *   2. The Astro layout-tail rename fires when ALL FOUR gates hold:
 *
 *      - `depth === 0` — same root-tail constraint as Liquid.
 *      - Closer name is one of `html` / `body` / `head`.
 *      - `astroComposedLayout` is `true` — the parser was invoked
 *        through `parseAstro`, so the file is known to be `.astro`
 *        source whose frontmatter was stripped before `parseHtml`
 *        ran. Without this flag we can't tell the file apart from
 *        a hand-authored HTML partial that's just missing an open;
 *        with it we know the document envelope is conventionally
 *        delegated to a parent `<Layout>` component.
 *      - The matching open tag for THIS closer does NOT appear in
 *        source ({@link hasMatchingOpenTag} returns false for the
 *        same lowercased name). Per-tag rather than count-of-all
 *        because Astro partials canonically close `</body></html>`
 *        together — both delegated by the parent — whereas Liquid
 *        wrappers carry exactly one root-envelope closer at the
 *        very tail. The per-tag gate keeps a paired
 *        `<body>…</body>` from spuriously triggering the rename
 *        when the trailing `</html>` is the one that's actually
 *        stray.
 *
 *   3. Nested stray (`depth > 0`, an enclosing ancestor is still
 *      open) — name the offending tag and the immediate enclosing
 *      scope. `enclosingTag` MUST be the lowercased name at the
 *      top of the parser's `#openStack`; the parser guarantees a
 *      non-empty stack whenever `depth > 0` because each
 *      `#consumeChildren` push happens before `depth` increments.
 *
 *   4. Genuine root-level stray (`depth === 0` after the layout-
 *      tail checks failed) — name the actual stray tag in the
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
 *   ancestor (`undefined` at `depth === 0`). Used only by branch 3.
 * @param hasLiquidIncludeHead — pre-computed Liquid-head detector
 *   result; passed in rather than re-derived so the parser caches
 *   the detection across multiple stray-close events on one file.
 * @param source — the file source, used by branch 1 to count
 *   `</html>` / `</body>` / `</head>` tokens (case-insensitive)
 *   and by branch 2 to check whether the matching open tag for
 *   the diagnosed closer is present elsewhere in source. Scanned
 *   per call rather than cached because branches 1 and 2 only
 *   run when the prior gates hold, and on most files no
 *   stray-close event reaches them at all.
 * @param astroComposedLayout — true when the parser was invoked
 *   via `parseAstro`. Gates branch 2 — the Astro layout-tail
 *   rename — so the elision wording fires only on `.astro` source
 *   where the closer-only shape is the documented composition,
 *   not arbitrary HTML partials whose origin is unknown.
 */
export function strayClosingTagMessage(
  closerName: string,
  depth: number,
  line: number,
  enclosingTag: string | undefined,
  hasLiquidIncludeHead: boolean,
  source: string,
  astroComposedLayout: boolean,
): string {
  const lower = closerName.toLowerCase();
  if (
    depth === 0 &&
    LAYOUT_TAIL_CLOSERS.has(lower) &&
    hasLiquidIncludeHead &&
    countLayoutTailClosers(source) === 1
  ) {
    // The `</${lower}>` IS in source (that's what we just diagnosed); the
    // OPENING `<${lower}>` is what's elided — supplied by the sibling
    // partial pulled in via `{% include %}` / `{% render %}`. Naming the
    // elided side honestly per docs/kb/architecture/ai-first-consumer.md
    // "Heuristic-mislabeled meta sub-fields are dishonest" — the prior
    // wording named the closer as elided and claimed the partial "closes"
    // the tag (it opens it), which inverted the direction the agent
    // routes on.
    return `Elided layout-tail <${lower}> open — file ends with a bare </${lower}> closer; opens with a Liquid {% include %} directive whose sibling partial provides the matching <${lower}> open tag`;
  }
  if (
    depth === 0 &&
    LAYOUT_TAIL_CLOSERS.has(lower) &&
    astroComposedLayout &&
    !hasMatchingOpenTag(source, lower)
  ) {
    // Same direction-inversion fix as the Liquid branch: the closer is in
    // source, the opener is delegated to the parent `<Layout>` component
    // and is what's actually elided.
    return `Elided layout-tail <${lower}> open — file contains a bare </${lower}> closer; this Astro page or partial expects the matching <${lower}> open tag from a parent <Layout> component`;
  }
  if (depth > 0 && enclosingTag !== undefined) {
    return `Mismatched </${closerName}> close at line ${line} (inside <${enclosingTag}>)`;
  }
  return `Stray </${closerName}> at top level`;
}

/**
 * True when `source` contains an opening `<tag>` (case-insensitive)
 * for the given lowercased name. Used by {@link strayClosingTagMessage}
 * branch 2 to gate the Astro layout-tail rename — the rename fires
 * only when the diagnosed closer has no matching open elsewhere in
 * source, signalling the open lives in an imported `<Layout>`
 * component rather than this file.
 *
 * The match accepts `<tag>`, `<tag attr="x">`, `<tag\n…`, etc. — any
 * shape where the `<tag` token is followed by a character that ends
 * the tag name (whitespace, `>`, or `/`). It does NOT match comment
 * spans (`<!-- -->`) because the leading `!` cannot be the first
 * character of a tag name. Exported so the predicate is unit-testable
 * as a pure function.
 */
export function hasMatchingOpenTag(source: string, lowerName: string): boolean {
  const re = new RegExp(`<${lowerName}(?:[\\s/>])`, "i");
  return re.test(source);
}

/**
 * Count occurrences of root-envelope closing tags
 * (`</html>` / `</body>` / `</head>`, case-insensitive) in the
 * source. Used by {@link strayClosingTagMessage} branch 1 to
 * gate the layout-tail elision rename: a wrapper that delegates
 * root-tag closure to a sibling partial has exactly one such
 * closer in its source (the trailing stray); a file whose tail
 * reads `</body>\n</html>` has two and is closing its own
 * document.
 *
 * Exported for unit testing so the count's acceptance surface is
 * visible as a pure function. Implemented as a single regex sweep
 * for the closed three-element set; widening the set without a
 * matching fixture would re-introduce the silent-miss failure
 * mode on every template shape we haven't verified.
 */
export function countLayoutTailClosers(source: string): number {
  // Match `</tag>` for tag in {html, body, head}, case-insensitive.
  // Trailing `[\s>]` accepts both bare `</html>` and `</html >` so a
  // stray spelled with an inner space (rare but legal in recovery
  // paths) still counts. The leading boundary is the literal `</`
  // sequence, which cannot appear inside attribute values or text
  // entities — no false positives from `&lt;/html&gt;` or similar.
  const matches = source.match(/<\/(?:html|body|head)[\s>]/gi);
  return matches ? matches.length : 0;
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
