---
title: "motion/animation-from-interactions"
severity: "warning"
scope: "node"
satisfies: ["wcag22:2.3.3", "wcag21:2.3.3"]
---
# `motion/animation-from-interactions`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:2.3.3`, `wcag21:2.3.3`
- **Applies to:** .html, .htm, .css
## What it checks
Flags CSS animation/transition declarations whose selector is entirely gated by a user-interaction pseudo-class (:hover, :focus, :active, :focus-visible, :focus-within). WCAG 2.3.3 AAA requires a mechanism to disable motion triggered by interaction unless the animation is essential — a @media (prefers-reduced-motion: reduce) guard satisfies that mechanism.
## Why it matters
Motion triggered by hover/focus/activate is usually decorative but can still provoke vestibular or attention symptoms in users who depend on keyboard navigation or pointer exploration. Unlike auto-updating motion (2.2.2), interaction-gated motion is bounded by user intent — but users who cannot avoid the interaction (keyboard tab-through, mobile hover-on-tap) still need a way to disable it. A prefers-reduced-motion guard is the standard mechanism; essential animation (drag feedback, spatial reorientation) is out of scope per the SC's exception.
## Normative quote
> Motion animation triggered by interaction can be disabled, unless the animation is essential to the functionality or the information being conveyed.
## Good example
```tsx
@media (prefers-reduced-motion: reduce) {
  .btn:hover { transition: none; }
}
.btn:hover { transition: transform 0.2s; }
```
## Bad example
```tsx
.btn:hover { transition: transform 0.2s ease; }
.card:focus-visible { animation: pulse 0.6s; }
```
## References
- <https://www.w3.org/TR/WCAG22/#animation-from-interactions>
- <https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions>
