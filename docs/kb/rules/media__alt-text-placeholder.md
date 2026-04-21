---
title: "media/alt-text-placeholder"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"]
---
# `media/alt-text-placeholder`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.1.1`, `wcag21:1.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <img> / <input type="image"> whose alt value is generic boilerplate ("image", "screenshot", "TODO", "placeholder") that carries no information about what the image conveys.
## Why it matters
WCAG 1.1.1 requires a text alternative that "serves the equivalent purpose." Boilerplate alt text — restating the medium ("image", "screenshot"), authoring markers ("TODO", "placeholder"), or meta words ("description") — conveys no information about the content, so the requirement is not met. Screen-reader users are announced the filler word verbatim and learn nothing about the image.
## Normative quote
> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.
## Good example
```tsx
<img src="chart.png" alt="Quarterly revenue growth 2024-2026: $1.2M to $3.8M." />
```
## Bad example
```tsx
<img src="chart.png" alt="image" />
```
## References
- <https://www.w3.org/TR/WCAG22/#non-text-content>
- <https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html>
- <https://www.w3.org/WAI/tutorials/images/>
