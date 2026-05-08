---
title: "media/audio-controls-or-transcript-missing"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.1.1", "wcag21:1.1.1", "section508:1.1.1", "en301549:9.1.1.1"]
---
# `media/audio-controls-or-transcript-missing`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.1.1`, `wcag21:1.1.1`, `section508:1.1.1`, `en301549:9.1.1.1`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
<audio> elements with no controls, no <track>, and no neighboring transcript link have no text alternative — failing WCAG 1.1.1 (Non-text Content).
## Why it matters
Audio content is non-text content under WCAG 1.1.1: it must have a text alternative serving the equivalent purpose. The static-deterministic signal that no text alternative exists is the conjunction of three observable predicates: no `controls` attribute (no transcript surfaced via the player UI), no `<track>` child (no caption/description track inline), and no transcript anchor in the surrounding siblings (no `<a href="transcript.…">` link). When all three fail, the audio is inaccessible to anyone who cannot hear it. Adding any one of `controls`, a `<track>`, or a clearly-labeled transcript anchor next to the element resolves the static signal.
## Normative quote
> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for the situations listed below. (1.1.1 Non-text Content)
## Good example
```tsx
<audio src="podcast.mp3" controls></audio>
<a href="podcast-transcript.html">Read the transcript</a>
```
## Bad example
```tsx
<audio src="podcast.mp3"></audio>
```
## References
- <https://www.w3.org/TR/WCAG22/#non-text-content>
- <https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html>
- <https://www.w3.org/WAI/WCAG22/Techniques/general/G158>
