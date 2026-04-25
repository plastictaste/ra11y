// Good: the visually-disabled card carries aria-disabled="true" plus
// role="button" + tabIndex={-1} so the accessibility tree exposes the
// disabled-control state, matching what sighted users see.

export function ComingSoonCard() {
  return (
    <div className="card disabled" aria-disabled="true" role="button" tabIndex={-1}>
      Coming soon
    </div>
  );
}
