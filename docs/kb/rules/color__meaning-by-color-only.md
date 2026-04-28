---
title: "color/meaning-by-color-only"
severity: "error"
scope: "node"
satisfies: ["wcag22:1.4.1", "wcag21:1.4.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `color/meaning-by-color-only`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:1.4.1`, `wcag21:1.4.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .tsx, .jsx, .html
## What it checks
Elements that rely on a status-semantic color utility class (text-danger, alert-success, btn-warning, etc.) must also convey the status via an icon, a screen-reader-only label, a prose status prefix, an ARIA live role, or an accessible name — color alone fails WCAG 1.4.1. Also surfaces a review candidate (severity warning) when an element carries a toggled-state class (.active / .selected / .checked) without an aria-pressed / aria-selected / aria-checked / aria-current / aria-expanded attribute, native checked/selected attribute, or text/label channel — class-name-driven state without a programmatic channel risks 1.4.1 + 4.1.2.
## Why it matters
Bootstrap's `.text-danger` / `.alert-success` / `.btn-warning` family carries semantic status — red means error, green means success. A sighted user sees the color and understands the meaning; a screen-reader user, a colorblind user, or anyone reading under a color-inverted theme gets nothing unless the status is also conveyed through another channel. Bootstrap's own accessibility docs admit this: "assistive technologies will not convey information that is denoted purely with color" — the class ships the color, the author supplies the second channel. The fix is cheap: an icon + an `.visually-hidden` label, or a prose prefix ("Error: invalid email"), or `role="alert"` on a live region. The rule only fires when the class token itself names a status (`-danger`/`-success`/`-warning`/`-error`/`-info`) — theme tokens like `.text-primary` / `.text-muted` do not trigger, because they are not status channels.
## Normative quote
> Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.
## Good example
```tsx
<span class="text-danger"><i class="bi bi-exclamation-circle" aria-hidden="true"></i><span class="visually-hidden">Error:</span> Invalid email</span>
```
## Bad example
```tsx
<span class="text-danger">Access denied</span>
```
## References
- <https://www.w3.org/TR/WCAG22/#use-of-color>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G14>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G111>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA10>
- <https://getbootstrap.com/docs/5.3/getting-started/accessibility/#color-contrast>
