---
title: "keyboard/anchor-button-not-focusable"
severity: "error"
scope: "node"
satisfies: ["wcag22:2.1.1", "wcag21:2.1.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `keyboard/anchor-button-not-focusable`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:2.1.1`, `wcag21:2.1.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
An <a> announced as a button (role="button" or btn/button class token) must be keyboard-reachable: add href, tabindex="0", or change to <button>.
## Why it matters
An anchor with role="button" or a btn/button class promises a clickable control to both screen readers and sighted users. Without href or tabindex="0", the element is invisible to the tab order — keyboard users cannot reach it, let alone activate it. Mouse/touch users see and use the control normally, so the bug is silent during sighted testing. SC 2.1.1 is broken because the functionality is not keyboard-operable; SC 4.1.2 is broken because the programmatic role ("button") doesn't match the actual operable state (no focus, no activation). The fix is almost always to change the element to <button type="button"> — buttons are focusable, announce as "button", and fire click on Enter/Space natively.
## Normative quote
> All functionality of the content is operable through a keyboard interface. ... For all user interface components, the name and role can be programmatically determined; states, properties, and values that can be set by the user can be programmatically set.
## Good example
```tsx
<a class="btn" href="/orders">View orders</a>
```
## Bad example
```tsx
<a class="btn">Click me</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/ARIA/apg/patterns/button/>
