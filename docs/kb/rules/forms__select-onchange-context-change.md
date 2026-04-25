---
title: "forms/select-onchange-context-change"
severity: "error"
scope: "node"
satisfies: ["wcag22:3.2.2", "wcag21:3.2.2", "section508:3.2.2", "en301549:9.3.2.2"]
---
# `forms/select-onchange-context-change`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:3.2.2`, `wcag21:3.2.2`, `section508:3.2.2`, `en301549:9.3.2.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
Flags <select onchange> handlers that navigate, submit, or open a new window — selecting an option triggers a context change without explicit user activation.
## Why it matters
WCAG 3.2.2 (On Input, Level A) forbids unannounced context changes from a user adjusting a control's setting. A `<select>` whose `onchange` navigates the page or submits the form fails this universally for keyboard users: arrow-key navigation through options walks the page away from them on every keystroke. Sighted mouse users are also surprised when picking the wrong option commits an unintended action with no confirmation. The fix is almost always to pair the `<select>` with a separate `<button>` ("Go", "Apply", "Submit") that the user activates explicitly — that is the user request the spec requires.
## Normative quote
> Changing the setting of any user interface component does not automatically cause a change of context unless the user has been advised of the behavior before using the component.
## Good example
```tsx
<form>
  <select name="lang">
    <option value="en">English</option>
    <option value="fr">Français</option>
  </select>
  <button type="submit">Apply</button>
</form>
```
## Bad example
```tsx
<select onchange="location.href=this.value">
  <option value="/en">English</option>
  <option value="/fr">Français</option>
</select>
```
## References
- <https://www.w3.org/TR/WCAG22/#on-input>
- <https://www.w3.org/WAI/WCAG22/Understanding/on-input.html>
- <https://www.w3.org/WAI/WCAG22/Techniques/failures/F36>
- <https://www.w3.org/WAI/WCAG22/Techniques/failures/F37>
