// Good: anchors that announce as buttons are keyboard-reachable.
// Each shape has a focus pathway: real href, explicit tabIndex={0}, or a
// plain <a class="link"> that does not promise button semantics.

export function Example() {
  return (
    <nav>
      <a className="btn btn-primary" href="/orders">
        View orders
      </a>
      <a role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") { /* … */ } }}>
        Toggle panel
      </a>
      <a className="link" href="/help">
        Help
      </a>
    </nav>
  );
}
