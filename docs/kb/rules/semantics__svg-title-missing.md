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
- **Applies to:** .svg, .html, .htm, .tsx, .jsx
## What it checks
Every <svg> rendered to the user — standalone .svg file or inline in HTML / JSX — must expose an accessible name via a <title> child, aria-label, or aria-labelledby; otherwise mark it decorative with aria-hidden / role=presentation.
## Why it matters
Whether a `<svg>` is a standalone `.svg` asset or inline markup inside an HTML page or JSX component, screen readers need a text alternative to announce what the graphic communicates. Without a `<title>` child (the SVG 2 accessibility primary name source), `aria-label`, or `aria-labelledby`, most assistive tech announces the file name at best or nothing at all. Inline `<svg>` is the routine miss: authors drop icons into buttons, links, and standalone graphics straight from a design tool (Figma, Illustrator, Sketch) — every export omits the `<title>`. Static detection is load-bearing because the runtime element is opaque without it.
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
