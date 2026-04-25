---
title: "parsing/malformed-tag"
severity: "warning"
scope: "document"
satisfies: ["wcag21:4.1.1"]
---
# `parsing/malformed-tag`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag21:4.1.1`
- **Applies to:** .html, .htm
## What it checks
Element tag names of the form `h<digits>` outside h1-h6 (e.g. `<h0>`, `<h7>`, `<h33>`) are typos. Browsers fall back to handling the unknown name as a generic inline element, stripping heading semantics from the assistive-tech tree.
## Why it matters
HTML5 defines exactly six heading levels: h1, h2, h3, h4, h5, h6. A tag like `<h33>` (digit-double typo on `<h3>`) or `<h0>` is not a valid heading; browsers parse it as an unknown element with no implicit role, so the element is absent from the screen-reader heading list and skip-by-heading navigation passes over it. The HTML5 parser recovers silently from malformed names — meaning the visual rendering may look acceptable while the AT tree is wrong. The canonical field shape is a closing-tag typo (`<h3>Hello</h33>`) that the parser logs as a recoverable error without surfacing the offending name to a rule; this rule re-scans source so the bad token reaches the agent at file:line.
## Normative quote
> In content implemented using markup languages, elements have complete start and end tags, elements are nested according to their specifications, elements do not contain duplicate attributes, and any IDs are unique, except where the specifications allow these features.
## Good example
```tsx
<h2>Section title</h2>
<h3>Sub-section</h3>
<my-widget>custom element with hyphen — legal</my-widget>
```
## Bad example
```tsx
<h33>Section title</h33>
<h3>Sub-section</h7>
<h0>not a heading</h0>
```
## References
- <https://www.w3.org/TR/WCAG21/#parsing>
- <https://html.spec.whatwg.org/multipage/sections.html#the-h1,-h2,-h3,-h4,-h5,-and-h6-elements>
- <https://html.spec.whatwg.org/multipage/indices.html#elements-3>
