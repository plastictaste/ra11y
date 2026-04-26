---
title: "semantics/inline-display-none-on-focusable"
severity: "error"
scope: "node"
satisfies: ["wcag22:2.4.3", "wcag21:2.4.3", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `semantics/inline-display-none-on-focusable`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:2.4.3`, `wcag21:2.4.3`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Elements with an inline style="display:none" declaration must not be focusable themselves and must not contain focusable descendants. The moment the inline style is toggled off, the focusable subtree returns to the tab order without aria treatment.
## Why it matters
Inline `style="display:none"` removes the element from the rendering, the accessibility tree, AND the tab order — so the user-visible behavior is fine while the style is active. The failure mode is the runtime toggle: scripts that flip `display:none` to `display:block` (progressive disclosure, single-page-app route swaps, dead-nav residue exposed by a debug flag) re-expose every focusable descendant in tab order with whatever stale `href` / `tabindex` / label they carried. Static analysis cannot observe the toggle, but the markup pattern itself is the warning sign — Focus Order (2.4.3) is about the sequence focus follows, and a hidden subtree of focusable controls that can rejoin that sequence at any moment violates the predictability the SC requires. Name/Role/Value (4.1.2) is the secondary failure: when the toggle exposes the subtree mid-interaction, focus may land on a control whose programmatic name no longer matches the visible context.
## Normative quote
> If a Web page can be navigated sequentially and the navigation sequences affect meaning or operation, focusable components receive focus in an order that preserves meaning and operability.
## Good example
```tsx
<li hidden><a href="#topnav">HOME</a></li>
```
## Bad example
```tsx
<li style="display:none;"><a href="#topnav">HOME</a></li>
```
## References
- <https://www.w3.org/TR/WCAG22/#focus-order>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://html.spec.whatwg.org/multipage/interaction.html#focusable-area>
