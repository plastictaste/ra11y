---
title: "color/state-class-color-only"
severity: "warning"
scope: "document"
satisfies: ["wcag22:1.4.1", "wcag21:1.4.1"]
---
# `color/state-class-color-only`
- **Severity:** warning
- **Scope:** document
- **Satisfies:** `wcag22:1.4.1`, `wcag21:1.4.1`
- **Applies to:** .css, .scss, .less
## What it checks
State-class CSS rules (.active, .selected, .current, .disabled, [aria-selected=true], [aria-current], [aria-pressed=true], :checked) that declare only color-family properties (color, background-color, border-color, outline-color, text-decoration-color) — with no non-color cue (text-decoration line, font-weight, border-style, outline thickness, background-image, content, transform) — risk relying on color alone to communicate the state. Surface the CSS shape so the agent can verify a second channel is present in the consumer site.
## Why it matters
WCAG 1.4.1 requires that state distinctions (selected vs. unselected, active vs. inactive, current vs. other) reach users who cannot perceive color — colorblind users, users under color-inverted themes, screen-reader users hearing the announcement. When a state class shifts only color (`.tab.active { color: blue; background-color: white; }` against a base `.tab { color: gray; background-color: lightgray; }`), the rendered state difference is visible to sighted full-color users only. The fix is cheap and well-known: add a non-color cue — `font-weight: bold`, `text-decoration: underline`, `border-style: solid`, an icon, or expose the state via `aria-current` / `aria-selected` / `aria-pressed` so assistive tech announces it. The static rule cannot prove the consumer site lacks a second channel (an aria attribute exposed in JSX, an icon swap), so severity is `warning` and the message frames the question rather than asserts the violation.
## Normative quote
> Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.
## Good example
```tsx
.tab.active { color: #1a56db; background-color: #fff; font-weight: 600; border-bottom: 2px solid #1a56db; }
```
## Bad example
```tsx
.tab.active { color: #1a56db; background-color: #fff; }
```
## References
- <https://www.w3.org/TR/WCAG22/#use-of-color>
- <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G182>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G183>
