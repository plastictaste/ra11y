---
title: "parsing/html-has-lang"
severity: "error"
scope: "document"
satisfies: ["wcag22:3.1.1", "wcag21:3.1.1", "wcag22:3.1.2", "wcag21:3.1.2"]
---
# `parsing/html-has-lang`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag22:3.1.1`, `wcag21:3.1.1`, `wcag22:3.1.2`, `wcag21:3.1.2`
- **Applies to:** .html, .htm
## What it checks
Every element that declares a lang attribute must use a syntactically valid, non-empty BCP 47 language tag — and underspecified codes (zxx, und, mul, mis) must not appear on elements that contain visible prose.
## Why it matters
Screen readers switch pronunciation dictionaries based on lang. An empty or malformed value (lang="", lang="english", lang="en_US") is treated as unknown — the assistive technology falls back to the default voice and mispronounces the content, which is indistinguishable from no lang attribute at all. Underspecified codes like zxx ("no linguistic content") are syntactically valid but semantically wrong on a page with real UI copy: the screen reader trusts the declaration and either skips pronunciation or falls back to the default voice on text the user will actually hear.
## Normative quote
> The human language of each passage or phrase in the content can be programmatically determined except for proper names, technical terms, words of indeterminate language, and words or phrases that have become part of the vernacular of the immediately surrounding text.
## Good example
```tsx
<html lang="en-US"><body><p lang="fr">Bonjour</p></body></html>
```
## Bad example
```tsx
<html lang="zxx"><body><p>Email address</p><button>Sign in</button></body></html>
```
## References
- <https://www.w3.org/TR/WCAG22/#language-of-parts>
- <https://www.w3.org/WAI/WCAG22/Techniques/html/H58>
- <https://www.rfc-editor.org/rfc/rfc5646>
