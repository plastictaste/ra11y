// Bad: non-heading elements wearing Bootstrap heading classes.
// All three of these LOOK like headings visually but carry no heading
// role — screen-reader H-key navigation skips them entirely, and the
// page's heading outline is silently incomplete.
//
// semantics/heading-class-on-nonheading should fire three times.

export function Example() {
  return (
    <section>
      <div className="h1">Main Page Title</div>
      <p className="display-4">Marketing Headline</p>
      <span className="h3">Section Subtitle</span>
    </section>
  );
}
