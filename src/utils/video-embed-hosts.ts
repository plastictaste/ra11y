/**
 * Shared video-host allowlist for `<iframe>` embeds that definitionally
 * carry video content. Consumed by:
 *
 *   - `src/rules/media/video-captions-missing.ts` — promotes an iframe
 *     pointed at one of these hosts to a captions-required violation
 *     (wcag22:1.2.2).
 *   - `src/review/finders/media-alternatives.ts` — gates iframe-as-media
 *     review candidate emission on the same allowlist, so bare iframes
 *     pointed at non-video hosts (docs CMS embeds, payment widgets, map
 *     embeds) don't promote wcag22:1.2.1 / 1.2.3 / 1.2.5 out of the
 *     `likelyIrrelevant` bucket on projects with no `<video>`/`<audio>`.
 *
 * The allowlist is conservative: only hosts whose primary surface is a
 * video embed are included. URL shape at these hosts unambiguously
 * identifies media — e.g. `youtube.com/embed/<id>`,
 * `player.vimeo.com/video/<id>`. Hosts whose iframes are typically
 * non-media (generic CMS iframes, checkout widgets, Google Maps) are
 * deliberately excluded — they would surface captions warnings and
 * media-alternative review on non-media content.
 *
 * Per AI-first doctrine (`docs/kb/architecture/ai-first-consumer.md`),
 * the `likelyIrrelevant` label is one of the few buckets that must be
 * provable from the code. Gating iframe-as-media on this allowlist
 * keeps the bucket honest: a bare `<iframe src="https://example.com/…">`
 * is not evidence of media presence.
 */

/**
 * Platform identifier (human-facing name used in violation/review text)
 * keyed off the hostname set the platform serves embeds from. Consumers
 * read `name` for the platform label and `captionHint` for
 * platform-specific caption-enablement guidance.
 */
export interface MediaEmbedPlatform {
  readonly name: string;
  readonly hosts: readonly string[];
  readonly captionHint: string;
}

export const MEDIA_EMBED_PLATFORMS: readonly MediaEmbedPlatform[] = [
  {
    name: "YouTube",
    hosts: [
      "youtube.com",
      "www.youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ],
    captionHint:
      "YouTube: captions are authored in YouTube Studio; append `cc_load_policy=1` to the embed URL to force the caption track on by default",
  },
  {
    name: "Vimeo",
    hosts: ["vimeo.com", "player.vimeo.com"],
    captionHint:
      "Vimeo: upload a text-track (VTT/SRT) on the clip's Distribution → Subtitles panel; enable the default text-track via the `texttrack` embed parameter",
  },
  {
    name: "Wistia",
    hosts: ["wistia.com", "wistia.net", "fast.wistia.net", "fast.wistia.com"],
    captionHint:
      "Wistia: enable captions on the Customize → Captions panel and upload a VTT/SRT; the caption toggle then surfaces in the player chrome",
  },
  {
    name: "Brightcove",
    hosts: ["brightcove.net", "players.brightcove.net"],
    captionHint:
      "Brightcove: attach a WebVTT file to the video in Video Cloud Studio; confirm the player has the captions plugin enabled",
  },
  {
    name: "Loom",
    hosts: ["loom.com", "www.loom.com"],
    captionHint:
      "Loom: Loom auto-generates captions after processing — verify the clip has finished processing and the transcript panel shows captions",
  },
];

/**
 * Extracts a hostname from a URL-shaped string. Accepts absolute
 * (`https://host/…`), protocol-relative (`//host/…`), and scheme-less
 * (`host/…`) inputs. Returns `null` for relative paths (`/foo`,
 * `./video`) and empty strings. Never throws — `new URL` rejects
 * protocol-relative URLs without a base, so we parse manually.
 *
 * The returned hostname is lowercased. Port suffixes (`host:8080`) are
 * stripped so `youtube.com:443` still matches. IDN / punycode is not
 * normalized — the allowlist names Latin-ASCII hosts only.
 */
export function extractHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Strip scheme or protocol-relative prefix.
  let rest = trimmed;
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(rest);
  if (schemeMatch) {
    rest = rest.slice(schemeMatch[0].length);
  } else if (rest.startsWith("//")) {
    rest = rest.slice(2);
  } else if (rest.startsWith("/") || rest.startsWith("./") || rest.startsWith("../")) {
    // Relative path — no host to extract.
    return null;
  }
  // Strip userinfo.
  const at = rest.indexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  // Host ends at the first slash, question mark, or hash.
  const end = rest.search(/[/?#]/);
  const hostPort = end === -1 ? rest : rest.slice(0, end);
  if (hostPort.length === 0) return null;
  // Drop port suffix.
  const colon = hostPort.indexOf(":");
  const host = colon === -1 ? hostPort : hostPort.slice(0, colon);
  return host.toLowerCase();
}

/**
 * Returns the matching {@link MediaEmbedPlatform} when `src` points at
 * one of the known video-embed hosts, or `null` otherwise. `null` src
 * (missing attribute, expression value, empty string) always returns
 * `null` — we don't guess.
 */
export function mediaEmbedHost(src: string | null): MediaEmbedPlatform | null {
  if (src === null) return null;
  const host = extractHost(src);
  if (host === null) return null;
  for (const platform of MEDIA_EMBED_PLATFORMS) {
    if (platform.hosts.includes(host)) return platform;
  }
  return null;
}
