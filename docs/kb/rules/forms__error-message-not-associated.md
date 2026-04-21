---
title: "forms/error-message-not-associated"
severity: "error"
scope: "node"
satisfies: ["wcag22:3.3.1", "wcag21:3.3.1", "wcag22:3.3.3", "wcag21:3.3.3"]
---
# `forms/error-message-not-associated`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:3.3.1`, `wcag21:3.3.1`, `wcag22:3.3.3`, `wcag21:3.3.3`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
An error-message element (.invalid-feedback / .error-message / [role=alert]) adjacent to a form control must be referenced via aria-describedby on that control, or screen-reader users never hear the error.
## Why it matters
SC 3.3.1 requires the item in error to be identified AND the error described in text that reaches the user. "Reaches the user" is the load-bearing clause for assistive-tech consumers: a `<div class="invalid-feedback">` next to an `<input>` shows a red error message to sighted users, but a screen-reader user tabbing into the field hears only the label and state — the error text is in the DOM but not wired to the control. `aria-describedby` is the association mechanism; without it the text is invisible to the accessibility tree. SC 3.3.3 then piles on for the correction-suggestion case — an error message that says "enter a valid email" is a suggestion that must also be announced with the control. The fix is one attribute (`aria-describedby="<error-id>"`) plus, if missing, an `id` on the error element. Static analysis can prove the link is broken cheaply: the error element is present, the control is present, and the `aria-describedby` token either exists or it does not.
## Normative quote
> If an input error is automatically detected, the item that is in error is identified and the error is described to the user in text. (SC 3.3.1) If an input error is automatically detected and suggestions for correction are known, the suggestions are provided to the user. (SC 3.3.3)
## Good example
```tsx
<input type="email" class="form-control is-invalid" aria-describedby="email-error">
<div class="invalid-feedback" id="email-error">Please enter a valid email.</div>
```
## Bad example
```tsx
<input type="email" class="form-control is-invalid">
<div class="invalid-feedback" id="email-error">Please enter a valid email.</div>
```
## References
- <https://www.w3.org/TR/WCAG22/#error-identification>
- <https://www.w3.org/TR/WCAG22/#error-suggestion>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA18>
- <https://getbootstrap.com/docs/5.3/forms/validation/#server-side>
