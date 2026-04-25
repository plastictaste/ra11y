// Good: custom JS-driven controls with the finding suppressed at source.
//
// The page wires up its own keyboard-accessible play/pause/mute UI, so
// the native controls bar is intentionally omitted. The author has
// verified the custom controls expose the required functionality and
// suppressed this rule with the source-level pragma.

export function GoodCustomControls() {
  return (
    <div>
      <CustomMediaPlayer />
      {/* ra11y-disable media/audio-video-no-controls */}
      <video src="/video/hero.mp4" id="hero" />
    </div>
  );
}

function CustomMediaPlayer(): null {
  return null;
}
