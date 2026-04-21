---
title: "keyboard/handler-missing"
severity: "error"
scope: "node"
satisfies: ["wcag22:2.1.1", "wcag21:2.1.1"]
---
# `keyboard/handler-missing`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Elements that declare click or toggle behavior (onClick, data-bs-toggle, etc.) must be reachable by keyboard: use a native button/link or add tabIndex plus an onKeyDown/onKeyUp that handles Enter and Space.
## Why it matters
Mouse users can click anywhere; keyboard users can't. An onClick on a bare <div>, or a Bootstrap-style data-bs-toggle/data-bs-dismiss/data-bs-ride on a <div> or <span>, means the functionality is invisible to people who navigate with the keyboard — blind users, motor-impaired users, and anyone without a mouse. The attribute-based grammar is especially dangerous because the interaction still works for mouse users (Bootstrap's JS listens for click), so the bug is silent during sighted testing. The fix is almost always to host the attribute on a <button> instead.
## Normative quote
> All functionality of the content is operable through a keyboard interface.
## Good example
```tsx
<button type="button" data-bs-toggle="modal" data-bs-target="#my-modal">Open</button>
```
## Bad example
```tsx
<div data-bs-toggle="modal" data-bs-target="#my-modal">Open</div>
```
## References
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G202>
- <https://www.w3.org/WAI/ARIA/apg/patterns/button/>
