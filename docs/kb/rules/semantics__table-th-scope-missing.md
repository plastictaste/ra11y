---
title: "semantics/table-th-scope-missing"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1"]
---
# `semantics/table-th-scope-missing`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `section508:1.3.1`, `en301549:9.1.3.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Header cells in multi-row and multi-column tables must declare a scope (col/row/colgroup/rowgroup), or every data cell must reference its header's id via headers=, so screen readers can unambiguously pair each data cell with its header.
## Why it matters
In a 2-D data table, a <th> in the top-left corner could be a column header, a row header, or a section label — a screen reader cannot tell without help. scope='col' / scope='row' / scope='colgroup' / scope='rowgroup' makes the relationship explicit; the headers=/id pattern handles irregular layouts (merged cells, section subheads) the scope attribute can't. Either mechanism is enough; neither means the cell-to-header association is guesswork.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<table>
  <thead><tr><th scope="col">Product</th><th scope="col">Price</th></tr></thead>
  <tbody>
    <tr><th scope="row">Widget</th><td>$50</td></tr>
    <tr><th scope="row">Gadget</th><td>$75</td></tr>
  </tbody>
</table>
```
## Bad example
```tsx
<table>
  <thead><tr><th>Product</th><th>Price</th></tr></thead>
  <tbody>
    <tr><td>Widget</td><td>$50</td></tr>
    <tr><td>Gadget</td><td>$75</td></tr>
  </tbody>
</table>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/tutorials/tables/two-headers/>
- <https://www.w3.org/WAI/tutorials/tables/multi-level/>
- <https://html.spec.whatwg.org/multipage/tables.html#attr-th-scope>
