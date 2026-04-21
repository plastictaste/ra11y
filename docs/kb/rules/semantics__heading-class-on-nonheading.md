---
title: "semantics/heading-class-on-nonheading"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1"]
---
# `semantics/heading-class-on-nonheading`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`
- **Applies to:** .tsx, .jsx, .html, .htm
## What it checks
Non-heading elements styled with Bootstrap heading classes (.h1-.h6 or .display-1-.display-6) look like headings visually but expose no heading role — change the tag to <h1>-<h6> or add role="heading" with aria-level.
## Why it matters
Bootstrap's `.h1`-`.h6` and `.display-1`-`.display-6` classes ship the heading *typography* (font size, weight, line height) without the heading *role*. Applied to a `<div>` or `<p>`, they produce text that looks like a heading to sighted users but is announced as plain prose by assistive tech — the structural relationship WCAG 1.3.1 requires is conveyed through presentation only. Heading navigation commands (screen-reader H-key, shortcuts that enumerate the heading outline) skip the element entirely, so the document's structure is silently incomplete. The fix is either structural (use the matching `<h1>`-`<h6>` tag, which carries the role natively) or compensatory (`role="heading"` + `aria-level` on the non-heading element).
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<h1 class="display-4">Marketing Headline</h1>
<div class="h2" role="heading" aria-level="2">Section Title</div>
```
## Bad example
```tsx
<div class="h1">Main Title</div>
<p class="display-4">Marketing Headline</p>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/WCAG22/Techniques/failures/F2>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA12>
- <https://getbootstrap.com/docs/5.3/content/typography/#headings>
- <https://getbootstrap.com/docs/5.3/content/typography/#display-headings>
