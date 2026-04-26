---
title: "layout/horizontal-scroll-no-keyboard"
severity: "warning"
scope: "document"
satisfies: ["wcag22:2.1.1", "wcag21:2.1.1"]
---
# `layout/horizontal-scroll-no-keyboard`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .css
## What it checks
CSS rules that create a horizontally scrollable region (overflow-x: auto/scroll, or the overflow shorthand with auto/scroll) need elements matching that selector to also carry tabindex="0" and an accessible name so keyboard-only users can focus and scroll the region.
## Why it matters
When CSS makes an element scrollable but the element is not focusable, keyboard-only users cannot reach the content beyond the visible viewport. Pointer users can drag or wheel-scroll; keyboard users have no equivalent affordance unless the wrapper itself is in the tab order. WCAG 2.1.1 Keyboard requires that all functionality — including reading the off-axis content of a scrollable region — be reachable from the keyboard. The fix on the rendered element is `tabindex="0"` plus `aria-label` (or `aria-labelledby`) so the focused region announces what it contains.
## Normative quote
> All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes, except where the underlying function requires input that depends on the path of the user's movement and not just the endpoints.
## Good example
```tsx
.table-wrapper {
  overflow-x: auto;
}
/* In the rendered DOM, the wrapper element carries the keyboard hooks: */
/* <div class="table-wrapper" tabindex="0" aria-label="Quarterly results"> */
/*   <table>...</table>                                                   */
/* </div>                                                                 */
```
## Bad example
```tsx
.table-wrapper {
  overflow-x: auto;
}
/* Rendered as <div class="table-wrapper"><table>...</table></div> with no */
/* tabindex or aria-label — keyboard users cannot scroll the table.        */
```
## References
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html>
- <https://adrianroselli.com/2020/11/under-engineered-responsive-tables.html>
