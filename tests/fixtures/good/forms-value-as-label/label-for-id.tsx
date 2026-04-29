// Good: compliant forms/value-as-label scenario.
//
// The <input> carries an associated <label htmlFor> — the accessible
// name is established through the spec-compliant channel. The value
// attribute is absent (or, for an edit form, would carry a real
// pre-filled default while the label still announces the field).
// Either way, the rule does not fire.

export function SignUp() {
  return (
    <form>
      <label htmlFor="username">Username</label>
      <input id="username" type="text" />
      <button type="submit">Sign up</button>
    </form>
  );
}
