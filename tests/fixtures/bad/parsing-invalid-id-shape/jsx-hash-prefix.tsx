// JSX sibling of the hash-prefix case — same author confusion at the
// literal level. Dynamic ids (`id={slug}`) are opaque to static analysis
// and stay silent; only string-literal values like this one get flagged.
export function Page() {
  return (
    <section id="#top">
      <h1>Page heading</h1>
    </section>
  );
}
