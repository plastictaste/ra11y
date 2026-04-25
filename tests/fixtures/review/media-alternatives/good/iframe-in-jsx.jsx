// JSX iframe pointed at a YouTube embed. The finder does NOT emit
// 1.2.1/1.2.3/1.2.5 review candidates for iframes, regardless of
// whether the `src` matches a video-host allowlist. The iframe URL
// could embed a player, a channel page, a non-video tutorial, or a
// decorative thumbnail — not deterministic evidence of prerecorded
// A/V. Per AI-first doctrine, `likelyIrrelevant` for these criteria
// must be provable from `<video>` / `<audio>` presence alone.
//
// Captions for iframe-embedded media (1.2.2) are still surfaced —
// the rule `media/video-captions-missing` fires a warning at the
// violations layer, separate from this finder.
export function Embed() {
  return (
    <div>
      <iframe
        src="https://www.youtube.com/embed/dQw4w9WgXcQ"
        title="Product demo"
      ></iframe>
    </div>
  );
}
