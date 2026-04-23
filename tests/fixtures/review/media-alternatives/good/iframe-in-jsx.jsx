// Real JSX iframe pointed at a YouTube embed — finder SHOULD emit
// review candidates here. Iframes pointed at non-video hosts (docs
// CMS, payment widgets, maps) do NOT emit candidates; the iframe
// allowlist gate is shared with `media/video-captions-missing` and
// documented in `src/utils/video-embed-hosts.ts`.
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
