/**
 * html-implicit-close-browser-renderable — guards the HTML parser's
 * tolerance for browser-renderable HTML5 patterns that rely on
 * implicit element closes.
 *
 * HTML5 allows several elements to omit their explicit end tag when
 * the parser can infer the close from context. The relevant patterns
 * a hand-authored `index.html` routinely uses include:
 *
 *   - `<p>` paragraphs that end when the next block-level sibling
 *     opens (`<p>`, `<ul>`, `<table>`, …) or when the ancestor
 *     `<body>` closes.
 *   - `<li>` items that end when the next `<li>` opens or when the
 *     `<ul>` / `<ol>` parent closes.
 *   - `<dt>` / `<dd>` that close on each other and on `</dl>`.
 *   - `<thead>` / `<tbody>` / `<tfoot>` and `<tr>` / `<td>` / `<th>`
 *     that close when the next sibling row/cell opens, or when the
 *     enclosing `<table>` closes.
 *
 * Before the fix the parser treated every implicit close as an
 * "Unclosed <p>" / "Unclosed <li>" recoverable error AND emitted a
 * "Stray closing tag at top level" error for the trailing
 * `</body></html>` whose openers had been "consumed" by the unclosed
 * descendants. The result: hand-authored, browser-renderable
 * `index.html` files routed into `analysisCoverage.partialParseFiles`
 * with reasons that read as parser failures. An agent reading those
 * entries reasonably treats the file as broken HTML and skips it,
 * silently missing real a11y findings on the rest of the document.
 *
 * After the fix the parser implements HTML5 implicit-close behavior
 * for the documented set: when a parent's closing tag arrives and
 * the current open element is in the implied-end-tag set, the parent
 * close is honored and the descendant closes implicitly. When a
 * sibling opens that triggers an implicit close (a second `<p>` while
 * the first is still open, a second `<li>`, a sibling `<tr>`), the
 * previous element closes before the sibling opens.
 *
 * What the fixture locks in:
 *   - A common, browser-renderable `index.html` — DOCTYPE + html +
 *     head + body + main + the four canonical implicit-close shapes
 *     (`<p>` siblings, `<li>` siblings, `<table>` rows + cells,
 *     `<dt>` / `<dd>` definitions) plus a trailing whitespace tail —
 *     parses cleanly with zero parse errors.
 *   - The recovered AST contains the document-shaped subtrees the
 *     downstream rules need (`<main>`, `<h1>`).
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Browser-renderable HTML5 index.html using implicit-close patterns " +
    "(<p>, <li>, <table>, <dl>) plus a trailing newline tail must parse " +
    "cleanly — no 'Stray closing tag at top level' on </body></html> and " +
    "no 'Unclosed <p>' / 'Unclosed <li>' cascades.",
  origin: {
    feedbackRound: "Q8-HTML-PARSER-STRAY-CLOSING-TAG-PARTIAL-PARSE",
    notes:
      "Field-report: 208 HTML files reported as partialParseFiles with " +
      "reason 'Stray closing tag at top level' — including browser-renderable " +
      "index.html files ending with whitespace + </body></html>. Root cause " +
      "was the parser not implementing HTML5 implicit-close behavior for <p>, " +
      "<li>, <dt>/<dd>, <thead>/<tbody>/<tfoot>, and <tr>/<td>/<th>; the " +
      "unclosed elements stole the </body> and </html> closers, surfacing the " +
      "trailing root-tag closers as stray.",
  },
  expectations: [
    // Core invariant: the file must parse without recoverable errors.
    // Implicit-close elements are valid HTML5 — the parser must not
    // surface them as parse failures, since downstream consumers (the
    // MCP `analysisCoverage.partialParseFiles` bucket and the agent
    // reading it) cannot distinguish "real parse degradation" from
    // "spec-compliant implicit close" once the recoverable error has
    // been recorded.
    { kind: "zero-parse-errors" },
  ],
};
