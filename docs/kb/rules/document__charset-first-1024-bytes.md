---
title: "document/charset-first-1024-bytes"
severity: "error"
scope: "document"
satisfies: ["wcag21:4.1.1", "wcag22:1.3.1", "wcag21:1.3.1"]
---
# `document/charset-first-1024-bytes`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag21:4.1.1`, `wcag22:1.3.1`, `wcag21:1.3.1`
- **Applies to:** .html, .htm
## What it checks
<meta charset> must be the first child of <head> and serialized within the first 1024 bytes. HTML §4.2.5.4 requires this so the UA can decode the rest of the document correctly; a late declaration means earlier bytes were already decoded under the wrong encoding.
## Why it matters
Browsers sniff the document's encoding from the first 1024 bytes. If the charset declaration arrives later — or is missing entirely — the prefix is decoded under a guessed encoding and text renders as mojibake. Screen readers read the same mis-rendered text, so the programmatic information in the document is corrupted. Parsing (WCAG 2.1 4.1.1) and Info and Relationships (WCAG 1.3.1) both fail.
## Normative quote
> The element containing the character encoding declaration must be serialized completely within the first 1024 bytes of the document.
## Good example
```tsx
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Hello</title>
  </head>
</html>
```
## Bad example
```tsx
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Hello</title>
    <meta charset="utf-8">
  </head>
</html>
```
## References
- <https://html.spec.whatwg.org/multipage/semantics.html#charset>
- <https://www.w3.org/TR/WCAG21/#parsing>
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
