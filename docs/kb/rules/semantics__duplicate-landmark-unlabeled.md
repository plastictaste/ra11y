---
title: "semantics/duplicate-landmark-unlabeled"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:2.4.1", "wcag21:2.4.1"]
---
# `semantics/duplicate-landmark-unlabeled`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:2.4.1`, `wcag21:2.4.1`
- **Applies to:** .html, .htm
## What it checks
When a document ships two or more landmarks of the same type (nav, aside, form, main), each one needs a distinguishing aria-label or aria-labelledby so screen-reader users can tell them apart. A fragment/partial file with a single unlabeled nav/aside/form is flagged too — it will compose with siblings at render.
## Why it matters
Screen readers expose landmarks via a dedicated shortcut (D in NVDA, VO+U in VoiceOver, R in JAWS). Two `<nav>` elements with no labels both announce as 'navigation landmark', so a blind user cursoring the landmark list sees 'navigation, navigation' and has to enter each one to discover which is the primary nav. In Jekyll, Astro, Handlebars etc., header partials that ship mobile + desktop copies of the same landmark are the canonical shape of this failure — the duplicate only materializes after the layout composes, so the in-file partial check is load-bearing.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined.
## Good example
```tsx
<header><nav aria-label="Primary">…</nav><nav aria-label="Mobile">…</nav></header>
```
## Bad example
```tsx
<header><nav>…desktop…</nav><nav>…mobile…</nav></header>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#bypass-blocks>
- <https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/examples/navigation.html>
