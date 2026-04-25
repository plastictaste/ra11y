---
title: "aria/presentation-on-semantic-ancestor"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "section508:1.3.1", "en301549:9.1.3.1", "wcag22:4.1.2", "wcag21:4.1.2", "section508:4.1.2", "en301549:9.4.1.2"]
---
# `aria/presentation-on-semantic-ancestor`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `section508:1.3.1`, `en301549:9.1.3.1`, `wcag22:4.1.2`, `wcag21:4.1.2`, `section508:4.1.2`, `en301549:9.4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags role="presentation" / role="none" on a semantic host (<table>, <ul>, <ol>, <dl>, <figure>, <form>) whose subtree contains the children that encode that host's semantics (<th>/<caption>, <li>, <dt>/<dd>, <figcaption>, <legend>) — the role silently strips semantics those children depend on.
## Why it matters
role="presentation" / role="none" on a host element tells assistive technology "treat this as a generic container, ignore the implicit semantics." When the host's subtree contains the children that carry those semantics — <th> headers in a <table>, <li> items in a list, <dt>/<dd> pairs in a definition list, <figcaption> in a figure, <legend> in a form — stripping the host's role breaks the children's announcement and navigation contracts: a <th> outside a recognized <table> is just a styled cell with no row/column semantics; an <li> outside a recognized list is just an indented bullet with no "1 of N" announcement; a <figcaption> outside a recognized <figure> is just floating text. WAI-ARIA 1.2 specifies a "conditional role stripping" behavior for some pairs (the UA may ignore role="presentation" on an element with required children for an explicit role), but the behavior is uneven across browser/AT combinations and depends on the children matching exactly — the static-source pattern is still misleading and fragile across refactors. Detecting it cheaply at scan time prevents the silent semantics loss.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<table>
  <caption>Quarterly results</caption>
  <thead><tr><th scope="col">Quarter</th><th scope="col">Revenue</th></tr></thead>
  <tbody><tr><td>Q1</td><td>$1.2M</td></tr></tbody>
</table>

<ul>
  <li>First</li>
  <li>Second</li>
</ul>

<table role="presentation">
  <tr><td>Layout cell A</td><td>Layout cell B</td></tr>
</table>
```
## Bad example
```tsx
<table role="presentation">
  <caption>Quarterly results</caption>
  <thead><tr><th scope="col">Quarter</th><th scope="col">Revenue</th></tr></thead>
  <tbody><tr><td>Q1</td><td>$1.2M</td></tr></tbody>
</table>

<ul role="none">
  <li>First</li>
  <li>Second</li>
</ul>

<figure role="presentation">
  <img src="chart.png" alt="">
  <figcaption>Revenue over time</figcaption>
</figure>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/wai-aria-1.2/#presentation>
- <https://www.w3.org/TR/wai-aria-1.2/#none>
- <https://www.w3.org/TR/html-aria/>
