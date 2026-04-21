---
title: "semantics/section-accessible-name-missing"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `semantics/section-accessible-name-missing`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm
## What it checks
A <section> used as a top-level content wrapper (direct child of <body> or sibling to other landmarks) needs an accessible name — aria-label, aria-labelledby, or a direct-child <h1>-<h6> heading — otherwise assistive tech treats it as a generic <div>.
## Why it matters
HTML5 only promotes <section> to the ARIA 'region' landmark role when the element has an accessible name. Without one, the browser accessibility tree strips the region role and the section becomes a generic grouping element for screen readers — the author's intent to carve out a top-level region is silently discarded. In NVDA/JAWS/VoiceOver landmark lists, an unnamed section simply does not appear, so a blind user cursoring by landmark skips over it entirely. Scoping the rule to body-level sections and landmark-siblings keeps the bar high: prose sections inside articles are fine unnamed, but a <section> sitting alongside <main> or <nav> was clearly intended as a landmark.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined.
## Good example
```tsx
<body><main>…</main><section aria-labelledby="related-h"><h2 id="related-h">Related</h2>…</section></body>
```
## Bad example
```tsx
<body><main>…</main><section>Related articles…</section></body>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/html-aria/#el-section>
- <https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/region.html>
