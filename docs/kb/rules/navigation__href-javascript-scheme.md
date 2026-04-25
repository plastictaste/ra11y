---
title: "navigation/href-javascript-scheme"
severity: "error"
scope: "node"
satisfies: ["wcag22:4.1.2", "wcag21:4.1.2", "wcag22:2.1.1", "wcag21:2.1.1"]
---
# `navigation/href-javascript-scheme`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:4.1.2`, `wcag21:4.1.2`, `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <a href="javascript:..."> in any of its forms — `javascript:void(0)`, `javascript:void 0`, `javascript:;`, `javascript:` (empty body), `javascript:alert(1)` and other arbitrary expressions, plus `JAVASCRIPT:…` and other case-insensitive variants (RFC 3986 §3.1). The bare token `javascript` (no colon — almost always an author typo for `javascript:void(0)`) is also flagged. Whitespace is trimmed before matching, so `"  javascript: void(0)  "` matches. Companion rule `navigation/href-empty-fragment` covers the non-scheme placeholder shapes (`href="#"`, `href=""`). Use `<button type="button">` for actions, or put a real URL in href for navigation. JSX expression-form `href={…}` is opaque at static time and intentionally not flagged — the agent reads the source if the call site looks suspicious.
## Why it matters
Assistive technology decides how to announce a control from its role: `<a>` with an href maps to the link role. The browser treats every `javascript:` URI as a link (one with an inline script for its destination), but the click never navigates anywhere — the user hears 'link,' activates it, and either nothing happens or an arbitrary script runs. The semantic role contradicts the runtime behavior. Static detection is reliable because the href attribute's string value is the full signal.

Split out from the umbrella `navigation/href-placeholder` rule so an agent suppressing the JS-scheme variant (often "we know this is a button styled as a link, this codebase uses jQuery patterns") doesn't also silently suppress the bare-`#`/empty-href variants (which usually want a real route, not a button). The two shapes have different fix profiles; one rule ID per shape lets the agent triage them independently.
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
