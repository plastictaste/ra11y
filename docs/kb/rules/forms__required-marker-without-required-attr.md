---
title: "forms/required-marker-without-required-attr"
severity: "error"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2"]
---
# `forms/required-marker-without-required-attr`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:3.3.2`, `wcag21:3.3.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
A <label> with a visible required marker (* in an element wrapper, <abbr title="required">, or the literal word 'required') must pair with an input that sets `required` or `aria-required="true"` — visual-only required cues are inaccessible to screen readers.
## Why it matters
When a label tells sighted users a field is required (via an asterisk, a red marker, or the word 'required'), the same information must reach assistive tech. If the underlying control sets neither `required` nor `aria-required="true"`, the requirement is communicated visually only — a screen-reader user hears 'Email star edit text' with no programmatic signal that the field is required, and submission failures become the first time they learn the rule. The companion rule `color/meaning-by-color-only` flags the red `*` itself; this rule flags the input that fails to expose the required state. Both findings together describe the full failure.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<label for="email">Email <span class="text-danger">*</span></label>
<input id="email" type="email" required>
```
## Bad example
```tsx
<label for="email">Email <span class="text-danger">*</span></label>
<input id="email" type="email">
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA2>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H90>
