---
title: "navigation/href-empty-fragment"
severity: "error"
scope: "node"
satisfies: ["wcag22:4.1.2", "wcag21:4.1.2", "wcag22:2.1.1", "wcag21:2.1.1"]
---
# `navigation/href-empty-fragment`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:4.1.2`, `wcag21:4.1.2`, `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx, .vue, .svelte
## What it checks
Flags <a> elements with placeholder href values that announce as links but do not navigate meaningfully: bare `href="#"` (no fragment id, nothing to scroll to) and empty `href=""` (which the HTML spec resolves to the current document URL — activating reloads the page rather than navigating). Whitespace is trimmed before matching, so `"  #  "` and `"   "` are flagged. Companion rule `navigation/href-javascript-scheme` covers the `javascript:` scheme variants. Use <button type="button"> for actions, or put a real URL in href for navigation.
## Why it matters
Assistive technology decides how to announce a control from its role: `<a>` with an href maps to the link role. The browser treats `href="#"` and `href=""` as links (the first as an in-page anchor, the second as a self-link), but neither shape navigates meaningfully — the user hears 'link,' activates it, and either nothing happens or the page silently reloads (losing form state). The semantic role contradicts the runtime behavior.

Specifically the matched shapes:

  - Bare `href="#"` with no fragment id — there is no target to scroll to, so the anchor announces as a link but navigates nowhere. (`href="#section-id"` pointing at a real id is real in-page navigation and stays silent.)
  - Empty `href=""` — per HTML spec this resolves to the current document URL, so activating the link reloads the page rather than navigating. The `link-no-href` rule only catches the empty case when an onClick is attached (its scope is the `<a onClick>` keyboard-trap pattern); the bare `<a href="">Forgot password?</a>` case (common in legacy form pages wired up later) belongs here.
  - Whitespace is trimmed before classification, so `"  #  "` matches as bare-fragment and `"   "` matches as empty.

Split out from the umbrella `navigation/href-placeholder` rule (which previously also covered `javascript:` schemes) so an agent suppressing one shape doesn't silently suppress the other — the two surfaces have different fix profiles. JSX expression-form `href={…}` is opaque at static time and intentionally not flagged.
## Normative quote
> For all user interface components … the name and role can be programmatically determined.
## Good example
```tsx
<a href="/forgot-password">Forgot password?</a>
```
## Bad example
```tsx
<a href="">Forgot password?</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://html.spec.whatwg.org/#the-a-element>
