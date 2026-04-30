/**
 * jekyll-liquid-text-literal — guards the HTML parser's text-node
 * emission layer against treating Liquid/Jinja/ERB directives as
 * literal visible text.
 *
 * Rules that consume visible text (`semantics/label-in-name`,
 * `semantics/list-structure`, `document/page-titled`,
 * `navigation/link-descriptive-text`) operate on the rendered-text
 * shape — the string a sighted user actually sees. Before this fix,
 * the parser emitted `HtmlText` nodes carrying the raw template
 * source, so `<select>…{% for %}{% endfor %}…</select>` registered
 * `{% for %}` as part of the accessible name, and a `{% capture %}`
 * block inside a `<ul>` made the embedded `<a>` appear as a direct
 * child of the list container (hoisting into a Liquid variable is
 * invisible to a static tokenizer).
 *
 * The parser now:
 *   1. Strips inline Liquid/Jinja (`{{ … }}` / `{% … %}`) and ERB
 *      (`<% … %>` / `<%= … %>` / `<%# … %>`) spans from text-node
 *      values, preserving surrounding whitespace so the rendered
 *      shape reads correctly.
 *   2. Treats `{% capture … %}…{% endcapture %}` and
 *      `{% comment %}…{% endcomment %}` as opaque text spans —
 *      their element children are not exposed as siblings because
 *      the content is assigned to a variable (capture) or discarded
 *      (comment), not rendered in-place.
 *   3. Flags text nodes that contained stripped directives via
 *      `containsTemplateDirective: true` so rules can append the
 *      `template_directive_stripped` signal to their reason text —
 *      the agent knows the check ran against the stripped shape.
 *
 * What the fixture locks in:
 *   - Zero parse errors.
 *   - No false `semantics/label-in-name` on the mobile-nav `<select>`
 *     whose visible label is the `{% for %}` loop (now stripped).
 *   - No false `semantics/list-structure` on the Jekyll docs list
 *     whose `{% capture %}`-hoisted `<a>` looked like a `<ul>` child.
 *   - The honest "surface, don't suppress" counter-example: when
 *     a link's *residual* stripped text is itself a generic phrase,
 *     navigation/link-descriptive-text still fires — with the
 *     `template_directive_stripped` signal in the message so the
 *     agent knows the check ran against the stripped shape.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Liquid/Jinja template directives in text content are stripped so rules consuming " +
    "visible text (label-in-name, list-structure, link-descriptive-text, page-titled) " +
    "operate on the rendered-text shape, not the template source shape.",
  origin: {
    notes:
      "Jekyll's canonical docs-nav templates embed `{% for %}` loops inside `<select>` " +
      "and `{% capture %}` blocks inside `<ul>`. Before the fix, label-in-name saw the " +
      "loop syntax as the <select>'s accessible name, and list-structure saw the <a> " +
      "nested inside the capture as a naked list-container child — both confident " +
      "wrong findings on every Jekyll site.",
  },
  expectations: [
    { kind: "zero-parse-errors" },

    // docs_contents_mobile.html — the <select>'s visible text is the
    // Liquid for-loop. Before the fix, label-in-name compared the
    // aria-label "Choose a section" against visible text starting with
    // "{% for section in site.docs_sections %}" and fired a FALSE
    // positive. After the strip, the loop literal is gone and the
    // rule stays silent.
    { kind: "no-violation", ruleId: "semantics/label-in-name" },

    // docs_contents.html — the <a> sits inside a {% capture %}…{%
    // endcapture %} block inside the <ul>. Liquid assigns the captured
    // HTML to a variable; the rendered output places `{{ doc_link }}`
    // inside the <li>. Statically, the <a> was a direct child of <ul>
    // → list-structure fired "non-<li> child". After the fix, capture
    // blocks are opaque text spans and the <a> is no longer a sibling.
    { kind: "no-violation", ruleId: "semantics/list-structure" },

    // post.html — `<a href="{{ post.url }}">{{ post.cta_prefix }} Read
    // more</a>` strips to " Read more" → "read more" (generic phrase).
    // The rule must still fire (stripping is NOT suppression) and the
    // reason must carry the template_directive_stripped signal so the
    // agent knows the check ran against the stripped shape.
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: "read more",
    },
    {
      kind: "violation-present",
      ruleId: "navigation/link-descriptive-text",
      reasonIncludes: "template_directive_stripped",
    },
  ],
};
