---
title: "navigation/link-target-blank-announcement"
severity: "warning"
scope: "node"
satisfies: ["wcag22:3.2.5"]
---
# `navigation/link-target-blank-announcement`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:3.2.5`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Links with target="_blank" must announce that they open in a new window or tab so users aren't disoriented by the unexpected context change.
## Why it matters
Opening a new window or tab is a change of context that happens at link activation. WCAG 3.2.5 (Change on Request, AAA) requires such changes to be initiated by user request — meaning the user is informed before they activate the control, not surprised by it after. Screen-reader users especially lose orientation when focus lands in a new tab they didn't expect. A visible "opens in new window" note, an `aria-label` including the phrase, or a visually-hidden span with the announcement all satisfy this.
## Normative quote
> Changes of context are initiated only by user request or a mechanism is available to turn off such changes.
## Good example
```tsx
<a href="/docs" target="_blank" aria-label="Docs (opens in new window)">Docs</a>
```
## Bad example
```tsx
<a href="/docs" target="_blank">Docs</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#change-on-request>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G201>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H83>
