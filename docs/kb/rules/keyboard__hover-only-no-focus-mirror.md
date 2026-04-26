---
title: "keyboard/hover-only-no-focus-mirror"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.4.13", "wcag21:1.4.13", "wcag22:2.1.1", "wcag21:2.1.1"]
---
# `keyboard/hover-only-no-focus-mirror`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.4.13`, `wcag21:1.4.13`, `wcag22:2.1.1`, `wcag21:2.1.1`
- **Applies to:** .css, .scss, .less
## What it checks
CSS :hover rules that mutate transform/opacity/visibility/display must have a paired :focus or :focus-within mirror so keyboard users can trigger the same reveal.
## Why it matters
Mouse users discover a hover-revealed panel by moving the pointer over its trigger; keyboard users have no equivalent gesture. WCAG 1.4.13 (Content on Hover or Focus) covers content that appears on hover OR focus, and 2.1.1 (Keyboard) requires every functional pathway have a keyboard equivalent — together they require any reveal-on-hover behavior to also fire on `:focus` / `:focus-within`. The fix is cheap and idiomatic: add the focus pseudo to the same selector chain (`.card:hover .panel, .card:focus-within .panel { transform: translateY(0); }`). Static analysis catches the canonical reveal pattern (transform / opacity / visibility / display mutated on `:hover` with no focus mirror); color-only state changes are out of scope (they don't reveal content) and live in `color/state-class-color-only`.
## Normative quote
> Where receiving and then removing pointer hover or keyboard focus triggers additional content to become visible and then hidden, the [content is] dismissable, hoverable, and persistent.
## Good example
```tsx
.card:hover .panel,
.card:focus-within .panel {
  transform: translateY(0);
  opacity: 1;
}
```
## Bad example
```tsx
.card:hover .panel {
  transform: translateY(0);
  opacity: 1;
}
```
## References
- <https://www.w3.org/TR/WCAG22/#content-on-hover-or-focus>
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html>
- <https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html>
