// Good: <audio> exposes a text alternative path. Either `controls`,
// a `<track>` child, or a clearly-labeled transcript anchor in the
// surrounding ring resolves the WCAG 1.1.1 surface signal.

export function Example() {
  return (
    <div>
      <audio src="podcast.mp3" controls />
      <a href="podcast-transcript.html">Read the transcript</a>
    </div>
  );
}
