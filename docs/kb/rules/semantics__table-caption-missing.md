---
title: "semantics/table-caption-missing"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1"]
---
# `semantics/table-caption-missing`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `section508:1.3.1`, `en301549:9.1.3.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Data tables must have an accessible name via <caption>, aria-label, aria-labelledby, or title so screen readers announce what the table represents before reading its cells.
## Why it matters
Without a label, screen readers announce only 'table, N columns, M rows' — users get the dimensions but not the subject. A caption (or aria-label / aria-labelledby) establishes the relationship between the table and its meaning programmatically, which is exactly what WCAG 1.3.1 requires for information conveyed through presentation. <caption> is the HTML-native mechanism and appears inline for sighted users too; aria-label is appropriate when the label is already visible in surrounding prose.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<table>
  <caption>Quarterly sales by region</caption>
  <thead><tr><th scope="col">Region</th><th scope="col">Q1</th></tr></thead>
  <tbody><tr><td>North</td><td>$100</td></tr></tbody>
</table>
```
## Bad example
```tsx
<table>
  <thead><tr><th scope="col">Region</th><th scope="col">Q1</th></tr></thead>
  <tbody><tr><td>North</td><td>$100</td></tr></tbody>
</table>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/tutorials/tables/caption-summary/>
- <https://html.spec.whatwg.org/multipage/tables.html#the-caption-element>
