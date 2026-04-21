---
title: "aria/role-from-class-only"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.3", "wcag21:1.3.3", "wcag22:1.4.1", "wcag21:1.4.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `aria/role-from-class-only`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.3`, `wcag21:1.3.3`, `wcag22:1.4.1`, `wcag21:1.4.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Admonition-styled elements (class=note/warning/alert/tip/info/…) must expose their severity through a role or textual prefix — class-plus-color alone is invisible to assistive tech.
## Why it matters
A block styled as a coloured "Warning" or "Note" callout communicates severity to sighted users through CSS, but the underlying markup (`<div class="warning">…</div>`) has no programmatic role and no textual label. Screen reader users hear the inner text with the severity stripped, so an instruction like "Don't forget to run bundle install" loses its "warning" framing. WCAG 1.4.1 prohibits colour as the sole indicator; 1.3.3 prohibits sensory-only instructions; 4.1.2 requires that role be programmatically exposed. Fix by adding role="alert" / "status" / "note" (live-region or landmark), or by prefixing the visible text with the severity word ("Warning: …") so it becomes part of the accessible name.
## Normative quote
> Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.
## Good example
```tsx
<div class="note warning" role="alert">
  <strong>Warning:</strong> Don't forget to run bundle install.
</div>
```
## Bad example
```tsx
<div class="note warning">Don't forget to run bundle install.</div>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#use-of-color>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G182>
- <https://www.w3.org/TR/wai-aria-1.2/#alert>
- <https://www.w3.org/TR/wai-aria-1.2/#note>
