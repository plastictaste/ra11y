# 50p-vanilla-doctype

Guards the fix for the over-permissive fragment heuristic in
`src/rules/semantics/landmark-main.ts` (`looksLikeFullPage`).

**Failure mode.** A 52-file field-test pass against a vanilla-JS
mini-projects corpus produced only 1
`semantics/landmark-main` finding despite the majority of files having full
DOCTYPE+html+head+body structure and no `<main>` landmark. Root cause:
`looksLikeFullPage()` requires a `header`/`nav`/`footer`/`aside` element
before it will flag a missing `<main>`. Minimal widget pages have none of
those — the heuristic silently passes them.

**Shapes covered.**

| File | landmark-main bug | heading-hierarchy |
|---|---|---|
| `counter.html` | missing `<main>`, no header/nav/footer | clean headings |
| `progress-steps.html` | missing `<main>`, no header/nav/footer | h1 → h3 skip |
| `hidden-search.html` | missing `<main>`, no header/nav/footer | no h1 (first is h3) |
| `faq-accordion.html` | missing `<main>`, no header/nav/footer | h2 → h4 skip |

**Lock-in assertion.** `violation-present { ruleId: "semantics/landmark-main" }`
was RED on the capturing commit and is GREEN after the fix tightens
`looksLikeFullPage` to recognise full-page shape from either (B) an `<h1>`
plus ≥5 body descendants or (C) any heading + list (`ul`/`ol`/`dl`) + at
least one interactive element. The original landmark-presence branch (A)
still applies for pages that already declare `<header>`/`<nav>`/`<footer>`/`<aside>`.

**Sanitization.** Class names, button labels, and content are replaced with
neutral placeholders. No brand names or project-specific identifiers remain.
CSS and JS files referenced by `<link>` / `<script>` are intentionally absent
— the scanner does not require them to parse the HTML.
