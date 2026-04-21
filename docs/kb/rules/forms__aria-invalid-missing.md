---
title: "forms/aria-invalid-missing"
severity: "error"
scope: "node"
satisfies: ["wcag22:1.4.1", "wcag21:1.4.1", "wcag22:4.1.3", "wcag21:4.1.3"]
---
# `forms/aria-invalid-missing`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:1.4.1`, `wcag21:1.4.1`, `wcag22:4.1.3`, `wcag21:4.1.3`
- **Applies to:** .tsx, .jsx, .html, .htm
## What it checks
Form inputs with the Bootstrap .is-invalid error class must set aria-invalid="true" so assistive tech announces the error state — otherwise the invalid state is conveyed by color alone.
## Why it matters
Bootstrap's `.is-invalid` class is the canonical server-side validation pattern: a red border, red focus ring, and red cross-icon paint the error for sighted users without touching the accessibility tree. Without `aria-invalid="true"` the screen-reader user hears the same `edit, blank` they heard before submitting — the page's visual claim that the field is wrong never reaches them. That makes the error state color-only (WCAG 1.4.1 — Use of Color) and blocks the field's validity from being programmatically determined (WCAG 4.1.3 — Status Messages). `aria-invalid="false"` on an `.is-invalid` element is worse: it actively lies to assistive tech about the state the author is painting on the page. The fix is a single attribute — `aria-invalid="true"` — and, while you're there, pointing `aria-describedby` at the companion `<div class="invalid-feedback">` so the error text is announced too.
## Normative quote
> Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element. (SC 1.4.1) Status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus. (SC 4.1.3)
## Good example
```tsx
<input type="email" class="form-control is-invalid" aria-invalid="true" aria-describedby="email-error">
<div id="email-error" class="invalid-feedback">Please enter a valid email.</div>
```
## Bad example
```tsx
<input type="email" class="form-control is-invalid">
<div class="invalid-feedback">Please enter a valid email.</div>
```
## References
- <https://www.w3.org/TR/WCAG22/#use-of-color>
- <https://www.w3.org/TR/WCAG22/#status-messages>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA21>
- <https://getbootstrap.com/docs/5.3/forms/validation/#server-side>
