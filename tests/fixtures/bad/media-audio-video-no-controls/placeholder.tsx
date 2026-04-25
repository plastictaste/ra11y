// Bad: media elements with no `controls` attribute.
//
// Without `controls`, the browser renders no UI — the element is not
// focusable, keyboard users cannot pause/mute the audio, and any sound
// it plays cannot be stopped from the keyboard. Each element below
// triggers one violation of media/audio-video-no-controls.

export function BadMediaNoControls() {
  return (
    <div>
      <audio src="/audio/bgm.mp3" />
      <video src="/video/demo.mp4" />
      <video autoPlay muted loop src="/video/hero.mp4" />
    </div>
  );
}
