/**
 * code-block-cdata — guards the HTML parser's treatment of `<code>`
 * and `<pre>` text content as opaque (CDATA-like).
 *
 * Documentation pages routinely use `<code>` and `<pre>` to display
 * literal HTML examples — sometimes balanced, sometimes intentionally
 * showing only a close tag for context (e.g. "drop this `</button>`
 * before the wrapper closes"). Per the HTML Living Standard, neither
 * `<code>` nor `<pre>` is a formal raw-text element (only `<script>`
 * and `<style>` are), so a strict tag-walker reads the literal HTML
 * inside as nested DOM. When the literal is unbalanced — a stray
 * `</ul>`, `</button>`, `</li>` shown for narrative purposes — the
 * walker emits "Mismatched </X> close at line N (inside <code>)"
 * recoverable errors. Browsers tolerate the same input fine because
 * `<code>` content is rendered text-as-text; ra11y's downstream
 * pipeline does not — every file with a recoverable error lands in
 * `analysisCoverage.partialParseFiles[]`, and an agent reading that
 * bucket reasonably treats the file as broken HTML and skips the
 * surrounding rules.
 *
 * The bug recurred across CSS-framework `.astro` documentation and
 * SSG `.html` / `.markdown` files (5+ partial-parse files in one
 * scan) before this fix. Closure: treat `<code>` and `<pre>` text
 * content as opaque between their open and the matching close —
 * tag-recognition is suspended inside, so a literal `</ul>` is just
 * text, not a stray-close diagnostic. The carve-out is narrow and
 * named (these two tags only) — it does not extend to other elements
 * unless evidence warrants.
 *
 * What the fixture locks in:
 *   - A documentation HTML file using `<code>` and `<pre>` with
 *     literal HTML examples (balanced, unbalanced, and close-tag-only
 *     for narrative purposes) parses cleanly with zero parse errors.
 *
 * Trade-off accepted by this carve-out: anchors / interactive
 * elements that are *literally* nested inside `<code>` / `<pre>` in
 * the source no longer surface as parsed elements (they become text).
 * That's the intended outcome — content shown as a code example is
 * documentation prose, not a live control. Findings on real
 * (non-`<code>`) anchors elsewhere in the document are unaffected.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Documentation HTML using <code> and <pre> blocks to display literal " +
    "HTML examples (including unbalanced close tags shown for narrative " +
    "purposes) must parse cleanly — no 'Mismatched </X> close at line N " +
    "(inside <code>)' errors that route the file into partialParseFiles[].",
  origin: {
    notes:
      "Recurring across CSS-framework .astro documentation and SSG " +
      ".html / .markdown files (5+ partial-parse files in one scan). " +
      "Root cause was the HTML parser treating <code> and <pre> text " +
      "as nested DOM rather than character-data; literal close tags " +
      "shown for narrative purposes (e.g. '</ul>') triggered " +
      "stray-close recoverable errors that gutted rule coverage on " +
      "the surrounding document.",
  },
  expectations: [
    // Core invariant: documentation snippets inside <code>/<pre> must
    // not surface as parse failures. Per the AI-first doctrine ("any
    // classification that gates the rule's evidence model must
    // propagate to that rule's confidence label"), a recoverable
    // error here cascades into per-rule coverage downgrades on the
    // entire file — silently dropping signal the agent would use.
    { kind: "zero-parse-errors" },
  ],
};
