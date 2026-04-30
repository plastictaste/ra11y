/**
 * jekyll-xmllang-lang-mismatch — guards `document/lang-attribute` against
 * the "both xml:lang and lang present, but they disagree" shape.
 *
 * The canonical repro is a Jekyll-style layout that ships both attributes
 * at the document root:
 *
 *   <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en-us">
 *
 * Here `xml:lang="en"` is the bare primary subtag and `lang="en-us"` is a
 * primary+region pair. A conforming assistive technology is allowed to
 * consult either attribute; when they disagree, the announced language is
 * nondeterministic. WCAG 3.1.1 is about the page's language being
 * *programmatically determinable* — when two sources of truth contradict,
 * that programmatic determination is ambiguous.
 *
 * Before the fix, `document/lang-attribute` only flagged the missing /
 * empty cases; "both present, both non-empty, but disagree" fell through
 * the existing guards silently.
 *
 * What the fixture locks in:
 *   1. Zero parse errors — the template is valid HTML.
 *   2. A `document/lang-attribute` violation fires, with a reason naming
 *      both values so the agent can read the mismatch from the finding
 *      without re-opening the file.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "When <html> declares both xml:lang and lang but their values disagree " +
    '(e.g. xml:lang="en" lang="en-us"), document/lang-attribute must flag the ' +
    "inconsistency — the announced language is otherwise nondeterministic.",
  origin: {
    notes:
      "Observed in a Jekyll-style `_layouts/default.html` that paired a bare " +
      '`xml:lang="en"` with a region-qualified `lang="en-us"`. No rule caught ' +
      "the internal disagreement; the agent saw a clean scan on a file with " +
      "real WCAG 3.1.1 ambiguity.",
  },
  expectations: [
    { kind: "zero-parse-errors" },
    {
      kind: "violation-present",
      ruleId: "document/lang-attribute",
      // The reason must echo both values so the agent can triage from the
      // finding alone. "en" and "en-us" are the two conflicting tags.
      reasonIncludes: "en-us",
    },
  ],
};
