---
title: "parsing/invalid-id-shape"
severity: "error"
scope: "document"
satisfies: ["wcag21:4.1.1"]
---
# `parsing/invalid-id-shape`
- **Severity:** error
- **Scope:** document
- **Satisfies:** `wcag21:4.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
id attribute values must be non-empty, must not contain whitespace, must not start with '#' (URL fragment syntax), and must use only ASCII-safe characters [A-Za-z0-9_-].
## Why it matters
The HTML spec requires id to contain at least one character and forbids ASCII whitespace. An empty id never matches getElementById, so ARIA references, label[for] associations, and anchor links silently fail. A whitespace-bearing id tokenizes as multiple ids under the spec's space-separated parsing — CSS selectors, getElementById, and aria-labelledby all mis-resolve. A leading '#' (id="#top") is the author confusing id syntax with CSS selector / URL fragment syntax; the '#' becomes part of the id literal, so href="#top" cannot find the target. Non-ASCII characters (id="présentation", id="emoji-🎉") are technically legal HTML5 but break URL-fragment routing in older browsers, AT keyboard-shortcut tables, and many CSS selector / getElementById polyfills — the canonical failure mode is an `e` vs `é` mismatch between the id and a copy-pasted href fragment that lost the accent.
## Normative quote
> In content implemented using markup languages, elements have complete start and end tags, elements are nested according to their specifications, elements do not contain duplicate attributes, and any IDs are unique, except where the specifications allow these features.
## Good example
```tsx
<section id="main-content">…</section>
```
## Bad example
```tsx
<section id="#main-content">…</section>
<section id="">…</section>
<section id="main content">…</section>
<section id="présentation">…</section>
```
## References
- <https://www.w3.org/TR/WCAG21/#parsing>
- <https://html.spec.whatwg.org/multipage/dom.html#the-id-attribute>
- <https://www.w3.org/WAI/WCAG21/Techniques/general/F77>
