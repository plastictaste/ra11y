// Bad: card-link anti-pattern. <a href> wraps an <h2>+<h3>; <button>
// wraps an <h3>. Each heading-inside-interactive pair is one violation.
//
// AT will announce "link" / "button" first and the heading semantics
// (the structural relationship 1.3.1 protects) collapse into the
// interactive role's accessible name.
//
// semantics/interactive-ancestor-of-heading SHOULD fire (3 violations).

export function Example() {
  return (
    <article>
      <a href="/post">
        <h2>Post Title</h2>
        <h3>By Author</h3>
      </a>

      <button type="button">
        <h3>Expand section</h3>
      </button>
    </article>
  );
}
