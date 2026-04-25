---
title: "forms/no-submit-control"
severity: "error"
scope: "node"
satisfies: ["wcag22:3.3.2", "wcag21:3.3.2"]
---
# `forms/no-submit-control`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:3.3.2`, `wcag21:3.3.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
<form> with text inputs but no submit control (button[type=submit], input[type=submit], or default-type <button>) leaves users with no way to submit.
## Why it matters
WCAG 3.3.2 covers labels OR instructions for completing a form — the affordance to submit is part of the instructions. A contact form with name/email/message inputs but no Send button is the canonical broken stub: the author started building a form, scaffolded the inputs, and never came back to add the submit control. Sighted users hunt for a button and find none; keyboard users press Enter, which only submits implicitly when a default-type submit button exists in the form. Static detection is reliable because the absence is structural — no DOM render, no CSS state, no JS path is needed to confirm 'this form has nowhere to send the typed data.'
## Normative quote
> Labels or instructions are provided when content requires user input.
## Good example
```tsx
<form action="/contact" method="post">
  <label>Name <input type="text" name="name"></label>
  <label>Message <textarea name="message"></textarea></label>
  <button>Send</button>
</form>
```
## Bad example
```tsx
<form action="/contact" method="post">
  <label>Name <input type="text" name="name"></label>
  <label>Message <textarea name="message"></textarea></label>
  <button type="button">Reset</button>
</form>
```
## References
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G184>
- <https://html.spec.whatwg.org/multipage/form-elements.html#attr-button-type>
