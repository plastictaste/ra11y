/**
 * jekyll-liquid-attr-quote — guards the HTML parser against nested-quote
 * Liquid expressions inside attribute values.
 *
 * The canonical Jekyll scaffold template writes:
 *   <html lang="{{ site.lang | default: "en-US" }}">
 *
 * Before the fix, the attribute-value tokenizer terminated on the inner
 * `"` of `default: "en-US"`, truncating the attribute to
 * `lang="{{ site.lang | default: "`. That malformed value failed the
 * BCP 47 check in `parsing/html-has-lang`, producing a confident FALSE
 * positive on every `jekyll new` scaffold. The fix teaches the
 * attribute-value tokenizer to track balanced `{{ ... }}` and `{% ... %}`
 * spans so quotes inside a Liquid expression no longer terminate the
 * attribute value.
 *
 * What the fixture locks in:
 *   1. Zero parse errors — the parser must accept the template verbatim.
 *   2. No `parsing/html-has-lang` violation — the Liquid-expressed lang
 *      value is opaque to the static scanner, so the rule must not fire
 *      on a template that the runtime will resolve to a valid BCP 47 tag.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Liquid expressions with nested double-quotes inside HTML attribute values (e.g. " +
    'lang="{{ site.lang | default: "en-US" }}") must not truncate the attribute or ' +
    "trigger a false parsing/html-has-lang violation.",
  origin: {
    feedbackRound: "Q4-LIQUID-ATTR-QUOTE-BUG",
    notes:
      "Jekyll's canonical `_layouts/default.html` (from `jekyll new`) uses Liquid " +
      "filter arguments with their own double-quoted literals inside a double-quoted " +
      "attribute value. Every Jekyll-based site inherited the false positive until " +
      "the HTML parser learned to skip over balanced `{{ ... }}` / `{% ... %}` spans " +
      "when searching for the closing quote.",
  },
  expectations: [
    // The attribute-value tokenizer must not error on nested-quote Liquid.
    // A broken AST here leaves every downstream rule operating on garbage.
    { kind: "zero-parse-errors" },

    // The false `parsing/html-has-lang` finding is the headline bug. The
    // template's `lang="{{ site.lang | default: "en-US" }}"` is opaque to
    // static analysis — the runtime may resolve it to a valid BCP 47 tag
    // or not, and the scanner cannot decide either way. Surfacing a
    // confident "invalid BCP 47" violation on this shape is dishonest.
    { kind: "no-violation", ruleId: "parsing/html-has-lang" },
  ],
};
