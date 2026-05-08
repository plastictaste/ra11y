---
title: "pointer/target-size-enhanced"
severity: "warning"
scope: "document"
satisfies: ["wcag22:2.5.5", "wcag21:2.5.5"]
---
# `pointer/target-size-enhanced`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:2.5.5`, `wcag21:2.5.5`
- **Applies to:** .css, .html, .htm, .tsx, .jsx
## What it checks
Pointer targets must measure at least 44×44 CSS pixels (WCAG 2.1 SC 2.5.5 AAA, the enhanced companion to SC 2.5.8 AA at 24×24), unless the inline, equivalent, user-agent, or essential exception applies.
## Why it matters
AAA-grade touch targets help users with substantial motor impairments, severe tremors, or low-precision pointing devices. The 44 CSS pixel minimum aligns with platform HIG guidance (Apple HIG, Material) and is what AAA-conformant public-sector and accessibility-critical sites target. A 30×30 button satisfies the AA SC 2.5.8 minimum but still fails AAA — and unlike AA, the AAA SC has no Spacing exception, so non-overlapping placement does not save an undersized target.
## Normative quote
> The size of the target for pointer inputs is at least 44 by 44 CSS pixels, except when: Equivalent, Inline, User Agent Control, or Essential.
## Good example
```tsx
.icon-button { width: 44px; height: 44px; }
<button className="w-11 h-11">×</button>
```
## Bad example
```tsx
.icon-button { width: 32px; height: 32px; }
<button className="w-8 h-8">×</button>
```
## References
- <https://www.w3.org/TR/WCAG22/#target-size-enhanced>
- <https://www.w3.org/WAI/WCAG21/Understanding/target-size.html>
