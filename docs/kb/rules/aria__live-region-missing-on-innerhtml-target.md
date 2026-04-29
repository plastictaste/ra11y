---
title: "aria/live-region-missing-on-innerhtml-target"
severity: "warning"
scope: "project"
satisfies: ["wcag22:4.1.3", "wcag21:4.1.3"]
---
# `aria/live-region-missing-on-innerhtml-target`
- **Severity:** warning
- **Scope:** project
- **Satisfies:** `wcag22:4.1.3`, `wcag21:4.1.3`
- **Applies to:** .html, .htm, .tsx, .jsx, .ts, .js
## What it checks
Elements whose innerHTML/textContent is rewritten by recurring schedulers or event handlers must declare a live region (aria-live, role=status, role=alert, role=log, or <output>) so screen-reader users hear the update.
## Why it matters
When a vanilla-JS app calls `document.getElementById('X').innerHTML = …` inside a `setInterval` or event handler, the element's content changes at runtime and sighted users see the update. Without `aria-live` or a live-region role on the host, screen-reader users are never told the content changed — the SC 4.1.3 failure this rule targets. Emitting at the HTML element (rather than the JS site) points the agent at the file they edit to fix it; the suggestion names the JS site so the agent can verify the trace before adding the attribute.
## Normative quote
> In content implemented using markup languages, status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus.
## Good example
```tsx
<!-- index.html -->
<div id="clock" aria-live="polite"></div>
<script src="./app.js"></script>

// app.js
setInterval(() => {
  document.getElementById('clock').innerHTML = new Date().toLocaleTimeString();
}, 1000);
```
## Bad example
```tsx
<!-- index.html -->
<div id="clock"></div>
<script src="./app.js"></script>

// app.js
setInterval(() => {
  document.getElementById('clock').innerHTML = new Date().toLocaleTimeString();
}, 1000);
```
## References
- <https://www.w3.org/TR/WCAG22/#status-messages>
- <https://www.w3.org/TR/wai-aria-1.2/#aria-live>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22>
- <https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA19>
