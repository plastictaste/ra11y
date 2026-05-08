# markdown-mkdn-extension

`.mkdn` files must be classified as `markdown-html-residue` in
`meta.analysisCoverage.parseModeByExtension`, matching `.md` and
`.markdown`. Today they ship as bare `"html"`, falsely advertising
authored-HTML evidence to per-rule coverage downstreamers.

The fixture is RED-first (`todo: true`); flip it green after extending
the allowlist in `src/mcp/markdown-classifier.ts#parseModeByExtension`.
