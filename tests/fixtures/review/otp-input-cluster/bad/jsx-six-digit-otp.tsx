// JSX OTP cluster — six native <input> intrinsics under one parent.
// Per-input forms/labels-required would fire on each box; the cluster
// finder names the whole pattern once with the right group-fix shape.
export const OtpForm = () => (
  <form>
    <input type="number" maxLength={1} />
    <input type="number" maxLength={1} />
    <input type="number" maxLength={1} />
    <input type="number" maxLength={1} />
    <input type="number" maxLength={1} />
    <input type="number" maxLength={1} />
    <button type="submit">Verify</button>
  </form>
);
