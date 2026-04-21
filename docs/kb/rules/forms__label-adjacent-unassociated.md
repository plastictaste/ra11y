---
title: "forms/label-adjacent-unassociated"
severity: "error"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `forms/label-adjacent-unassociated`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:3.3.2`, `wcag21:3.3.2`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
A <label> immediately preceding an <input>/<select>/<textarea> with an id must carry a matching for= attribute — without it, the association is visual-only and invisible to assistive tech.
## Why it matters
Sighted users see a label and a control next to each other and read them as associated. Assistive tech does not — a <label> with no `for=` (and no implicit wrapping) is announced as unrelated text, and the control is announced as unlabeled. The control already has an id, so the fix is a one-attribute edit. Catching this shape statically surfaces a pervasive tutorial-propagated pattern that `forms/labels-required` flags generically but can't fix mechanically.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<label for="length">Length</label>
<input id="length" type="number">
```
## Bad example
```tsx
<label>Length</label>
<input id="length" type="number">
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H44>
- <https://html.spec.whatwg.org/multipage/forms.html#the-label-element>
