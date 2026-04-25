// Bad: anchors that announce as buttons but are not keyboard-reachable.
// Both shapes promise button semantics (role attribute or btn class) yet
// have no href and no tabIndex — keyboard users cannot reach or activate
// them. Sighted mouse users see and use them normally, so the bug is
// silent in non-keyboard testing.

export function Example() {
  return (
    <nav>
      <a role="button" onClick={() => { /* opens dialog */ }}>
        Open dialog
      </a>
      <a className="btn btn-primary" onClick={() => { /* saves */ }}>
        Save changes
      </a>
    </nav>
  );
}
