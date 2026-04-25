// Bad: handcrafted modal shell with every behavioural signal of a
// dialog (focus-trap tabindex="-1", aria-labelledby for the accessible
// name, aria-hidden for managed visibility, modal-class token) but
// missing role="dialog"/role="alertdialog" and aria-modal. AT will
// announce the container as a generic group rather than a dialog.
// aria/dialog-role-missing should fire exactly once.

export function Example() {
  return (
    <div
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
