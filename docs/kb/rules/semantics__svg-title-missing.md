---
title: "semantics/svg-title-missing"
severity: "error"
scope: "node"
satisfies: ["wcag22:1.1.1", "wcag21:1.1.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `semantics/svg-title-missing`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:1.1.1`, `wcag21:1.1.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .svg
## What it checks
Standalone SVG assets must expose an accessible name via a <title> child, aria-label, or aria-labelledby — otherwise screen readers announce nothing for the image.
## Why it matters
A standalone `.svg` file is an image asset. When referenced via `<img src="…svg">` or loaded directly, the root `<svg>` element is what assistive tech presents to the user. Without a `<title>` child (the SVG 2 accessibility primary name source), `aria-label`, or `aria-labelledby`, the image is silently opaque — screen readers announce the file name at best or nothing at all. Static detection is load-bearing because authors routinely forget the `<title>` child when exporting from design tools (Figma, Illustrator, Sketch) — every export defaults to omitting it.
## Normative quote
> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for the situations listed below: controls, input, time-based media, tests, sensory, CAPTCHA, decoration/formatting/invisible.
## Good example
```tsx
<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <title>Search</title>
  <path d="M10 10L20 20" />
</svg>
```
## Bad example
```tsx
<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M10 10L20 20" />
</svg>
```
## References
- <https://www.w3.org/TR/WCAG22/#non-text-content>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/SVG2/struct.html#DescriptionAndTitleElements>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G94>
