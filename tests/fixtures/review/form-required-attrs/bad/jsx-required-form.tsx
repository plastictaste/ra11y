// A registration form with required and pattern constraints in JSX.
// The finder surfaces each constrained field so a reviewer verifies
// that error descriptions are programmatically associated.

export function RegistrationForm() {
  return (
    <form>
      <label htmlFor="username">Username</label>
      <input type="text" id="username" required minLength={3} />

      <label htmlFor="email">Email address</label>
      <input type="email" id="email" required />

      <label htmlFor="postal">Postal code</label>
      <input type="text" id="postal" pattern="[A-Z0-9 ]{5,8}" />

      <button type="submit">Register</button>
    </form>
  );
}
