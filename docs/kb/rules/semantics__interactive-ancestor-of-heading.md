---
title: "semantics/interactive-ancestor-of-heading"
severity: "error"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"]
---
# `semantics/interactive-ancestor-of-heading`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`
- **Applies to:** .tsx, .jsx, .html, .htm
## What it checks
Block-level headings (<h1>-<h6>) must not sit inside an <a href> or <button> ancestor — the interactive role consumes the heading semantics so the structural relationship is no longer programmatically determinable.
## Why it matters
Wrapping a heading in an interactive control (the 'card link' anti-pattern) makes assistive technology announce 'link' / 'button' first; many AT either drop the heading from the heading-navigation list entirely or fold its text into the link's accessible name. Either way, the SC 1.3.1 requirement that heading structure be programmatically determinable is broken. Inverting the nesting — placing the interactive element *inside* the heading — preserves both the heading outline and the interactive control's own role.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<h2><a href="post.html">Post Title</a></h2>
```
## Bad example
```tsx
<a href="post.html"><h2>Post Title</h2><h3>Subhead</h3></a>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G115>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G117>
- <https://html.spec.whatwg.org/multipage/sections.html#headings-and-sections>
