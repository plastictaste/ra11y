# anchor-icon-prefix-with-text

**Guarded commit:** 5c681b66

## What this fixture guards

`navigation/link-descriptive-text` must NOT fire on the canonical
icon-prefix-with-label pattern: an `<a href>` whose first child is an
icon-font glyph (Font Awesome, Material Icons, Bootstrap Icons, etc.)
followed by a sibling text node carrying the link's accessible name.
This is the most common shape of a labeled icon-link in field code:

```html
<a href="/profile"><i class="fa fa-user"></i> User Profile</a>
```

The link has an accessible name (`User Profile`); the icon contributes
nothing presentationally and is correctly stripped by
`visibleTextExcludingPresentationalHtml`. Any future refactor that
narrows the visible-text computation to "every child is presentational"
without considering text-node siblings would silently regress this
pattern into a false-positive icon-only finding.

## Failure mode captured

A field report claimed the rule's "every child is presentational"
predicate misclassifies `<a><i class="<icon>"></i> User Profile</a>`
because the predicate walks element children only and misses sibling
text nodes. Live probe on current `src/` shows the predicate already
walks all child node kinds (HtmlText + HtmlElement) — the bug is
already fixed and the existing unit test at
`tests/unit/rules/navigation/link-descriptive-text.test.ts` ("icon sits
alongside descriptive text") encodes the invariant. This fixture pins
the same invariant against future regression at a layer (full scanner
pipeline, real-world harness) that survives refactors of the rule's
internal AST helpers.

## Sanitization

Source is a minimal HTML skeleton with five anchors covering the
icon-prefix-with-text pattern across detection axes (Font Awesome
class with and without `aria-hidden`, Material Symbols ligature span,
Bootstrap Icons, decorative `<svg aria-hidden>`). No brand names,
copy, or real URLs. Icon class tokens are stock identifiers from each
icon-font library's documentation.

## Pairs with

- `tests/fixtures/real-world/anchor-icon-only-name/` — sibling fixture
  guarding the *positive* invariant (anchor-level rule fires when no
  text accompanies the icon). This fixture guards the *negative*
  invariant (rule stays silent when text accompanies the icon).
