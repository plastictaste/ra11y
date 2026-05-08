# Sample tutorial

A short tutorial-style README. The first prose blocks below contain
a stray `<div>` block whose closing tag is malformed; that bails the
HTML parser early when the file is routed through the markdown-html
fallback. Lines past the bail boundary are pure markdown prose, but
they keep mentioning HTML element names (`<html>`, `<head>`,
`<title>`, `<body>`) because the tutorial is _about_ HTML.

<div class="callout">
  <p>Welcome to the lesson</p>
</p>

## What an HTML document looks like

Every HTML document begins with a `<!DOCTYPE html>` declaration and
a root `<html>` element. Inside the root sit two children: `<head>`
(metadata) and `<body>` (rendered content). The `<head>` typically
carries a `<title>` element and a `<meta charset="utf-8">` element.

Even though those tag names appear in this prose, the surrounding
file is **not** an HTML document. The markdown source is being
parsed via the html-residue fallback, the parser bailed at the
malformed `</p>` above, and every line below is text content the
real HTML parser never saw.

## Why this matters

A document-shaped rule (page-titled, lang-attribute,
charset-first-1024-bytes, landmark-main) must not claim that a
markdown source "is missing a `<title>` element" — there is no
document envelope to be missing pieces of. The honest reading is
either to skip emission entirely on this substrate, or to route
the candidate to the review-candidate channel at info severity so
the agent's attention budget is not spent triaging a contradiction
between the rule's reason text (which cites an `<html>` tag in
prose) and the actual file class (markdown-html-residue, parser
bailed at line 13).

## Headings, lists, and code

This section adds enough markdown body that the file's total line
count comfortably exceeds the parsed-through line. The fixture is
asserting on the file's _post-bail_ behavior, so we need at least a
few hundred bytes of unparsed text below the failed boundary.

- A list item naming `<header>` and `<footer>`.
- Another item naming `<nav>` and `<main>`.
- A final item that mentions `<title>HTML cheat sheet</title>`.

```html
<!-- Even fenced code that LOOKS like an HTML document is still
     markdown-residue, not parsed structure. The rule must not
     latch onto these tag tokens as evidence of a real envelope. -->
<html>
  <head><title>Example</title></head>
  <body><h1>Hi</h1></body>
</html>
```

## Wrap up

The whole point of `parseModeByExtension['.md'] ===
'markdown-html-residue'` is to tell rules that the AST they receive
is residue from a parser-fallback, not authored HTML. Document-shaped
rules must downgrade their evidence model accordingly — silence the
emission or move it to a review candidate. Anything stronger than
info severity on this file is a per-finding contradiction with the
file's classification.
