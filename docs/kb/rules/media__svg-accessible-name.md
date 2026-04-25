---
title: "media/svg-accessible-name"
severity: "error"
scope: "node"
satisfies: ["wcag22:1.1.1", "wcag21:1.1.1"]
---
# `media/svg-accessible-name`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:1.1.1`, `wcag21:1.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Inline <svg> elements inside interactive contexts (<button>, <a>, role=button) must expose an accessible name via a child <title>, role="img" + aria-label/aria-labelledby, or a resolvable <use> reference to a named <symbol>.
## Why it matters
An inline <svg> inside a <button> or <a> IS the visual representation of the control. Without a <title> child, role="img" + aria-label, or a <use> referencing a named <symbol>, screen readers announce nothing for the SVG and (when the parent has no other accessible name) the control becomes opaque — the canonical icon-only-button anti-pattern. Static detection is load-bearing because the antipattern is mechanical: design-tool exports (Figma, Illustrator) strip <title> by default, and inlining the export into a <button> is a one-line copy that ships unnamed every time.
## Normative quote
> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for the situations listed below: controls, input, time-based media, tests, sensory, CAPTCHA, decoration/formatting/invisible.
## Good example
```tsx
<button><svg viewBox="0 0 24 24"><title>Search</title><path d="M0 0"/></svg></button>
```
## Bad example
```tsx
<button><svg viewBox="0 0 24 24"><path d="M0 0"/></svg></button>
```
## References
- <https://www.w3.org/TR/WCAG22/#non-text-content>
- <https://www.w3.org/TR/SVG2/struct.html#DescriptionAndTitleElements>
- <https://www.w3.org/TR/SVG2/struct.html#UseElement>
- <https://www.w3.org/WAI/tutorials/images/decorative/>
