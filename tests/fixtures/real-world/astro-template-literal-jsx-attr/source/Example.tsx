// Sanitized from Bootstrap's docs site helpers/ratio.mdx and
// components/dropdowns.mdx, which ship an Astro/Starlight `<Example>`
// component that receives a *template literal* carrying HTML-shaped
// text as a JSX attribute value. In the upstream file this reads:
//
//   <Example code={`<div class="ratio ratio-16x9">
//       <iframe src="…" title="YouTube video" allowfullscreen></iframe>
//     </div>`} />
//
// The TSX parser's JSX attribute expression consumer (`#skipBraceBlock`)
// walks character-by-character counting braces and does NOT recognize
// string-literal, template-literal, or comment spans. Template literals
// that embed `}` in their textual content (inline JS object literals,
// CSS rule bodies with unbalanced braces under conditional stripping,
// JSX-shaped snippets that would render `</span>` verbatim, etc.) close
// the JSX attribute expression early. The parser returns to JSX-child
// mode positioned in what WAS template-literal content, finds an orphan
// `</div>` or bare `<span>`, and reports "Unclosed JSX element
// <Example>" (or <iframe>/<body>/<span> on the upstream source). The
// whole file drops to partial-parse; downstream rules never fire.
//
// The fix direction is captured in the Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS
// backlog item: while tokenizing a JSX attribute expression body, skip
// over string literals, template literals, and comments exactly like
// the top-level scanner does. Braces that live inside those spans do
// not affect depth.

// biome-ignore lint/correctness/noUnusedVariables: fixture source under static analysis — never rendered.
function Example(_props: { readonly code: string }) {
  return null;
}

// biome-ignore lint/correctness/noUnusedVariables: fixture source under static analysis — never rendered.
function Page() {
  // The template literal contains an HTML snippet with a `}` character
  // mid-content (here: a JS fragment that ends an inline function body).
  // This is the minimal shape that reproduces the JSX-attribute-expression
  // early-close: `#skipBraceBlock` sees `{` of `code={`, increments depth
  // to 1, walks through the backtick-opened template literal, hits the
  // literal `}` in the JS snippet, decrements to 0, and returns —
  // leaving the parser positioned inside what was template content.
  return (
    <Example
      code={`<button onclick="window.close()}" type="button">Close dialog</button>`}
    />
  );
}
