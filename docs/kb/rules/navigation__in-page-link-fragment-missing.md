---
title: "navigation/in-page-link-fragment-missing"
severity: "warning"
scope: "document"
satisfies: ["wcag22:2.4.1", "wcag21:2.4.1"]
---
# `navigation/in-page-link-fragment-missing`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:2.4.1`, `wcag21:2.4.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <a href="#some-id"> whose fragment id has no matching element in the same document — the link announces as in-page navigation but lands nowhere. The bare `#`, the universal `#top` convention, cross-document links (`/path#id`), and JSX expression-form href={…} are intentionally out of scope.
## Why it matters
An anchor with a fragment href promises the user that activating it will navigate to (and focus) a named region of the same page. When the named region does not exist, the browser silently scrolls to the document top and leaves focus at the link — the user hears 'link', activates it, and either nothing visible happens or focus order breaks. This is the failure mode 2.4.1 (Bypass Blocks) and the surrounding navigable-block criteria assume cannot occur: skip links, table-of-contents anchors, and 'back to top' / 'jump to section' affordances all depend on the fragment resolving. The check is deterministic over the parsed document — id collection is one pass over every element, the lookup is case-sensitive per the HTML spec — so a dangling reference is structural, not a heuristic guess.

Legacy `<a name='X'>` anchors satisfy `href='#X'` per browser fragment-resolution behavior; the lookup includes both `id` and `<a name>` so HTML4 / XHTML 1.0 idioms don't produce false positives. Fragment files (front-matter, fragment-convention paths, no document envelope) are omitted from emission entirely because the target id may be supplied by the composing parent layout or a sibling fragment — the predicate 'no element with this id exists in the rendered DOM' is structurally unverifiable from one fragment file. Per the AI-first consumer doctrine bullet 'Heuristic emission is the symmetric twin of heuristic suppression', emitting on speculation about composition (even at `info` with a hedge code) leaks heuristic uncertainty into a slot the agent reads as 'the scanner saw evidence of this.' Scan-confidence is preserved via the `FRAGMENT_DOWNGRADE_RULE_IDS` set in `src/mcp/scan-assembly.ts`, which downgrades `perRuleCoverage[].coverageConfidence` to `medium` with reason `fragment-input-no-document-envelope` for fragment-classified files in the scan.
## Normative quote
> A mechanism is available to bypass blocks of content that are repeated on multiple Web pages.
## Good example
```tsx
<a href="#main">Skip to main content</a>
<main id="main"><h1>Page</h1></main>
```
## Bad example
```tsx
<a href="#main-contnet">Skip to main content</a>
<main id="main-content"><h1>Page</h1></main>
```
## References
- <https://www.w3.org/TR/WCAG22/#bypass-blocks>
- <https://html.spec.whatwg.org/multipage/browsing-the-web.html#scroll-to-the-fragment-identifier>
- <https://html.spec.whatwg.org/multipage/dom.html#the-id-attribute>
