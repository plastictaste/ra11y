/**
 * document-rules-on-markdown-residue — guards that document-shaped
 * rules (page-titled, lang-attribute, charset-first-1024-bytes,
 * landmark-main) do not emit at error/warning severity on a markdown
 * source whose `parseModeByExtension` is `markdown-html-residue`.
 *
 * Bug shape: a tutorial README mentions `<html>`, `<head>`, `<title>`
 * tag names in narrative prose — including a fenced code block that
 * literally renders an HTML document. The HTML parser bails early on
 * a stray `</p>` after a `<div class="callout">`, and every line
 * below the bail is markdown text the parser never structurally saw.
 * Yet the document-shaped rules emit
 *   "HTML document is missing a <title> element"
 * on lines well past `parsedThroughLine`, citing the prose mentions
 * as if they were a real document envelope. The rule's
 * `couldBeWrongBecause` correctly carries
 *   ["partial_parse", "beyond_partial_parse_boundary"]
 * but severity stays at `error` and confidence stays inconsistent
 * (per-finding `low` vs the rule's `coverageConfidence: high`),
 * which is the per-finding-vs-per-rule confidence drift the
 * "Per-finding confidence must reflect per-rule coverage limitations"
 * doctrine bullet names.
 *
 * Closure paths from doctrine: skip emission when the offending
 * location is past `parsedThroughLine`, OR move the candidate to
 * the review-candidate channel at `info` severity, OR downgrade
 * per-finding `confidence` AND `severity` so the attention-budget
 * signal matches the conceded uncertainty. Whichever closure lands,
 * the document-shaped rules stop appearing in `findings[]` at
 * error/warning on this fixture's source — the assertions below
 * use `no-violation` because they pass under any of the three.
 *
 * This fixture is RED-first per CLAUDE.md §7's bug-fix workflow:
 * `todo: true` keeps the integration test pending until the closure
 * lands. Remove the flag in the same commit that fixes the rule
 * branch and the test turns green permanently.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "Document-shaped rules (document/page-titled, document/lang-attribute, " +
    "document/charset-first-1024-bytes, semantics/landmark-main) must not " +
    "emit at error/warning severity on a markdown source that is parsed " +
    "via the markdown-html-residue fallback — the AST is parser residue, " +
    "not an authored document envelope, and the rules' reason text " +
    "(citing tag names lifted from prose past the bail boundary) " +
    "contradicts the file's classification.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep on a tutorial-style HTML/CSS/JS " +
      "collection observed document/page-titled, document/lang-attribute, " +
      "and document/charset-first-1024-bytes emitting at severity:error, " +
      "confidence:low on a README.md whose parser bailed near the top. " +
      "Per-finding emissions on lines well past parsedThroughLine cite " +
      "narrative HTML tag mentions as document-envelope evidence; reason " +
      "text and severity disagree.",
  },
  toolInput: {
    verboseMeta: true,
  },
  // Intentionally RED — remove this flag once the rule branch
  // for parseModeByExtension === "markdown-html-residue" stops
  // emitting at error/warning severity on this fixture's source.
  todo: true,
  expectations: [
    // Sanity: the source classifies as markdown-html-residue. If the
    // routing ever changes, the rest of the assertions stop being
    // meaningful and the agent should re-evaluate the closure.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "parseModeByExtension", ".md"],
      predicate: { equals: "markdown-html-residue" },
    },

    // The four document-shaped rules must not appear in `findings[]`
    // at error/warning severity. The closure may pick: skip emission
    // entirely, OR move to review-candidate channel at info severity,
    // OR downgrade severity to info — `no-violation` passes under
    // any of the three closures (review candidates and info-severity
    // findings ride a different surface than per-finding violations).
    { kind: "no-violation", ruleId: "document/page-titled" },
    { kind: "no-violation", ruleId: "document/lang-attribute" },
    { kind: "no-violation", ruleId: "document/charset-first-1024-bytes" },
    { kind: "no-violation", ruleId: "semantics/landmark-main" },
  ],
};
