---
title: "forms/autocomplete-missing"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.3.5", "wcag21:1.3.5"]
---
# `forms/autocomplete-missing`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.3.5`, `wcag21:1.3.5`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Input fields collecting information about the user must declare an autocomplete value drawn from WCAG's 53 input-purpose tokens so the field's purpose can be programmatically determined (WCAG 2.2 SC 1.3.5, Level AA).
## Why it matters
SC 1.3.5 Identify Input Purpose is Level AA and conformance-mandatory for every input field collecting information about the user. The normative requirement is that the purpose can be programmatically determined via the `autocomplete` attribute, using one of the 53 tokens enumerated in the WCAG 2.1 Input Purposes for User Interface Components section (`name`, `given-name`, `family-name`, `email`, `tel`, `street-address`, `postal-code`, `country`, `bday`, `current-password`, and so on). Password managers, symbol-based input aids, and browser autofill all depend on these tokens to identify a field — users with cognitive disabilities rely on those aids heavily, so an unlabelled email field turns a one-tap autofill into a manual re-entry. "Should" understates the normative weight: if a field collects a purpose on the SC 1.3.5 list, the `autocomplete` attribute is required.
## Normative quote
> The purpose of each input field collecting information about the user can be programmatically determined when: (1) The input field serves a purpose identified in the Input Purposes for User Interface Components section; and (2) The content is implemented using technologies with support for identifying the expected meaning for form input data.
## Good example
```tsx
<input type="email" name="email" autocomplete="email">
```
## Bad example
```tsx
<input type="email" name="email">
```
## References
- <https://www.w3.org/TR/WCAG22/#identify-input-purpose>
- <https://www.w3.org/TR/WCAG21/#input-purposes>
