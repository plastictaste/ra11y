---
title: "navigation/href-javascript-void"
severity: "error"
scope: "node"
satisfies: ["wcag22:4.1.2", "wcag21:4.1.2", "wcag22:2.1.1", "wcag21:2.1.1"]
---
# `navigation/href-javascript-void`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:4.1.2`, `wcag21:4.1.2`, `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
<a> elements with href='javascript:…' or bare href='#' announce as links but do not navigate. Use <button type="button"> for actions, or put a real URL in href for navigation.
## Why it matters
Assistive technology decides how to announce a control from its role: `<a>` with an href maps to the link role. When the href is `javascript:void(0)`, `javascript:;`, or bare `#`, the browser treats the element as a link but nothing navigates — the user hears 'link,' activates it, and nothing happens. The semantic role (link) contradicts the runtime behavior (button-like action or no-op), breaking WCAG 4.1.2 Name, Role, Value. Static detection is reliable because the href attribute's string value is the full signal.
## Normative quote
> For all user interface components … the name and role can be programmatically determined.
## Good example
```tsx
<button type="button" onClick={handleClick}>Toggle menu</button>
```
## Bad example
```tsx
<a href="javascript:void(0)" onClick={handleClick}>Toggle menu</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://html.spec.whatwg.org/#the-a-element>
