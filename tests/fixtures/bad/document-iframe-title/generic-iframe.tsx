export function EmbeddedMap() {
  // Title names the embed type, not its contents — screen-reader users
  // hear "iframe" with no hint of what the frame actually shows.
  return <iframe src="/map" title="iframe" width={600} height={400} />;
}
