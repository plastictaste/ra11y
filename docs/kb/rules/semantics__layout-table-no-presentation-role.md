---
title: "semantics/layout-table-no-presentation-role"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1"]
---
# `semantics/layout-table-no-presentation-role`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `section508:1.3.1`, `en301549:9.1.3.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Layout-only <table> elements (no <th>, <thead>, <tfoot>, <caption>, scope, headers, or ARIA name) should declare role="presentation" so screen readers don't announce them as data tables.
## Why it matters
A <table> without any header cell, caption, scope/headers wiring, or ARIA name is structurally indistinguishable from a div grid — and is overwhelmingly used for visual layout in legacy HTML, email templates, and old CMS output. Without role="presentation", screen readers honor the <table> semantics: they announce "table, N rows, M columns" and read each <td> as a data cell, forcing the user to navigate through layout scaffolding as if it were tabular data. role="presentation" / role="none" tells assistive technology to treat the element as a generic container, which matches the author's intent and removes the noise. The alternative — adding <th>/<caption> to make it a real data table — only applies when the content actually is tabular.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<table role="presentation">
  <tr><td><img src="logo.png" alt="Acme"/></td><td>Header text</td></tr>
  <tr><td colspan="2">Body content laid out in a grid</td></tr>
</table>
```
## Bad example
```tsx
<table>
  <tr><td><img src="logo.png" alt="Acme"/></td><td>Header text</td></tr>
  <tr><td colspan="2">Body content laid out in a grid</td></tr>
</table>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/tutorials/tables/>
- <https://www.w3.org/TR/wai-aria-1.2/#presentation>
- <https://html.spec.whatwg.org/multipage/tables.html#the-table-element>
