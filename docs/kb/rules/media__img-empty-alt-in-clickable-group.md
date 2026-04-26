---
title: "media/img-empty-alt-in-clickable-group"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.1.1", "wcag21:1.1.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `media/img-empty-alt-in-clickable-group`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.1.1`, `wcag21:1.1.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <img alt=""> when the image is the only visual content of an interactive ancestor (button, link, role=button/link, or onClick host) and that ancestor has no other accessible-name source.
## Why it matters
alt="" tells assistive tech to ignore the image. That is correct in flow content, but wrong when the image is the sole visual payload of a clickable widget — the wrapping <button>/<a> is then announced as "button"/"link" with no name, and operating it is opaque to screen-reader users. media/alt-text-missing covers the missing-alt case; this rule covers the "explicitly decorative inside an unnamed control" case.
## Normative quote
> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose. For all user interface components, the name and role can be programmatically determined.
## Good example
```tsx
<a href="/profile" aria-label="View profile"><img src="avatar.png" alt="" /></a>
```
## Bad example
```tsx
<a href="/profile"><img src="avatar.png" alt="" /></a>
```
## References
- <https://www.w3.org/TR/WCAG22/#non-text-content>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/tutorials/images/functional/>
