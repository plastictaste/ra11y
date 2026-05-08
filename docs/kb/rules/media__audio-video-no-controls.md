---
title: "media/audio-video-no-controls"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.4.2", "wcag22:2.1.1", "wcag21:1.4.2", "wcag21:2.1.1", "section508:1.4.2", "section508:2.1.1", "en301549:9.1.4.2", "en301549:9.2.1.1"]
---
# `media/audio-video-no-controls`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.4.2`, `wcag22:2.1.1`, `wcag21:1.4.2`, `wcag21:2.1.1`, `section508:1.4.2`, `section508:2.1.1`, `en301549:9.1.4.2`, `en301549:9.2.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
<audio> and <video> elements should expose user controls — without `controls`, there is no keyboard-operable mechanism to pause, mute, or adjust volume.
## Why it matters
An `<audio>` or `<video>` element without the `controls` attribute renders no built-in UI. The element is not focusable, so keyboard users cannot interact with it (WCAG 2.1.1), and any audio it plays cannot be stopped by the user (WCAG 1.4.2). Custom JS controls are valid alternatives, but they must wire up keyboard handling themselves and degrade when scripts fail. Adding `controls` as a fallback alongside custom UI is the safest pattern.
## Normative quote
> If any audio on a Web page plays automatically for more than 3 seconds, either a mechanism is available to pause or stop the audio, or a mechanism is available to control audio volume independently from the overall system volume level. (1.4.2) — All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes. (2.1.1)
## Good example
```tsx
<video controls src="demo.mp4"></video>
```
## Bad example
```tsx
<video src="demo.mp4"></video>
```
## References
- <https://www.w3.org/TR/WCAG22/#audio-control>
- <https://www.w3.org/TR/WCAG22/#keyboard>
- <https://www.w3.org/WAI/WCAG22/Understanding/audio-control.html>
- <https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html>
