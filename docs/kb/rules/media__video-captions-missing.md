---
title: "media/video-captions-missing"
severity: "warning"
scope: "node"
satisfies: ["wcag22:1.2.2", "wcag21:1.2.2"]
---
# `media/video-captions-missing`
- **Severity:** warning
- **Scope:** node
- **Satisfies:** `wcag22:1.2.2`, `wcag21:1.2.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
<video> elements need a <track kind='captions'> child, and <iframe> embeds of known video hosts (YouTube, Vimeo, Wistia, Brightcove, Loom) need host-side captions enabled — so deaf and hard-of-hearing users can follow the dialogue.
## Why it matters
Captions are the minimum accessible representation of spoken content in prerecorded and live video. For self-hosted `<video>`, a `<track kind="captions">` child is the author-owned mechanism. For iframe-embedded media, captions come from the host platform and static analysis can only point at the embed — the agent must verify captions are turned on upstream.
## Normative quote
> Captions are provided for all prerecorded audio content in synchronized media.
## Good example
```tsx
<video src="launch.mp4" controls><track kind="captions" src="launch.vtt" srclang="en" label="English"></video>
```
## Bad example
```tsx
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Launch demo"></iframe>
```
## References
- <https://www.w3.org/TR/WCAG22/#captions-prerecorded>
- <https://www.w3.org/WAI/media/av/captions/>
