# iframe-prose-vs-element-candidate

**Guards commit:** fix for Q7-CHECKLIST-IFRAME-FINDER-ELEMENT-VS-PROSE

**Failure mode:** `review/media-alternatives` was matching the string `<iframe>` in text content (code examples and prose paragraphs in developer documentation pages) and emitting false 1.2.x review candidates. The text occurrences appear inside `<code>` blocks that explain how to use iframes for video embedding — they are not actual media elements. An AST-based implementation traverses the parsed DOM for element nodes and avoids this; a naive regex implementation fires on every substring occurrence.

**Which assertion locks it in:** `candidate-present-without { criterionId: "wcag22:1.2.1", reasonExcludes: "iframe" }` — if a regression adds regex-based iframe detection, the reason text would contain "iframe element" and this assertion fails. The companion `candidate-at-line { criterionId: "wcag22:1.2.1", path: "embed-guide.html", line: 65 }` guards positional honesty: the real `<video>` candidate must anchor at line 65, not at a code-block line where `<iframe>` text appears.

**Sanitization:** source is a minimal documentation page explaining media embedding options. Brand names, platform URLs, and video identifiers replaced with generic equivalents. Code examples use `example-player.test` (non-real domain) for iframe embeds and `/assets/sample-intro.mp4` for the native video. Comments in the HTML do not contain ra11y pragma syntax.
