// Sanitized from Bootstrap's docs site helpers/ratio.mdx, which ships an
// Astro/Starlight `<Example>` component that receives a *template literal*
// carrying HTML-shaped text as a JSX attribute value. In the upstream file
// this reads:
//
//   <Example code={`<div class="ratio ratio-16x9">
//       <iframe src="…" title="YouTube video" allowfullscreen></iframe>
//     </div>`} />
//
// The TSX parser currently enters JSX mode on the `<div>`/`<iframe>` tokens
// inside the template literal, reports "Unclosed JSX element <iframe>" or
// similar, and drops the whole file to partial-parse. Downstream rules then
// never fire against the file.
//
// The fix direction is captured in the Q-SHARED-TSX-PARSER-FALSE-JSX-CONTEXTS
// backlog item: while tokenizing a template literal that is the body of a JSX
// attribute expression, treat the template-literal contents as opaque string
// data and never promote `<identifier` to a JSX open-tag.

// biome-ignore lint/correctness/noUnusedVariables: fixture source under static analysis — never rendered.
function Example(_props: { readonly code: string }) {
  return null;
}

// biome-ignore lint/correctness/noUnusedVariables: fixture source under static analysis — never rendered.
function Page() {
  return (
    <Example
      code={`<div class="ratio ratio-16x9">
    <iframe src="https://example.test/embed" title="Sample video" allowfullscreen></iframe>
  </div>`}
    />
  );
}
