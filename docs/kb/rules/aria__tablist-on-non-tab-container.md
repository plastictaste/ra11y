---
title: "aria/tablist-on-non-tab-container"
severity: "error"
scope: "node"
satisfies: ["wcag22:1.3.1", "wcag21:1.3.1", "wcag22:4.1.2", "wcag21:4.1.2"]
---
# `aria/tablist-on-non-tab-container`
- **Severity:** error
- **Scope:** node
- **Satisfies:** `wcag22:1.3.1`, `wcag21:1.3.1`, `wcag22:4.1.2`, `wcag21:4.1.2`
- **Applies to:** .html, .htm, .tsx, .jsx
## What it checks
role="tablist" element has no role="tab" descendant at any depth — assistive tech announces a tablist but the children are not tabs. Common misuse: putting role="tablist" on the panels container instead of the tab strip.
## Why it matters
The WAI-ARIA tabs pattern is a programmatic-role contract: a `tablist` is the container of one or more `tab` elements; each `tab` controls a `tabpanel`. The "Required Owned Elements" clause of the tablist role makes this normative — `role="tablist"` MUST contain at least one element with `role="tab"`. When the role lands on the wrong half of the widget (the canonical case is `<div class="tab-content" role="tablist">` housing `role="tabpanel"` children), screen readers announce "tab list" and then expose the panel content as if each panel were a tab. Keyboard users press the standard arrow-key tab-cycling shortcut and find themselves cycling through panel bodies instead of switching tabs. The visual layout still works for sighted users — the tabs above and the panels below render correctly — but the entire programmatic structure is inverted. This rule fires the moment we see a `role="tablist"` whose subtree contains zero `role="tab"` elements, since that is provable from this file alone.
## Normative quote
> Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.
## Good example
```tsx
<div role="tablist">
  <button role="tab" aria-selected="true" aria-controls="panel-1" id="tab-1">Tab 1</button>
  <button role="tab" aria-selected="false" aria-controls="panel-2" id="tab-2">Tab 2</button>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Panel 1</div>
<div role="tabpanel" id="panel-2" aria-labelledby="tab-2">Panel 2</div>
```
## Bad example
```tsx
<div class="tab-content" role="tablist">
  <div role="tabpanel" id="panel-1">Panel 1</div>
  <div role="tabpanel" id="panel-2">Panel 2</div>
</div>
```
## References
- <https://www.w3.org/TR/WCAG22/#info-and-relationships>
- <https://www.w3.org/TR/WCAG22/#name-role-value>
- <https://www.w3.org/TR/wai-aria-1.2/#tablist>
- <https://www.w3.org/TR/wai-aria-1.2/#tab>
- <https://www.w3.org/TR/wai-aria-1.2/#mustContain>
- <https://www.w3.org/WAI/ARIA/apg/patterns/tabs/>
