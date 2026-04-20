---
title: "semantics/heading-hierarchy"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"]
---
# `semantics/heading-hierarchy`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`
- **Applies to:** .html, .htm
## What it checks
Heading levels should follow a logical hierarchy without skipping levels (e.g., h1 → h3); a document without an <h1> should have a designated main heading via <h1> or role="heading" aria-level="1".
## Why it matters
Screen-reader users navigate by heading with the H key. A skipped level (h1 → h3) tells them "this is a sub-sub-section of something that doesn't exist", breaking their mental model of the page structure. SC 1.3.1 does not mandate an <h1>, but a document without one loses the single top-of-document landmark AT relies on; verify the page has a designated main heading via <h1> or role="heading" aria-level="1".
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<h1>Page</h1>
  <h2>Section</h2>
    <h3>Detail</h3>
```
## Bad example
```tsx
<h1>Page</h1>
    <h3>Detail</h3>  <!-- skipped h2 -->
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/tutorials/page-structure/headings/>
