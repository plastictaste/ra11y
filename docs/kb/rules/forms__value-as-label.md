---
title: "forms/value-as-label"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `forms/value-as-label`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Text-shaped <input> has a value attribute that looks like a label (e.g. value="Username") but no <label>, aria-label, aria-labelledby, or title — the value renders as pre-filled input text and disappears the moment the user starts typing.
## Why it matters
A pre-filled `value` is not a label channel. To a sighted user on first paint the visible text in the field looks like a hint, but it is input text — the moment focus arrives and the user types, the 'label' is gone. Screen readers announce a control's accessible name (label / aria-label / aria-labelledby / title), not its current value as a name; without one of those the field has no name to announce. SC 1.3.1 requires the label-to-control relationship to be programmatically determinable; SC 4.1.2 requires the name to be programmatically determinable. A `<input type="text" value="Username">` satisfies neither — there is no programmatic association between the displayed copy and the control, and the form may submit the literal string 'Username' if the user tabs past without editing. The fix is the same as the placeholder-as-label antipattern: promote the copy into a real `<label>` or `aria-label`.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text. (SC 1.3.1) For all user interface components ... the name and role can be programmatically determined. (SC 4.1.2)
## Good example
```tsx
<label for="username">Username</label>
<input id="username" type="text">
```
## Bad example
```tsx
<input type="text" value="Username">
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G131>
- <https://www.w3.org/WAI/WCAG22/Techniques/failures/F68>
