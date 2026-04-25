---
title: "semantics/form-landmark-name-missing"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag22:4.1.2"]
---
# `semantics/form-landmark-name-missing`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag22:4.1.2`
- **Applies to:** .html, .htm
## What it checks
A standalone <form> needs an accessible name (aria-label, aria-labelledby, or title) so it surfaces as the ARIA form landmark. Without one, the browser strips the landmark role and the form does not appear in the screen-reader landmark list. The multi-form case is handled by semantics/duplicate-landmark-unlabeled.
## Why it matters
ARIA exposes <form> as the 'form' landmark only when the element has an accessible name. An unlabeled <form> is announced as a generic group and is invisible to landmark navigation (NVDA D, JAWS R, VoiceOver VO+U) — a blind user cursoring landmarks skips over the form entirely. The fix is mechanical: add aria-label="<purpose>" (e.g. "Search", "Subscribe", "Contact us") describing what the form does. The rule fires only when the file contains exactly one <form>; multi-form documents are covered by semantics/duplicate-landmark-unlabeled, which adds disambiguation framing to its message.
## Normative quote
> For all user interface components, the name and role can be programmatically determined.
## Good example
```tsx
<form aria-label="Search"><input type="search" name="q"><button>Go</button></form>
```
## Bad example
```tsx
<form action="/search"><input type="search" name="q"><button>Go</button></form>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/html-aria/#el-form>
- <https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/form.html>
