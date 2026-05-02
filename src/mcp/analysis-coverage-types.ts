/**
 * Shared types co-owned by `analysis-coverage.ts` and its sibling
 * sub-assemblers (`analysis-coverage-parse-errors.ts`,
 * `markdown-classifier.ts`). Kept in a thin types-only module so
 * neither consumer creates an import-back-edge to the parent — the
 * parent file owns the orchestration and the sub-assemblers own the
 * per-section logic, and the shared shapes they both touch live here.
 */

import type { FragmentClassificationSignals } from "../engine/layout-partial.ts";

/**
 * A file whose parser emitted errors. The `reason` is the first parse
 * error's message — surfaced as-is so an agent can branch on the root
 * cause ("Unexpected token `<`" vs "Unterminated string literal")
 * rather than guessing from the file extension.
 *
 * `parserAttempted` names which in-house parser owned the failure
 * (`html`, `css`, `tsx`, `jsx`, `ts`, `js`) — i.e. the routing
 * decision the dispatcher in `src/mcp/session.ts` `parseSourceForFile`
 * actually took. This is *not* a content classification: a `.js` file
 * routed through the TSX parser ships `parserAttempted: "tsx"`, which
 * an agent reading naively could mistake as "this codebase uses TSX"
 * and re-route fix suggestions accordingly. The companion
 * `naturalParser` field disambiguates (per AI-first consumer model
 * "Ambiguous field shapes are dishonest").
 *
 * `naturalParser` is present-when-meaningful: the per-extension
 * default the agent would expect from looking at the file extension
 * alone (`.js` → `js`, `.svg` → `svg`, `.scss` → `scss`). Surfaced
 * only when it differs from `parserAttempted` — for matching
 * extension/parser pairs (`.tsx` → `tsx`, `.html` → `html`,
 * `.css` → `css`) the field is omitted because there is no routing
 * mismatch to disclose. The two-field shape lets the agent see in one
 * read whether the parse failure was on a file routed through a
 * non-natural parser (e.g. `.js` → tsx) versus a file whose natural
 * parser failed on its own input.
 *
 * Classification into either `parseErrorFiles` (total-parse-failure,
 * file invisible to rules) or `partialParseFiles` (rules fired on the
 * recovered slice) is decided at emission time by checking whether
 * the file produced any findings.
 *
 * `triggerToken` is present-when-meaningful: parsers populate it when
 * the structured `reason` token (e.g. `tsx_parser_on_non_jsx_input`)
 * names a routing or interpretation failure rather than an authored-
 * source error, and the offending source fragment (e.g. the literal
 * `<r.length>` read from a minified `.js` `r.length<b.length`
 * comparison) is the additive evidence the agent needs to verify the
 * read without the parser echoing the fragment as if it were
 * authored ground truth. Absent on conventional prose-reason entries.
 *
 * `parsedThroughLine` is present-when-meaningful: the 1-based source
 * line of the first parse error — the natural "parser stopped here"
 * signal so an agent can bound trust in per-rule findings on the file
 * (rules may have visited the first 5 lines or the first 500). Without
 * it, an agent triaging a `partialParseFiles` entry has no way to
 * scope the verification read short of the whole file, defeating the
 * static-scanner premise. Sourced from the head error's
 * {@link ../types/ast.SourcePosition.line | `position.line`}; absent
 * when the parser couldn't record an exact line (`position.line` is 0
 * or otherwise non-meaningful) — never `0` or `null` as a sentinel,
 * per the AI-first consumer model's rule against ambiguous field
 * shapes.
 */
export interface ParseErrorEntry {
  readonly path: string;
  readonly parserAttempted: string;
  readonly naturalParser?: string;
  readonly reason: string;
  readonly triggerToken?: string;
  readonly parsedThroughLine?: number;
}

/**
 * Categorical shape of a fragment file. The flat
 * `analysisCoverage.fragmentFiles[]` list previously surfaced only the
 * path, but observed members fall into categorically-different shapes
 * that warrant different downstream rule-skipping decisions:
 *
 *   - `html_partial` — Jekyll `_includes/`, Hugo `partials/`, Astro /
 *     Handlebars layouts: HTML markup intended to be composed into a
 *     parent layout at render time. Document-shaped rules
 *     (`landmark-main`, `heading-hierarchy`, `page-titled`,
 *     `lang-attribute`) are out of scope because the parent layout
 *     supplies the envelope.
 *   - `markdown_residue` — `.md` / `.markdown` files routed through
 *     the HTML parser per ADR 0025 AND for which positive
 *     layout-composition evidence exists in the scan (a sibling file
 *     declares a layout directive, lives in a layouts dir, or the
 *     scanned tree contains a recognized static-site-generator
 *     config). The parsed AST is the literal-text residue after the
 *     markdown body, so a missing `<html>` root reflects the source
 *     format AND the markdown body is composed by an SSG-supplied
 *     parent layout the static scanner can't see in one pass.
 *   - `markdown_unclassified` — `.md` / `.markdown` files routed
 *     through the HTML parser whose surrounding scan carries NO
 *     positive layout evidence. The honest discriminator when the
 *     scanner can't tell whether the file is README-style standalone
 *     prose or a content page composed by an unseen SSG layout — per
 *     AI-first consumer doctrine "Heuristic-mislabeled meta sub-
 *     fields are dishonest," uniform `markdown_residue` on negative-
 *     default signals would imply a deterministic SSG read the
 *     scanner did not perform.
 *   - `svg_standalone` — `.svg` files routed through `parseHtml` per
 *     `src/input/parsers/svg.ts`. A standalone icon / brand-mark SVG
 *     has no `<html>` or `<body>` because it isn't a document.
 *     Page-level rules should skip these unconditionally.
 *
 * Per the AI-first consumer model "Heuristic-mislabeled meta sub-
 * fields are dishonest" rule: the kind is provable from the file
 * extension plus deterministic in-scope evidence (no path-pattern
 * guessing on the file alone), so the discriminator clears the "100%
 * correct from the evidence" bar.
 *
 * Document-shaped rules will read the discriminator before deciding
 * eligibility — that wiring is a follow-up; this type ships the field
 * so downstream consumers can branch on it now.
 */
export interface FragmentFileEntry {
  readonly path: string;
  readonly kind: "html_partial" | "markdown_residue" | "markdown_unclassified" | "svg_standalone";
  /**
   * Structural signals captured by the shared
   * {@link import("../engine/layout-partial.ts").classifyFragment}
   * predicate when this file was classified as a fragment —
   * `hasHtmlOpener`, `hasLayoutDirective`, `inLayoutsDir`. All three
   * are `false` for entries that reach this list (the predicate
   * stamps fragment only when ALL three signals are absent), but
   * surfaced explicitly so an agent auditing a classification can
   * read the raw evidence without re-deriving it. Pairs with the
   * "Heuristic-mislabeled meta sub-fields are dishonest" rule per
   * `docs/kb/architecture/ai-first-consumer.md`: every signal here is
   * provable from the file alone (path / AST / source regex) so the
   * sub-field labels clear the "100% correct from the evidence" bar.
   */
  readonly fragmentClassificationSignals: FragmentClassificationSignals;
  /**
   * Additive evidence — present-when-meaningful — naming the layout-
   * composition signal(s) that promoted a `.md` / `.markdown` entry
   * from `markdown_unclassified` to `markdown_residue`. Each token
   * names a deterministic in-scope predicate the scanner observed
   * elsewhere in the same scan: a recognized SSG config filename
   * (`ssg_config:gatsby-config.js`, `ssg_config:astro.config.ts`), a
   * sibling file with a layout directive
   * (`sibling_layout_directive`), or a sibling file in a layouts dir
   * (`sibling_in_layouts_dir`). Per AI-first consumer doctrine
   * "Heuristic-mislabeled meta sub-fields are dishonest," each token
   * is provable from the scanned file set alone so the field clears
   * the "100% correct from the evidence" bar. Omitted when the kind
   * is not `markdown_residue` or when no qualifying evidence was
   * observed.
   */
  readonly ssgEvidence?: readonly string[];
}
