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
 *   "Elided layout-tail <html> open — file ends with a bare </html>
 *    closer; opens with a Liquid {% include %} directive whose sibling
 *    partial provides the matching <html> open tag"
 *
 * The reason names the elided side (the OPENING `<html>` supplied by
 * the partial) and the observed side (the bare `</html>` closer in
 * this file). An earlier rename inverted that direction — naming the
 * closer `</html>` as elided and claiming the partial "closes" the
 * tag — which read backwards to an agent triaging the file.
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
 *   3. `semantics/landmark-main` fires on the recovered file with the
 *      `partial_or_layout_file_requires_composed_check` enrichment.
 *      The shared fragment classifier identifies the file as a LAYOUT
 *      (its source ships `{{ content }}` — a layout-shape composition
 *      directive whose presence vetoes fragment classification per the
 *      AND-conjunction predicate). With `bodies.length === 0` and
 *      `fragment === false` AND `layoutOrPartial === true`, the
 *      bodyless branch of `landmark-main` emits at `warning` severity
 *      with the enrichment message ("This file looks like a layout
 *      wrapper or template partial…") so an agent reading the finding
 *      verifies the composed parent supplies `<main>` rather than
 *      acting on the call site. Per docs/kb/architecture/ai-first-
 *      consumer.md "Surface, don't suppress" — surfacing with
 *      enrichment is more honest than the prior outright-suppression
 *      behavior, which silently hid the composition site from the
 *      agent's triage budget.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "HTML parser renames the stray-close diagnostic on a Liquid `_layouts/default.html` " +
    "shape so `partialParseFiles[].reason` names the layout-composition tail instead " +
    "of echoing the generic 'Stray closing tag at top level' wording — the partial " +
    "AST (including the recovered <main>) is still available to rules.",
  origin: {
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

    // The file ships a `{{ content }}` layout-shape composition
    // directive — under the shared fragment classifier this signals
    // the file IS a layout that composes child content (a layout is
    // not a fragment; its rendered page envelope is composed at this
    // file's level). With the bodyless branch in landmark-main:
    // `bodies.length === 0` AND `fragment === false` AND
    // `layoutOrPartial === true` → emit `bodylessPartial` with the
    // `partial_or_layout_file_requires_composed_check` enrichment so
    // an agent reading the finding follows the include chain rather
    // than acting on the missing-body at the call site. This is the
    // honest framing per docs/kb/architecture/ai-first-consumer.md
    // "Surface, don't suppress" — the file is a layout-shape
    // composition site whose body lives in `_includes/top.html`, and
    // surfacing the finding lets the agent verify the composed parent
    // chain rather than suppressing silently. The deterministic escape
    // hatch remains the source-level disable pragma for consumers who
    // disagree.
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      reasonIncludes: "layout wrapper or template partial",
    },
  ],
};
