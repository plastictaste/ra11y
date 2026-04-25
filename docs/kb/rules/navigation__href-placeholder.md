---
title: "navigation/href-placeholder"
severity: "error"
scope: "node"
satisfies: ["wcag22:4.1.2", "wcag21:4.1.2", "wcag22:2.1.1", "wcag21:2.1.1"]
---
# `navigation/href-placeholder`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:4.1.2`, `wcag21:4.1.2`, `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <a> elements whose href value announces as a link but does not navigate — the "placeholder href" family. The rule spans every non-navigating href shape: any `javascript:` scheme (`javascript:void(0)`, `javascript:void 0`, `javascript:;`, `javascript:`, `javascript:alert(1)`, the case-insensitive `JAVASCRIPT:…` variants, plus the bare-`javascript`-no-colon typo), bare `href="#"` with no fragment id, and empty `href=""` (which the HTML spec resolves to the current page URL — activating the link reloads the page). Whitespace is trimmed before matching, so `"  #  "` and `"   "` are flagged the same way. Suppressing this rule ID by name silences ALL of the above shapes — register the suppression with that surface in mind. Use <button type="button"> for actions, or put a real URL in href for navigation.
## Why it matters
Assistive technology decides how to announce a control from its role: `<a>` with an href maps to the link role. The browser treats every shape this rule catches as a link, but none of them navigate meaningfully — the user hears 'link,' activates it, and nothing happens (or worse, loses form state from a surprise reload). Concretely, the matched shapes are:

  - `javascript:` scheme in any form: `javascript:void(0)`, `javascript:void 0`, `javascript:;`, `javascript:` (empty body), `javascript:alert(1)` and other arbitrary expressions, plus `JAVASCRIPT:…` and other case-insensitive variants (RFC 3986 §3.1 makes URL schemes case-insensitive). The bare token `javascript` (no colon — almost always an author typo for `javascript:void(0)`) is also flagged.
  - Bare `href="#"` with no fragment id — there is no target to scroll to, so the anchor announces as a link but navigates nowhere. (`href="#section-id"` pointing at a real id is real in-page navigation and stays silent.)
  - Empty `href=""` — per HTML spec this resolves to the current document URL, so activating the link reloads the page rather than navigating. The `link-no-href` rule only catches the empty case when an onClick is attached (its scope is the keyboard-trap pattern); the bare `<a href="">Forgot password?</a>` case (common in legacy form pages wired up later) belongs here.
  - Whitespace is trimmed before classification, so `"  #  "` matches as bare-fragment and `"   "` matches as empty.

In every case the semantic role (link) contradicts the runtime behavior, breaking WCAG 4.1.2 Name, Role, Value. Static detection is reliable because the href attribute's string value is the full signal. JSX expression-form `href={…}` is opaque at static time and intentionally not flagged — the agent reads the source if the call site looks suspicious.
## Normative quote
> For all user interface components … the name and role can be programmatically determined.
## Good example
```tsx
<button type="button" onClick={handleClick}>Toggle menu</button>
```
## Bad example
```tsx
<a href="javascript:void(0)" onClick={handleClick}>Toggle menu</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://html.spec.whatwg.org/#the-a-element>
