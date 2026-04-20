---
title: Fix-suggestion audit (v1.0 ship gate)
audience: maintainer
layer: rules
generated: 2026-04-19
---

# Fix-suggestion audit (v1.0 ship gate)

This is the v1.0 audit output for CLAUDE.md §3 invariant 5: every violation must
carry a context-aware fix suggestion, not a generic boilerplate string. The
benchmark from `docs/kb/patterns/writing-a-rule.md` §"Violation emission": the
suggestion should include a code snippet or imperative that references the
offending element's concrete state — `Add alt describing the chart's message
(e.g., alt="revenue chart 2026")`, not `add alt text`.

Each row reflects a read-only inspection of the rule file's `suggestion` /
`fixPaths.primary.label` builders as of the generated date above. Classification
uses three verdicts:

- **context-aware** — the builder inspects surrounding AST nodes or attribute
  values and inlines concrete tokens (filename, href, id, role, aria value,
  contrast ratio, computed size, sibling line number, …) into the fix text.
  Same rule firing on two different elements produces materially different
  suggestions.
- **generic** — the builder returns the same constant string across every
  occurrence, or only branches on the tag kind the user already sees. Tag-only
  templating counts as generic: "Remove tabindex from `<div>`" vs "Remove
  tabindex from `<a>`" carries no information the caller didn't already have.
- **caveat-only** — the rule emits an advisory note without a concrete
  remediation path. Used for guidance-class rules that cannot propose a fix
  from static evidence alone.

`generic` rows are the fix-suggestion debt v1.0 has to clear. Each one needs
its own `feat(rules): context-aware fix for <rule>` follow-up commit that
threads one or more of: surrounding-element inspection, cross-element
references (label-for, sibling markers, ancestor role), filename/href-derived
example text, or the adjacent signal the rule is already reading to decide the
violation fires.

## Per-rule verdicts

| Rule ID | Fix class | Verdict | Context inputs | Notes |
|---|---|---|---|---|
| aria/conflicting-role | verify-in-source | context-aware | tagName, implicit role, explicit role | `remediationSuggestion` branches on button/link swap, landmark swap, heading/list/table mismatch; inlines a landmark-specific correct tag when applicable. |
| aria/hidden-focus | verify-in-source | context-aware | tagName, direct-vs-descendant path, child tag, edit-safety | `buildDirect/DescendantViolation` choose distinct `fixPaths` per variant; anchor-vs-input-vs-other branch for the non-focusable-swap alternative. |
| aria/invalid-role | mechanical | context-aware | offending role token, edit-distance suggestion | Emits `Did you mean role="X"?` with a Levenshtein-2 match when one exists; names the invalid token. |
| aria/live-region-valid | mechanical | context-aware | raw attribute value, tag, role, explicit-vs-implicit politeness | Five violation builders; each inlines the offending token and tailors advice per role-conflict combination. |
| aria/required-attrs | mechanical | context-aware | role, first missing attribute | `buildSuggestion` branches on aria-checked / aria-selected / aria-expanded / aria-valuenow with attribute-specific guidance. |
| aria/valid-attr | mechanical | context-aware | offending aria-* name, edit-distance suggestion | Emits `Did you mean aria-X?` when a Levenshtein-2 match exists; references the actual attribute name. |
| contrast/enhanced | guidance | context-aware | foreground source, background source, measured ratio, required minimum, large-text flag | Shared `buildContrastSuggestion` inlines both color tokens, the current ratio, the gap, and a rough darken-percentage. |
| contrast/minimum | guidance | context-aware | foreground source, background source, measured ratio, required minimum, large-text flag | Same `buildContrastSuggestion` helper as `contrast/enhanced`. |
| contrast/non-text | guidance | context-aware | CSS property, fg source, bg source, measured ratio | `buildSuggestion(prop, fgSource, bgSource, ratio)` — per-property boundary advice with the failing pair inlined. |
| document/iframe-title | mechanical | context-aware | `src` attribute | `describeSource` derives a human subject from the URL path and inlines it as an example `title` value. |
| document/lang-attribute | mechanical | context-aware | `<meta http-equiv="Content-Language">`, `<meta name="language">`, `<meta charset>` legacy encoding | Four-step ladder inlines an authoritative lang value from http-equiv, falls back to the non-standard name="language" meta, then to a legacy-charset region hint (shift_jis → ja, gb2312 → zh-Hans, …). Generic fallthrough still names four concrete BCP 47 examples. Resolved by 746ecee. |
| document/lang-on-parts | mechanical | context-aware | attribute name, raw value, issue kind, canonical rewrite | Per-kind builders; underscore/uppercase branches compute the exact corrected value and inline it. |
| document/meta-refresh | guidance | context-aware | target URL, delay seconds | Branches on zero-delay vs delayed redirect, inlines the target URL into the suggested replacement link. |
| document/page-titled | mechanical | context-aware | first non-empty `<h1>` text + line, first `<meta name="description">` content + line | Shared `buildSuggestion` ladder: h1-text branch inlines the heading string as the candidate `<title>` (mentioning meta description as a fallback when both exist); meta-description branch truncates the description to ~60 chars at a word boundary and strips trailing punctuation; fallback names the ≤60 char length budget and the "differs from sibling pages" constraint. Resolved by 1a639b3. |
| document/viewport-zoom | mechanical | context-aware | offending viewport directive, raw value | Inlines the offending directive name and value, with WCAG-specific threshold guidance per problem. |
| focus/not-obscured | guidance | context-aware | selector, declared height | `buildSuggestion` inlines the anchor selector and the candidate `scroll-padding-*` value derived from the declared height. |
| focus/outline-visible | guidance | context-aware | selector, scoped-vs-bare, Tailwind utility cross-reference | Inlines the selector in the remediation; appends a pragma-silencing note when the selector is class-scoped. |
| focus/tabindex-positive | mechanical | context-aware | tagName, raw tabindex value, native-focusability, explicit role, contenteditable host | `buildSuggestion` inlines `tabindex="N"` + tag and branches three ways: natively-focusable (`<button>`, `<a>`, `<input>`, …) recommends removal + native tab order; contenteditable host recommends removal + explains implicit tab-order participation; non-focusable tag recommends `tabindex="0"` plus `role="button"` (or keeps the declared role) and Enter/Space keydown handler. |
| forms/autocomplete-missing | mechanical | context-aware | inferred autocomplete token | `Add autocomplete="${expected}"` — the expected token is derived from `type` / `name` / `id` heuristics. |
| forms/fieldset-legend | guidance | context-aware | fieldset subject (id/name), reason kind | Subject describes the actual `<fieldset>` by id or name; reason-kind branch picks empty-vs-missing advice. |
| forms/label-for-id-mismatch | mechanical | context-aware | `for` target, nearest existing id (Levenshtein-2), wraps-control flag | Emits `Did you mean id="X"?` when a typo-range match exists; appends a note when the label also wraps the control. |
| forms/labels-required | verify-in-source | context-aware | tagName, type, id, spread-props flag | Non-primitive path inlines tag + type + id; primitive-props branch suggests a pragma scoped to the rule. |
| forms/non-empty-label | guidance | context-aware | `for` / `htmlFor` target, cross-file control (tag, type, name, placeholder, line), JSX-primitive flag | Four-branch ladder: (A) no `for` / `htmlFor` → dialect-aware generic advice; (B1) matching control + derivable hint → inlines `for="id"` (or `htmlFor="id"`), `<tag type="…">` descriptor, control line number, and a candidate derived from `type` (email → "Email address", tel → "Phone number", …), `placeholder` (verbatim), or `name` (humanized: `firstName` → "First name"); (B2) matching control with no hint → short-noun fallback naming the missing signals; (C) unmatched id → flags the missing control and suggests typo/cross-file verification. JSX-primitive ({...spread}) branch stays info-severity pragma guidance. Resolved by commit pending. |
| forms/required-indicator-missing | verify-in-source | context-aware | wrapper component name, forwarded native tag | `buildSuggestion` inlines the component name and the native tag it forwards to; proposes concrete `aria-required` + indicator pair. |
| keyboard/accesskey-duplicate | verify-in-source | context-aware | token, first binding's tag/line/column | Names the colliding access-key, points at the earlier binding by file coordinates, flags the case-insensitive comparison. |
| keyboard/character-shortcuts | guidance | context-aware | first flagged key, event target, event name | Inlines the flagged key into a proposed `event.ctrlKey && event.key === "…"` guard and names the listener's target. |
| keyboard/handler-missing | guidance | context-aware | tagName, role | Role-branch inlines the actual role into the `onKeyDown` Enter/Space guidance; no-role branch recommends `<button>` by name. |
| layout/orientation-lock | guidance | context-aware | orientation, selector, declaration text, lock kind (hidden vs rotated) | Builder inlines the offending selector, the declaration, and the orientation axis; branches on hidden vs rotated. |
| layout/reflow-hardcoded-width | guidance | context-aware | property name, declared value | Inlines the offending property, value, and the reflow-threshold media-query breakpoint into the suggested rewrite. |
| layout/text-spacing | guidance | context-aware | CSS property name | Inlines the offending property into `Remove !important from '${property}'`; names specificity as the alternative lever. |
| media/alt-text-missing | mechanical | context-aware | tagName, `src` filename, derived subject | `buildSuggestion` inlines a humanized filename as the example alt text (`alt="revenue chart 2026"`). |
| media/autoplay-sound | guidance | context-aware | tag kind (audio vs video) | Two tag-specific suggestions with genuinely different advice: audio gets controls-or-muted guidance, video gets the `autoplay muted loop` pattern. |
| media/video-captions-missing | guidance | context-aware | video src basename, first `<source>` src fallback, document `<html lang>`, derived VTT filename + language label | `buildSuggestion` ladder: video `src` → strip directory + swap extension into a concrete `src="<stem>.vtt"`; no `src` → fall back to first `<source>` child's basename; neither → `captions.vtt` with child-of-`<video>` phrasing. Inlines the nearest `<html lang="…">` (HTML doc root, or JSX root-layout shape) as `srclang`; defaults to `en` when absent. Humanizes common primary subtags into a `label="English captions"` style hint, and always names the captions-vs-subtitles distinction so the agent picks the right `kind`. |
| motion/pause-stop-hide | guidance | context-aware | selector, animation property | Inlines the selector and property into a ready-to-copy `@media (prefers-reduced-motion: reduce)` override. |
| navigation/link-descriptive-text | guidance | context-aware | href, generic-phrase token, derived destination hint | Inlines the offending phrase and a URL-derived destination candidate into the replacement suggestion. |
| navigation/link-no-href | mechanical | context-aware | onClick expression text, intent probe | `describeJsxExpressionIntent` classifies the handler body as navigation (navigate/router/history/redirect/location/`.push(`/`.replace(`), mutation (React setter `set[A-Z]…(`, or camelCase verb-prefix `toggleMenu`/`openDialog`/…), or unknown. Navigation branch proposes `<a href="...">` + `preventDefault()` interception pattern; mutation branch proposes `<button type="button">`; unknown branch asks the agent to decide. Probe is text-level — no cross-file resolution, no type checking; weak-evidence cases honestly return unknown. Resolved by commit pending. |
| navigation/skip-link | mechanical | context-aware | targetId branch | Missing-id branch inlines the expected `id="${targetId}"` value from the skip-link href. Missing-link and wrong-first-link branches are constants but coexist with a context-aware third branch. |
| parsing/duplicate-id | mechanical | context-aware | duplicated id value, first occurrence's tag+line, current tag+line, next free numeric suffix (document-aware) | `proposeUniqueId` pre-scans the document for all ids and computes the next free numeric suffix; inlines the duplicated id, both binding sites (tag + line), and the concrete rename candidate. Ids already ending in digits strip the trailing run before incrementing (`section2` → `section3`, not `section22`). Names aria-labelledby / aria-describedby / aria-controls / label[for] / `href="#id"` as the reference hooks that silently resolve to the first match. |
| parsing/html-has-lang | mechanical | context-aware | tagName, raw value, trimmed vs raw, underscore-vs-hyphen, guessed BCP 47 code | `buildInvalidSuggestion` computes a concrete rewrite per issue shape (dashed form, BCP-47 guess from full-word name). |
| pointer/cancellation | guidance | context-aware | tagName, list of down-events | Maps each down-event to its correct up-event (`onMouseDown` → `onMouseUp`, `onTouchStart` → `onTouchEnd`). |
| pointer/drag-alternative | guidance | context-aware | tagName, drag-signal tokens, imported library name | Element-level builder names the tag and the exact drag-signal that fired; file-level builder cites the imported library. |
| pointer/target-size | guidance | context-aware | selector/tag, declared width/height, padding, measured size text | Computes the exact pixel delta and proposes concrete `width: 24px` / `height: 24px` / `padding` deltas to reach the 24×24 floor. |
| semantics/button-name | guidance | context-aware | host subject (button / a / input type=… / div role="button" / …), icon-child shell (svg-no-title / img-with-src / img-without-src / empty), filename-derived subject for `<img>` and `<input type="image">` src | `buildIconAwareSuggestion` branches on what the unnamed control is actually wrapping: SVG-icon branch names the `<svg><title>…</title></svg>` fix alongside `aria-label`; `<img>`-icon branch inlines a Title-Cased subject derived from the src filename (`icons/trash-bin.png` → `Trash Bin`) and proposes both `alt="Trash Bin"` on the image and `aria-label="Trash Bin"` on the host; `<input type="image">` branch never says "wraps an <img>" (it IS the image) and cites HTML §4.10.5.1.18 that value is not a name source; empty `<input type="submit/button/reset">` branch proposes `value="…"` or `aria-label="…"` (no nested children); empty `<button>` / `<a>` / `[role="button"]` fallback keeps the visible-text example anchored on the actual host tag. Resolved by commit cf53e34. |
| semantics/empty-heading | verify-in-source | context-aware | tagName, document heading outline, nearest preceding heading's tag/level/text/line | `buildEmptyHeadingSuggestion` walks the document once, collects every heading in source order, and picks the nearest preceding non-empty heading for the fix builder. Four-branch ladder: preceding heading one level higher → names it as the parent section and asks for a continuation title ("continues the Contact Information hierarchy"); preceding heading at the same level → sibling branch, suggests the next section's title or removal; preceding heading at any other level → flags the hierarchy break and cross-references `semantics/heading-hierarchy`; no preceding heading → top-of-document fallback naming the screen-reader navigation gap plus the styled-`<p>`/`<div>` option. Long preceding-heading text is truncated to ~80 chars with an ellipsis so the suggestion stays readable. Resolved by commit b374e12. |
| semantics/heading-hierarchy | guidance | context-aware | previous level, current level | Inlines the exact `h${previous+1}` the heading should become, plus the gap width. |
| semantics/label-in-name | guidance | context-aware | visible text, aria-label, interleaved-expansion detection, case-mismatch words | Ranked `fixPaths`; optional `editCandidate` when visible-text tokens are non-contiguous in the aria-label. |
| semantics/landmark-main | guidance | context-aware | tag, id, class, role, line, all-role-only flag | `buildMultipleMainSuggestion` ladder: all-`role="main"` branch inlines every binding's line and targets the attribute; `<main>` branch inlines each landmark's tag + `id=` / `class=` (+ role when role-bearing) and line for pairwise disambiguation; identity-free fallback degrades to line-only. Missing-`<main>` branch names the wrap target (primary article/content) and explicitly excludes `<header>` / `<nav>` / `<footer>`. Resolved by commit pending. |
| semantics/list-structure | guidance | context-aware | parent tag, child tag, primitive-vs-wrong-child flag | Stray-li and primitive branches are tag-templated; wrong-child branch inlines both parent and child tags into the fix. |
| semantics/nested-interactive | verify-in-source | context-aware | outer descriptor, inner descriptor, outer-open line number | `describeHtml` / `describeJsx` compose tag + identifying attrs into the descriptors; suggestion inlines both. |
| semantics/table-headers | guidance | context-aware | first-row `<td>` text content, first-column `<td>` text content, header-shape heuristic (short, title-cased, non-numeric), up to 5 inlined candidate strings | `buildSuggestionFromDetection` walks the first `<tr>` (or first-column cell per row) of the offending `<table>`, runs `looksHeaderShaped` (≤40 chars, starts-upper, not numeric/currency), and picks one of four branches: (1) first row + first column both header-shaped → inlines both candidate lists and mentions `<th scope="col">`, `<th scope="row">`, plus `<th scope="colgroup">` for complex tables; (2) first row only → inlines detected column headers (e.g. `Name`, `Email`, `Role`, `Last Login`) and recommends `<th scope="col">`; (3) first column only → inlines detected row labels and recommends `<th scope="row">`; (4) no header-shape signal → fallback naming both scopes and the `role="presentation"` layout-table escape. Nested tables are skipped at the traversal boundary so each table is judged on its own cells. Resolved by commit pending. |
| tooltip/dismissable | guidance | context-aware | tagName, offending title text (truncated) | Inlines the title text into the proposed `aria-label="${title}"` replacement and the visible-label alternative. |
| wrapper/drift | verify-in-source | context-aware | wrapper name, declared element, actual rendered element, definition file path | Proposes two concrete fixes and names the `ra11y.config.ts` entry to change, inlining the path the agent should read. |

## Summary

Verdict distribution:

- context-aware: 52
- generic: 0
- caveat-only: 0

Rules flagged `generic` (need per-rule `feat(rules): context-aware fix for <rule>` follow-up commits before v1.0):

_(none — v1.0 fix-suggestion debt cleared)_

Resolved since publication (flipped to `context-aware`):

- `focus/tabindex-positive` — V1-FIX-TABINDEX-POSITIVE.
- `document/lang-attribute` — V1-FIX-DOC-LANG (commit 746ecee).
- `parsing/duplicate-id` — V1-FIX-DUPLICATE-ID (commit pending).
- `document/page-titled` — V1-FIX-DOC-TITLE (commit 1a639b3).
- `media/video-captions-missing` — V1-FIX-VIDEO-CAPTIONS (commit pending).
- `forms/non-empty-label` — V1-FIX-NON-EMPTY-LABEL (commit pending).
- `semantics/button-name` — V1-FIX-BUTTON-NAME (commit cf53e34).
- `semantics/landmark-main` — V1-FIX-LANDMARK-MAIN (commit 06035ee).
- `semantics/empty-heading` — V1-FIX-EMPTY-HEADING (commit b374e12).
- `navigation/link-no-href` — V1-FIX-LINK-NO-HREF (commit pending).
- `semantics/table-headers` — V1-FIX-TABLE-HEADERS (commit pending).

No rows flagged `needs-review` — every rule's fix builder read cleanly under
inspection. No runtime bugs (ReferenceErrors, unsafe expressions) were spotted
during the audit.

## Follow-up guidance (for the per-rule tightening commits)

Suggested context inputs by rule — these are read-only recommendations, not
commitments; the implementer reads the rule file and decides:

- `forms/non-empty-label`: when the label has a `for` / `htmlFor` target,
  inline the referenced control's tag and id in the suggestion
  (`the control at id="email"`).
- `navigation/link-no-href`: inspect the onClick body — if it's navigation,
  recommend `href={route}`; if it's a mutation, recommend `<button>` and
  name the handler's identifier.
- `semantics/table-headers`: inspect the first row — if it contains `<td>`
  elements whose text looks header-shaped (short, title-case), suggest
  converting those specific cells to `<th scope="col">`.

The v1.0 acceptance gate is zero `generic` rows in this table. Each
follow-up commit MUST re-run this audit (manually for the row under change)
and update the verdict cell.
