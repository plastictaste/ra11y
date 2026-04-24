---
title: "forms/label-adjacent-mismatch"
severity: "error"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:3.3.2", "wcag21:3.3.2", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `forms/label-adjacent-mismatch`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:3.3.2`, `wcag21:3.3.2`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
A <label for='X'> immediately preceding a labelable control whose id is not X (and where X resolves to a different element in the same document) is a copy-paste mismatch — the visible label associates with the wrong control.
## Why it matters
Sighted users see a label sitting on top of a control and read them as a pair. When the label's for= resolves to a different element elsewhere in the document, assistive tech announces the label as the name of THAT element (often double-announcing it) while leaving the adjacent control unlabeled. forms/label-for-id-mismatch only catches dangling references; forms/label-adjacent-unassociated only catches missing for=. The mismatched-but-resolving case escapes both, even though the visual intent (label belongs to the adjacent control) is plain.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<label for="password">Password:</label>
<input id="password" type="password">
```
## Bad example
```tsx
<label for="email">Password:</label>
<input id="password" type="password">
<input id="email" type="text">
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#labels-or-instructions>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H44>
- <https://html.spec.whatwg.org/multipage/forms.html#the-label-element>
