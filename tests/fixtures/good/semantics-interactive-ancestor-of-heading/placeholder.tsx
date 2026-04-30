// Good: heading wraps the link (idiomatic shape) — heading appears in
// the heading-navigation list and the link retains its own role.
//
// Plus a button wrapping non-heading content (no violation) and a
// stand-alone heading next to a "Read more" link (no nesting at all).
//
// semantics/interactive-ancestor-of-heading should NOT fire.

export function Example() {
  return (
    <article>
      {/* Heading wraps the link — the inverse of the card-link anti-pattern. */}
      <h2>
        <a href="/post">Post Title</a>
      </h2>

      {/* Button wraps a span — no heading involved, no violation. */}
      <button type="button">
        <span>Toggle section</span>
      </button>

      {/* Heading is a sibling of the link, not a descendant. */}
      <section>
        <h3>Latest update</h3>
        <p>Summary copy here.</p>
        <a href="/update">Read more</a>
      </section>
    </article>
  );
}
