---
title: "pointer/draggable-no-keyboard-alt"
severity: "warning"
scope: "document"
satisfies: ["wcag22:2.5.7", "wcag22:2.1.1", "wcag21:2.1.1", "section508:2.1.1", "en301549:9.2.1.1"]
---
# `pointer/draggable-no-keyboard-alt`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:2.5.7`, `wcag22:2.1.1`, `wcag21:2.1.1`, `section508:2.1.1`, `en301549:9.2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
draggable element must expose a keyboard handler (onkeydown / onKeyDown) so users who cannot drag can reorder, move, or pick up the item via the keyboard.
## Why it matters
Native HTML5 drag-and-drop (`draggable="true"`) is mouse/touch only — the platform exposes no keyboard pathway to start, drag, or drop. Users on switch input, head pointers, eye-gaze, or keyboard-only workflows cannot operate a draggable element unless the author wires keyboard equivalents (typically Arrow keys to move, Home/End to send to extremes, Space to pick up / drop). Without any keyboard handler at all the operation is keyboard-inoperable, failing SC 2.1.1; combined with no drag-free pathway, it also fails SC 2.5.7.
## Normative quote
> All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes.
## Good example
```tsx
<a href="#" draggable="true" onKeyDown={handleArrows}>
  Drag me — or use Arrow keys to move
</a>
```
## Bad example
```tsx
<a href="#" draggable="true">
  Drag me
</a>
```
## References
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://www.w3.org/TR/WCAG22/#dragging-movements>
- <https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html>
- <https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html>
