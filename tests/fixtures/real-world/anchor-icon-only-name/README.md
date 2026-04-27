# anchor-icon-only-name

**Guarded commit:** 45525d85
**Backlog item:**

## What this fixture guards

`navigation/link-descriptive-text` fires at the `<a>` level when an anchor's only child is a presentational element: an `<img alt="">` (empty alt, decorative), an icon-font glyph with `aria-hidden="true"`, or an `<svg aria-hidden="true">`. All three patterns correctly produce anchor-level violations naming the presentational child as evidence.

The rule stays silent when a non-empty `alt` attribute provides the anchor's accessible name (WAI accname-1.1 step F) or when `aria-label` supplies an explicit name override.

## Failure mode captured

Field report: a deeper scan appeared to emit only `media/alt-text-missing` at the `<img>` level, with no secondary anchor-level finding. Live probe on current `src/` confirms anchor-level detection is working. This fixture locks that in: if a future refactor silences anchor-level detection and emits only the img-level violation, the `violation-present` + `reasonIncludes` assertions on the `no accessible name` message string will fail.

## Sanitization

Source is a minimal HTML skeleton with five isolated `<a>` elements, one per detection case. No brand names, copy, or real URLs. The Font Awesome class (`fa fa-shopping-cart`) and SVG path data are generic stand-ins.
