/**
 * document-rules-skipped-on-layout-envelope — guards that document-
 * shaped rules (`semantics/landmark-main`) DO emit on a layout
 * source that carries a full `<html>` / `<head>` / `<body>` envelope
 * even when the body interpolates a template directive like
 * `{{ content }}`.
 *
 * Bug shape: a static-site-generator's `_layouts/` tree shipped a
 * document-shaped HTML file — `<!DOCTYPE>`, `<html lang>`, `<head>`
 * with `<title>`, `<body>` with `<header>`/`<footer>` and a
 * `{{ content }}` placeholder where the rendered page would land.
 * The file is the canonical document envelope (the rendered output
 * IS this file with `{{ content }}` replaced by the post body), so
 * `semantics/landmark-main` should fire — the layout has no `<main>`
 * element. Instead, the file landed in
 * `meta.template_files_parsed_as_literal` and document-shaped rules
 * silently suppressed their emissions on every `_layouts/*.html`
 * file in the tree.
 *
 * The skip is over-broad: `template_files_parsed_as_literal` fires
 * because the Liquid `{{ content }}` directive cannot be expanded
 * by a static parser, but the surrounding envelope IS the authored
 * structure the rule asks about. The fragment-vs-document axis and
 * the template-directive axis are independent — this layout is a
 * document AND has unrenderable directives. Suppressing document
 * rules on the second axis hides real authored-structure violations.
 *
 * Closure paths from doctrine ("Heuristic emission is the symmetric
 * twin of heuristic suppression"): when a file has document-envelope
 * evidence (`<html>` opener present, `<body>` present), document-
 * shaped rules must run regardless of whether the body contains
 * unrenderable template directives. The directives reduce confidence
 * on rules that depend on the body's textual contents (e.g. heading
 * text), but they do not reduce confidence on a structural check
 * that asks "is there a `<main>` landmark anywhere in this file?"
 *
 * Closure: the unified `classifyHtmlFile` predicate in
 * `src/engine/layout-partial.ts` derives `isFragment` and
 * `isLayoutOrPartial` from a single signal pass over the file. On a
 * `_layouts/*.html` document that has an `<html>` opener AND a
 * composition directive (`{{ content }}`) the `hasHtmlOpener` signal
 * vetoes `isFragment`, so the leaf-fragment suppression gate in
 * `semantics/landmark-main` does not apply — the rule continues into
 * the missing-`<main>` path and emits with
 * `couldBeWrongBecause: partial_or_layout_file_requires_composed_check`
 * + the layout-partial message suffix. The envelope axis (file
 * carries `<html>`/`<body>` — document-shape rules should run) and
 * the body-content directive axis (an agent reading body text needs
 * to know `{{ content }}` is unrenderable) are already independent in
 * the classifier: `template_files_parsed_as_literal` only populates
 * the meta-channel telemetry payload, it does not gate emissions.
 * `landmark-main` / `page-titled` / `lang-attribute` are envelope-
 * axis checks and run on this layout file regardless of body-content
 * directive parseability.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A layout file with a full `<html>`/`<head>`/`<body>` envelope and a " +
    "`{{ content }}` template directive in the body must still trigger " +
    "`semantics/landmark-main` (the layout has no `<main>` element). The " +
    "skip currently observed on `_layouts/*.html` is an over-broad " +
    "interaction between the template-directive classifier and the " +
    "fragment-classifier — document rules belong to the envelope axis, " +
    "not the body-content axis.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep on a static-site-generator with mixed " +
      "Liquid / ERB templates observed three `_layouts/*.html` files with " +
      "full HTML envelopes shipping zero `semantics/landmark-main` and zero " +
      "`document/page-titled` emissions, despite the layouts having no " +
      "`<main>` element. The files were listed in " +
      "`template_files_parsed_as_literal`, suggesting that classifier " +
      "gates document-rule emissions off too aggressively.",
  },
  toolInput: {
    verboseMeta: true,
  },
  expectations: [
    // Sanity: parser bails are unrelated to the skip — the file's HTML
    // envelope parses cleanly even if the `{{ content }}` literal is
    // not expanded. A parse-error here would make the violation-present
    // assertion below pass for the wrong reason.
    { kind: "zero-parse-errors" },

    // The load-bearing assertion: `semantics/landmark-main` MUST fire
    // on this layout file. The layout's body has no `<main>` element
    // — the WCAG 1.3.1 / 4.1.2 question the rule asks ("is there a
    // landmark?") is independently answerable from the envelope, no
    // matter what the body's textual content turns out to be at
    // render time. Now GREEN under the unified classifier: the
    // `hasHtmlOpener` signal vetoes the leaf-fragment gate so the
    // missing-`<main>` emit fires with the layout-partial enrichment
    // (couldBeWrongBecause: partial_or_layout_file_requires_composed_check)
    // rather than being silently suppressed.
    {
      kind: "violation-present",
      ruleId: "semantics/landmark-main",
      inFile: "_layouts/page.html",
    },
  ],
};
