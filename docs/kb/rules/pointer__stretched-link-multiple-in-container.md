---
title: "pointer/stretched-link-multiple-in-container"
severity: "error"
scope: "document"
satisfies: ["wcag22:2.4.4", "wcag21:2.4.4"]
---
# `pointer/stretched-link-multiple-in-container`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:2.4.4`, `wcag21:2.4.4`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Two or more `.stretched-link` anchors must not share the same positioned ancestor — the first overlay covers the entire container, leaving every subsequent link without a distinguishable activation target.
## Why it matters
Bootstrap's `.stretched-link` helper expands an anchor's hit area to fill its nearest positioned ancestor via a `::after` overlay. If a card contains two stretched links, only one activation target exists for the whole card — the one whose overlay wins the z-index race — and the purpose of every other link can no longer be determined from the link-text-in-context pair the user actually activates.
## Normative quote
> The purpose of each link can be determined from the link text alone or from the link text together with its programmatically determined link context, except where the purpose of the link would be ambiguous to users in general.
## Good example
```tsx
<div class="card">
  <div class="card-body">
    <h5 class="card-title">Product</h5>
    <a href="/product" class="stretched-link">View product</a>
  </div>
</div>
```
## Bad example
```tsx
<div class="card">
  <div class="card-body">
    <h5 class="card-title">Product</h5>
    <a href="/product" class="stretched-link">View product</a>
    <a href="/compare" class="stretched-link">Compare</a>
  </div>
</div>
```
## References
- <https://www.w3.org/TR/WCAG22/#link-purpose-in-context>
- <https://getbootstrap.com/docs/5.3/helpers/stretched-link/>
