// Login form with a password field — surfaces as a 3.3.8 review candidate.
const LoginForm = () => (
  <form>
    <label htmlFor="username">Username</label>
    <input type="text" id="username" name="username" autoComplete="username" />

    <label htmlFor="password">Password</label>
    <input type="password" id="password" name="password" />

    <button type="submit">Sign in</button>
  </form>
);
