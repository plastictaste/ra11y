/**
 * markdown-mkdn-extension — guards that `.mkdn` files are routed to the
 * markdown-html-residue parse mode alongside `.md` and `.markdown`.
 *
 * Bug shape: `src/mcp/markdown-classifier.ts#parseModeByExtension` checks
 *   `if (lang === "html" && (ext === ".md" || ext === ".markdown"))`
 * and tags those two extensions as `markdown-html-residue`. `.mkdn`
 * is a recognized markdown extension (the HTML parser produces an
 * `html` AST for it) but is not in that two-extension allowlist, so it
 * falls through to the bare-language label and ships
 *   `meta.analysisCoverage.parseModeByExtension[".mkdn"] === "html"`.
 *
 * The label drift is consequential: any rule that downgrades coverage
 * confidence on `markdown-html-residue` (because the source is not
 * actually authored as HTML) will silently retain `high` confidence on
 * `.mkdn` files, claiming evidence the parser did not really observe.
 *
 * This fixture is RED-first per CLAUDE.md §7's bug-fix workflow:
 * `todo: true` keeps the integration test pending until the closure
 * lands. The fix is a one-line addition to the allowlist; once it
 * lands, remove the `todo` flag and the test turns green permanently.
 */

import type { FixtureAssertions } from "../runner.ts";

export const assertions: FixtureAssertions = {
  description:
    "A `.mkdn` file is routed through the markdown-html-residue parse " +
    "mode in meta.analysisCoverage.parseModeByExtension, matching the " +
    "treatment of `.md` and `.markdown`.",
  origin: {
    notes:
      "Multi-corpus AI-first sweep observed parseModeByExtension['.mkdn']: 'html' " +
      "while sibling markdown extensions ship 'markdown-html-residue'. The " +
      "downstream effect is per-rule coverage-confidence retaining 'high' on " +
      ".mkdn files where the rule's evidence model was actually degraded.",
  },
  toolInput: {
    verboseMeta: true,
  },
  expectations: [
    // The .mkdn parser does not record errors.
    { kind: "zero-parse-errors" },

    // Honest classification: the agent reading
    // parseModeByExtension can branch on `.mkdn` the same way it
    // branches on `.md` and `.markdown` — knowing the AST is markdown
    // residue, not authored HTML.
    {
      kind: "meta-field",
      path: ["analysisCoverage", "parseModeByExtension", ".mkdn"],
      predicate: { equals: "markdown-html-residue" },
    },
  ],
};
