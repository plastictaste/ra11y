/**
 * jekyll-liquid-root-layout-parse-recovery — guards the HTML parser's
 * diagnostic for the canonical Jekyll root-layout composition shape.
 *
 * Every `jekyll new` site inherits a `_layouts/default.html` that looks
 * like:
 *
 *   {%- include top.html -%}      <!-- opens <html>/<body> in a sibling -->
 *   <main>{{ content }}</main>
 *   {%- include footer.html -%}   <!-- closes </body> in a sibling -->
 *   </html>                       <!-- trailing root-tag closer -->
 *
 * The literal `</html>` at the tail has no matching open inside this
 * file — `top.html` holds the opener. Before the fix the parser emitted
 * the generic "Stray closing tag at top level" recoverable error, which
 * `analysisCoverage.partialParseFiles[].reason` then echoed to the
 * agent. An agent reading "Stray closing tag at top level" on every
 * `jekyll new` site reasonably treats the file as a broken HTML parse
 * and skips it, silently missing real a11y findings on the recovered
 * partial AST (the `<main>` subtree is intact; document rules already
 * gate on `isHtmlFragment` / `isHtmlLayoutOrPartial` and behave
 * correctly).
 *
 * After the fix the parser recognises the shape — `depth === 0` stray
 * closer + one of `html` / `body` / `head` + a `{% include %}` /
 * `{% render %}` head — and renames the reason to
 *
 *   "Elided layout-tail </html> — file opens with a Liquid {% include %}
 *    directive whose sibling partial closes this root tag"
 *
 * The rename is reason-string enrichment, not suppression: the
 * recoverable error still fires (so `partialParseFiles` retains the
 * honest "scan degraded" telemetry), the partial AST is still handed to
 * the rule pipeline, and existing `isHtmlLayoutOrPartial` /
 * `isHtmlFragment` gates continue to do the document-rule routing. Per
 * docs/kb/architecture/ai-first-consumer.md §"Surface, don't suppress"
 * the move when a heuristic is too coarse is to enrich the text an
 * agent reads — not to hide the signal.
 *
 * What the fixture locks in:
 *   1. Parse errors are still reported on the file (partialParseFiles
 *      bucket must still flag it so the agent knows parsing degraded).
 *   2. The first parse-error reason names the layout-tail shape — the
 *      substring an agent routes on lives at the head of the message.
 *   3. `semantics/landmark-main` does not fire on the recovered file.
 *      Pre-Q8-HEADING-HIERARCHY-FRAGMENT-EMISSION the rule emitted a
 *      `partial_or_layout_file_requires_composed_check`-enriched
 *      "missing <main>" finding via the bodyless-partial branch — the
 *      composition directive `{% include top.html %}` qualified the
 *      file as a layout/partial. After Q8 the file has none of
 *      `<html>` / `<body>` / `<head>` (the parser only recovered the
 *      `<main>` subtree and the trailing stray `</html>`), so the
 *      shared `isFragmentFile` predicate's branch (a) classifies it as
 *      a fragment whose composed parent supplies the landmark, and the
 *      gate suppresses the missing-<main> emit outright. The fixture
 *      asserts the absence to lock in the suppression contract.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "HTML parser renames the stray-close diagnostic on a Liquid `_layouts/default.html` " +
    "shape so `partialParseFiles[].reason` names the layout-composition tail instead " +
    "of echoing the generic 'Stray closing tag at top level' wording — the partial " +
    "AST (including the recovered <main>) is still available to rules.",
  origin: {
    feedbackRound: "Q4-LIQUID-ROOT-LAYOUT-PARSE-RECOVERY",
    notes:
      "Every `jekyll new` site inherits a `_layouts/default.html` with a trailing " +
      "bare `</html>` whose opener lives in `_includes/top.html`. Before this fix " +
      "the generic 'Stray closing tag at top level' reason pushed the file into " +
      "partialParseFiles with a message that read as a parser failure, so agents " +
      "routinely skipped the recovered subtree and real a11y findings went silent.",
  },
  expectations: [
    // Parse error is expected and must still surface — this fixture
    // deliberately exercises the recovery path. Using
    // `parse-errors-at-path` rather than `zero-parse-errors` documents
    // that the rename is honest telemetry, not silent suppression.
    {
      kind: "parse-errors-at-path",
      path: "default.html",
    },

    // The reason the agent reads is the layout-tail rename, not the
    // generic wording. Guarded via `partialParseFiles[0].reason` on
    // the MCP-formatted meta — this IS the string a consuming agent
    // reads to decide whether the partial parse is a real failure or
    // the recognised layout-composition shape. The fixture has a
    // single file so `[0]` is deterministic; `meta-field` with
    // `contains` does substring matching on strings.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "partialParseFiles", "0", "reason"],
      predicate: { contains: "Elided layout-tail" },
    },

    // Q8-HEADING-HIERARCHY-FRAGMENT-EMISSION: the file has none of
    // <html>/<body>/<head> (only the recovered <main> subtree and the
    // trailing stray </html>). The shared `isFragmentFile` predicate's
    // branch (a) classifies it as a fragment whose composed parent
    // supplies the landmark, so the gate suppresses the missing-<main>
    // emit outright. The duplicate-<main> emit (the other observable
    // bug landmark-main checks) is not relevant here — the recovered
    // subtree carries exactly one <main>. Source-level disable pragmas
    // remain the deterministic escape hatch for any consumer that
    // disagrees with the suppression. Parser-recovery telemetry stays
    // visible via the meta-field assertion above.
    {
      kind: "no-violation",
      ruleId: "semantics/landmark-main",
    },
  ],
};
