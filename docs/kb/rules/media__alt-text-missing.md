---
title: "media/alt-text-missing"
severity: "error"
scope: "node"
satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"]
---
# `media/alt-text-missing`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:1.1.1`, `wcag21:1.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Images, SVG <image>, elements with role="img", and <canvas> must have a text alternative — alt, aria-label, aria-labelledby, or (for canvas) fallback content. Decorative surfaces must be explicitly marked.
## Why it matters
Screen readers announce images by their accessible name. A non-text surface without a text alternative is announced as the file name, the generic word "image", or nothing at all, leaving non-sighted users unable to understand what the element communicates.
## Normative quote
> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.
## Good example
```tsx
<img src="chart.png" alt="Quarterly revenue growth 2024–2026: $1.2M to $3.8M." />
```
## Bad example
```tsx
<img src="chart.png" />
```
## References
- <https://www.w3.org/TR/WCAG22/#non-text-content>
- <https://www.w3.org/WAI/tutorials/images/>
- <https://www.w3.org/TR/wai-aria-1.2/#img>
- <https://html.spec.whatwg.org/multipage/canvas.html#the-canvas-element>
