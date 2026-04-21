// Placeholder-as-label antipattern in JSX. The <input> has a
// `placeholder` prop carrying label copy ("Your full name") but no
// wrapping <label>, no htmlFor association, no aria-label. Rule fires.
// The fix is usually to promote the placeholder copy to a <label>
// (and keep the placeholder only if it's a format hint distinct from
// the label).
export default function SignupForm(): JSX.Element {
  return (
    <form>
      <input type="text" placeholder="Your full name" />
      <input type="email" placeholder="name@example.com" />
      <button type="submit">Create account</button>
    </form>
  );
}
