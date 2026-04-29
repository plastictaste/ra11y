// Bad: failing forms/value-as-label scenario.
//
// The <input type="text"> uses the `value` attribute to carry what
// looks like a label ("Username"). To a sighted user on first paint
// the field appears labeled, but the moment focus arrives and they
// type, the apparent label disappears — it was input text all along.
// Screen readers do not announce the `value` as the field's name.
//
// Expected: forms/value-as-label fires once on the <input>. The fix
// is to promote the copy into a real <label> or aria-label and remove
// (or replace with `placeholder=`) the value attribute.

export function SignUp() {
  return (
    <form>
      <input type="text" value="Username" />
      <button type="submit">Sign up</button>
    </form>
  );
}
