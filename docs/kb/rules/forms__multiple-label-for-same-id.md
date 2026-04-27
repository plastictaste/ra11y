---
title: "forms/multiple-label-for-same-id"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `forms/multiple-label-for-same-id`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Two or more <label for='X'> elements pointing at the same id produce inconsistent labeling — assistive tech may concatenate, announce only the first, or vary by engine.
## Why it matters
When multiple `<label for='X'>` elements reference the same input id, the form control's `labels` IDL collection returns all of them and the HTML-AAM accessible-name computation walks the references in source order. Screen readers handle the concatenation differently — NVDA/JAWS often announce only the first label, VoiceOver may concatenate without a separator, Narrator may pick the lexically-first — so the user-perceived label varies by AT against an authored intent the parser can't infer. The common shape is a copy-paste of a visible label and a visually-hidden screen-reader-only label both pointing at the same id; reconciling to one explicit association (or routing the secondary text through `aria-describedby`) is the durable fix.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<label for="email">Email address</label>
<input id="email" type="email">
```
## Bad example
```tsx
<label for="email">Email</label>
<label for="email" class="sr-only">Email address</label>
<input id="email" type="email">
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/html-aam-1.0/#input-text-and-other-input-types-text-search-tel-url-email-and-password-accessible-name-computation>
- <https://html.spec.whatwg.org/multipage/forms.html#the-label-element>
