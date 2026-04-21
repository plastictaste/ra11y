---
title: "forms/radio-group-without-fieldset"
severity: "error"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `forms/radio-group-without-fieldset`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:3.3.2`, `wcag21:3.3.2`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Radio inputs sharing a name must be wrapped by <fieldset>+<legend> or a role='radiogroup' container with an accessible name, so the group is programmatically announced with its purpose.
## Why it matters
Radios sharing a `name` are mutually-exclusive choices — a group, not independent controls. Without a fieldset+legend or role='radiogroup' with a name, screen readers announce each option in isolation ('Standard, radio button, 1 of …?') but never the group's purpose ('Shipping speed'). The visually-obvious relationship fails to reach assistive technology; WCAG 1.3.1 (structure), 3.3.2 (label for the input set), and 4.1.2 (name/role for the group) all fail together.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<fieldset>
  <legend>Shipping speed</legend>
  <label><input type="radio" name="speed" value="std"> Standard</label>
  <label><input type="radio" name="speed" value="exp"> Express</label>
</fieldset>
```
## Bad example
```tsx
<label><input type="radio" name="speed" value="std"> Standard</label>
<label><input type="radio" name="speed" value="exp"> Express</label>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/ARIA/apg/patterns/radio/>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H71>
