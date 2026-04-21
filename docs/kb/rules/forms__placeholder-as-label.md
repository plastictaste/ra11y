---
title: "forms/placeholder-as-label"
severity: "warning"
scope: "document"
satisfies: ["wcag22:3.3.2", "wcag21:3.3.2", "wcag22:1.3.1", "wcag21:1.3.1"]
---
# `forms/placeholder-as-label`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:3.3.2`, `wcag21:3.3.2`, `wcag22:1.3.1`, `wcag21:1.3.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Form control has a placeholder but no label, aria-label, aria-labelledby, or wrapping <label> — the placeholder is the only hint, but it disappears on focus and is announced inconsistently by screen readers.
## Why it matters
Placeholder text is assistive-tech unstable: it disappears the moment a user focuses the field (so a sighted user who looks away loses the hint), it is announced inconsistently across screen readers, and most browser UAs render it at low contrast. SC 3.3.2 requires labels or instructions when content requires input; SC 1.3.1 requires the label-to-control relationship to be programmatically determinable. A `placeholder="Email"` satisfies neither — the field has no persistent name for AT to announce and no programmatic association between the hint and the control. The fix is inexpensive (move the placeholder copy into a `<label>` or an `aria-label`), and the author usually already has the label text — it's sitting inside the placeholder.
## Normative quote
> Labels or instructions are provided when content requires user input. (SC 3.3.2) Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text. (SC 1.3.1)
## Good example
```tsx
<label for="email">Email</label>
<input id="email" type="email" placeholder="name@example.com">
```
## Bad example
```tsx
<input type="email" placeholder="Email">
```
## References
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G131>
- <https://www.w3.org/WAI/WCAG22/Techniques/failures/F68>
- <https://www.w3.org/WAI/tutorials/forms/labels/>
