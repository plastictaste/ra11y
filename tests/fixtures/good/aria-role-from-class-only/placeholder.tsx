// Good: admonition class is paired with role="alert" AND a "Warning:"
// textual prefix, so screen reader users receive the severity signal
// programmatically (via role) and in the accessible name (via prefix).
// Either mechanism on its own would suffice; showing both here makes
// the passing case unambiguous.

export function Example() {
  return (
    <div className="note warning" role="alert">
      <strong>Warning:</strong> Don't forget to run bundle install.
    </div>
  );
}
