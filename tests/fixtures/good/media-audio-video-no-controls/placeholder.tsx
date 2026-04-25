// Good: media elements expose user controls.
//
// `controls` renders the native keyboard-operable UI (play/pause, mute,
// volume) and makes the element focusable. Either the bare attribute or
// any truthy expression is accepted.

export function GoodMediaWithControls() {
  return (
    <div>
      <audio controls src="/audio/narration.mp3" />
      <video controls src="/video/demo.mp4" />
      <video controls={true} src="/video/explainer.mp4" />
    </div>
  );
}
