---
title: "navigation/link-descriptive-text"
severity: "warning"
scope: "node"
satisfies: ["wcag22:2.4.4", "wcag21:2.4.4", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `navigation/link-descriptive-text`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:2.4.4`, `wcag21:2.4.4`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Link text must identify the link's destination — never a generic phrase like 'click here' or 'read more', and never an icon-only anchor without an accessible name.
## Why it matters
Screen readers read links out of context — users scan the links list, Tab through them, or use the VoiceOver rotor. A link that says 'here' tells users nothing. An icon-only link (`<a><i class="fa-twitter"></i></a>`) has no text at all — AT announces 'link' with silence behind it, and keyboard users land on an unlabeled control. Both failure modes violate SC 2.4.4 (Link Purpose); the icon-only case also violates SC 4.1.2 (Name, Role, Value) because no name can be programmatically determined.
## Normative quote
> The purpose of each link can be determined from the link text alone or from the link text together with its programmatically determined link context.
## Good example
```tsx
<a href="/docs/api">Read the API reference</a>
```
## Bad example
```tsx
<a href="/twitter"><i class="fa fa-twitter"></i></a>
```
## References
- <https://www.w3.org/TR/WCAG22/#link-purpose-in-context>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G91>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA8>
