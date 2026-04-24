// Good: compliant aria/redundant-role-on-host-element scenario.
// Implicit roles carry the semantics; no role attribute duplicates them.
// role="button" on <div> is correct ARIA augmentation, not redundancy.

export function Good() {
  return (
    <main>
      <nav aria-label="Primary">
        <a href="/docs">Docs</a>
      </nav>
      <button type="button">Save</button>
      <img src="hero.jpg" alt="Team photo" />
      <form action="/submit">
        <input type="text" />
      </form>
      <div role="button" tabIndex={0}>
        Custom button (correct ARIA augmentation on a non-host element)
      </div>
    </main>
  );
}
