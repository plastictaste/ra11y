---
title: "navigation/link-name-only-symbol"
severity: "warning"
scope: "node"
satisfies: ["wcag22:2.4.4", "wcag21:2.4.4", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `navigation/link-name-only-symbol`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:2.4.4`, `wcag21:2.4.4`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <a> (and JSX link wrappers) whose computed accessible name is one or two characters drawn entirely from Unicode punctuation/symbol categories — chevrons (« » ‹ ›), arrows (← → ↑ ↓), the multiplication sign (×) used as 'close', stars (★ ☆), hearts (♥), bullets (•), or paired variants. Screen readers announce these as punctuation ('LEFT-POINTING DOUBLE ANGLE QUOTATION MARK') or skip them, leaving the link with no usable destination name. Add an aria-label naming the destination (or include a visually-hidden span inside the anchor expanding the glyph into words). Pairs with the pagination-specific review/pagination-glyph-accessible-name finder; this rule is the broader catch.
## Why it matters
Assistive technology decides how to announce a link from its accessible name. When the name is one or two punctuation/symbol codepoints, AT either reads the Unicode-category name verbatim ('left-pointing double angle quotation mark', 'multiplication sign') or skips the codepoint entirely — neither outcome tells the user where the link goes. The visual convention (× = close, › = next, ★ = favorite, ↑ = back-to-top) is sighted-only metadata; AT users hear nothing meaningful.

Specifically the matched shapes:

  - One- or two-codepoint accessible names (after collapsing whitespace and decoding the four named entities the HTML parser leaves intact: &laquo; &raquo; &lsaquo; &rsaquo; plus &times;).
  - Every codepoint must be in Unicode punctuation (\p{P}) OR symbol (\p{S}) — letters and digits exit the rule (a letter is real text; a digit might be a page number labeled by surrounding context).
  - Anchors with aria-label / aria-labelledby / title overrides stay silent (the override is the real accessible name).
  - Anchors with aria-hidden='true' on themselves are removed from the a11y tree — silent.
  - JSX expression children (`<a>{label}</a>`) are opaque to static analysis — silent.

Distinct from the pagination-glyph review finder (which only matches the four chevron/guillemet glyphs in pagination context) — this rule fires on every short symbol-only name regardless of context. Distinct from link-descriptive-text generic-phrase (curated 'click here' dictionary) and icon-only (every child presentational) paths — symbol-only links sit in the gap between those.
## Normative quote
> The purpose of each link can be determined from the link text alone or from the link text together with its programmatically determined link context.
## Good example
```tsx
<a href="/prev" aria-label="Previous page">«</a>
```
## Bad example
```tsx
<a href="/prev">«</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#link-purpose-in-context>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA7>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA8>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G91>
