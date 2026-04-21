// Bad: admonition-styled block with no role and no severity prefix.
// Sighted users see a coloured "warning" callout; screen reader users
// hear "Don't forget to run bundle install." with no severity framing.
// aria/role-from-class-only should fire exactly once.

export function Example() {
  return (
    <div className="note warning">Don't forget to run bundle install.</div>
  );
}
