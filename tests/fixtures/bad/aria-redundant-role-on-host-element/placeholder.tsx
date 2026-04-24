// Bad: failing aria/redundant-role-on-host-element scenario.
// Each element below re-declares the host's implicit ARIA role and
// should trigger one violation per element.

export function Bad() {
  return (
    <main role="main">
      <nav role="navigation">
        <a href="/docs" role="link">
          Docs
        </a>
      </nav>
      <button type="button" role="button">
        Save
      </button>
      <img src="hero.jpg" alt="Team photo" role="img" />
      <form action="/submit" role="form">
        <input type="text" />
      </form>
    </main>
  );
}
