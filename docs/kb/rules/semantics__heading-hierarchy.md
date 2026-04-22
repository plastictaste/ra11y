---
title: "semantics/heading-hierarchy"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:2.4.6", "wcag21:2.4.6"]
---
# `semantics/heading-hierarchy`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:2.4.6`, `wcag21:2.4.6`
- **Applies to:** .html, .htm
## What it checks
Heading levels should follow a logical hierarchy without skipping levels (e.g., h1 → h3); a full-page document without an <h1> should add one (or an equivalent role="heading" aria-level="1") so screen-reader users have a top-of-document landmark.
## Why it matters
Screen-reader users navigate by heading with the H key. A skipped level (h1 → h3) tells them "this is a sub-sub-section of something that doesn't exist", breaking their mental model of the page structure. A full page with no <h1> at all leaves the user with no top-of-document landmark to anchor on. SC 1.3.1 governs the structural relationship; SC 2.4.6 is satisfied by the page having headings whose presence and ordering convey topic — a page without any top-level heading fails both.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text. Headings and labels describe topic or purpose.
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
- <https://www.w3.org/TR/WCAG22/#headings-and-labels>
- <https://www.w3.org/WAI/tutorials/page-structure/headings/>
