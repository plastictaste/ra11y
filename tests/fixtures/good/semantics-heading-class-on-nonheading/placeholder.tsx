// Good: heading classes used either on real heading tags or paired with
// an explicit ARIA heading role — the heading relationship is
// programmatically exposed either way.
//
// Plus one negative-control element (<p className="lead">) to show that
// non-heading typography utilities are correctly left alone.
//
// semantics/heading-class-on-nonheading should NOT fire.

export function Example() {
  return (
    <section>
      {/* Heading tag with a heading class: legitimate visual override. */}
      <h1 className="display-4">Hero Title</h1>

      {/* Non-heading element that declares the heading role explicitly. */}
      <div className="h2" role="heading" aria-level="2">
        Section Title
      </div>

      {/* Pure typography utility: not a heading class. */}
      <p className="lead">
        This is a lead paragraph that styles text without claiming
        heading semantics.
      </p>
    </section>
  );
}
