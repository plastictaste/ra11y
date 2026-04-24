# empty-shell-page

Guards the fix for the silent-pass on empty-structural-shell HTML pages
in `src/rules/semantics/landmark-main.ts` and
`src/rules/semantics/heading-hierarchy.ts`.

**Failure mode.** Pages that have a `<body>` with non-trivial visible
content (≥3 element descendants) but **zero** `<h1>`-`<h6>` headings AND
**zero** landmark elements (`header`/`nav`/`footer`/`aside`/`main`)
silently pass both rules. The empty body is structurally a *stronger*
1.3.1 signal than a page with the wrong heading level — there is
nothing programmatically determinable about page structure at all — but
the existing `looksLikeFullPage` predicate requires a heading or
landmark to be present in one of its branches (A, B, C, D), so a page
shaped like `<body><div>…</div><div>…</div><div>…</div></body>` clears
none of them.

**Shapes covered.**

| File | landmark-main | heading-hierarchy |
|---|---|---|
| `clock.html` | missing `<main>`, no header/nav/footer | no h1, no headings at all |
| `loader.html` | missing `<main>`, no script even | no h1, no headings at all |
| `gallery.html` | missing `<main>`, just an image grid | no h1, no headings at all |

`clock.html` mirrors a theme-clock-style demo: a button toggle plus a
clock widget made of nested `<div>` needles, no heading copy, no
landmark structure. `loader.html` mirrors a kinetic-loader-style demo:
no script, no headings, just decorative animation divs. `gallery.html`
mirrors a random-image-generator-style demo: image tiles with no
surrounding structure.

**Lock-in assertion.** Both
`semantics/landmark-main` and `semantics/heading-hierarchy` must fire
on each file (anchored at the `<body>` tag) once `looksLikeFullPage`
adds a content-only branch — body has ≥3 visible (non-script,
non-style) descendants but no headings AND no landmarks.

**Sanitization.** Class names, IDs, and image filenames are placeholders.
The DOCTYPE / `<head>` shape mirrors the original projects so the parse
path matches what the scanner sees in the wild. Linked CSS / JS files
are intentionally absent — the scanner does not require them to parse
the HTML.
