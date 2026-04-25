// Good: same shell as the bad fixture but with role="dialog" plus
// aria-modal="true" — AT announces "Dialog: Confirm deletion" when
// focus enters the container, satisfying WCAG 4.1.2 (Name, Role, Value).
// Either role="dialog" or aria-modal alone would clear the rule; showing
// both makes the passing case unambiguous.

export function Example() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="modal-content"
      tabIndex="-1"
      aria-labelledby="dlg-title"
      aria-hidden="false"
    >
      <h2 id="dlg-title">Confirm deletion</h2>
      <p>This action cannot be undone.</p>
    </div>
  );
}
