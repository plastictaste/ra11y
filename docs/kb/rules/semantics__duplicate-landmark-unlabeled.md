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
When a file ships two or more landmarks of the same type (nav, aside, form, main) and at least one lacks aria-label or aria-labelledby, screen-reader users cannot tell them apart in the landmark list. Each unlabeled landmark in the duplicate set is flagged. The single-unlabeled-in-fragment case is not emitted — composition with a sibling partial is unobservable from this file alone.
## Why it matters
Screen readers expose landmarks via a dedicated shortcut (D in NVDA, VO+U in VoiceOver, R in JAWS). Two `<nav>` elements with no labels both announce as 'navigation landmark', so a blind user cursoring the landmark list sees 'navigation, navigation' and has to enter each one to discover which is the primary nav. The rule emits only when the duplicate is observable in the file — two `<nav>`s in one document, two `<form>`s in one partial. Predicting that a single unlabeled landmark in a partial will compose alongside another at render time is a guess about an unseen layout; that case belongs on the review-candidate surface, where the `reason` text frames the question instead of asserting it.
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
