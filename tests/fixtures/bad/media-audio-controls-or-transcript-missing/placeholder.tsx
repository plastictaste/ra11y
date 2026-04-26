// Bad: bare <audio> with no `controls` attribute, no `<track>` child,
// and no neighboring transcript anchor — failing all three predicates
// for WCAG 1.1.1 (Non-text Content) text-alternative coverage.

export function Example() {
  return (
    <div>
      <audio src="podcast.mp3" />
    </div>
  );
}
