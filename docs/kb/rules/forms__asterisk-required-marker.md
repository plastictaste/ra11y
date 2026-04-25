---
title: "forms/asterisk-required-marker"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2"]
---
# `forms/asterisk-required-marker`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:3.3.2`, `wcag21:3.3.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
A <label> whose trimmed text ends with a bare `*` (or a control whose `placeholder` ends with `*`) must pair with an input that sets `required` or `aria-required="true"` — the asterisk-equals-required convention is sighted-only without a programmatic signal.
## Why it matters
The trailing-asterisk-equals-required convention is widespread in form design (a Nielsen Norman survey usability standard) but it lives entirely in the visual layer — a screen-reader user hearing 'Email star edit text' has no way to know the field is required until submission fails. The sister rule `forms/required-marker-without-required-attr` covers element-wrapped markers (`<span>*</span>`, `<abbr title="required">`); this rule covers the bare-text shape that's just as common in handwritten HTML and JSX. Severity is `warning` rather than `error` because a small residue of false positives remains (labels where the trailing `*` is a footnote marker pointing to a fine-print disclosure rather than a required-field convention) — the reason text frames the question so an agent can dismiss with one read.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<label for="email">Email *</label>
<input id="email" type="email" required>
```
## Bad example
```tsx
<label for="email">Email *</label>
<input id="email" type="email">
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA2>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H90>
