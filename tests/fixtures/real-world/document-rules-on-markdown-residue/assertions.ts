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
 * signal matches the conceded uncertainty. The closure that landed
 * is the third (downgrade-not-drop) at the per-finding pass in
 * `src/mcp/per-finding-beyond-parse-boundary.ts`: findings emitted
 * past `parsedThroughLine` slide to `confidence: "low"` AND
 * `severity: "info"` and gain
 * `couldBeWrongBecause: ["beyond_partial_parse_boundary"]`.
 *
 * This fixture also pins the routing precondition: the document-
 * shaped rules' extension gates (`.html` / `.htm`) do not match
 * `.md` — so the `Violation[]` engine stream stays empty regardless
 * of the per-finding helper. The `no-violation` rows below pin
 * that engine-level absence; combined with the per-finding helper
 * at the MCP layer, the agent reads no document-envelope claim on
 * a markdown-residue substrate from any surface.
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
  expectations: [
    // Sanity: the source classifies as markdown-html-residue. If the
    // routing ever changes, the rest of the assertions stop being
    // meaningful and the agent should re-evaluate the closure.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "parseModeByExtension", ".md"],
      predicate: { equals: "markdown-html-residue" },
    },

    // The four document-shaped rules must not appear in the engine's
    // `Violation[]` stream on this fixture's `.md` source. The
    // structural reason is the rules' `appliesTo.fileExtensions`
    // gate (`.html` / `.htm`) — `.md` is filtered before per-file
    // dispatch, so even a markdown-residue substrate that exposes
    // narrative `<html>` / `<head>` / `<title>` mentions to the HTML
    // parser gets no rule emission. The `no-violation` predicate
    // reads raw `Violation[]` from the engine; combined with the
    // per-finding helper at the MCP layer (which separately downgrades
    // any post-boundary finding's `confidence` + `severity`), no
    // document-envelope claim reaches the agent on any surface for
    // a `.md` source.
    { kind: "no-violation", ruleId: "document/page-titled" },
    { kind: "no-violation", ruleId: "document/lang-attribute" },
    { kind: "no-violation", ruleId: "document/charset-first-1024-bytes" },
    { kind: "no-violation", ruleId: "semantics/landmark-main" },
  ],
};
