// Bad: visual-disabled non-control — div carries the "disabled" class
// (a visual-disabled marker), but no aria-disabled and no interactive
// role. Sighted users see the greyed-out card; the accessibility tree
// receives no signal of the disabled state. WCAG 4.1.2 failure.

export function ComingSoonCard() {
  return <div className="card disabled">Coming soon</div>;
}
